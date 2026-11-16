-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign retention and PDPL erasure fixes (#3427, #3428 L4):
--   1. Preserve untouched draft envelopes in cleanup sweeps (zero draft deletions regardless of age),
--      and remove the crove.sign_cleanup bypass from crove_sign.signing_event_append_only.
--   2. Align secret retention to 24 hours for signing_otp and 30 days for signing_token via
--      cleanup_org_secrets / cleanup_due_orgs_secrets (keeping legacy cleanup_org_stale / cleanup_due_orgs
--      signatures safe for re-application and rolling deploys without deleting drafts).
--   3. Order due orgs deterministically (ORDER BY org_id ASC) in expire_sweep_due_orgs and cleanup due-org queries.
--   4. Add owner-only crove_sign.personal_erase_unsealed_signers(text, text) and allow it inside signer_guard
--      and field_guard so unsealed envelopes (draft, voided, expired, declined with sealed_file_id IS NULL)
--      erase signer PII and fields while keeping executed/completed/sealed records and signing_event intact.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Secret retention cleanup (OTP 24h, token 30d; zero draft deletion)
-- ---------------------------------------------------------------------------
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
  v_token_ids uuid[] := '{}'::uuid[];
  v_otp_ids uuid[] := '{}'::uuid[];
  v_otps integer := 0;
  v_tokens integer := 0;
BEGIN
  IF v_org IS NULL
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_CLEANUP_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_otp_cutoff IS NULL OR p_token_cutoff IS NULL THEN
    RAISE EXCEPTION 'SIGN_CLEANUP_CUTOFF_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- Canonical lock order: signing_token -> signing_otp (matches public RPCs and personal_erase_unsealed_signers).
  v_token_ids := ARRAY(
    SELECT t.id
    FROM crove_sign.signing_token t
    WHERE t.org_id = v_org
      AND LEAST(t.expires_at, COALESCE(t.revoked_at, t.expires_at), COALESCE(t.used_at, t.expires_at)) < p_token_cutoff
    ORDER BY t.id
    FOR UPDATE OF t
  );

  -- Lock due OTPs and any child OTPs cascaded by deleting v_token_ids in one ordered pass.
  WITH locked_otps AS (
    SELECT
      o.id,
      (LEAST(o.expires_at, COALESCE(o.invalidated_at, o.expires_at), COALESCE(o.verified_at, o.expires_at)) < p_otp_cutoff) AS is_due_otp
    FROM crove_sign.signing_otp o
    WHERE o.org_id = v_org
      AND (
        LEAST(o.expires_at, COALESCE(o.invalidated_at, o.expires_at), COALESCE(o.verified_at, o.expires_at)) < p_otp_cutoff
        OR o.signing_token_id = ANY (v_token_ids)
      )
    ORDER BY o.id
    FOR UPDATE OF o
  )
  SELECT COALESCE(pg_catalog.array_agg(l.id ORDER BY l.id) FILTER (WHERE l.is_due_otp), '{}'::uuid[])
  INTO v_otp_ids
  FROM locked_otps l;

  -- Prune expired, invalidated, or verified OTP rows older than p_otp_cutoff (24 hours by default).
  IF COALESCE(pg_catalog.array_length(v_otp_ids, 1), 0) > 0 THEN
    DELETE FROM crove_sign.signing_otp o
    WHERE o.org_id = v_org
      AND o.id = ANY (v_otp_ids);
    GET DIAGNOSTICS v_otps = ROW_COUNT;
  END IF;

  -- Prune expired, revoked, or used signing tokens older than p_token_cutoff (30 days by default).
  IF COALESCE(pg_catalog.array_length(v_token_ids, 1), 0) > 0 THEN
    DELETE FROM crove_sign.signing_token t
    WHERE t.org_id = v_org
      AND t.id = ANY (v_token_ids);
    GET DIAGNOSTICS v_tokens = ROW_COUNT;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'otps', v_otps,
    'tokens', v_tokens,
    'drafts', 0,
    'draftEvents', 0
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.cleanup_org_secrets(timestamptz, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.cleanup_org_secrets(timestamptz, timestamptz) TO crove_worker;

-- Keep legacy 2-arg cleanup_org_stale signature for rolling deploys and migration re-apply idempotency;
-- p_draft_cutoff is ignored so drafts are never deleted by any caller.
CREATE OR REPLACE FUNCTION crove_sign.cleanup_org_stale(
  p_draft_cutoff timestamptz,
  p_secret_cutoff timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN crove_sign.cleanup_org_secrets(p_secret_cutoff, p_secret_cutoff);
END $$;

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
    WHERE LEAST(o.expires_at, COALESCE(o.invalidated_at, o.expires_at), COALESCE(o.verified_at, o.expires_at)) < p_otp_cutoff
    UNION
    SELECT s.org_id FROM crove_sign.signing_token s
    WHERE LEAST(s.expires_at, COALESCE(s.revoked_at, s.expires_at), COALESCE(s.used_at, s.expires_at)) < p_token_cutoff
  ) sub
  JOIN crove_kernel.tenant t ON t.org_id = sub.org_id
  WHERE t.status = 'active'
  ORDER BY sub.org_id ASC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_sign.cleanup_due_orgs_secrets(timestamptz, timestamptz, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.cleanup_due_orgs_secrets(timestamptz, timestamptz, integer) TO crove_worker;

-- Keep legacy 3-arg cleanup_due_orgs signature without scanning draft envelopes, ordered by org_id ASC.
CREATE OR REPLACE FUNCTION crove_sign.cleanup_due_orgs(
  p_draft_cutoff timestamptz,
  p_secret_cutoff timestamptz,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(org_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT d.org_id
  FROM crove_sign.cleanup_due_orgs_secrets(p_secret_cutoff, p_secret_cutoff, p_limit) AS d
  ORDER BY d.org_id ASC;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.expire_sweep_due_orgs(p_limit integer DEFAULT 100)
RETURNS TABLE(org_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_now timestamptz := pg_catalog.now();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_SWEEP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT e.org_id
  FROM crove_sign.envelope e
  JOIN crove_kernel.tenant t ON t.org_id = e.org_id
  WHERE t.status = 'active'
    AND e.status IN ('sent', 'in_progress')
    AND e.expires_at IS NOT NULL
    AND e.expires_at <= v_now
  ORDER BY e.org_id ASC
  LIMIT v_limit;
END $$;

-- Remove the crove.sign_cleanup bypass: only org_purge (offboarding) may delete signing_event rows.
CREATE OR REPLACE FUNCTION crove_sign.signing_event_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_purge_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_kernel.org_purge(integer)'::pg_catalog.regprocedure);
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
BEGIN
  IF TG_OP = 'DELETE'
     AND v_cur_role = v_purge_owner
     AND pg_catalog.current_setting('crove.org_purge', true) = OLD.org_id::text
     AND pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     AND crove_kernel.ctx_actor_type() = 'system'
     AND crove_kernel.ctx_org_id() = OLD.org_id
     AND EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'offboarding') THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

-- ---------------------------------------------------------------------------
-- 2. PDPL erasure of signers on unsealed envelopes (draft, voided, expired, declined)
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
  v_touched_env_ids uuid[];
  v_otps integer := 0;
  v_signers integer := 0;
  v_emails integer := 0;
  v_phones integer := 0;
  v_typed integer := 0;
  v_uas integer := 0;
  v_field_sigs integer := 0;
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
        'typedSignatures', 0, 'userAgents', 0, 'fieldSignatures', 0, 'otps', 0
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
            (p_kind = 'email' AND s.email IS NOT NULL AND pg_catalog.lower(s.email) = v_email)
            OR (p_kind = 'digits' AND s.phone IS NOT NULL AND pg_catalog.regexp_replace(s.phone, '[^0-9]', '', 'g') IN (v_local_phone, v_intl_phone))
          )
      )
    ORDER BY e.id
    FOR UPDATE OF e
  );

  IF COALESCE(pg_catalog.array_length(v_env_ids, 1), 0) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'signers', 0, 'emails', 0, 'phones', 0,
      'typedSignatures', 0, 'userAgents', 0, 'fieldSignatures', 0, 'otps', 0
    );
  END IF;

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
    FOR UPDATE OF s
  );

  IF COALESCE(pg_catalog.array_length(v_signer_ids, 1), 0) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'signers', 0, 'emails', 0, 'phones', 0,
      'typedSignatures', 0, 'userAgents', 0, 'fieldSignatures', 0, 'otps', 0
    );
  END IF;

  PERFORM 1 FROM crove_sign.signing_token t WHERE t.org_id = v_org AND t.signer_id = ANY (v_signer_ids) ORDER BY t.id FOR UPDATE;
  PERFORM 1 FROM crove_sign.field f WHERE f.org_id = v_org AND f.signer_id = ANY (v_signer_ids) ORDER BY f.id FOR UPDATE;
  PERFORM 1 FROM crove_sign.signing_otp o WHERE o.org_id = v_org AND o.signer_id = ANY (v_signer_ids) ORDER BY o.id FOR UPDATE;

  PERFORM pg_catalog.set_config('crove.sign_personal_erase', v_org::text, true);

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
      (s.signer_user_agent IS NOT NULL) AS has_ua
  )
  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.count(*) FILTER (WHERE has_email), 0)::integer,
    COALESCE(pg_catalog.count(*) FILTER (WHERE has_phone), 0)::integer,
    COALESCE(pg_catalog.count(*) FILTER (WHERE has_typed), 0)::integer,
    COALESCE(pg_catalog.count(*) FILTER (WHERE has_ua), 0)::integer,
    ARRAY(SELECT DISTINCT r.envelope_id FROM removed_signers r ORDER BY r.envelope_id)
  INTO v_signers, v_emails, v_phones, v_typed, v_uas, v_touched_env_ids
  FROM removed_signers;

  PERFORM pg_catalog.set_config('crove.sign_personal_erase', '', true);

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
    'otps', v_otps
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.personal_erase_unsealed_signers(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.personal_erase_unsealed_signers(text, text) TO crove_app;

-- Update signer_guard and field_guard to allow DELETE solely from personal_erase_unsealed_signers
-- on unsealed envelopes (draft, voided, expired, declined with sealed_file_id IS NULL).
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
    IF NEW.token_last_reminded_at IS NOT NULL OR NEW.viewed_at IS NOT NULL OR NEW.signed_at IS NOT NULL
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
  IF (NEW.viewed_at, NEW.signed_at, NEW.declined_at, NEW.decline_reason, NEW.otp_verified_at,
      NEW.signature_kind, NEW.signature_typed_text, NEW.signer_user_agent, NEW.signer_ip_hash, NEW.consent_accepted_at)
     IS DISTINCT FROM (OLD.viewed_at, OLD.signed_at, OLD.declined_at, OLD.decline_reason, OLD.otp_verified_at,
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

CREATE OR REPLACE FUNCTION crove_sign.field_guard() RETURNS trigger
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
  IF TG_OP = 'UPDATE' AND (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.org_id, NEW.id, NEW.envelope_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.created_at) THEN
    RAISE EXCEPTION 'FIELD_IMMUTABLE' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'fields cannot change after envelope is sent';
  END IF;
  IF v_env_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'fields cannot change after envelope is sent';
  END IF;
  IF NEW.value_text IS NOT NULL OR NEW.value_checked IS NOT NULL OR NEW.signature_png_base64 IS NOT NULL OR NEW.filled_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'field values are filled only through public signing';
  END IF;
  RETURN NEW;
END $$;
