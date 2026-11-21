-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 3c (#3813, docs/plan/esign.md, owner decision 2026-11-19):
--   1. Add auto_remind_before_expiry boolean NOT NULL DEFAULT true, decline_acknowledged_at timestamptz, and
--      decline_acknowledged_by uuid on crove_sign.envelope. Envelopes already sent before this migration keep
--      auto_remind_before_expiry = false so pre-upgrade envelopes never send automated reminders without sender opt-in.
--   2. Restate crove_sign.envelope_guard() preserving direct_link_id, detected_tags_json, template_inherit_inspect,
--      and all draft/void/send guards, plus allowing decline acknowledgment on declined envelopes.
--   3. Add pre_expiry_reminded_at timestamptz on crove_sign.signer and update crove_sign.signer_guard() so only
--      system workers can stamp pre_expiry_reminded_at (preserving personal_erase_unsealed_signers DELETE bypass).
--   4. Update crove_sign.public_mail_token_issue(...) so 24h pre-expiry reminder emails reuse an active valid email
--      signing token when present without revoking an open signing session or invalidating active OTPs.
--   5. Add supporting partial index for unacknowledged declined envelopes and worker SECURITY DEFINER helper
--      crove_sign.pre_expiry_remind_due_orgs(integer, timestamptz) gated on crove_kernel.org_app_on(org_id, 'sign').
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Columns, pre-migration opt-in backfill, and supporting index
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_sign'
      AND c.relname = 'envelope'
      AND a.attname = 'auto_remind_before_expiry'
      AND NOT a.attisdropped
  ) THEN
    PERFORM pg_catalog.set_config('crove.sign_add_auto_remind_col', 'true', true);
  END IF;
END $$;

ALTER TABLE crove_sign.envelope
  ADD COLUMN IF NOT EXISTS auto_remind_before_expiry boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS decline_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS decline_acknowledged_by uuid REFERENCES crove_kernel.user_account (id);

DO $$
BEGIN
  IF pg_catalog.current_setting('crove.sign_add_auto_remind_col', true) = 'true' THEN
    UPDATE crove_sign.envelope
    SET auto_remind_before_expiry = false
    WHERE status <> 'draft';
  END IF;
END $$;

ALTER TABLE crove_sign.signer
  ADD COLUMN IF NOT EXISTS pre_expiry_reminded_at timestamptz;

DROP INDEX IF EXISTS crove_sign.envelope_declined_recent_idx;

CREATE INDEX IF NOT EXISTS envelope_declined_unacked_idx
  ON crove_sign.envelope (org_id, declined_at DESC, id)
  WHERE status = 'declined' AND decline_acknowledged_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Envelope and signer mutation guards
-- ---------------------------------------------------------------------------

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
    -- auto_remind_before_expiry is configurable by the creator on draft creation (defaults to true).
    IF NEW.status <> 'draft' OR NEW.inspect_status <> 'pending' OR NEW.inspect_error IS NOT NULL
       OR NEW.direct_link_id IS NOT NULL
       OR NEW.page_count IS NOT NULL OR NEW.page_dimensions_json IS NOT NULL OR NEW.detected_tags_json IS NOT NULL
       OR NEW.seal_status IS NOT NULL
       OR NEW.sealed_file_id IS NOT NULL OR NEW.sealed_storage_key IS NOT NULL
       OR NEW.sealed_generation IS NOT NULL OR NEW.sealed_sha256 IS NOT NULL
       OR NEW.certificate_file_id IS NOT NULL OR NEW.certificate_storage_key IS NOT NULL
       OR NEW.certificate_generation IS NOT NULL OR NEW.certificate_sha256 IS NOT NULL
       OR NEW.certificate_code IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.completed_at IS NOT NULL
       OR NEW.declined_at IS NOT NULL OR NEW.decline_acknowledged_at IS NOT NULL OR NEW.decline_acknowledged_by IS NOT NULL
       OR NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL
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
  IF OLD.status = 'declined' AND NEW.status = 'declined' THEN
    IF OLD.decline_acknowledged_at IS NOT NULL
       OR NEW.decline_acknowledged_at IS NULL
       OR NEW.decline_acknowledged_by IS DISTINCT FROM crove_kernel.ctx_user_id()
       OR (pg_catalog.to_jsonb(OLD) - ARRAY['decline_acknowledged_at', 'decline_acknowledged_by', 'version', 'updated_at'])
          IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['decline_acknowledged_at', 'decline_acknowledged_by', 'version', 'updated_at']) THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only decline acknowledgment metadata can change once on a declined envelope';
    END IF;
    RETURN NEW;
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
      IF (NEW.sent_at, NEW.voided_at, NEW.voided_by, NEW.void_reason, NEW.decline_acknowledged_at, NEW.decline_acknowledged_by)
         IS DISTINCT FROM (OLD.sent_at, OLD.voided_at, OLD.voided_by, OLD.void_reason, OLD.decline_acknowledged_at, OLD.decline_acknowledged_by) THEN
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

CREATE OR REPLACE FUNCTION crove_sign.signer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
  v_env_sealed_file_id uuid;
  v_erase_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_sign.personal_erase_unsealed_signers(text,text)'::pg_catalog.regprocedure);
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  SELECT e.status, e.sealed_file_id INTO v_env_status, v_env_sealed_file_id
  FROM crove_sign.envelope e WHERE e.org_id = v_org AND e.id = v_env_id FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF v_env_status = 'draft' THEN
      RETURN OLD;
    END IF;
    IF v_env_status IN ('voided', 'expired', 'declined')
       AND v_env_sealed_file_id IS NULL
       AND v_cur_role = v_erase_owner
       AND pg_catalog.current_setting('crove.sign_personal_erase', true) = OLD.org_id::text
       AND v_actor = 'user'
       AND crove_kernel.ctx_agent_id() IS NULL
       AND crove_kernel.ctx_org_id() = OLD.org_id
       AND EXISTS (
         SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = OLD.org_id AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signers can only be added or removed while envelope is draft';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_env_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signers can only be added or removed while envelope is draft';
    END IF;
    IF NEW.status <> 'waiting' THEN
      RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = 'new signers on a draft envelope must start in waiting status';
    END IF;
    IF NEW.token_last_reminded_at IS NOT NULL OR NEW.pre_expiry_reminded_at IS NOT NULL
       OR NEW.viewed_at IS NOT NULL OR NEW.signed_at IS NOT NULL
       OR NEW.declined_at IS NOT NULL OR NEW.decline_reason IS NOT NULL OR NEW.otp_verified_at IS NOT NULL
       OR NEW.signature_kind IS NOT NULL OR NEW.signature_typed_text IS NOT NULL
       OR NEW.signer_user_agent IS NOT NULL OR NEW.signer_ip_hash IS NOT NULL
       OR NEW.consent_accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'signing evidence columns are system-managed';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE by tenant user
  IF (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.envelope_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SIGNER_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF (NEW.pre_expiry_reminded_at, NEW.viewed_at, NEW.signed_at, NEW.declined_at, NEW.decline_reason, NEW.otp_verified_at,
      NEW.signature_kind, NEW.signature_typed_text, NEW.signer_user_agent, NEW.signer_ip_hash, NEW.consent_accepted_at)
     IS DISTINCT FROM (OLD.pre_expiry_reminded_at, OLD.viewed_at, OLD.signed_at, OLD.declined_at, OLD.decline_reason, OLD.otp_verified_at,
      OLD.signature_kind, OLD.signature_typed_text, OLD.signer_user_agent, OLD.signer_ip_hash, OLD.consent_accepted_at) THEN
    RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'signing evidence columns are system-managed';
  END IF;
  IF v_env_status = 'draft' THEN
    IF NEW.token_last_reminded_at IS DISTINCT FROM OLD.token_last_reminded_at THEN
      RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'reminder timestamp cannot be set while envelope is draft';
    END IF;
    IF (NEW.routing_order, NEW.role_label, NEW.name, NEW.email, NEW.phone, NEW.delivery_mode, NEW.require_email_otp, NEW.status)
       IS DISTINCT FROM (OLD.routing_order, OLD.role_label, OLD.name, OLD.email, OLD.phone, OLD.delivery_mode, OLD.require_email_otp, OLD.status) THEN
      IF NEW.status <> 'waiting' THEN
        RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF v_env_status IN ('sent', 'in_progress', 'voided') THEN
    IF (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'token_last_reminded_at', 'updated_at'])
       IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'token_last_reminded_at', 'updated_at']) THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signer identity and delivery cannot change after send';
    END IF;
    IF v_env_status = 'voided' THEN
      IF NEW.token_last_reminded_at IS DISTINCT FROM OLD.token_last_reminded_at
         OR NOT (OLD.status IN ('waiting', 'pending', 'viewed') AND NEW.status = 'voided') THEN
        RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT ((OLD.status = 'waiting' AND NEW.status = 'pending')
              OR (OLD.status IN ('waiting', 'pending', 'viewed') AND NEW.status = 'voided')) THEN
        RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signers are frozen after envelope leaves active state';
END $$;

REVOKE ALL ON FUNCTION crove_sign.signer_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 3. Non-disruptive token reuse for automatic 24h pre-expiry reminders
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.public_mail_token_issue(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_message_id uuid,
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
  v_env record;
  v_signer record;
  v_existing record;
  v_active record;
  v_mail_source text;
  v_prev_mail record;
  v_prev_msg text;
  v_prev_mac bytea;
  v_prev_raw text;
  v_prev_hash text;
  v_msg text;
  v_mac bytea;
  v_raw_token text;
  v_token_hash text;
  v_final_exp timestamptz;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL
     OR v_actor IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     OR p_envelope_id IS NULL
     OR p_signer_id IS NULL
     OR p_message_id IS NULL
     OR p_now IS NULL
     OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'SIGN_SYSTEM_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_expires_at <= p_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token -> signing_otp.
  SELECT e.id, e.status, e.message, e.expires_at, e.created_by
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org
    AND e.id = p_envelope_id
  FOR SHARE;

  IF NOT FOUND
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= p_now) THEN
    RETURN NULL;
  END IF;

  SELECT s.id, s.name, s.signer_role, s.status
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = p_signer_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed') THEN
    RETURN NULL;
  END IF;

  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;

  -- For automatic 24h pre-expiry reminders, reuse an active valid email signing token if present
  -- so an open ceremony tab, in-progress OTP, or prior invite email link is never invalidated.
  SELECT m.source
  INTO v_mail_source
  FROM crove_kernel.mail_message m
  WHERE m.org_id = v_org
    AND m.id = p_message_id;

  IF v_mail_source = 'sign.envelope.pre_expiry_remind_sweep' THEN
    SELECT t.id, t.token_sha256, t.expires_at, t.last_viewed_at
    INTO v_active
    FROM crove_sign.signing_token t
    WHERE t.org_id = v_org
      AND t.signer_id = v_signer.id
      AND t.revoked_at IS NULL
      AND t.used_at IS NULL
    FOR UPDATE;

    IF FOUND AND v_active.expires_at > p_now THEN
      FOR v_prev_mail IN
        SELECT m.id
        FROM crove_kernel.mail_message m
        WHERE m.org_id = v_org
          AND m.source_id = v_signer.id
          AND m.template_key IN ('sign.invite', 'sign.remind')
          AND m.id <> p_message_id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 10
      LOOP
        v_prev_msg := 'crove:sign:mail-token:v1:' || v_org::text || ':' || v_env.id::text || ':' || v_signer.id::text || ':' || v_prev_mail.id::text;
        v_prev_mac := pg_catalog.sha256(v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(v_prev_msg, 'UTF8')));
        v_prev_raw := pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(v_prev_mac, 'base64'), '+/', '-_'), '=');
        v_prev_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_prev_raw, 'UTF8')), 'hex');
        IF v_prev_hash = v_active.token_sha256 THEN
          RETURN pg_catalog.jsonb_build_object(
            'tokenId', v_active.id,
            'token', v_prev_raw,
            'signerName', v_signer.name,
            'message', v_env.message,
            'expiresAt', pg_catalog.to_char(v_active.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'minted', false
          );
        END IF;
      END LOOP;

      -- If the active token came from a manual Zalo link and is actively open right now, do not revoke it mid-ceremony.
      IF v_active.last_viewed_at IS NOT NULL AND v_active.last_viewed_at > p_now - interval '15 minutes' THEN
        RETURN NULL;
      END IF;
    END IF;
  END IF;

  v_msg := 'crove:sign:mail-token:v1:' || v_org::text || ':' || v_env.id::text || ':' || v_signer.id::text || ':' || p_message_id::text;
  v_mac := pg_catalog.sha256(v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(v_msg, 'UTF8')));
  v_raw_token := pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(v_mac, 'base64'), '+/', '-_'), '=');
  v_token_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_raw_token, 'UTF8')), 'hex');

  SELECT t.id, t.expires_at, t.revoked_at, t.used_at
  INTO v_existing
  FROM crove_sign.signing_token t
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.token_sha256 = v_token_hash
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.revoked_at IS NOT NULL OR v_existing.used_at IS NOT NULL OR v_existing.expires_at <= p_now THEN
      RETURN NULL;
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'tokenId', v_existing.id,
      'token', v_raw_token,
      'signerName', v_signer.name,
      'message', v_env.message,
      'expiresAt', pg_catalog.to_char(v_existing.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'minted', false
    );
  END IF;

  UPDATE crove_sign.signing_token t
  SET revoked_at = p_now,
      revoked_by = v_env.created_by
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = p_now
  WHERE o.org_id = v_org
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  v_final_exp := CASE
    WHEN v_env.expires_at IS NOT NULL AND v_env.expires_at > p_now THEN v_env.expires_at
    ELSE p_expires_at
  END;

  INSERT INTO crove_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, created_by)
  VALUES (v_org, v_env.id, v_signer.id, v_token_hash, v_final_exp, v_env.created_by)
  RETURNING id INTO v_token_id;

  RETURN pg_catalog.jsonb_build_object(
    'tokenId', v_token_id,
    'token', v_raw_token,
    'signerName', v_signer.name,
    'message', v_env.message,
    'expiresAt', pg_catalog.to_char(v_final_exp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'minted', true
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_mail_token_issue(uuid, uuid, uuid, timestamptz, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_mail_token_issue(uuid, uuid, uuid, timestamptz, timestamptz) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 4. Worker due-org lookup for 24h pre-expiry reminder sweep (ADR-0053 'work')
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.pre_expiry_remind_due_orgs(
  p_limit integer DEFAULT 100,
  p_now timestamptz DEFAULT NULL
)
RETURNS TABLE(org_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_now timestamptz := COALESCE(p_now, pg_catalog.now());
  v_until timestamptz := v_now + pg_catalog.make_interval(hours => 24);
  v_active_view_cutoff timestamptz := v_now - pg_catalog.make_interval(mins => 15);
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_SWEEP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT DISTINCT e.org_id
  FROM crove_sign.envelope e
  JOIN crove_kernel.tenant t ON t.org_id = e.org_id
  WHERE t.status = 'active'
    AND crove_kernel.org_app_on(e.org_id, 'sign')
    AND e.status IN ('sent', 'in_progress')
    AND e.auto_remind_before_expiry = true
    AND e.expires_at IS NOT NULL
    AND e.expires_at > v_now
    AND e.expires_at <= v_until
    AND EXISTS (
      SELECT 1
      FROM crove_sign.signer s
      WHERE s.org_id = e.org_id
        AND s.envelope_id = e.id
        AND s.signer_role <> 'cc'
        AND s.delivery_mode = 'email'
        AND s.email IS NOT NULL
        AND s.status IN ('pending', 'viewed')
        AND (s.viewed_at IS NULL OR s.viewed_at <= v_active_view_cutoff)
        AND s.pre_expiry_reminded_at IS NULL
        AND (
          e.routing_mode <> 'sequential'
          OR NOT EXISTS (
            SELECT 1
            FROM crove_sign.signer earlier
            WHERE earlier.org_id = e.org_id
              AND earlier.envelope_id = e.id
              AND earlier.signer_role <> 'cc'
              AND earlier.status IN ('waiting', 'pending', 'viewed')
              AND earlier.routing_order < s.routing_order
          )
        )
        AND (
          s.otp_verified_at IS NOT NULL
          OR (
            e.direct_link_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM crove_sign.signing_event ge
              WHERE ge.org_id = e.org_id
                AND ge.envelope_id = e.id
                AND ge.seq = 1
                AND ge.actor_label = 'system:sign-direct-link'
            )
          )
        )
    )
  ORDER BY e.org_id ASC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_sign.pre_expiry_remind_due_orgs(integer, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.pre_expiry_remind_due_orgs(integer, timestamptz) TO crove_worker;
