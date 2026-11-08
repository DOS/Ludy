-- SPDX-License-Identifier: AGPL-3.0-only
-- Bind the Ludy extension's id to its one-time sign-in code (issue #2850, follow-up of #2740 / #2582). Idempotent; applied files
-- stay untouched. Step 1 of 2: it is additive, so the invariant suite (which pins the 5-argument issue and the 3-argument
-- exchange) keeps passing. Step 2 moves the invariant to the new signatures and drops the old functions.
--
-- 1. crove_kernel.extension_auth_code.extension_id: the id of the extension the member approved (32 letters a to p), null for a
--    code made before this migration or by the 5-argument issue.
-- 2. issue_extension_auth_code(bytea, text, text, text[], text, text): the 5-argument function plus the extension id, required.
-- 3. exchange_extension_auth_code(bytea, text, bytea, text): the exchange plus the id of the extension asking (the API reads it
--    from the Origin header). It answers no row, without spending the code, when the code is not bound to that id (an unbound
--    code included), so a stolen code is useless from another extension and the real one can still use it.
-- 4. The 3-argument exchange refuses a bound code, so the old function cannot be used to get around the binding.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.extension_auth_code ADD COLUMN IF NOT EXISTS extension_id text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.extension_auth_code'::pg_catalog.regclass AND conname = 'extension_auth_code_extension_id_check'
  ) THEN
    ALTER TABLE crove_kernel.extension_auth_code
      ADD CONSTRAINT extension_auth_code_extension_id_check CHECK (extension_id IS NULL OR extension_id ~ '^[a-p]{32}$');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- issue_extension_auth_code with the extension id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.issue_extension_auth_code(
  p_code_hash bytea, p_code_challenge text, p_method text, p_scopes text[], p_device_name text, p_extension_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_scopes text[];
  v_device text := pg_catalog.btrim(p_device_name);
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'EXTENSION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32
     OR p_method IS DISTINCT FROM 'S256'
     OR p_code_challenge IS NULL OR p_code_challenge !~ '^[A-Za-z0-9_-]{43}$'
     OR p_scopes IS NULL OR pg_catalog.cardinality(p_scopes) NOT BETWEEN 1 AND 8
     OR NOT (p_scopes <@ ARRAY['meetings']::text[])
     OR v_device IS NULL OR pg_catalog.char_length(v_device) NOT BETWEEN 1 AND 80
     OR p_extension_id IS NULL OR p_extension_id !~ '^[a-p]{32}$' THEN
    RAISE EXCEPTION 'EXTENSION_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT s ORDER BY s) INTO v_scopes FROM pg_catalog.unnest(p_scopes) AS s;
  DELETE FROM crove_kernel.extension_auth_code c WHERE c.org_id = v_org AND c.created_at < pg_catalog.now() - interval '1 day';
  IF (SELECT pg_catalog.count(*) FROM crove_kernel.extension_auth_code c
      WHERE c.org_id = v_org AND c.user_id = v_user AND c.consumed_at IS NULL AND c.expires_at > pg_catalog.now()) >= 10 THEN
    RAISE EXCEPTION 'EXTENSION_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_kernel.extension_auth_code (org_id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
  VALUES (v_org, v_user, p_code_hash, p_code_challenge, 'S256', v_scopes, v_device, p_extension_id, pg_catalog.now(), pg_catalog.now() + interval '5 minutes')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- exchange_extension_auth_code with the id of the extension asking
-- ---------------------------------------------------------------------------
-- The body of the 3-argument exchange (20261128080000) with one more check, made before the verifier is looked at: the code's
-- extension_id must be the asking id. A mismatch answers no row and changes nothing (no failed attempt is counted, so an
-- attacker holding a stolen code cannot burn it for the member).
CREATE OR REPLACE FUNCTION crove_kernel.exchange_extension_auth_code(p_code_hash bytea, p_code_verifier text, p_token_hash bytea, p_extension_id text)
RETURNS TABLE (token_id uuid, org_id uuid, user_id uuid, scopes text[], expires_at timestamptz, code_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_code crove_kernel.extension_auth_code%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_challenge text;
  v_id uuid;
BEGIN
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32
     OR p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32
     OR p_code_verifier IS NULL OR p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$'
     OR p_extension_id IS NULL OR p_extension_id !~ '^[a-p]{32}$' THEN
    RETURN;
  END IF;
  SELECT c.* INTO v_code FROM crove_kernel.extension_auth_code c WHERE c.code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR v_code.consumed_at IS NOT NULL OR v_code.expires_at <= v_now OR v_code.failed_attempts >= 5 THEN
    RETURN;
  END IF;
  IF v_code.extension_id IS DISTINCT FROM p_extension_id THEN
    RETURN;
  END IF;
  v_challenge := pg_catalog.translate(
    pg_catalog.rtrim(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code_verifier, 'UTF8')), 'base64'), '='), '+/', '-_');
  IF v_challenge <> v_code.code_challenge THEN
    UPDATE crove_kernel.extension_auth_code c
    SET failed_attempts = c.failed_attempts + 1,
        consumed_at = CASE WHEN c.failed_attempts + 1 >= 5 THEN v_now ELSE NULL END
    WHERE c.org_id = v_code.org_id AND c.id = v_code.id;
    RETURN;
  END IF;
  PERFORM 1
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
  JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
  WHERE m.org_id = v_code.org_id AND m.user_id = v_code.user_id AND m.role IN ('owner', 'admin', 'member')
    AND m.created_at <= v_code.created_at
  FOR SHARE OF m, u;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE crove_kernel.extension_auth_code c SET consumed_at = v_now WHERE c.org_id = v_code.org_id AND c.id = v_code.id;
  UPDATE crove_kernel.extension_token t SET revoked_at = v_now
  WHERE t.org_id = v_code.org_id AND t.id IN (
    SELECT o.id FROM crove_kernel.extension_token o
    WHERE o.org_id = v_code.org_id AND o.user_id = v_code.user_id AND o.revoked_at IS NULL AND o.expires_at > v_now
    ORDER BY o.created_at DESC OFFSET 19);
  INSERT INTO crove_kernel.extension_token (org_id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
  VALUES (v_code.org_id, v_code.user_id, p_token_hash, v_code.device_name, v_code.scopes, v_now, v_now + interval '2160 hours', v_code.user_id)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, v_code.org_id, v_code.user_id, v_code.scopes, v_now + interval '2160 hours', v_code.id;
END $$;

-- ---------------------------------------------------------------------------
-- The 3-argument exchange refuses a code bound to an extension
-- ---------------------------------------------------------------------------
-- Its body is the one of 20261128080000 with one more refusal: a code that carries an extension_id is exchanged by the
-- 4-argument function only. Unbound codes (made by the 5-argument issue) behave as before.
CREATE OR REPLACE FUNCTION crove_kernel.exchange_extension_auth_code(p_code_hash bytea, p_code_verifier text, p_token_hash bytea)
RETURNS TABLE (token_id uuid, org_id uuid, user_id uuid, scopes text[], expires_at timestamptz, code_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_code crove_kernel.extension_auth_code%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_challenge text;
  v_id uuid;
BEGIN
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32
     OR p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32
     OR p_code_verifier IS NULL OR p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' THEN
    RETURN;
  END IF;
  SELECT c.* INTO v_code FROM crove_kernel.extension_auth_code c WHERE c.code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR v_code.consumed_at IS NOT NULL OR v_code.expires_at <= v_now OR v_code.failed_attempts >= 5 THEN
    RETURN;
  END IF;
  IF v_code.extension_id IS NOT NULL THEN
    RETURN;
  END IF;
  v_challenge := pg_catalog.translate(
    pg_catalog.rtrim(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code_verifier, 'UTF8')), 'base64'), '='), '+/', '-_');
  IF v_challenge <> v_code.code_challenge THEN
    UPDATE crove_kernel.extension_auth_code c
    SET failed_attempts = c.failed_attempts + 1,
        consumed_at = CASE WHEN c.failed_attempts + 1 >= 5 THEN v_now ELSE NULL END
    WHERE c.org_id = v_code.org_id AND c.id = v_code.id;
    RETURN;
  END IF;
  PERFORM 1
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
  JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
  WHERE m.org_id = v_code.org_id AND m.user_id = v_code.user_id AND m.role IN ('owner', 'admin', 'member')
    AND m.created_at <= v_code.created_at
  FOR SHARE OF m, u;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE crove_kernel.extension_auth_code c SET consumed_at = v_now WHERE c.org_id = v_code.org_id AND c.id = v_code.id;
  UPDATE crove_kernel.extension_token t SET revoked_at = v_now
  WHERE t.org_id = v_code.org_id AND t.id IN (
    SELECT o.id FROM crove_kernel.extension_token o
    WHERE o.org_id = v_code.org_id AND o.user_id = v_code.user_id AND o.revoked_at IS NULL AND o.expires_at > v_now
    ORDER BY o.created_at DESC OFFSET 19);
  INSERT INTO crove_kernel.extension_token (org_id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
  VALUES (v_code.org_id, v_code.user_id, p_token_hash, v_code.device_name, v_code.scopes, v_now, v_now + interval '2160 hours', v_code.user_id)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, v_code.org_id, v_code.user_id, v_code.scopes, v_now + interval '2160 hours', v_code.id;
END $$;

-- ---------------------------------------------------------------------------
-- Grants: the API's login alone, as for the other extension definers.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text),
  crove_kernel.exchange_extension_auth_code(bytea, text, bytea, text)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text), '
      'crove_kernel.exchange_extension_auth_code(bytea, text, bytea, text) FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  crove_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text),
  crove_kernel.exchange_extension_auth_code(bytea, text, bytea, text)
TO crove_app;
