-- SPDX-License-Identifier: AGPL-3.0-only
-- Defense-in-depth actor guard for meeting_minutes envelopes inside
-- ludy_sign.mint_signing_token and ludy_sign.mint_in_person_signing_token (#4558):
-- a plain meeting reader (not created_by, owner, or admin) who can read the
-- envelope passes the visibility check and is rejected with 42501 SIGN_FORBIDDEN,
-- while non-readers (including unshared owners/admins on attendees-only meetings)
-- still receive ENVELOPE_NOT_ACTIVE so no existence oracle leaks, and system
-- callers of mint_signing_token remain unaffected.

SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_sign.mint_signing_token(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_token_sha256 text,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_status text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_env_source_id uuid;
  v_env_ret_org boolean;
  v_env_ret_readers uuid[];
  v_signer_status text;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT e.status, e.created_by, e.source_kind, e.source_id, e.retained_org_visible, e.retained_reader_ids
  INTO v_env_status, v_env_creator, v_env_source_kind, v_env_source_id, v_env_ret_org, v_env_ret_readers
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR SHARE;
  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user'
     AND v_env_source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user'
     AND v_env_source_kind = 'meeting_minutes'
     AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
       v_org, v_env_source_id, v_env_creator, v_env_status, v_env_ret_org, v_env_ret_readers
     ) THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user'
     AND v_env_source_kind = 'meeting_minutes'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT s.status INTO v_signer_status
  FROM ludy_sign.signer s
  WHERE s.org_id = v_org AND s.id = p_signer_id AND s.envelope_id = p_envelope_id
  FOR UPDATE;
  IF v_signer_status IS NULL OR v_signer_status NOT IN ('pending', 'viewed') THEN
    RAISE EXCEPTION 'SIGNER_NOT_LIVE' USING ERRCODE = '42501';
  END IF;

  UPDATE ludy_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = COALESCE(v_user, v_env_creator)
  WHERE t.org_id = v_org
    AND t.signer_id = p_signer_id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  UPDATE ludy_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = p_signer_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  INSERT INTO ludy_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, created_by)
  VALUES (v_org, p_envelope_id, p_signer_id, p_token_sha256, p_expires_at, COALESCE(v_user, v_env_creator))
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.mint_signing_token(uuid, uuid, text, timestamptz)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION ludy_sign.mint_signing_token(uuid, uuid, text, timestamptz) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION ludy_sign.mint_signing_token(uuid, uuid, text, timestamptz) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_sign.mint_in_person_signing_token(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_token_sha256 text,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_status text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_env_source_id uuid;
  v_env_ret_org boolean;
  v_env_ret_readers uuid[];
  v_env_expires_at timestamptz;
  v_signer_status text;
  v_signer_role text;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR ludy_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
  FROM ludy_kernel.tenant_member m
  WHERE m.org_id = v_org
    AND m.user_id = v_user
    AND m.role IN ('owner', 'admin', 'member');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now OR p_expires_at > v_now + interval '2 hours' + interval '5 minutes' THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT e.status, e.created_by, e.source_kind, e.source_id, e.expires_at, e.retained_org_visible, e.retained_reader_ids
  INTO v_env_status, v_env_creator, v_env_source_kind, v_env_source_id, v_env_expires_at, v_env_ret_org, v_env_ret_readers
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR SHARE;
  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_expires_at IS NOT NULL AND v_env_expires_at <= v_now THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_source_kind = 'meeting_minutes'
     AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
       v_org, v_env_source_id, v_env_creator, v_env_status, v_env_ret_org, v_env_ret_readers
     ) THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_source_kind = 'meeting_minutes'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT s.status, s.signer_role
  INTO v_signer_status, v_signer_role
  FROM ludy_sign.signer s
  WHERE s.org_id = v_org AND s.id = p_signer_id AND s.envelope_id = p_envelope_id
  FOR UPDATE;
  IF v_signer_status IS NULL OR v_signer_role = 'cc' OR v_signer_status NOT IN ('pending', 'viewed') THEN
    RAISE EXCEPTION 'SIGNER_NOT_LIVE' USING ERRCODE = '42501';
  END IF;

  UPDATE ludy_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = v_user
  WHERE t.org_id = v_org
    AND t.signer_id = p_signer_id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  UPDATE ludy_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = p_signer_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  INSERT INTO ludy_sign.signing_token (
    org_id, envelope_id, signer_id, token_sha256, expires_at, in_person_host_user_id, created_by, created_at
  )
  VALUES (
    v_org, p_envelope_id, p_signer_id, p_token_sha256, p_expires_at, v_user, v_user, v_now
  )
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.mint_in_person_signing_token(uuid, uuid, text, timestamptz)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION ludy_sign.mint_in_person_signing_token(uuid, uuid, text, timestamptz) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION ludy_sign.mint_in_person_signing_token(uuid, uuid, text, timestamptz) TO ludy_tenant;
