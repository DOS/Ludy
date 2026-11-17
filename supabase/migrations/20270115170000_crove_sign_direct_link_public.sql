-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 2a A1 (#3551) + #3565 defense-in-depth hardening:
--   1. Harden crove_sign.template_direct_link with max_uses, uses_count, expires_at,
--      CHECK (NOT (revoked_at IS NOT NULL AND enabled)), BEFORE UPDATE immutability trigger,
--      and 30-day revoked direct-link pruning in crove_sign.cleanup_org_secrets.
--   2. Extend crove_sign.signing_otp (MACHINERY, zero runtime role grants) to hold pre-envelope
--      direct-link OTP challenges (direct_link_id, claim_sha256, claim_used_at) with OTP codes
--      minted only at kernel-mail-send dispatch time (zero plaintext OTP persisted).
--   3. Add narrow SECURITY DEFINER orgless resolvers and ceremony procedures for /-/sign/d#<token>
--      enforcing crove_kernel.org_app_on(org_id, 'sign'), active tenant, 1 non-CC role, optional
--      max_uses / expires_at / email OTP, and atomic envelope instantiation without storing
--      plaintext capability or signing tokens.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Harden crove_sign.template_direct_link (#3565 follow-up + #3551 caps)
-- ---------------------------------------------------------------------------

ALTER TABLE crove_sign.template_direct_link
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_uses integer,
  ADD COLUMN IF NOT EXISTS uses_count integer NOT NULL DEFAULT 0;

UPDATE crove_sign.template_direct_link
SET enabled = false
WHERE revoked_at IS NOT NULL AND enabled;

ALTER TABLE crove_sign.template_direct_link
  DROP CONSTRAINT IF EXISTS template_direct_link_max_uses_check;
ALTER TABLE crove_sign.template_direct_link
  ADD CONSTRAINT template_direct_link_max_uses_check
  CHECK (max_uses IS NULL OR (max_uses >= 1 AND max_uses <= 100000));

ALTER TABLE crove_sign.template_direct_link
  DROP CONSTRAINT IF EXISTS template_direct_link_uses_count_check;
ALTER TABLE crove_sign.template_direct_link
  ADD CONSTRAINT template_direct_link_uses_count_check
  CHECK (uses_count >= 0 AND (max_uses IS NULL OR uses_count <= max_uses));

ALTER TABLE crove_sign.template_direct_link
  DROP CONSTRAINT IF EXISTS template_direct_link_revoked_disabled_check;
ALTER TABLE crove_sign.template_direct_link
  ADD CONSTRAINT template_direct_link_revoked_disabled_check
  CHECK (NOT (revoked_at IS NOT NULL AND enabled));

CREATE INDEX IF NOT EXISTS template_direct_link_cleanup_idx
  ON crove_sign.template_direct_link (org_id, revoked_at)
  WHERE revoked_at IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.org_id, NEW.id, NEW.template_id, NEW.token_sha256, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.template_id, OLD.token_sha256, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'TEMPLATE_DIRECT_LINK_IMMUTABLE'
      USING ERRCODE = '42501', DETAIL = 'template_direct_link identity and token_sha256 columns are immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'TEMPLATE_DIRECT_LINK_REVOKED'
      USING ERRCODE = '42501', DETAIL = 'revoked template_direct_link cannot be modified or un-revoked';
  END IF;
  IF NEW.uses_count < OLD.uses_count THEN
    RAISE EXCEPTION 'TEMPLATE_DIRECT_LINK_USES_MONOTONIC'
      USING ERRCODE = '42501', DETAIL = 'template_direct_link uses_count cannot decrease';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_immutable()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS template_direct_link_immutable ON crove_sign.template_direct_link;
CREATE TRIGGER template_direct_link_immutable
  BEFORE UPDATE ON crove_sign.template_direct_link
  FOR EACH ROW
  EXECUTE FUNCTION crove_sign.template_direct_link_immutable();

-- ---------------------------------------------------------------------------
-- 2. Extend crove_sign.signing_otp for pre-envelope direct-link OTP challenges
-- ---------------------------------------------------------------------------

ALTER TABLE crove_sign.signing_otp
  ALTER COLUMN signer_id DROP NOT NULL,
  ALTER COLUMN signing_token_id DROP NOT NULL;

ALTER TABLE crove_sign.signing_otp
  ADD COLUMN IF NOT EXISTS direct_link_id uuid,
  ADD COLUMN IF NOT EXISTS claim_sha256 text,
  ADD COLUMN IF NOT EXISTS claim_used_at timestamptz;

ALTER TABLE crove_sign.signing_otp
  DROP CONSTRAINT IF EXISTS signing_otp_claim_sha256_check;
ALTER TABLE crove_sign.signing_otp
  ADD CONSTRAINT signing_otp_claim_sha256_check
  CHECK (claim_sha256 IS NULL OR claim_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE crove_sign.signing_otp
  DROP CONSTRAINT IF EXISTS signing_otp_target_check;
ALTER TABLE crove_sign.signing_otp
  ADD CONSTRAINT signing_otp_target_check
  CHECK (
    (signer_id IS NOT NULL AND signing_token_id IS NOT NULL AND direct_link_id IS NULL AND claim_sha256 IS NULL AND claim_used_at IS NULL)
    OR
    (signer_id IS NULL AND signing_token_id IS NULL AND direct_link_id IS NOT NULL)
  );

ALTER TABLE crove_sign.signing_otp
  DROP CONSTRAINT IF EXISTS signing_otp_direct_link_fk;
ALTER TABLE crove_sign.signing_otp
  ADD CONSTRAINT signing_otp_direct_link_fk
  FOREIGN KEY (org_id, direct_link_id) REFERENCES crove_sign.template_direct_link (org_id, id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS signing_otp_direct_link_idx
  ON crove_sign.signing_otp (org_id, direct_link_id);

CREATE UNIQUE INDEX IF NOT EXISTS signing_otp_claim_sha256_uq
  ON crove_sign.signing_otp (claim_sha256)
  WHERE claim_sha256 IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_invalidate_otps()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
     OR (OLD.enabled AND NOT NEW.enabled) THEN
    UPDATE crove_sign.signing_otp o
    SET invalidated_at = pg_catalog.now()
    WHERE o.org_id = NEW.org_id
      AND o.direct_link_id = NEW.id
      AND o.invalidated_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_invalidate_otps()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS template_direct_link_invalidate_otps ON crove_sign.template_direct_link;
CREATE TRIGGER template_direct_link_invalidate_otps
  AFTER UPDATE OF revoked_at, enabled ON crove_sign.template_direct_link
  FOR EACH ROW
  WHEN ((OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) OR (OLD.enabled AND NOT NEW.enabled))
  EXECUTE FUNCTION crove_sign.template_direct_link_invalidate_otps();

-- ---------------------------------------------------------------------------
-- 2b. Track direct_link_id on crove_sign.envelope for DB-level rate caps (N1)
--     and add single-mailbox SQL validator (#3620)
-- ---------------------------------------------------------------------------

ALTER TABLE crove_sign.envelope
  ADD COLUMN IF NOT EXISTS direct_link_id uuid;

ALTER TABLE crove_sign.envelope
  DROP CONSTRAINT IF EXISTS envelope_direct_link_fk;
ALTER TABLE crove_sign.envelope
  ADD CONSTRAINT envelope_direct_link_fk
  FOREIGN KEY (org_id, direct_link_id)
  REFERENCES crove_sign.template_direct_link (org_id, id)
  ON DELETE SET NULL (direct_link_id);

CREATE INDEX IF NOT EXISTS envelope_direct_link_created_idx
  ON crove_sign.envelope (org_id, direct_link_id, created_at DESC)
  WHERE direct_link_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_sign.envelope_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_old jsonb;
  v_new jsonb;
  v_keep text[] := ARRAY['version', 'updated_at'];
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
  v_inherit_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_sign.template_inherit_inspect(uuid,uuid)'::pg_catalog.regprocedure);
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only a draft envelope can be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'draft' OR NEW.inspect_status <> 'pending' OR NEW.inspect_error IS NOT NULL
       OR NEW.direct_link_id IS NOT NULL
       OR NEW.page_count IS NOT NULL OR NEW.page_dimensions_json IS NOT NULL OR NEW.detected_tags_json IS NOT NULL
       OR NEW.seal_status IS NOT NULL
       OR NEW.sealed_file_id IS NOT NULL OR NEW.sealed_storage_key IS NOT NULL
       OR NEW.sealed_generation IS NOT NULL OR NEW.sealed_sha256 IS NOT NULL
       OR NEW.certificate_file_id IS NOT NULL OR NEW.certificate_storage_key IS NOT NULL
       OR NEW.certificate_generation IS NOT NULL OR NEW.certificate_sha256 IS NOT NULL
       OR NEW.certificate_code IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.completed_at IS NOT NULL
       OR NEW.declined_at IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL
       OR NEW.void_reason IS NOT NULL OR NEW.expired_at IS NOT NULL THEN
      RAISE EXCEPTION 'ENVELOPE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'an envelope starts as an uninspected draft without sealing or completion data';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE by tenant user
  IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  v_old := pg_catalog.to_jsonb(OLD) - v_keep;
  v_new := pg_catalog.to_jsonb(NEW) - v_keep;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.created_by, NEW.created_at,
      NEW.source_kind, NEW.source_id, NEW.direct_link_id, NEW.source_file_id, NEW.source_storage_key, NEW.source_generation, NEW.source_sha256)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.created_by, OLD.created_at,
      OLD.source_kind, OLD.source_id, OLD.direct_link_id, OLD.source_file_id, OLD.source_storage_key, OLD.source_generation, OLD.source_sha256) THEN
    RAISE EXCEPTION 'ENVELOPE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'envelope identity and source document columns are immutable';
  END IF;
  IF v_inherit_owner IS NOT NULL
     AND v_cur_role = v_inherit_owner
     AND pg_catalog.current_setting('crove.sign_template_inherit', true) IS NOT DISTINCT FROM NEW.id::text
     AND OLD.status = 'draft'
     AND NEW.status = 'draft'
     AND OLD.inspect_status = 'pending'
     AND NEW.inspect_status = 'passed'
     AND NEW.page_count IS NOT NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF (NEW.inspect_status, NEW.inspect_error, NEW.page_count, NEW.page_dimensions_json, NEW.detected_tags_json,
      NEW.seal_status, NEW.sealed_file_id, NEW.sealed_storage_key, NEW.sealed_generation, NEW.sealed_sha256,
      NEW.certificate_file_id, NEW.certificate_storage_key, NEW.certificate_generation, NEW.certificate_sha256,
      NEW.certificate_code, NEW.completed_at, NEW.declined_at, NEW.expired_at)
     IS DISTINCT FROM (OLD.inspect_status, OLD.inspect_error, OLD.page_count, OLD.page_dimensions_json, OLD.detected_tags_json,
      OLD.seal_status, OLD.sealed_file_id, OLD.sealed_storage_key, OLD.sealed_generation, OLD.sealed_sha256,
      OLD.certificate_file_id, OLD.certificate_storage_key, OLD.certificate_generation, OLD.certificate_sha256,
      OLD.certificate_code, OLD.completed_at, OLD.declined_at, OLD.expired_at) THEN
    RAISE EXCEPTION 'ENVELOPE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'inspection, sealed, and completion metadata are system-managed';
  END IF;
  IF OLD.status IN ('draft', 'sent', 'in_progress') AND NEW.status = 'voided' THEN
    IF NEW.voided_at IS NULL OR (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'voided_at', 'voided_by', 'void_reason', 'version', 'updated_at'])
       IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'voided_at', 'voided_by', 'void_reason', 'version', 'updated_at']) THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only void metadata can change when voiding';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'draft' THEN
      IF (NEW.sent_at, NEW.voided_at, NEW.voided_by, NEW.void_reason)
         IS DISTINCT FROM (OLD.sent_at, OLD.voided_at, OLD.voided_by, OLD.void_reason) THEN
        RAISE EXCEPTION 'ENVELOPE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'lifecycle timestamps cannot be modified on a draft';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status = 'sent' THEN
      IF OLD.inspect_status <> 'passed' THEN
        RAISE EXCEPTION 'ENVELOPE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'source PDF must pass inspection before sending';
      END IF;
      IF NEW.sent_at IS NULL OR (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'sent_at', 'version', 'updated_at'])
         IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'sent_at', 'version', 'updated_at']) THEN
        RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only status and sent_at can change when sending';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = 'draft envelope can only move to sent or voided';
  END IF;
  RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'envelope is frozen after leaving draft';
END $$;

REVOKE ALL ON FUNCTION crove_sign.envelope_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.is_single_mail_address(p_email text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_local text;
  v_domain text;
BEGIN
  IF p_email IS NULL OR pg_catalog.length(p_email) < 3 OR pg_catalog.length(p_email) > 254 THEN
    RETURN false;
  END IF;
  IF p_email ~ '[[:cntrl:][:space:]]' THEN
    RETURN false;
  END IF;
  IF pg_catalog.length(p_email) - pg_catalog.length(pg_catalog.replace(p_email, '@', '')) <> 1 THEN
    RETURN false;
  END IF;
  v_local := pg_catalog.split_part(p_email, '@', 1);
  v_domain := pg_catalog.split_part(p_email, '@', 2);
  IF pg_catalog.length(v_local) < 1 OR pg_catalog.length(v_local) > 64 THEN
    RETURN false;
  END IF;
  IF pg_catalog.length(v_domain) < 3 OR pg_catalog.length(v_domain) > 253 THEN
    RETURN false;
  END IF;
  IF v_local !~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+)*$' THEN
    RETURN false;
  END IF;
  IF v_domain !~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION crove_sign.is_single_mail_address(text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 3. Update direct-link management definers and 30-day secret retention sweep
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_state(
  p_template_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_row record;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT l.id, l.enabled, l.require_email_otp, l.max_uses, l.uses_count, l.expires_at,
         l.last_rotated_at, l.created_at, l.updated_at
  INTO v_row
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org AND l.template_id = p_template_id AND l.revoked_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'enabled', v_row.enabled,
    'requireEmailOtp', v_row.require_email_otp,
    'maxUses', v_row.max_uses,
    'usesCount', v_row.uses_count,
    'expiresAt', v_row.expires_at,
    'lastRotatedAt', v_row.last_rotated_at,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_state(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_state(uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_set_v2(
  p_template_id uuid,
  p_enabled boolean,
  p_require_email_otp boolean DEFAULT false,
  p_token_sha256 text DEFAULT NULL,
  p_max_uses integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_update_limits boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_tpl record;
  v_non_cc_count integer;
  v_existing record;
  v_creator uuid;
  v_link_id uuid;
  v_revoked_count integer := 0;
  v_next_max_uses integer;
  v_next_expires_at timestamptz;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_max_uses IS NOT NULL AND (p_max_uses < 1 OR p_max_uses > 100000) THEN
    RAISE EXCEPTION 'SIGN_INVALID_MAX_USES' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.created_by
  INTO v_tpl
  FROM crove_sign.template t
  WHERE t.org_id = v_org AND t.id = p_template_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_creator := COALESCE(v_user, v_tpl.created_by);

  IF NOT p_enabled THEN
    WITH revoked AS (
      UPDATE crove_sign.template_direct_link
      SET enabled = false,
          revoked_at = v_now,
          revoked_by = v_user,
          updated_at = v_now
      WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL
      RETURNING id
    )
    SELECT pg_catalog.count(*)::integer INTO v_revoked_count FROM revoked;

    UPDATE crove_sign.signing_otp o
    SET invalidated_at = v_now
    WHERE o.org_id = v_org
      AND o.direct_link_id IN (
        SELECT l.id FROM crove_sign.template_direct_link l
        WHERE l.org_id = v_org AND l.template_id = p_template_id
      )
      AND o.invalidated_at IS NULL;

    RETURN pg_catalog.jsonb_build_object(
      'id', NULL,
      'enabled', false,
      'requireEmailOtp', COALESCE(p_require_email_otp, false),
      'maxUses', NULL,
      'usesCount', 0,
      'expiresAt', NULL,
      'minted', false,
      'revokedCount', v_revoked_count,
      'lastRotatedAt', NULL
    );
  END IF;

  IF v_tpl.status <> 'active' THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_org AND r.template_id = p_template_id AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RAISE EXCEPTION 'SIGN_DIRECT_LINK_SINGLE_ROLE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT l.id, l.enabled, l.require_email_otp, l.max_uses, l.uses_count, l.expires_at, l.last_rotated_at
  INTO v_existing
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org AND l.template_id = p_template_id AND l.revoked_at IS NULL
  FOR UPDATE;

  IF FOUND AND v_existing.enabled AND p_token_sha256 IS NULL THEN
    v_next_max_uses := CASE WHEN COALESCE(p_update_limits, false) THEN p_max_uses ELSE v_existing.max_uses END;
    v_next_expires_at := CASE WHEN COALESCE(p_update_limits, false) THEN p_expires_at ELSE v_existing.expires_at END;
    IF v_next_max_uses IS NOT NULL AND v_next_max_uses < v_existing.uses_count THEN
      RAISE EXCEPTION 'SIGN_DIRECT_LINK_MAX_USES_EXCEEDED' USING ERRCODE = '22023';
    END IF;

    UPDATE crove_sign.template_direct_link
    SET require_email_otp = COALESCE(p_require_email_otp, false),
        max_uses = v_next_max_uses,
        expires_at = v_next_expires_at,
        updated_at = v_now
    WHERE org_id = v_org AND id = v_existing.id;

    RETURN pg_catalog.jsonb_build_object(
      'id', v_existing.id,
      'enabled', true,
      'requireEmailOtp', COALESCE(p_require_email_otp, false),
      'maxUses', v_next_max_uses,
      'usesCount', v_existing.uses_count,
      'expiresAt', v_next_expires_at,
      'minted', false,
      'revokedCount', 0,
      'lastRotatedAt', v_existing.last_rotated_at
    );
  END IF;

  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;

  IF FOUND THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        revoked_at = v_now,
        revoked_by = v_user,
        updated_at = v_now
    WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL;
    v_revoked_count := 1;
  END IF;

  INSERT INTO crove_sign.template_direct_link (
    org_id, template_id, token_sha256, enabled, require_email_otp, max_uses, uses_count, expires_at,
    created_by, created_at, updated_at
  ) VALUES (
    v_org, p_template_id, p_token_sha256, true, COALESCE(p_require_email_otp, false), p_max_uses, 0, p_expires_at,
    v_creator, v_now, v_now
  )
  RETURNING id INTO v_link_id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_link_id,
    'enabled', true,
    'requireEmailOtp', COALESCE(p_require_email_otp, false),
    'maxUses', p_max_uses,
    'usesCount', 0,
    'expiresAt', p_expires_at,
    'minted', true,
    'revokedCount', v_revoked_count,
    'lastRotatedAt', NULL
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_set_v2(uuid, boolean, boolean, text, integer, timestamptz, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_set_v2(uuid, boolean, boolean, text, integer, timestamptz, boolean) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_set(
  p_template_id uuid,
  p_enabled boolean,
  p_require_email_otp boolean DEFAULT false,
  p_token_sha256 text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN crove_sign.template_direct_link_set_v2(p_template_id, p_enabled, p_require_email_otp, p_token_sha256, NULL, NULL, false);
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_set(uuid, boolean, boolean, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_set(uuid, boolean, boolean, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_rotate_v2(
  p_template_id uuid,
  p_token_sha256 text,
  p_require_email_otp boolean DEFAULT NULL,
  p_max_uses integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_update_limits boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_tpl record;
  v_non_cc_count integer;
  v_prev record;
  v_revoked_count integer := 0;
  v_creator uuid;
  v_link_id uuid;
  v_effective_otp boolean;
  v_effective_max_uses integer;
  v_effective_expires_at timestamptz;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_max_uses IS NOT NULL AND (p_max_uses < 1 OR p_max_uses > 100000) THEN
    RAISE EXCEPTION 'SIGN_INVALID_MAX_USES' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.created_by
  INTO v_tpl
  FROM crove_sign.template t
  WHERE t.org_id = v_org AND t.id = p_template_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_tpl.status <> 'active' THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_org AND r.template_id = p_template_id AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RAISE EXCEPTION 'SIGN_DIRECT_LINK_SINGLE_ROLE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT l.id, l.require_email_otp, l.max_uses, l.expires_at
  INTO v_prev
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org AND l.template_id = p_template_id AND l.revoked_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        revoked_at = v_now,
        revoked_by = v_user,
        updated_at = v_now
    WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL;
    v_revoked_count := 1;

    UPDATE crove_sign.signing_otp o
    SET invalidated_at = v_now
    WHERE o.org_id = v_org
      AND o.direct_link_id = v_prev.id
      AND o.invalidated_at IS NULL;

    v_effective_otp := COALESCE(p_require_email_otp, v_prev.require_email_otp, false);
    v_effective_max_uses := CASE WHEN COALESCE(p_update_limits, false) THEN p_max_uses ELSE v_prev.max_uses END;
    v_effective_expires_at := CASE WHEN COALESCE(p_update_limits, false) THEN p_expires_at ELSE v_prev.expires_at END;
  ELSE
    v_effective_otp := COALESCE(p_require_email_otp, false);
    v_effective_max_uses := p_max_uses;
    v_effective_expires_at := p_expires_at;
  END IF;

  v_creator := COALESCE(v_user, v_tpl.created_by);

  INSERT INTO crove_sign.template_direct_link (
    org_id, template_id, token_sha256, enabled, require_email_otp, max_uses, uses_count, expires_at,
    last_rotated_at, created_by, created_at, updated_at
  ) VALUES (
    v_org, p_template_id, p_token_sha256, true, v_effective_otp, v_effective_max_uses, 0, v_effective_expires_at,
    v_now, v_creator, v_now, v_now
  )
  RETURNING id INTO v_link_id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_link_id,
    'enabled', true,
    'requireEmailOtp', v_effective_otp,
    'maxUses', v_effective_max_uses,
    'usesCount', 0,
    'expiresAt', v_effective_expires_at,
    'minted', true,
    'revokedCount', v_revoked_count,
    'lastRotatedAt', v_now
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_rotate_v2(uuid, text, boolean, integer, timestamptz, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_rotate_v2(uuid, text, boolean, integer, timestamptz, boolean) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_rotate(
  p_template_id uuid,
  p_token_sha256 text,
  p_require_email_otp boolean DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN crove_sign.template_direct_link_rotate_v2(p_template_id, p_token_sha256, p_require_email_otp, NULL, NULL, false);
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_rotate(uuid, text, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_rotate(uuid, text, boolean) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.cleanup_org_secrets(
  p_otp_cutoff timestamptz,
  p_token_cutoff timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_direct_link_ids uuid[] := '{}'::uuid[];
  v_token_ids uuid[] := '{}'::uuid[];
  v_otp_ids uuid[] := '{}'::uuid[];
  v_otps integer := 0;
  v_tokens integer := 0;
  v_direct_links integer := 0;
BEGIN
  IF v_org IS NULL
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_CLEANUP_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_otp_cutoff IS NULL OR p_token_cutoff IS NULL THEN
    RAISE EXCEPTION 'SIGN_CLEANUP_CUTOFF_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- Canonical lock order: template_direct_link -> signing_token -> signing_otp.
  v_direct_link_ids := ARRAY(
    SELECT l.id
    FROM crove_sign.template_direct_link l
    WHERE l.org_id = v_org
      AND l.revoked_at IS NOT NULL
      AND l.revoked_at < p_token_cutoff
    ORDER BY l.id
    FOR UPDATE OF l
  );

  v_token_ids := ARRAY(
    SELECT t.id
    FROM crove_sign.signing_token t
    WHERE t.org_id = v_org
      AND LEAST(t.expires_at, COALESCE(t.revoked_at, t.expires_at), COALESCE(t.used_at, t.expires_at)) < p_token_cutoff
    ORDER BY t.id
    FOR UPDATE OF t
  );

  -- Lock due OTPs and any child OTPs cascaded by deleting v_token_ids or v_direct_link_ids in one ordered pass.
  WITH locked_otps AS (
    SELECT
      o.id,
      (
        LEAST(
          o.expires_at,
          COALESCE(o.invalidated_at, o.expires_at),
          COALESCE(o.verified_at, o.expires_at),
          COALESCE(o.claim_used_at, o.expires_at)
        ) < p_otp_cutoff
      ) AS is_due_otp
    FROM crove_sign.signing_otp o
    WHERE o.org_id = v_org
      AND (
        LEAST(
          o.expires_at,
          COALESCE(o.invalidated_at, o.expires_at),
          COALESCE(o.verified_at, o.expires_at),
          COALESCE(o.claim_used_at, o.expires_at)
        ) < p_otp_cutoff
        OR o.signing_token_id = ANY (v_token_ids)
        OR o.direct_link_id = ANY (v_direct_link_ids)
      )
    ORDER BY o.id
    FOR UPDATE OF o
  )
  SELECT COALESCE(pg_catalog.array_agg(l.id ORDER BY l.id) FILTER (WHERE l.is_due_otp), '{}'::uuid[])
  INTO v_otp_ids
  FROM locked_otps l;

  IF COALESCE(pg_catalog.array_length(v_otp_ids, 1), 0) > 0 THEN
    DELETE FROM crove_sign.signing_otp o
    WHERE o.org_id = v_org
      AND o.id = ANY (v_otp_ids);
    GET DIAGNOSTICS v_otps = ROW_COUNT;
  END IF;

  IF COALESCE(pg_catalog.array_length(v_token_ids, 1), 0) > 0 THEN
    DELETE FROM crove_sign.signing_token t
    WHERE t.org_id = v_org
      AND t.id = ANY (v_token_ids);
    GET DIAGNOSTICS v_tokens = ROW_COUNT;
  END IF;

  IF COALESCE(pg_catalog.array_length(v_direct_link_ids, 1), 0) > 0 THEN
    DELETE FROM crove_sign.template_direct_link l
    WHERE l.org_id = v_org
      AND l.id = ANY (v_direct_link_ids);
    GET DIAGNOSTICS v_direct_links = ROW_COUNT;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'otps', v_otps,
    'tokens', v_tokens,
    'drafts', 0,
    'draftEvents', 0
  ) || CASE
    WHEN v_direct_links > 0 THEN pg_catalog.jsonb_build_object('directLinks', v_direct_links)
    ELSE '{}'::jsonb
  END;
END $$;

REVOKE ALL ON FUNCTION crove_sign.cleanup_org_secrets(timestamptz, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.cleanup_org_secrets(timestamptz, timestamptz) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_sign.cleanup_due_orgs_secrets(
  p_otp_cutoff timestamptz,
  p_token_cutoff timestamptz,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(org_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_CLEANUP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_otp_cutoff IS NULL OR p_token_cutoff IS NULL THEN
    RAISE EXCEPTION 'SIGN_CLEANUP_CUTOFF_REQUIRED' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT DISTINCT sub.org_id
  FROM (
    SELECT o.org_id FROM crove_sign.signing_otp o
    WHERE LEAST(
      o.expires_at,
      COALESCE(o.invalidated_at, o.expires_at),
      COALESCE(o.verified_at, o.expires_at),
      COALESCE(o.claim_used_at, o.expires_at)
    ) < p_otp_cutoff
    UNION
    SELECT s.org_id FROM crove_sign.signing_token s
    WHERE LEAST(s.expires_at, COALESCE(s.revoked_at, s.expires_at), COALESCE(s.used_at, s.expires_at)) < p_token_cutoff
    UNION
    SELECT l.org_id FROM crove_sign.template_direct_link l
    WHERE l.revoked_at IS NOT NULL AND l.revoked_at < p_token_cutoff
  ) sub
  JOIN crove_kernel.tenant t ON t.org_id = sub.org_id
  WHERE t.status = 'active'
  ORDER BY sub.org_id ASC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_sign.cleanup_due_orgs_secrets(timestamptz, timestamptz, integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.cleanup_due_orgs_secrets(timestamptz, timestamptz, integer) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 4. Worker mail-time OTP hydration for direct links (crove_worker + system ctx only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.public_direct_otp_issue(
  p_otp_id uuid,
  p_expires_at timestamptz,
  p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_ipad bytea;
  v_opad bytea;
  v_lookup record;
  v_tpl record;
  v_link record;
  v_otp record;
  v_ctr integer := 0;
  v_msg text;
  v_mac bytea;
  v_u32 bigint;
  v_code text;
  v_hash text;
  v_final_exp timestamptz;
BEGIN
  IF v_org IS NULL
     OR v_actor IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     OR p_otp_id IS NULL
     OR p_now IS NULL
     OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'SIGN_SYSTEM_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_expires_at <= p_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_OTP_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT
    o.id AS otp_id,
    o.direct_link_id,
    l.template_id
  INTO v_lookup
  FROM crove_sign.signing_otp o
  JOIN crove_sign.template_direct_link l
    ON l.org_id = o.org_id
   AND l.id = o.direct_link_id
  WHERE o.org_id = v_org
    AND o.id = p_otp_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Canonical lock order: template -> template_direct_link -> signing_otp.
  SELECT t.id, t.title, t.status, t.inspect_status, t.page_count
  INTO v_tpl
  FROM crove_sign.template t
  WHERE t.org_id = v_org
    AND t.id = v_lookup.template_id
  FOR SHARE;

  SELECT l.id, l.enabled, l.revoked_at, l.expires_at, l.max_uses, l.uses_count
  INTO v_link
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org
    AND l.id = v_lookup.direct_link_id
  FOR SHARE;

  SELECT o.id, o.direct_link_id, o.email, o.otp_sha256, o.attempts, o.expires_at, o.verified_at, o.invalidated_at
  INTO v_otp
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_org
    AND o.id = v_lookup.otp_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_otp.verified_at IS NOT NULL
     OR v_otp.invalidated_at IS NOT NULL
     OR v_otp.attempts >= 5
     OR NOT v_link.enabled
     OR v_link.revoked_at IS NOT NULL
     OR (v_link.expires_at IS NOT NULL AND v_link.expires_at <= p_now)
     OR (v_link.max_uses IS NOT NULL AND v_link.uses_count >= v_link.max_uses)
     OR v_tpl.status <> 'active'
     OR v_tpl.inspect_status <> 'passed'
     OR v_tpl.page_count IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;

  LOOP
    v_msg := 'crove:sign:direct-otp:hmac:v1:' || v_org::text || ':' || v_otp.direct_link_id::text || ':' || v_otp.id::text || ':' || v_ctr::text;
    v_mac := pg_catalog.sha256(v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(v_msg, 'UTF8')));
    v_u32 := pg_catalog.get_byte(v_mac, 0)::bigint * 16777216
           + pg_catalog.get_byte(v_mac, 1)::bigint * 65536
           + pg_catalog.get_byte(v_mac, 2)::bigint * 256
           + pg_catalog.get_byte(v_mac, 3)::bigint;
    IF v_u32 < 4294000000 OR v_ctr >= 64 THEN
      v_code := pg_catalog.lpad((v_u32 % 1000000)::text, 6, '0');
      EXIT;
    END IF;
    v_ctr := v_ctr + 1;
  END LOOP;

  v_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to('crove:sign:direct-otp:v1:' || v_otp.direct_link_id::text || ':' || v_otp.id::text || ':' || v_code, 'UTF8')
    ),
    'hex'
  );

  IF v_otp.otp_sha256 IS NOT NULL AND v_otp.otp_sha256 IS DISTINCT FROM v_hash THEN
    RETURN NULL;
  END IF;

  v_final_exp := CASE
    WHEN v_link.expires_at IS NOT NULL THEN LEAST(v_link.expires_at, GREATEST(v_otp.expires_at, p_expires_at))
    ELSE GREATEST(v_otp.expires_at, p_expires_at)
  END;

  UPDATE crove_sign.signing_otp
  SET otp_sha256 = v_hash,
      expires_at = v_final_exp
  WHERE org_id = v_org
    AND id = v_otp.id;

  RETURN pg_catalog.jsonb_build_object(
    'otpId', v_otp.id,
    'directLinkId', v_otp.direct_link_id,
    'templateId', v_tpl.id,
    'email', v_otp.email,
    'title', v_tpl.title,
    'code', v_code,
    'expiresAt', pg_catalog.to_char(v_final_exp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_direct_otp_issue(uuid, timestamptz, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_direct_otp_issue(uuid, timestamptz, timestamptz) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 5. Orgless public direct-link resolvers & ceremony procedures
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.public_direct_resolve(
  p_token_sha256 text,
  p_claim_sha256 text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_row record;
  v_non_cc_count integer := 0;
  v_role record;
  v_field_count integer := 0;
  v_effective_otp boolean := false;
  v_verified_email text := NULL;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT
    l.id AS direct_link_id,
    l.org_id,
    l.template_id,
    l.enabled,
    l.require_email_otp AS link_require_otp,
    l.revoked_at,
    l.expires_at AS link_expires_at,
    l.max_uses,
    l.uses_count,
    tpl.title,
    tpl.description,
    tpl.message,
    tpl.status AS template_status,
    tpl.inspect_status,
    tpl.page_count,
    tpl.page_dimensions_json,
    t.name AS org_name,
    t.status AS tenant_status
  INTO v_row
  FROM crove_sign.template_direct_link l
  JOIN crove_sign.template tpl
    ON tpl.org_id = l.org_id
   AND tpl.id = l.template_id
  JOIN crove_kernel.tenant t
    ON t.org_id = l.org_id
  WHERE l.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_row.org_id, 'sign')
     OR NOT v_row.enabled
     OR v_row.revoked_at IS NOT NULL
     OR (v_row.link_expires_at IS NOT NULL AND v_row.link_expires_at <= v_now)
     OR (v_row.max_uses IS NOT NULL AND v_row.uses_count >= v_row.max_uses)
     OR v_row.template_status <> 'active'
     OR v_row.inspect_status <> 'passed'
     OR v_row.page_count IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_row.org_id
    AND r.template_id = v_row.template_id
    AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RETURN NULL;
  END IF;

  SELECT r.id, r.signer_role, r.role_label, r.delivery_mode, r.require_email_otp
  INTO v_role
  FROM crove_sign.template_role r
  WHERE r.org_id = v_row.org_id
    AND r.template_id = v_row.template_id
    AND r.signer_role <> 'cc'
  LIMIT 1;

  v_effective_otp := COALESCE(v_row.link_require_otp, false) OR COALESCE(v_role.require_email_otp, false);

  IF p_claim_sha256 IS NOT NULL AND p_claim_sha256 ~ '^[0-9a-f]{64}$' THEN
    SELECT o.email
    INTO v_verified_email
    FROM crove_sign.signing_otp o
    WHERE o.org_id = v_row.org_id
      AND o.direct_link_id = v_row.direct_link_id
      AND o.claim_sha256 = p_claim_sha256
      AND o.verified_at IS NOT NULL
      AND o.invalidated_at IS NULL
      AND o.claim_used_at IS NULL
      AND o.expires_at > v_now
    LIMIT 1;
  END IF;

  IF v_effective_otp AND v_verified_email IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_row.org_id,
      'directLinkId', v_row.direct_link_id,
      'templateId', v_row.template_id,
      'state', 'otp_required',
      'orgName', v_row.org_name,
      'title', v_row.title,
      'description', v_row.description,
      'roleLabel', v_role.role_label,
      'signerRole', CASE WHEN v_role.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
      'requireEmailOtp', true
    );
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_field_count
  FROM crove_sign.template_field f
  WHERE f.org_id = v_row.org_id
    AND f.template_id = v_row.template_id
    AND f.template_role_id = v_role.id;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_row.org_id,
    'directLinkId', v_row.direct_link_id,
    'templateId', v_row.template_id,
    'state', 'ready',
    'orgName', v_row.org_name,
    'title', v_row.title,
    'description', v_row.description,
    'message', v_row.message,
    'roleLabel', v_role.role_label,
    'signerRole', CASE WHEN v_role.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
    'emailRequired', v_effective_otp OR v_role.delivery_mode = 'email',
    'requireEmailOtp', v_effective_otp,
    'otpVerified', v_verified_email IS NOT NULL,
    'verifiedEmail', v_verified_email,
    'pageCount', v_row.page_count,
    'pageDimensions', COALESCE(v_row.page_dimensions_json, '[]'::jsonb),
    'fieldCount', v_field_count
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_direct_resolve(text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_direct_resolve(text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_direct_pdf_source(
  p_token_sha256 text,
  p_claim_sha256 text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_row record;
  v_non_cc_count integer := 0;
  v_role_otp boolean := false;
  v_effective_otp boolean := false;
  v_otp_verified boolean := false;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT
    l.id AS direct_link_id,
    l.org_id,
    l.template_id,
    l.enabled,
    l.require_email_otp AS link_require_otp,
    l.revoked_at,
    l.expires_at AS link_expires_at,
    l.max_uses,
    l.uses_count,
    tpl.status AS template_status,
    tpl.inspect_status,
    tpl.page_count,
    tpl.source_storage_key,
    tpl.source_generation,
    tpl.source_sha256,
    t.status AS tenant_status
  INTO v_row
  FROM crove_sign.template_direct_link l
  JOIN crove_sign.template tpl
    ON tpl.org_id = l.org_id
   AND tpl.id = l.template_id
  JOIN crove_kernel.tenant t
    ON t.org_id = l.org_id
  WHERE l.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_row.org_id, 'sign')
     OR NOT v_row.enabled
     OR v_row.revoked_at IS NOT NULL
     OR (v_row.link_expires_at IS NOT NULL AND v_row.link_expires_at <= v_now)
     OR (v_row.max_uses IS NOT NULL AND v_row.uses_count >= v_row.max_uses)
     OR v_row.template_status <> 'active'
     OR v_row.inspect_status <> 'passed'
     OR v_row.page_count IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.bool_or(r.require_email_otp)
  INTO v_non_cc_count, v_role_otp
  FROM crove_sign.template_role r
  WHERE r.org_id = v_row.org_id
    AND r.template_id = v_row.template_id
    AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RETURN NULL;
  END IF;

  v_effective_otp := COALESCE(v_row.link_require_otp, false) OR COALESCE(v_role_otp, false);

  IF v_effective_otp THEN
    IF p_claim_sha256 IS NOT NULL AND p_claim_sha256 ~ '^[0-9a-f]{64}$' THEN
      SELECT EXISTS (
        SELECT 1
        FROM crove_sign.signing_otp o
        WHERE o.org_id = v_row.org_id
          AND o.direct_link_id = v_row.direct_link_id
          AND o.claim_sha256 = p_claim_sha256
          AND o.verified_at IS NOT NULL
          AND o.invalidated_at IS NULL
          AND o.claim_used_at IS NULL
          AND o.expires_at > v_now
      )
      INTO v_otp_verified;
    END IF;

    IF NOT v_otp_verified THEN
      RETURN pg_catalog.jsonb_build_object(
        'orgId', v_row.org_id,
        'otpRequired', true
      );
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_row.org_id,
    'otpRequired', false,
    'templateId', v_row.template_id,
    'storageKey', v_row.source_storage_key,
    'generation', v_row.source_generation,
    'sha256', v_row.source_sha256
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_direct_pdf_source(text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_direct_pdf_source(text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_direct_request_otp(
  p_token_sha256 text,
  p_email text,
  p_message_id_domain text DEFAULT 'crove.invalid'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_exp timestamptz := v_now + interval '10 minutes';
  v_ctx_org uuid := crove_kernel.ctx_org_id();
  v_lookup record;
  v_tpl record;
  v_link record;
  v_tenant record;
  v_non_cc_count integer := 0;
  v_role_otp boolean := false;
  v_effective_otp boolean := false;
  v_email text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_to_hash text;
  v_suppressed boolean := false;
  v_recent_email integer := 0;
  v_recent_link integer := 0;
  v_final_exp timestamptz;
  v_otp_id uuid;
  v_domain text := CASE WHEN p_message_id_domain IS NOT NULL AND pg_catalog.btrim(p_message_id_domain) ~ '^[A-Za-z0-9.-]{1,120}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_message_id_domain)) ELSE 'crove.invalid' END;
  v_org_name text;
  v_doc_title text;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT l.id AS direct_link_id, l.org_id, l.template_id
  INTO v_lookup
  FROM crove_sign.template_direct_link l
  WHERE l.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_ctx_org IS NOT NULL AND (crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_lookup.org_id) THEN
    RETURN NULL;
  END IF;

  -- Canonical lock order: template -> template_direct_link -> signing_otp.
  SELECT tpl.id, tpl.title, tpl.status, tpl.inspect_status, tpl.page_count
  INTO v_tpl
  FROM crove_sign.template tpl
  WHERE tpl.org_id = v_lookup.org_id
    AND tpl.id = v_lookup.template_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT l.*
  INTO v_link
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_lookup.org_id
    AND l.id = v_lookup.direct_link_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT t.name, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR NOT v_link.enabled
     OR v_link.revoked_at IS NOT NULL
     OR (v_link.expires_at IS NOT NULL AND v_link.expires_at <= v_now)
     OR (v_link.max_uses IS NOT NULL AND v_link.uses_count >= v_link.max_uses)
     OR v_tpl.status <> 'active'
     OR v_tpl.inspect_status <> 'passed'
     OR v_tpl.page_count IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.bool_or(r.require_email_otp)
  INTO v_non_cc_count, v_role_otp
  FROM crove_sign.template_role r
  WHERE r.org_id = v_lookup.org_id
    AND r.template_id = v_lookup.template_id
    AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RETURN NULL;
  END IF;

  v_effective_otp := COALESCE(v_link.require_email_otp, false) OR COALESCE(v_role_otp, false);
  IF NOT v_effective_otp THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_NOT_REQUIRED',
      'httpStatus', 409,
      'message', 'Email OTP verification is not required for this direct link'
    );
  END IF;

  IF NOT crove_sign.is_single_mail_address(v_email) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid email address'
    );
  END IF;

  v_to_hash := crove_kernel.mail_address_hash(v_email);
  IF v_to_hash IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid email address'
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM crove_kernel.mail_suppression ms
    WHERE ms.org_id = v_lookup.org_id
      AND ms.to_hash = v_to_hash
      AND ms.scope = 'all'
      AND ms.lifted_at IS NULL
  )
  INTO v_suppressed;

  SELECT
    pg_catalog.count(*) FILTER (WHERE pg_catalog.lower(o.email) = v_email)::integer,
    pg_catalog.count(*)::integer
  INTO v_recent_email, v_recent_link
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_lookup.org_id
    AND o.direct_link_id = v_link.id
    AND o.created_at > v_now - interval '1 hour';

  IF v_recent_email >= 3 OR v_recent_link >= 30 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_RATE_LIMITED',
      'httpStatus', 429,
      'message', 'Too many OTP requests; wait before trying again'
    );
  END IF;

  PERFORM 1
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_lookup.org_id
    AND o.direct_link_id = v_link.id
    AND pg_catalog.lower(o.email) = v_email
    AND o.verified_at IS NULL
    AND o.invalidated_at IS NULL
  ORDER BY o.id
  FOR UPDATE;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_lookup.org_id
    AND o.direct_link_id = v_link.id
    AND pg_catalog.lower(o.email) = v_email
    AND o.verified_at IS NULL
    AND o.invalidated_at IS NULL;

  v_final_exp := CASE WHEN v_link.expires_at IS NOT NULL THEN LEAST(v_link.expires_at, v_exp) ELSE v_exp END;

  -- For suppressed recipients (#3620), record an immediately-invalidated OTP row so per-email (3/hr)
  -- and per-link (30/hr) caps still advance identically while queueing zero outbound mail.
  INSERT INTO crove_sign.signing_otp (
    org_id, signer_id, signing_token_id, direct_link_id, email, otp_sha256,
    expires_at, attempts, invalidated_at, created_at
  )
  VALUES (
    v_lookup.org_id, NULL, NULL, v_link.id, v_email, NULL,
    v_final_exp, 0, CASE WHEN v_suppressed THEN v_now ELSE NULL END, v_now
  )
  RETURNING id INTO v_otp_id;

  IF NOT v_suppressed THEN
    v_org_name := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_tenant.name, '[[:cntrl:]]+', ' ', 'g')), 200), ''), 'Ludy');
    v_doc_title := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_tpl.title, '[[:cntrl:]]+', ' ', 'g')), 300), ''), 'Tai lieu');

    INSERT INTO crove_kernel.mail_message (
      org_id, stream, source, source_id, template_key, to_address, to_hash,
      subject, payload, message_id_header, status, created_by
    )
    VALUES (
      v_lookup.org_id,
      'transactional',
      'sign.direct.request_otp',
      v_otp_id,
      'sign.direct_otp',
      v_email,
      v_to_hash,
      pg_catalog.left('Ma xac thuc ky tai lieu: ' || v_doc_title, 300),
      pg_catalog.jsonb_build_object(
        'lang', 'vi',
        'orgName', v_org_name,
        'directLinkId', v_link.id::text,
        'otpId', v_otp_id::text,
        'docTitle', v_doc_title,
        'expiresAt', pg_catalog.to_char(v_final_exp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
      'queued',
      NULL
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'otpId', v_otp_id,
    'sent', true,
    'expiresInMinutes', 10,
    'maskedEmail', crove_sign.mask_email(v_email)
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_direct_request_otp(text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_direct_request_otp(text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_direct_verify_otp(
  p_token_sha256 text,
  p_email text,
  p_code text,
  p_claim_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_ctx_org uuid := crove_kernel.ctx_org_id();
  v_lookup record;
  v_tpl record;
  v_link record;
  v_tenant record;
  v_non_cc_count integer := 0;
  v_role_otp boolean := false;
  v_effective_otp boolean := false;
  v_email text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_otp record;
  v_cand_hash text;
  v_next integer;
  v_locked boolean;
  v_claim_exp timestamptz := v_now + interval '15 minutes';
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT l.id AS direct_link_id, l.org_id, l.template_id
  INTO v_lookup
  FROM crove_sign.template_direct_link l
  WHERE l.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_ctx_org IS NOT NULL AND (crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_lookup.org_id) THEN
    RETURN NULL;
  END IF;

  -- Canonical lock order: template -> template_direct_link -> signing_otp.
  SELECT tpl.id, tpl.status, tpl.inspect_status, tpl.page_count
  INTO v_tpl
  FROM crove_sign.template tpl
  WHERE tpl.org_id = v_lookup.org_id
    AND tpl.id = v_lookup.template_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT l.*
  INTO v_link
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_lookup.org_id
    AND l.id = v_lookup.direct_link_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR NOT v_link.enabled
     OR v_link.revoked_at IS NOT NULL
     OR (v_link.expires_at IS NOT NULL AND v_link.expires_at <= v_now)
     OR (v_link.max_uses IS NOT NULL AND v_link.uses_count >= v_link.max_uses)
     OR v_tpl.status <> 'active'
     OR v_tpl.inspect_status <> 'passed'
     OR v_tpl.page_count IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.bool_or(r.require_email_otp)
  INTO v_non_cc_count, v_role_otp
  FROM crove_sign.template_role r
  WHERE r.org_id = v_lookup.org_id
    AND r.template_id = v_lookup.template_id
    AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RETURN NULL;
  END IF;

  IF NOT crove_sign.is_single_mail_address(v_email) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'validation_error', 'message', 'Invalid email address');
  END IF;

  IF p_code IS NULL OR p_code !~ '^\d{6}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'validation_error', 'message', 'OTP code must be 6 digits');
  END IF;

  IF p_claim_sha256 IS NULL OR p_claim_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'validation_error', 'message', 'Invalid OTP session claim');
  END IF;

  v_effective_otp := COALESCE(v_link.require_email_otp, false) OR COALESCE(v_role_otp, false);
  IF NOT v_effective_otp THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_NOT_REQUIRED',
      'httpStatus', 409,
      'message', 'Email OTP verification is not required for this direct link'
    );
  END IF;

  SELECT o.id, o.otp_sha256, o.expires_at, o.attempts, o.invalidated_at
  INTO v_otp
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_lookup.org_id
    AND o.direct_link_id = v_link.id
    AND pg_catalog.lower(o.email) = v_email
    AND o.verified_at IS NULL
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'locked', false, 'attemptsRemaining', 0);
  END IF;

  IF v_otp.invalidated_at IS NOT NULL OR v_otp.attempts >= 5 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'locked', true, 'attemptsRemaining', 0);
  END IF;

  IF v_otp.expires_at <= v_now THEN
    UPDATE crove_sign.signing_otp
    SET invalidated_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_otp.id;
    RETURN pg_catalog.jsonb_build_object('ok', false, 'locked', false, 'attemptsRemaining', 0, 'expired', true);
  END IF;

  IF v_otp.otp_sha256 IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false,
      'locked', false,
      'attemptsRemaining', GREATEST(0, 5 - v_otp.attempts),
      'notReady', true
    );
  END IF;

  v_cand_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to('crove:sign:direct-otp:v1:' || v_link.id::text || ':' || v_otp.id::text || ':' || p_code, 'UTF8')
    ),
    'hex'
  );

  IF v_cand_hash = v_otp.otp_sha256 THEN
    IF v_link.expires_at IS NOT NULL THEN
      v_claim_exp := LEAST(v_link.expires_at, v_claim_exp);
    END IF;
    UPDATE crove_sign.signing_otp
    SET verified_at = v_now,
        claim_sha256 = p_claim_sha256,
        expires_at = GREATEST(expires_at, v_claim_exp)
    WHERE org_id = v_lookup.org_id
      AND id = v_otp.id;

    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'locked', false,
      'attemptsRemaining', GREATEST(0, 5 - v_otp.attempts),
      'verifiedEmail', v_email
    );
  END IF;

  v_next := v_otp.attempts + 1;
  v_locked := v_next >= 5;
  UPDATE crove_sign.signing_otp
  SET attempts = v_next,
      invalidated_at = CASE WHEN v_locked THEN v_now ELSE NULL END
  WHERE org_id = v_lookup.org_id
    AND id = v_otp.id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', false,
    'locked', v_locked,
    'attemptsRemaining', GREATEST(0, 5 - v_next)
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_direct_verify_otp(text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_direct_verify_otp(text, text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_direct_start(
  p_token_sha256 text,
  p_name text,
  p_email text,
  p_claim_sha256 text,
  p_signing_token_sha256 text,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_ctx_org uuid := crove_kernel.ctx_org_id();
  v_lookup record;
  v_tpl record;
  v_link record;
  v_tenant record;
  v_non_cc_count integer := 0;
  v_role record;
  v_cc_role record;
  v_effective_otp boolean := false;
  v_name text := pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]+', ' ', 'g'));
  v_email text := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, ''))), '');
  v_otp record;
  v_otp_verified_at timestamptz := NULL;
  v_delivery_mode text := 'link';
  v_recent_link_starts integer := 0;
  v_recent_email_starts integer := 0;
  v_sig_field_count integer := 0;
  v_oob_field_count integer := 0;
  v_env_expires_at timestamptz;
  v_token_expires_at timestamptz;
  v_env_id uuid;
  v_signer_id uuid;
  v_signing_token_id uuid;
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT l.id AS direct_link_id, l.org_id, l.template_id
  INTO v_lookup
  FROM crove_sign.template_direct_link l
  WHERE l.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_ctx_org IS NOT NULL AND (crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_lookup.org_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Canonical lock order: template -> template_direct_link -> signing_otp.
  -- FOR UPDATE on template_direct_link serializes concurrent starts so uses_count and hourly rate caps cannot race.
  SELECT tpl.*
  INTO v_tpl
  FROM crove_sign.template tpl
  WHERE tpl.org_id = v_lookup.org_id
    AND tpl.id = v_lookup.template_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT l.*
  INTO v_link
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_lookup.org_id
    AND l.id = v_lookup.direct_link_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT t.name, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR NOT v_link.enabled
     OR v_link.revoked_at IS NOT NULL
     OR (v_link.expires_at IS NOT NULL AND v_link.expires_at <= v_now)
     OR (v_link.max_uses IS NOT NULL AND v_link.uses_count >= v_link.max_uses)
     OR v_tpl.status <> 'active'
     OR v_tpl.inspect_status <> 'passed'
     OR v_tpl.page_count IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_lookup.org_id
    AND r.template_id = v_lookup.template_id
    AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT r.id, r.role_key, r.signer_role, r.role_label, r.routing_order, r.delivery_mode, r.require_email_otp
  INTO v_role
  FROM crove_sign.template_role r
  WHERE r.org_id = v_lookup.org_id
    AND r.template_id = v_lookup.template_id
    AND r.signer_role <> 'cc'
  LIMIT 1;

  IF p_signing_token_sha256 IS NULL OR p_signing_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid signing token digest'
    );
  END IF;

  IF pg_catalog.length(v_name) < 1 OR pg_catalog.length(v_name) > 200 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Recipient name must be between 1 and 200 characters'
    );
  END IF;

  IF v_email IS NOT NULL AND NOT crove_sign.is_single_mail_address(v_email) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid recipient email address'
    );
  END IF;

  v_effective_otp := COALESCE(v_link.require_email_otp, false) OR COALESCE(v_role.require_email_otp, false);

  IF v_effective_otp THEN
    IF p_claim_sha256 IS NULL OR p_claim_sha256 !~ '^[0-9a-f]{64}$' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_OTP_REQUIRED',
        'httpStatus', 403,
        'message', 'Email OTP verification is required before starting signing'
      );
    END IF;

    SELECT o.id, o.email, o.otp_sha256, o.verified_at, o.expires_at, o.invalidated_at, o.claim_used_at
    INTO v_otp
    FROM crove_sign.signing_otp o
    WHERE o.org_id = v_lookup.org_id
      AND o.direct_link_id = v_link.id
      AND o.claim_sha256 = p_claim_sha256
    FOR UPDATE;

    IF NOT FOUND
       OR v_otp.verified_at IS NULL
       OR v_otp.invalidated_at IS NOT NULL
       OR v_otp.claim_used_at IS NOT NULL
       OR v_otp.expires_at <= v_now THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_OTP_REQUIRED',
        'httpStatus', 403,
        'message', 'Email OTP verification is required or has expired'
      );
    END IF;

    IF v_email IS NOT NULL AND v_email <> pg_catalog.lower(v_otp.email) THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_OTP_EMAIL_MISMATCH',
        'httpStatus', 403,
        'message', 'Submitted email must match the OTP-verified email address'
      );
    END IF;

    v_email := pg_catalog.lower(v_otp.email);
    v_otp_verified_at := v_otp.verified_at;
    v_delivery_mode := 'email';
  ELSIF v_role.delivery_mode = 'email' AND v_email IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_REQUIRED',
      'httpStatus', 422,
      'message', 'Email address is required for this template'
    );
  END IF;

  -- Database-level hourly start caps across instances (N1): <= 30 starts/hour per direct link
  -- and <= 5 starts/hour per (direct_link_id, lower(email)) when an email address is provided.
  SELECT pg_catalog.count(*)::integer
  INTO v_recent_link_starts
  FROM crove_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.direct_link_id = v_link.id
    AND e.created_at > v_now - interval '1 hour';

  IF v_recent_link_starts >= 30 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DIRECT_START_RATE_LIMITED',
      'httpStatus', 429,
      'message', 'Too many signing sessions started for this link; wait before trying again'
    );
  END IF;

  IF v_email IS NOT NULL THEN
    SELECT pg_catalog.count(*)::integer
    INTO v_recent_email_starts
    FROM crove_sign.envelope e
    JOIN crove_sign.signer s
      ON s.org_id = e.org_id
     AND s.envelope_id = e.id
    WHERE e.org_id = v_lookup.org_id
      AND e.direct_link_id = v_link.id
      AND e.created_at > v_now - interval '1 hour'
      AND s.signer_role <> 'cc'
      AND pg_catalog.lower(s.email) = v_email;

    IF v_recent_email_starts >= 5 THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_DIRECT_START_RATE_LIMITED',
        'httpStatus', 429,
        'message', 'Too many signing sessions started for this email address; wait before trying again'
      );
    END IF;
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (WHERE f.field_type = 'signature')::integer,
    pg_catalog.count(*) FILTER (WHERE f.page_number > v_tpl.page_count)::integer
  INTO v_sig_field_count, v_oob_field_count
  FROM crove_sign.template_field f
  WHERE f.org_id = v_lookup.org_id
    AND f.template_id = v_tpl.id
    AND f.template_role_id = v_role.id;

  IF v_oob_field_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_FIELD_OUT_OF_BOUNDS',
      'httpStatus', 409,
      'message', 'Template contains fields outside the inspected PDF page bounds'
    );
  END IF;

  IF v_role.signer_role = 'signer' AND v_sig_field_count < 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_SIGNATURE_FIELD_REQUIRED',
      'httpStatus', 409,
      'message', 'Template requires at least one signature field before signing'
    );
  END IF;

  -- Atomically increment uses_count (enforcing max_uses under concurrency) and consume any OTP claim.
  UPDATE crove_sign.template_direct_link
  SET uses_count = uses_count + 1,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_link.id
    AND enabled = true
    AND revoked_at IS NULL
    AND (max_uses IS NULL OR uses_count < max_uses);

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_effective_otp THEN
    UPDATE crove_sign.signing_otp
    SET claim_used_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_otp.id
      AND claim_used_at IS NULL;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_OTP_REQUIRED',
        'httpStatus', 403,
        'message', 'Email OTP verification has already been used'
      );
    END IF;
  END IF;

  v_env_expires_at := CASE
    WHEN v_tpl.expires_in_hours IS NOT NULL THEN v_now + pg_catalog.make_interval(hours => v_tpl.expires_in_hours)
    ELSE NULL
  END;
  IF v_link.expires_at IS NOT NULL AND (v_env_expires_at IS NULL OR v_link.expires_at < v_env_expires_at) THEN
    v_env_expires_at := v_link.expires_at;
  END IF;

  v_token_expires_at := COALESCE(v_env_expires_at, v_now + interval '30 days');
  v_ip_hash := crove_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
  v_actor_label := pg_catalog.left(COALESCE(v_email, v_name), 254);

  INSERT INTO crove_sign.envelope (
    org_id, title, subject, message, status, routing_mode,
    source_kind, source_id, direct_link_id, source_file_id, source_storage_key, source_generation, source_sha256,
    inspect_status, page_count, page_dimensions_json, detected_tags_json,
    expires_at, sent_at, version, created_by, created_at, updated_at
  )
  VALUES (
    v_lookup.org_id, v_tpl.title, v_tpl.subject, v_tpl.message, 'sent', v_tpl.routing_mode,
    'standalone', NULL, v_link.id, v_tpl.source_file_id, v_tpl.source_storage_key, v_tpl.source_generation, v_tpl.source_sha256,
    'passed', v_tpl.page_count, v_tpl.page_dimensions_json, v_tpl.detected_tags_json,
    v_env_expires_at, v_now, 2, v_link.created_by, v_now, v_now
  )
  RETURNING id INTO v_env_id;

  -- N1(a): Only OTP-verified direct-link signers get delivery_mode = 'email'; unverified starts
  -- stay 'link' even when an optional email address is entered, preventing anonymous mail relay.
  INSERT INTO crove_sign.signer (
    org_id, envelope_id, role_key, routing_order, signer_role, role_label,
    name, email, phone, delivery_mode, require_email_otp,
    status, otp_verified_at, signer_ip_hash, signer_user_agent, created_at, updated_at
  )
  VALUES (
    v_lookup.org_id, v_env_id, v_role.role_key, v_role.routing_order, v_role.signer_role, v_role.role_label,
    v_name, v_email, NULL, v_delivery_mode, v_effective_otp,
    'pending', v_otp_verified_at, v_ip_hash, v_ua, v_now, v_now
  )
  RETURNING id INTO v_signer_id;

  FOR v_cc_role IN
    SELECT r.role_key, r.routing_order, r.role_label
    FROM crove_sign.template_role r
    WHERE r.org_id = v_lookup.org_id
      AND r.template_id = v_tpl.id
      AND r.signer_role = 'cc'
    ORDER BY r.routing_order ASC, r.created_at ASC, r.id ASC
  LOOP
    INSERT INTO crove_sign.signer (
      org_id, envelope_id, role_key, routing_order, signer_role, role_label,
      name, email, phone, delivery_mode, require_email_otp,
      status, created_at, updated_at
    )
    VALUES (
      v_lookup.org_id, v_env_id, v_cc_role.role_key, v_cc_role.routing_order, 'cc', v_cc_role.role_label,
      v_cc_role.role_label, NULL, NULL, 'link', false,
      'waiting', v_now, v_now
    );
  END LOOP;

  INSERT INTO crove_sign.field (
    org_id, envelope_id, signer_id, field_type, page_number,
    x_norm, y_norm, w_norm, h_norm, label, required, proposed_by_ai, font_size_pt,
    created_at, updated_at
  )
  SELECT
    v_lookup.org_id, v_env_id, v_signer_id, f.field_type, f.page_number,
    f.x_norm, f.y_norm, f.w_norm, f.h_norm, f.label, f.required, false, f.font_size_pt,
    v_now, v_now
  FROM crove_sign.template_field f
  WHERE f.org_id = v_lookup.org_id
    AND f.template_id = v_tpl.id
    AND f.template_role_id = v_role.id
  ORDER BY f.page_number ASC, f.id ASC;

  INSERT INTO crove_sign.signing_token (
    org_id, envelope_id, signer_id, token_sha256, expires_at, created_by, created_at
  )
  VALUES (
    v_lookup.org_id, v_env_id, v_signer_id, p_signing_token_sha256, v_token_expires_at, v_link.created_by, v_now
  )
  RETURNING id INTO v_signing_token_id;

  PERFORM crove_sign.public_append_event(
    v_lookup.org_id,
    v_env_id,
    NULL,
    'envelope_created',
    'system',
    'system:sign-direct-link',
    v_tpl.source_sha256,
    pg_catalog.jsonb_build_object(
      'templateId', v_tpl.id::text,
      'directLinkId', v_link.id::text,
      'routingMode', v_tpl.routing_mode,
      'sourceKind', 'standalone'
    ),
    v_ip_hash,
    v_ua,
    v_now
  );

  PERFORM crove_sign.public_append_event(
    v_lookup.org_id,
    v_env_id,
    v_signer_id,
    'envelope_sent',
    'system',
    'system:sign-direct-link',
    v_tpl.source_sha256,
    pg_catalog.jsonb_build_object(
      'templateId', v_tpl.id::text,
      'directLinkId', v_link.id::text,
      'activeSignerIds', pg_catalog.jsonb_build_array(v_signer_id::text)
    ),
    v_ip_hash,
    v_ua,
    v_now
  );

  IF v_effective_otp AND v_otp_verified_at IS NOT NULL THEN
    INSERT INTO crove_sign.signing_otp (
      org_id, signer_id, signing_token_id, direct_link_id, email, otp_sha256,
      expires_at, attempts, verified_at, created_at
    )
    VALUES (
      v_lookup.org_id, v_signer_id, v_signing_token_id, NULL, v_email, v_otp.otp_sha256,
      v_token_expires_at, 0, v_otp_verified_at, v_now
    );

    PERFORM crove_sign.public_append_event(
      v_lookup.org_id,
      v_env_id,
      v_signer_id,
      'signer_otp_verified',
      'signer',
      v_actor_label,
      v_tpl.source_sha256,
      pg_catalog.jsonb_build_object('otpId', v_otp.id::text, 'directLinkId', v_link.id::text),
      v_ip_hash,
      v_ua,
      v_now
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'orgId', v_lookup.org_id,
    'templateId', v_tpl.id,
    'directLinkId', v_link.id,
    'envelopeId', v_env_id,
    'signerId', v_signer_id,
    'signingTokenId', v_signing_token_id,
    'expiresAt', pg_catalog.to_char(v_token_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_direct_start(text, text, text, text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_direct_start(text, text, text, text, text, text, text) TO crove_app;
