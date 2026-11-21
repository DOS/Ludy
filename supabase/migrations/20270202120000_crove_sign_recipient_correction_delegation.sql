-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy eSign Slice 4c (#3819, docs/plan/esign.md):
--   1. Add allow_delegation boolean NOT NULL DEFAULT false on crove_sign.envelope and crove_sign.template.
--   2. Add delegated_from_name, delegated_from_email, delegation_reason, and delegation_count (0..2) on crove_sign.signer.
--   3. Add controlled tenant definer crove_sign.correct_signer_recipient(...) for in-flight recipient correction on
--      sent/in_progress envelopes by envelope creator, owner, or admin without voiding completed signers, atomically
--      revoking prior tokens and open OTPs.
--   4. Update crove_sign.envelope_guard(), crove_sign.signer_guard(), and crove_sign.personal_erase_unsealed_signers(...).
--   5. Update crove_sign.public_token_resolve(...) and crove_sign.public_record_view(...) with delegation state, and add
--      orgless definer crove_sign.public_delegate(...) enforcing org_app_on('sign'), OTP gate, allow_delegation = true,
--      delegation_count < 2 anti-relay cap, single-mailbox RFC validation, mail_suppression check, atomic token consume,
--      hash-chained signer_delegated audit event, delegate invitation queueing, and sender notification queueing.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Schema additions on envelope, template, and signer
-- ---------------------------------------------------------------------------
ALTER TABLE crove_sign.envelope
  ADD COLUMN IF NOT EXISTS allow_delegation boolean NOT NULL DEFAULT false;

ALTER TABLE crove_sign.template
  ADD COLUMN IF NOT EXISTS allow_delegation boolean NOT NULL DEFAULT false;

ALTER TABLE crove_sign.signer
  ADD COLUMN IF NOT EXISTS delegated_from_name text,
  ADD COLUMN IF NOT EXISTS delegated_from_email text,
  ADD COLUMN IF NOT EXISTS delegation_reason text,
  ADD COLUMN IF NOT EXISTS delegation_count integer NOT NULL DEFAULT 0;

ALTER TABLE crove_sign.signer
  DROP CONSTRAINT IF EXISTS signer_delegated_from_name_check;
ALTER TABLE crove_sign.signer
  ADD CONSTRAINT signer_delegated_from_name_check
  CHECK (delegated_from_name IS NULL OR pg_catalog.length(pg_catalog.btrim(delegated_from_name)) BETWEEN 1 AND 200);

ALTER TABLE crove_sign.signer
  DROP CONSTRAINT IF EXISTS signer_delegated_from_email_check;
ALTER TABLE crove_sign.signer
  ADD CONSTRAINT signer_delegated_from_email_check
  CHECK (
    delegated_from_email IS NULL
    OR (pg_catalog.length(delegated_from_email) BETWEEN 3 AND 254 AND pg_catalog.strpos(delegated_from_email, '@') > 1)
  );

ALTER TABLE crove_sign.signer
  DROP CONSTRAINT IF EXISTS signer_delegation_reason_check;
ALTER TABLE crove_sign.signer
  ADD CONSTRAINT signer_delegation_reason_check
  CHECK (delegation_reason IS NULL OR pg_catalog.length(delegation_reason) <= 1000);

ALTER TABLE crove_sign.signer
  DROP CONSTRAINT IF EXISTS signer_delegation_count_check;
ALTER TABLE crove_sign.signer
  ADD CONSTRAINT signer_delegation_count_check
  CHECK (delegation_count >= 0 AND delegation_count <= 2);

-- ---------------------------------------------------------------------------
-- 2. Controlled in-flight recipient correction definer (created before guards reference its owner)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.correct_signer_recipient(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_delivery_mode text,
  p_require_email_otp boolean,
  p_now timestamptz DEFAULT pg_catalog.now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_agent uuid := crove_kernel.ctx_agent_id();
  v_now timestamptz := COALESCE(p_now, pg_catalog.now());
  v_role text;
  v_env record;
  v_signer record;
  v_name text := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_email text := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, ''))), '');
  v_phone text := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_phone, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_delivery_mode text := pg_catalog.btrim(COALESCE(p_delivery_mode, ''));
  v_require_otp boolean := false;
  v_next_status text;
  v_next_version integer;
  v_revoked_tokens integer := 0;
  v_invalidated_otps integer := 0;
  v_to_hash text;
  v_suppressed boolean := false;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR v_agent IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'MODULE_OFF' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  WHERE m.org_id = v_org
    AND m.user_id = v_user;

  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_envelope_id IS NULL OR p_signer_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token -> signing_otp.
  SELECT e.*
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org
    AND e.id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  -- Enforce strict HR contract confidentiality (404 parity for non-privileged non-creators).
  IF v_env.source_kind = 'hr_contract'
     AND v_role NOT IN ('owner', 'admin')
     AND v_env.created_by IS DISTINCT FROM v_user THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  IF v_role NOT IN ('owner', 'admin') AND v_env.created_by IS DISTINCT FROM v_user THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_FORBIDDEN',
      'httpStatus', 403,
      'message', 'Only the envelope creator, owner, or admin can correct a recipient'
    );
  END IF;

  IF v_env.status NOT IN ('sent', 'in_progress') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_ENVELOPE_NOT_ACTIVE',
      'httpStatus', 409,
      'message', 'Recipients can only be corrected while the envelope is sent or in progress'
    );
  END IF;

  IF v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_ENVELOPE_EXPIRED',
      'httpStatus', 409,
      'message', 'Envelope has expired'
    );
  END IF;

  SELECT s.*
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = p_signer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'signer');
  END IF;

  v_require_otp := COALESCE(p_require_email_otp, v_signer.require_email_otp);

  IF v_signer.status NOT IN ('waiting', 'pending', 'viewed') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_SIGNER_ALREADY_COMPLETED',
      'httpStatus', 409,
      'message', 'Cannot correct a recipient who has already signed or declined'
    );
  END IF;

  IF v_name IS NULL OR pg_catalog.length(v_name) > 200 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Recipient name must be between 1 and 200 characters'
    );
  END IF;

  IF v_delivery_mode NOT IN ('link', 'email') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid delivery mode'
    );
  END IF;

  IF v_signer.signer_role = 'cc' AND v_require_otp THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_INVALID_SIGNER',
      'httpStatus', 422,
      'message', 'CC recipients cannot require email OTP'
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

  IF (v_delivery_mode = 'email' OR v_require_otp) AND v_email IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_REQUIRED',
      'httpStatus', 422,
      'message', 'Email address is required for email delivery or email OTP'
    );
  END IF;

  IF (v_delivery_mode = 'email' OR v_require_otp) AND v_email IS NOT NULL THEN
    v_to_hash := crove_kernel.mail_address_hash(v_email);
    IF v_to_hash IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_EMAIL_SUPPRESSED',
        'httpStatus', 422,
        'message', 'Recipient email address cannot receive invitations'
      );
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM crove_kernel.mail_suppression ms
      WHERE ms.org_id = v_org
        AND ms.to_hash = v_to_hash
        AND ms.scope = 'all'
        AND ms.lifted_at IS NULL
    )
    INTO v_suppressed;
    IF v_suppressed THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_EMAIL_SUPPRESSED',
        'httpStatus', 422,
        'message', 'Recipient email address is suppressed'
      );
    END IF;
  END IF;

  IF v_phone IS NOT NULL AND (pg_catalog.length(v_phone) < 6 OR pg_catalog.length(v_phone) > 32) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Phone number must be between 6 and 32 characters'
    );
  END IF;

  PERFORM 1
  FROM crove_sign.signing_token t
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL
  ORDER BY t.id
  FOR UPDATE;

  PERFORM 1
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_org
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL
  ORDER BY o.id
  FOR UPDATE;

  UPDATE crove_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = v_user
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;
  GET DIAGNOSTICS v_revoked_tokens = ROW_COUNT;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL;
  GET DIAGNOSTICS v_invalidated_otps = ROW_COUNT;

  v_next_status := CASE WHEN v_signer.status = 'viewed' THEN 'pending' ELSE v_signer.status END;
  v_next_version := v_env.version + 1;

  PERFORM pg_catalog.set_config('crove.sign_correct_signer', v_signer.id::text, true);
  PERFORM pg_catalog.set_config('crove.sign_correct_envelope', v_env.id::text, true);

  UPDATE crove_sign.signer s
  SET name = v_name,
      email = v_email,
      phone = v_phone,
      delivery_mode = v_delivery_mode,
      require_email_otp = v_require_otp,
      status = v_next_status,
      viewed_at = NULL,
      otp_verified_at = NULL,
      token_last_reminded_at = NULL,
      updated_at = v_now
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = v_signer.id;

  UPDATE crove_sign.envelope e
  SET version = v_next_version,
      updated_at = v_now
  WHERE e.org_id = v_org
    AND e.id = v_env.id;

  PERFORM pg_catalog.set_config('crove.sign_correct_signer', '', true);
  PERFORM pg_catalog.set_config('crove.sign_correct_envelope', '', true);

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'envelopeId', v_env.id,
    'envelopeTitle', v_env.title,
    'envelopeExpiresAt', CASE WHEN v_env.expires_at IS NOT NULL
      THEN pg_catalog.to_char(v_env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE NULL END,
    'sourceSha256', v_env.source_sha256,
    'version', v_next_version,
    'signerId', v_signer.id,
    'signerRole', v_signer.signer_role,
    'roleLabel', v_signer.role_label,
    'signerStatus', v_next_status,
    'name', v_name,
    'email', v_email,
    'phone', v_phone,
    'deliveryMode', v_delivery_mode,
    'requireEmailOtp', v_require_otp,
    'previousName', v_signer.name,
    'previousEmail', v_signer.email,
    'previousPhone', v_signer.phone,
    'previousDeliveryMode', v_signer.delivery_mode,
    'previousRequireEmailOtp', v_signer.require_email_otp,
    'revokedTokens', v_revoked_tokens,
    'invalidatedOtps', v_invalidated_otps
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.correct_signer_recipient(uuid, uuid, text, text, text, text, boolean, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.correct_signer_recipient(uuid, uuid, text, text, text, text, boolean, timestamptz)
  TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 3. Restated envelope_guard() and signer_guard() preserving all origin/main checks
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
  v_correct_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_sign.correct_signer_recipient(uuid,uuid,text,text,text,text,boolean,timestamptz)'::pg_catalog.regprocedure);
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

CREATE OR REPLACE FUNCTION crove_sign.signer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
  v_env_sealed_file_id uuid;
  v_erase_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_sign.personal_erase_unsealed_signers(text,text)'::pg_catalog.regprocedure);
  v_correct_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_sign.correct_signer_recipient(uuid,uuid,text,text,text,text,boolean,timestamptz)'::pg_catalog.regprocedure);
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
       OR NEW.consent_accepted_at IS NOT NULL
       OR NEW.delegated_from_name IS NOT NULL OR NEW.delegated_from_email IS NOT NULL
       OR NEW.delegation_reason IS NOT NULL OR NEW.delegation_count <> 0 THEN
      RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'signing evidence and delegation provenance columns are system-managed';
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
  -- Controlled PDPL unsealed delegation-column erasure by owner via personal_erase_unsealed_signers.
  IF v_env_status IN ('draft', 'voided', 'expired', 'declined')
     AND v_env_sealed_file_id IS NULL
     AND v_erase_owner IS NOT NULL
     AND v_cur_role = v_erase_owner
     AND pg_catalog.current_setting('crove.sign_personal_erase', true) = OLD.org_id::text
     AND v_actor = 'user'
     AND crove_kernel.ctx_agent_id() IS NULL
     AND crove_kernel.ctx_org_id() = OLD.org_id
     AND EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = OLD.org_id AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
     )
     AND NEW.delegated_from_name IS NULL
     AND NEW.delegated_from_email IS NULL
     AND NEW.delegation_reason IS NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['delegated_from_name', 'delegated_from_email', 'delegation_reason', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['delegated_from_name', 'delegated_from_email', 'delegation_reason', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  -- Controlled in-flight recipient correction via crove_sign.correct_signer_recipient on unsigned signers of active envelopes.
  IF v_env_status IN ('sent', 'in_progress')
     AND v_correct_owner IS NOT NULL
     AND v_cur_role = v_correct_owner
     AND pg_catalog.current_setting('crove.sign_correct_signer', true) = OLD.id::text
     AND v_actor = 'user'
     AND crove_kernel.ctx_agent_id() IS NULL
     AND crove_kernel.ctx_org_id() = OLD.org_id
     AND OLD.status IN ('waiting', 'pending', 'viewed')
     AND NEW.status = (CASE WHEN OLD.status = 'viewed' THEN 'pending' ELSE OLD.status END)
     AND NEW.viewed_at IS NULL
     AND NEW.otp_verified_at IS NULL
     AND NEW.token_last_reminded_at IS NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['name', 'email', 'phone', 'delivery_mode', 'require_email_otp', 'status', 'viewed_at', 'otp_verified_at', 'token_last_reminded_at', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['name', 'email', 'phone', 'delivery_mode', 'require_email_otp', 'status', 'viewed_at', 'otp_verified_at', 'token_last_reminded_at', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF (NEW.pre_expiry_reminded_at, NEW.viewed_at, NEW.signed_at, NEW.declined_at, NEW.decline_reason, NEW.otp_verified_at,
      NEW.signature_kind, NEW.signature_typed_text, NEW.signer_user_agent, NEW.signer_ip_hash, NEW.consent_accepted_at,
      NEW.delegated_from_name, NEW.delegated_from_email, NEW.delegation_reason, NEW.delegation_count)
     IS DISTINCT FROM (OLD.pre_expiry_reminded_at, OLD.viewed_at, OLD.signed_at, OLD.declined_at, OLD.decline_reason, OLD.otp_verified_at,
      OLD.signature_kind, OLD.signature_typed_text, OLD.signer_user_agent, OLD.signer_ip_hash, OLD.consent_accepted_at,
      OLD.delegated_from_name, OLD.delegated_from_email, OLD.delegation_reason, OLD.delegation_count) THEN
    RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'signing evidence and delegation provenance columns are system-managed';
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
-- 4. PDPL erasure update covering delegated_from_name / delegated_from_email / delegation_reason
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.personal_erase_unsealed_signers(
  p_kind text,
  p_value text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_email text;
  v_digits text;
  v_local_phone text;
  v_intl_phone text;
  v_env_ids uuid[];
  v_signer_ids uuid[];
  v_delegator_only_ids uuid[];
  v_touched_env_ids uuid[];
  v_delegator_env_ids uuid[];
  v_otps integer := 0;
  v_signers integer := 0;
  v_emails integer := 0;
  v_phones integer := 0;
  v_typed integer := 0;
  v_uas integer := 0;
  v_field_sigs integer := 0;
  v_del_names integer := 0;
  v_del_emails integer := 0;
  v_del_reasons integer := 0;
  v_del_only_names integer := 0;
  v_del_only_emails integer := 0;
  v_del_only_reasons integer := 0;
BEGIN
  IF v_org IS NULL
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_agent_id() IS NOT NULL
     OR crove_kernel.ctx_user_id() IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
     ) THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'email' THEN
    v_email := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_value, '')));
    IF v_email = '' THEN
      RETURN pg_catalog.jsonb_build_object(
        'signers', 0, 'emails', 0, 'phones', 0,
        'typedSignatures', 0, 'userAgents', 0, 'fieldSignatures', 0, 'otps', 0,
        'delegatedNames', 0, 'delegatedEmails', 0, 'delegationReasons', 0
      );
    END IF;
  ELSIF p_kind = 'digits' THEN
    v_digits := pg_catalog.regexp_replace(COALESCE(p_value, ''), '[^0-9]', '', 'g');
    IF v_digits !~ '^[0-9]{8,20}$' THEN
      RAISE EXCEPTION 'SIGN_INVALID_ERASE_PROBE' USING ERRCODE = '22023';
    END IF;
    v_local_phone := CASE WHEN v_digits LIKE '84%' THEN '0' || pg_catalog.substr(v_digits, 3) ELSE v_digits END;
    v_intl_phone := CASE WHEN v_local_phone LIKE '0%' THEN '84' || pg_catalog.substr(v_local_phone, 2) ELSE v_local_phone END;
  ELSE
    RAISE EXCEPTION 'SIGN_INVALID_ERASE_PROBE' USING ERRCODE = '22023';
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token -> field -> signing_otp.
  v_env_ids := ARRAY(
    SELECT e.id
    FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.status IN ('draft', 'voided', 'expired', 'declined')
      AND e.sealed_file_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM crove_sign.signer s
        WHERE s.org_id = e.org_id
          AND s.envelope_id = e.id
          AND (
            (p_kind = 'email' AND (
              (s.email IS NOT NULL AND pg_catalog.lower(s.email) = v_email)
              OR (s.delegated_from_email IS NOT NULL AND pg_catalog.lower(s.delegated_from_email) = v_email)
            ))
            OR (p_kind = 'digits' AND s.phone IS NOT NULL AND pg_catalog.regexp_replace(s.phone, '[^0-9]', '', 'g') IN (v_local_phone, v_intl_phone))
          )
      )
    ORDER BY e.id
    FOR UPDATE OF e
  );

  IF COALESCE(pg_catalog.array_length(v_env_ids, 1), 0) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'signers', 0, 'emails', 0, 'phones', 0,
      'typedSignatures', 0, 'userAgents', 0, 'fieldSignatures', 0, 'otps', 0,
      'delegatedNames', 0, 'delegatedEmails', 0, 'delegationReasons', 0
    );
  END IF;

  PERFORM 1
  FROM crove_sign.signer s
  WHERE s.org_id = v_org
    AND s.envelope_id = ANY (v_env_ids)
  ORDER BY s.id
  FOR UPDATE OF s;

  v_signer_ids := ARRAY(
    SELECT s.id
    FROM crove_sign.signer s
    WHERE s.org_id = v_org
      AND s.envelope_id = ANY (v_env_ids)
      AND (
        (p_kind = 'email' AND s.email IS NOT NULL AND pg_catalog.lower(s.email) = v_email)
        OR (p_kind = 'digits' AND s.phone IS NOT NULL AND pg_catalog.regexp_replace(s.phone, '[^0-9]', '', 'g') IN (v_local_phone, v_intl_phone))
      )
    ORDER BY s.id
  );

  v_delegator_only_ids := ARRAY(
    SELECT s.id
    FROM crove_sign.signer s
    WHERE s.org_id = v_org
      AND s.envelope_id = ANY (v_env_ids)
      AND p_kind = 'email'
      AND s.delegated_from_email IS NOT NULL
      AND pg_catalog.lower(s.delegated_from_email) = v_email
      AND NOT (s.id = ANY (COALESCE(v_signer_ids, '{}'::uuid[])))
    ORDER BY s.id
  );

  PERFORM pg_catalog.set_config('crove.sign_personal_erase', v_org::text, true);

  IF COALESCE(pg_catalog.array_length(v_signer_ids, 1), 0) > 0 THEN
    PERFORM 1 FROM crove_sign.signing_token t WHERE t.org_id = v_org AND t.signer_id = ANY (v_signer_ids) ORDER BY t.id FOR UPDATE;
    PERFORM 1 FROM crove_sign.field f WHERE f.org_id = v_org AND f.signer_id = ANY (v_signer_ids) ORDER BY f.id FOR UPDATE;
    PERFORM 1 FROM crove_sign.signing_otp o WHERE o.org_id = v_org AND o.signer_id = ANY (v_signer_ids) ORDER BY o.id FOR UPDATE;

    DELETE FROM crove_sign.signing_otp o
    WHERE o.org_id = v_org
      AND o.signer_id = ANY (v_signer_ids);
    GET DIAGNOSTICS v_otps = ROW_COUNT;

    DELETE FROM crove_sign.signing_token t
    WHERE t.org_id = v_org
      AND t.signer_id = ANY (v_signer_ids);

    WITH removed_fields AS (
      DELETE FROM crove_sign.field f
      WHERE f.org_id = v_org
        AND f.signer_id = ANY (v_signer_ids)
      RETURNING (f.signature_png_base64 IS NOT NULL) AS has_sig
    )
    SELECT COALESCE(pg_catalog.count(*) FILTER (WHERE has_sig), 0)::integer
    INTO v_field_sigs
    FROM removed_fields;

    WITH removed_signers AS (
      DELETE FROM crove_sign.signer s
      WHERE s.org_id = v_org
        AND s.id = ANY (v_signer_ids)
      RETURNING
        s.envelope_id,
        (s.email IS NOT NULL) AS has_email,
        (s.phone IS NOT NULL) AS has_phone,
        (s.signature_typed_text IS NOT NULL) AS has_typed,
        (s.signer_user_agent IS NOT NULL) AS has_ua,
        (s.delegated_from_name IS NOT NULL) AS has_del_name,
        (s.delegated_from_email IS NOT NULL) AS has_del_email,
        (s.delegation_reason IS NOT NULL) AS has_del_reason
    )
    SELECT
      pg_catalog.count(*)::integer,
      COALESCE(pg_catalog.count(*) FILTER (WHERE has_email), 0)::integer,
      COALESCE(pg_catalog.count(*) FILTER (WHERE has_phone), 0)::integer,
      COALESCE(pg_catalog.count(*) FILTER (WHERE has_typed), 0)::integer,
      COALESCE(pg_catalog.count(*) FILTER (WHERE has_ua), 0)::integer,
      COALESCE(pg_catalog.count(*) FILTER (WHERE has_del_name), 0)::integer,
      COALESCE(pg_catalog.count(*) FILTER (WHERE has_del_email), 0)::integer,
      COALESCE(pg_catalog.count(*) FILTER (WHERE has_del_reason), 0)::integer,
      ARRAY(SELECT DISTINCT r.envelope_id FROM removed_signers r ORDER BY r.envelope_id)
    INTO v_signers, v_emails, v_phones, v_typed, v_uas, v_del_names, v_del_emails, v_del_reasons, v_touched_env_ids
    FROM removed_signers;
  END IF;

  IF COALESCE(pg_catalog.array_length(v_delegator_only_ids, 1), 0) > 0 THEN
    WITH scrubbed AS (
      UPDATE crove_sign.signer s
      SET delegated_from_name = NULL,
          delegated_from_email = NULL,
          delegation_reason = NULL,
          updated_at = pg_catalog.now()
      FROM crove_sign.signer prev
      WHERE prev.org_id = s.org_id
        AND prev.id = s.id
        AND s.org_id = v_org
        AND s.id = ANY (v_delegator_only_ids)
      RETURNING
        s.envelope_id,
        (prev.delegated_from_name IS NOT NULL) AS had_del_name,
        (prev.delegated_from_email IS NOT NULL) AS had_del_email,
        (prev.delegation_reason IS NOT NULL) AS had_del_reason
    )
    SELECT
      COALESCE(pg_catalog.count(*) FILTER (WHERE had_del_name), 0)::integer,
      COALESCE(pg_catalog.count(*) FILTER (WHERE had_del_email), 0)::integer,
      COALESCE(pg_catalog.count(*) FILTER (WHERE had_del_reason), 0)::integer,
      ARRAY(SELECT DISTINCT r.envelope_id FROM scrubbed r ORDER BY r.envelope_id)
    INTO v_del_only_names, v_del_only_emails, v_del_only_reasons, v_delegator_env_ids
    FROM scrubbed;
  END IF;

  PERFORM pg_catalog.set_config('crove.sign_personal_erase', '', true);

  v_touched_env_ids := ARRAY(
    SELECT DISTINCT x
    FROM pg_catalog.unnest(COALESCE(v_touched_env_ids, '{}'::uuid[]) || COALESCE(v_delegator_env_ids, '{}'::uuid[])) AS x
    ORDER BY x
  );

  IF COALESCE(pg_catalog.array_length(v_touched_env_ids, 1), 0) > 0 THEN
    UPDATE crove_sign.envelope e
    SET version = e.version + 1,
        updated_at = pg_catalog.now()
    WHERE e.org_id = v_org
      AND e.id = ANY (v_touched_env_ids)
      AND e.status IN ('draft', 'voided', 'expired', 'declined')
      AND e.sealed_file_id IS NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'signers', v_signers,
    'emails', v_emails,
    'phones', v_phones,
    'typedSignatures', v_typed,
    'userAgents', v_uas,
    'fieldSignatures', v_field_sigs,
    'otps', v_otps,
    'delegatedNames', v_del_names + v_del_only_names,
    'delegatedEmails', v_del_emails + v_del_only_emails,
    'delegationReasons', v_del_reasons + v_del_only_reasons
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.personal_erase_unsealed_signers(text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.personal_erase_unsealed_signers(text, text) TO crove_app;

-- ---------------------------------------------------------------------------
-- 5. Mail token guard, public ceremony view updates, and crove_sign.public_delegate(...)
-- ---------------------------------------------------------------------------
-- Prevent stale queued sign.invite / sign.remind messages from minting a live token to an old mailbox or revoking
-- the current recipient's active token after an in-flight recipient correction or signer delegation.
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
  v_mail record;
  v_existing record;
  v_active record;
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

  SELECT s.id, s.name, s.signer_role, s.status, s.delivery_mode, s.email
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = p_signer_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_signer.delivery_mode IS DISTINCT FROM 'email'
     OR v_signer.email IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT m.id, m.source, m.to_address, m.created_at
  INTO v_mail
  FROM crove_kernel.mail_message m
  WHERE m.org_id = v_org
    AND m.id = p_message_id;

  IF NOT FOUND
     OR v_mail.to_address IS NULL
     OR pg_catalog.lower(pg_catalog.btrim(v_mail.to_address)) <> pg_catalog.lower(pg_catalog.btrim(v_signer.email))
     OR EXISTS (
       SELECT 1
       FROM crove_kernel.mail_message m2
       WHERE m2.org_id = v_org
         AND m2.source_id = v_signer.id
         AND m2.template_key = 'sign.invite'
         AND m2.source IN ('sign.signer.correct_recipient', 'sign.public.delegate')
         AND (m2.created_at, m2.id) > (v_mail.created_at, v_mail.id)
     ) THEN
    RETURN NULL;
  END IF;

  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;

  -- Preserve #3813 non-disruptive token reuse for automatic 24h pre-expiry reminders (#4158).
  IF v_mail.source = 'sign.envelope.pre_expiry_remind_sweep' THEN
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

REVOKE ALL ON FUNCTION crove_sign.public_mail_token_issue(uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_mail_token_issue(uuid, uuid, uuid, timestamptz, timestamptz) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.public_token_resolve(
  p_token_sha256 text,
  p_allow_used boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_row record;
  v_otp_verified_at timestamptz;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT
    tok.id AS token_id,
    tok.org_id,
    tok.envelope_id,
    tok.signer_id,
    tok.expires_at AS token_expires_at,
    tok.used_at AS token_used_at,
    tok.revoked_at AS token_revoked_at,
    e.title,
    e.message,
    e.status AS envelope_status,
    e.routing_mode,
    e.allow_delegation,
    e.source_sha256,
    e.page_count,
    e.page_dimensions_json,
    e.expires_at AS envelope_expires_at,
    s.routing_order,
    s.signer_role,
    s.role_label,
    s.name AS signer_name,
    s.email AS signer_email,
    s.require_email_otp,
    s.status AS signer_status,
    s.delegation_count,
    s.delegated_from_name,
    t.name AS org_name,
    t.status AS tenant_status
  INTO v_row
  FROM crove_sign.signing_token tok
  JOIN crove_sign.envelope e
    ON e.org_id = tok.org_id
   AND e.id = tok.envelope_id
  JOIN crove_sign.signer s
    ON s.org_id = tok.org_id
   AND s.id = tok.signer_id
   AND s.envelope_id = tok.envelope_id
  JOIN crove_kernel.tenant t
    ON t.org_id = tok.org_id
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active' THEN
    RETURN NULL;
  END IF;

  IF NOT crove_kernel.org_app_on(v_row.org_id, 'sign') THEN
    RETURN NULL;
  END IF;

  IF v_row.token_revoked_at IS NOT NULL OR v_row.token_expires_at <= v_now THEN
    RETURN NULL;
  END IF;

  IF v_row.signer_role = 'cc' OR v_row.signer_status IN ('waiting', 'voided', 'expired') THEN
    RETURN NULL;
  END IF;

  IF NOT COALESCE(p_allow_used, false) THEN
    IF v_row.token_used_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    IF v_row.signer_status NOT IN ('pending', 'viewed') THEN
      RETURN NULL;
    END IF;
    IF v_row.envelope_status NOT IN ('sent', 'in_progress') THEN
      RETURN NULL;
    END IF;
    IF v_row.envelope_expires_at IS NOT NULL AND v_row.envelope_expires_at <= v_now THEN
      RETURN NULL;
    END IF;
  ELSE
    IF v_row.signer_status NOT IN ('pending', 'viewed', 'signed', 'declined') THEN
      RETURN NULL;
    END IF;
    IF v_row.envelope_status NOT IN ('sent', 'in_progress', 'completed', 'declined') THEN
      RETURN NULL;
    END IF;
    IF v_row.token_used_at IS NULL
       AND v_row.signer_status IN ('pending', 'viewed')
       AND v_row.envelope_expires_at IS NOT NULL
       AND v_row.envelope_expires_at <= v_now THEN
      RETURN NULL;
    END IF;
  END IF;

  v_otp_verified_at := crove_sign.public_otp_verified_at_for_token(v_row.org_id, v_row.signer_id, v_row.token_id);

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_row.org_id,
    'orgName', v_row.org_name,
    'tokenId', v_row.token_id,
    'envelopeId', v_row.envelope_id,
    'signerId', v_row.signer_id,
    'tokenUsed', v_row.token_used_at IS NOT NULL OR v_row.signer_status IN ('signed', 'declined'),
    'tokenExpiresAt', v_row.token_expires_at,
    'envelopeStatus', v_row.envelope_status,
    'signerStatus', v_row.signer_status,
    'signerRole', v_row.signer_role,
    'routingMode', v_row.routing_mode,
    'routingOrder', v_row.routing_order,
    'requireEmailOtp', v_row.require_email_otp,
    'otpVerifiedAt', v_otp_verified_at,
    'allowDelegation', (v_row.allow_delegation AND v_row.signer_role IN ('signer', 'approver') AND v_row.delegation_count < 2),
    'delegationCount', v_row.delegation_count,
    'delegatedFromName', v_row.delegated_from_name,
    'title', v_row.title,
    'message', v_row.message,
    'roleLabel', v_row.role_label,
    'signerName', v_row.signer_name,
    'hasEmail', v_row.signer_email IS NOT NULL,
    'pageCount', v_row.page_count,
    'pageDimensions', v_row.page_dimensions_json,
    'sourceSha256', v_row.source_sha256
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_token_resolve(text, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_token_resolve(text, boolean) TO crove_app;

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
    'allowDelegation', (v_env.allow_delegation AND v_signer.signer_role IN ('signer', 'approver') AND v_signer.delegation_count < 2),
    'delegationCount', v_signer.delegation_count,
    'delegatedFromName', v_signer.delegated_from_name,
    'fields', v_fields,
    'sharedSummary', CASE
      WHEN v_env.share_summary_with_signers AND v_env.shared_summary_json IS NOT NULL THEN v_env.shared_summary_json
      ELSE NULL
    END
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_record_view(text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_record_view(text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_delegate(
  p_token_sha256 text,
  p_delegate_name text,
  p_delegate_email text,
  p_reason text DEFAULT NULL,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_message_id_domain text DEFAULT 'crove.invalid'
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
  v_delegate_name text := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_delegate_name, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_delegate_email text := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_delegate_email, ''))), '');
  v_reason text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_reason, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_domain text := CASE WHEN p_message_id_domain IS NOT NULL AND pg_catalog.btrim(p_message_id_domain) ~ '^[A-Za-z0-9.-]{1,120}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_message_id_domain)) ELSE 'crove.invalid' END;
  v_to_hash text;
  v_suppressed boolean := false;
  v_sender_email text;
  v_sender_hash text;
  v_sender_suppressed boolean := false;
  v_prev_name text;
  v_prev_email text;
  v_next_count integer;
  v_org_name text;
  v_doc_title text;
  v_role_label text;
  v_actor_label text;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM crove_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token -> signing_otp.
  SELECT e.*
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  PERFORM 1
  FROM crove_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
  ORDER BY s.id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.id = v_lookup.signer_id;

  PERFORM 1
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.signer_id = v_lookup.signer_id
  ORDER BY tok.id
  FOR UPDATE;

  SELECT tok.*
  INTO v_tok
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id;

  SELECT t.name, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status IN ('waiting', 'voided', 'expired')
     OR v_env.status IN ('draft', 'voided', 'expired')
     OR (v_tok.used_at IS NULL AND v_signer.status IN ('pending', 'viewed') AND v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_tok.used_at IS NOT NULL OR v_signer.status IN ('signed', 'declined') OR v_env.status NOT IN ('sent', 'in_progress') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  IF v_signer.require_email_otp
     AND crove_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_REQUIRED',
      'httpStatus', 403,
      'message', 'Email OTP verification is required before delegating'
    );
  END IF;

  IF NOT v_env.allow_delegation THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DELEGATION_DISABLED',
      'httpStatus', 403,
      'message', 'Signer delegation is disabled for this envelope'
    );
  END IF;

  IF v_signer.delegation_count >= 2 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DELEGATION_LIMIT_REACHED',
      'httpStatus', 409,
      'message', 'Maximum delegation limit (2) reached for this recipient'
    );
  END IF;

  IF v_delegate_name IS NULL OR pg_catalog.length(v_delegate_name) > 200 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Delegate name must be between 1 and 200 characters'
    );
  END IF;

  IF v_delegate_email IS NULL OR NOT crove_sign.is_single_mail_address(v_delegate_email) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Delegate email must be a valid single mailbox address'
    );
  END IF;

  IF v_signer.email IS NOT NULL AND pg_catalog.lower(pg_catalog.btrim(v_signer.email)) = v_delegate_email THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DELEGATE_SAME_EMAIL',
      'httpStatus', 422,
      'message', 'Delegate email must differ from the current recipient email'
    );
  END IF;

  IF v_reason IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Delegation reason is required'
    );
  END IF;

  v_to_hash := crove_kernel.mail_address_hash(v_delegate_email);
  IF v_to_hash IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_SUPPRESSED',
      'httpStatus', 422,
      'message', 'Delegate email address cannot receive invitations'
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

  IF v_suppressed THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_SUPPRESSED',
      'httpStatus', 422,
      'message', 'Delegate email address is suppressed'
    );
  END IF;

  PERFORM 1
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL
  ORDER BY o.id
  FOR UPDATE;

  UPDATE crove_sign.signing_token
  SET used_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  UPDATE crove_sign.signing_token
  SET revoked_at = v_now
  WHERE org_id = v_lookup.org_id
    AND signer_id = v_signer.id
    AND id <> v_tok.id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL;

  v_prev_name := v_signer.name;
  v_prev_email := v_signer.email;
  v_next_count := v_signer.delegation_count + 1;
  v_ip_hash := crove_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);

  UPDATE crove_sign.signer
  SET name = v_delegate_name,
      email = v_delegate_email,
      delivery_mode = 'email',
      status = 'pending',
      viewed_at = NULL,
      otp_verified_at = NULL,
      token_last_reminded_at = NULL,
      delegated_from_name = v_prev_name,
      delegated_from_email = v_prev_email,
      delegation_reason = v_reason,
      delegation_count = v_next_count,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_signer.id;

  UPDATE crove_sign.envelope
  SET version = v_env.version + 1,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_env.id;

  v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_prev_email, v_prev_name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
  v_actor_label := pg_catalog.left(v_actor_label, 254);

  PERFORM crove_sign.public_append_event(
    v_lookup.org_id,
    v_env.id,
    v_signer.id,
    'signer_delegated',
    'signer',
    v_actor_label,
    v_env.source_sha256,
    pg_catalog.jsonb_build_object(
      'routingOrder', v_signer.routing_order,
      'fromName', v_prev_name,
      'fromMaskedEmail', crove_sign.mask_email(v_prev_email),
      'delegateName', v_delegate_name,
      'delegateMaskedEmail', crove_sign.mask_email(v_delegate_email),
      'delegationCount', v_next_count,
      'reasonProvided', true
    ),
    v_ip_hash,
    v_ua,
    v_now
  );

  v_org_name := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_tenant.name, '[[:cntrl:]]+', ' ', 'g')), 200), ''), 'Ludy');
  v_doc_title := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_env.title, '[[:cntrl:]]+', ' ', 'g')), 300), ''), 'Tai lieu');
  v_role_label := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_signer.role_label, '[[:cntrl:]]+', ' ', 'g')), 120), ''), CASE WHEN v_signer.signer_role = 'approver' THEN 'Nguoi duyet' ELSE 'Nguoi ky' END);

  -- Queue fresh signing invitation to the delegate (zero plaintext token stored in mail_message).
  INSERT INTO crove_kernel.mail_message (
    org_id, stream, source, source_id, template_key, to_address, to_hash,
    subject, payload, message_id_header, status, created_by
  )
  VALUES (
    v_lookup.org_id,
    'transactional',
    'sign.public.delegate',
    v_signer.id,
    'sign.invite',
    v_delegate_email,
    v_to_hash,
    pg_catalog.left((CASE WHEN v_signer.signer_role = 'approver' THEN 'Moi duyet: ' ELSE 'Moi ky: ' END) || v_doc_title, 300),
    pg_catalog.jsonb_build_object(
      'lang', 'vi',
      'orgName', v_org_name,
      'envelopeId', v_env.id::text,
      'signerId', v_signer.id::text,
      'signerRole', CASE WHEN v_signer.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
      'docTitle', v_doc_title,
      'roleLabel', v_role_label,
      'expiresAt', CASE WHEN v_env.expires_at IS NOT NULL
        THEN pg_catalog.to_char(v_env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ELSE NULL END
    ),
    '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
    'queued',
    NULL
  );

  -- Notify the envelope sender (created_by) about the audited delegation.
  SELECT NULLIF(pg_catalog.lower(pg_catalog.btrim(u.email)), '')
  INTO v_sender_email
  FROM crove_kernel.user_account u
  WHERE u.id = v_env.created_by;

  IF v_sender_email IS NOT NULL AND crove_sign.is_single_mail_address(v_sender_email) THEN
    v_sender_hash := crove_kernel.mail_address_hash(v_sender_email);
    IF v_sender_hash IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM crove_kernel.mail_suppression ms
        WHERE ms.org_id = v_lookup.org_id
          AND ms.to_hash = v_sender_hash
          AND ms.scope = 'all'
          AND ms.lifted_at IS NULL
      )
      INTO v_sender_suppressed;

      INSERT INTO crove_kernel.mail_message (
        org_id, stream, source, source_id, template_key, to_address, to_hash,
        subject, payload, message_id_header, status, created_by
      )
      VALUES (
        v_lookup.org_id,
        'transactional',
        'sign.public.delegate',
        v_env.id,
        'sign.delegated',
        v_sender_email,
        v_sender_hash,
        pg_catalog.left('Uy quyen ky: ' || v_doc_title, 300),
        pg_catalog.jsonb_build_object(
          'lang', 'vi',
          'orgName', v_org_name,
          'envelopeId', v_env.id::text,
          'signerId', v_signer.id::text,
          'docTitle', v_doc_title,
          'roleLabel', v_role_label,
          'delegationCount', v_next_count
        ),
        '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
        CASE WHEN v_sender_suppressed THEN 'suppressed' ELSE 'queued' END,
        NULL
      );
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'signerId', v_signer.id,
    'delegateName', v_delegate_name,
    'maskedDelegateEmail', crove_sign.mask_email(v_delegate_email),
    'delegationCount', v_next_count,
    'delegatedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_delegate(text, text, text, text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_delegate(text, text, text, text, text, text, text) TO crove_app;
