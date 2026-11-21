-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 4f (#3822, docs/plan/esign.md, owner instruction 2026-11-19):
-- sender-approved counterparty reference summary (share_summary_with_signers, shared_summary_json)
-- on crove_sign.envelope and crove_sign.template, exposed on /-/sign and /-/sign/d strictly in the
-- 'ready' state (never before OTP verification, never auto-published by an AI agent without human review).

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Schema additions on crove_sign.envelope and crove_sign.template
-- ---------------------------------------------------------------------------

ALTER TABLE crove_sign.envelope
  ADD COLUMN IF NOT EXISTS share_summary_with_signers boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shared_summary_json jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'crove_sign'
      AND r.relname = 'envelope'
      AND c.conname = 'envelope_shared_summary_shape_chk'
  ) THEN
    ALTER TABLE crove_sign.envelope
      ADD CONSTRAINT envelope_shared_summary_shape_chk CHECK (
        (NOT share_summary_with_signers OR shared_summary_json IS NOT NULL)
        AND (
          shared_summary_json IS NULL
          OR (
            pg_catalog.jsonb_typeof(shared_summary_json) = 'object'
            AND pg_catalog.pg_column_size(shared_summary_json) <= 65536
          )
        )
      );
  END IF;
END $$;

ALTER TABLE crove_sign.template
  ADD COLUMN IF NOT EXISTS share_summary_with_signers boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shared_summary_json jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'crove_sign'
      AND r.relname = 'template'
      AND c.conname = 'template_shared_summary_shape_chk'
  ) THEN
    ALTER TABLE crove_sign.template
      ADD CONSTRAINT template_shared_summary_shape_chk CHECK (
        (NOT share_summary_with_signers OR shared_summary_json IS NOT NULL)
        AND (
          shared_summary_json IS NULL
          OR (
            pg_catalog.jsonb_typeof(shared_summary_json) = 'object'
            AND pg_catalog.pg_column_size(shared_summary_json) <= 65536
          )
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Update crove_sign.envelope_guard() and crove_sign.template_guard()
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
    IF NEW.share_summary_with_signers IS TRUE OR NEW.shared_summary_json IS NOT NULL THEN
      IF v_actor <> 'user'
         OR crove_kernel.ctx_agent_id() IS NOT NULL
         OR crove_kernel.ctx_user_id() IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = NEW.org_id
             AND m.user_id = crove_kernel.ctx_user_id()
             AND m.role IN ('owner', 'admin', 'member')
             AND (m.role IN ('owner', 'admin') OR m.user_id = NEW.created_by)
         ) THEN
        RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'counterparty summary requires human review by the envelope creator, owner, or admin';
      END IF;
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
  IF (NEW.share_summary_with_signers, NEW.shared_summary_json)
     IS DISTINCT FROM (OLD.share_summary_with_signers, OLD.shared_summary_json) THEN
    IF v_actor <> 'user'
       OR crove_kernel.ctx_agent_id() IS NOT NULL
       OR crove_kernel.ctx_user_id() IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = NEW.org_id
           AND m.user_id = crove_kernel.ctx_user_id()
           AND m.role IN ('owner', 'admin', 'member')
           AND (m.role IN ('owner', 'admin') OR m.user_id = OLD.created_by)
       ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'only the envelope creator, owner, or admin can update the counterparty summary';
    END IF;
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
  IF OLD.status IN ('sent', 'in_progress') AND NEW.status = OLD.status THEN
    IF (pg_catalog.to_jsonb(OLD) - ARRAY['share_summary_with_signers', 'shared_summary_json', 'version', 'updated_at'])
       IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['share_summary_with_signers', 'shared_summary_json', 'version', 'updated_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'envelope is frozen after leaving draft';
END $$;

REVOKE ALL ON FUNCTION crove_sign.envelope_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_old jsonb;
  v_new jsonb;
  v_keep text[] := ARRAY['version', 'updated_at'];
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.inspect_status = 'passed' AND NEW.page_count IS NULL THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'passed template inspection requires page_count';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'active' THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_ACTIVE' USING ERRCODE = '42501', DETAIL = 'active template must be archived instead of deleted';
    END IF;
    IF OLD.status = 'archived' THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVED' USING ERRCODE = '42501', DETAIL = 'archived template cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.inspect_status = 'failed' OR NEW.inspect_error IS NOT NULL THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'template inspection errors are system-managed';
    END IF;
    IF NEW.inspect_status = 'passed'
       OR NEW.page_count IS NOT NULL
       OR NEW.page_dimensions_json IS NOT NULL
       OR NEW.detected_tags_json IS NOT NULL THEN
      IF NEW.inspect_status <> 'passed'
         OR NEW.page_count IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM crove_kernel.file f
           WHERE f.org_id = NEW.org_id
             AND f.id = NEW.source_file_id
             AND f.storage_key = NEW.source_storage_key
             AND f.generation IS NOT DISTINCT FROM NEW.source_generation
             AND f.sha256 = NEW.source_sha256
             AND f.content_type = 'application/pdf'
         )
         OR NOT (
           EXISTS (
             SELECT 1 FROM crove_sign.envelope e
             WHERE e.org_id = NEW.org_id
               AND e.inspect_status = 'passed'
               AND e.page_count IS NOT NULL
               AND e.page_count IS NOT DISTINCT FROM NEW.page_count
               AND e.page_dimensions_json IS NOT DISTINCT FROM NEW.page_dimensions_json
               AND e.detected_tags_json IS NOT DISTINCT FROM NEW.detected_tags_json
               AND e.source_file_id = NEW.source_file_id
               AND e.source_storage_key = NEW.source_storage_key
               AND e.source_generation = NEW.source_generation
               AND e.source_sha256 = NEW.source_sha256
           )
           OR EXISTS (
             SELECT 1 FROM crove_sign.template t
             WHERE t.org_id = NEW.org_id
               AND t.inspect_status = 'passed'
               AND t.page_count IS NOT NULL
               AND t.page_count IS NOT DISTINCT FROM NEW.page_count
               AND t.page_dimensions_json IS NOT DISTINCT FROM NEW.page_dimensions_json
               AND t.detected_tags_json IS NOT DISTINCT FROM NEW.detected_tags_json
               AND t.source_file_id = NEW.source_file_id
               AND t.source_storage_key = NEW.source_storage_key
               AND t.source_generation = NEW.source_generation
               AND t.source_sha256 = NEW.source_sha256
           )
         ) THEN
        RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'template inspection metadata must match an inspected same-org source document';
      END IF;
    END IF;
    IF NEW.share_summary_with_signers IS TRUE OR NEW.shared_summary_json IS NOT NULL THEN
      IF v_actor <> 'user'
         OR crove_kernel.ctx_agent_id() IS NOT NULL
         OR crove_kernel.ctx_user_id() IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = NEW.org_id
             AND m.user_id = crove_kernel.ctx_user_id()
             AND m.role IN ('owner', 'admin', 'member')
             AND (m.role IN ('owner', 'admin') OR m.user_id = NEW.created_by)
         ) THEN
        RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'counterparty summary requires human review by the template creator, owner, or admin';
      END IF;
    END IF;
    IF NEW.status = 'active' AND (NEW.inspect_status <> 'passed' OR NEW.page_count IS NULL) THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'source PDF must pass inspection before template becomes active';
    END IF;
    IF NEW.status = 'archived' AND NEW.archived_at IS NULL THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVE_INVALID' USING ERRCODE = '42501', DETAIL = 'archived template requires archived_at timestamp';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE by tenant user
  v_old := pg_catalog.to_jsonb(OLD) - v_keep;
  v_new := pg_catalog.to_jsonb(NEW) - v_keep;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.source_file_id, NEW.source_storage_key, NEW.source_generation, NEW.source_sha256, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.source_file_id, OLD.source_storage_key, OLD.source_generation, OLD.source_sha256, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'template identity and source document columns are immutable';
  END IF;
  IF (NEW.inspect_status, NEW.inspect_error, NEW.page_count, NEW.page_dimensions_json, NEW.detected_tags_json)
     IS DISTINCT FROM (OLD.inspect_status, OLD.inspect_error, OLD.page_count, OLD.page_dimensions_json, OLD.detected_tags_json) THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'template inspection metadata is system-managed';
  END IF;
  IF OLD.status = 'archived' THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVED' USING ERRCODE = '42501', DETAIL = 'archived template cannot be modified';
  END IF;
  IF (NEW.share_summary_with_signers, NEW.shared_summary_json)
     IS DISTINCT FROM (OLD.share_summary_with_signers, OLD.shared_summary_json) THEN
    IF v_actor <> 'user'
       OR crove_kernel.ctx_agent_id() IS NOT NULL
       OR crove_kernel.ctx_user_id() IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = NEW.org_id
           AND m.user_id = crove_kernel.ctx_user_id()
           AND m.role IN ('owner', 'admin', 'member')
           AND (m.role IN ('owner', 'admin') OR m.user_id = OLD.created_by)
       ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'only the template creator, owner, or admin can update the counterparty summary';
    END IF;
  END IF;
  IF NEW.status = 'active' AND (OLD.inspect_status <> 'passed' OR OLD.page_count IS NULL) THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'source PDF must pass inspection before template becomes active';
  END IF;
  IF NEW.status NOT IN ('draft', 'archived') AND NEW.inspect_status = 'passed' AND NEW.page_count IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'passed template inspection requires page_count';
  END IF;
  IF NEW.status = 'archived' AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVE_INVALID' USING ERRCODE = '42501', DETAIL = 'archived template requires archived_at timestamp';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 3. Public signing view & direct-link resolvers (ready-state sharedSummary)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.public_record_view(
  p_token_sha256 text,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_tenant record;
  v_otp_verified boolean := false;
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
  v_fields jsonb := '[]'::jsonb;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM crove_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token (public_append_event also holds envelope FOR UPDATE).
  SELECT e.*
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
    AND s.id = v_lookup.signer_id
  FOR UPDATE;

  SELECT tok.*
  INTO v_tok
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.name, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.used_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  UPDATE crove_sign.signing_token
  SET last_viewed_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id;

  IF v_signer.status = 'pending' THEN
    v_ip_hash := crove_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
    v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
    v_actor_label := pg_catalog.left(v_actor_label, 254);

    UPDATE crove_sign.signer
    SET status = 'viewed',
        viewed_at = COALESCE(v_signer.viewed_at, v_now),
        signer_ip_hash = COALESCE(v_ip_hash, v_signer.signer_ip_hash),
        signer_user_agent = COALESCE(v_ua, v_signer.signer_user_agent),
        updated_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_signer.id;

    PERFORM crove_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'signer_viewed',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object('routingOrder', v_signer.routing_order),
      v_ip_hash,
      v_ua,
      v_now
    );
  END IF;

  v_otp_verified := crove_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF v_signer.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'state', 'otp_required',
      'orgName', v_tenant.name,
      'title', v_env.title,
      'maskedEmail', crove_sign.mask_email(v_signer.email)
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', f.id,
        'fieldType', f.field_type,
        'pageNumber', f.page_number,
        'xNorm', f.x_norm::text,
        'yNorm', f.y_norm::text,
        'wNorm', f.w_norm::text,
        'hNorm', f.h_norm::text,
        'label', f.label,
        'required', f.required,
        'fontSizePt', f.font_size_pt
      )
      ORDER BY f.page_number, f.y_norm, f.x_norm, f.id
    ),
    '[]'::jsonb
  )
  INTO v_fields
  FROM crove_sign.field f
  WHERE f.org_id = v_lookup.org_id
    AND f.envelope_id = v_env.id
    AND f.signer_id = v_signer.id;

  RETURN pg_catalog.jsonb_build_object(
    'state', 'ready',
    'orgName', v_tenant.name,
    'title', v_env.title,
    'message', v_env.message,
    'signerName', v_signer.name,
    'roleLabel', v_signer.role_label,
    'signerRole', CASE WHEN v_signer.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
    'expiresAt', pg_catalog.to_char(v_tok.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'pageCount', COALESCE(v_env.page_count, 1),
    'pageDimensions', COALESCE(v_env.page_dimensions_json, '[]'::jsonb),
    'requireEmailOtp', v_signer.require_email_otp,
    'otpVerified', v_otp_verified,
    'fields', v_fields,
    'sharedSummary', CASE
      WHEN v_env.share_summary_with_signers AND v_env.shared_summary_json IS NOT NULL THEN v_env.shared_summary_json
      ELSE NULL
    END
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_record_view(text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_record_view(text, text, text) TO crove_app;

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
    tpl.share_summary_with_signers,
    tpl.shared_summary_json,
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
    'fieldCount', v_field_count,
    'sharedSummary', CASE
      WHEN v_row.share_summary_with_signers AND v_row.shared_summary_json IS NOT NULL THEN v_row.shared_summary_json
      ELSE NULL
    END
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_direct_resolve(text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_direct_resolve(text, text) TO crove_app;

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
    share_summary_with_signers, shared_summary_json,
    expires_at, sent_at, version, created_by, created_at, updated_at
  )
  VALUES (
    v_lookup.org_id, v_tpl.title, v_tpl.subject, v_tpl.message, 'sent', v_tpl.routing_mode,
    'standalone', NULL, v_link.id, v_tpl.source_file_id, v_tpl.source_storage_key, v_tpl.source_generation, v_tpl.source_sha256,
    'passed', v_tpl.page_count, v_tpl.page_dimensions_json, v_tpl.detected_tags_json,
    v_tpl.share_summary_with_signers, v_tpl.shared_summary_json,
    v_env_expires_at, v_now, 2, v_link.created_by, v_now, v_now
  )
  RETURNING id INTO v_env_id;

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
