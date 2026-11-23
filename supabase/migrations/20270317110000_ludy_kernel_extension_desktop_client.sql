-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Desktop, ADR-0055 slice 2 (issue #4515): a desktop token is an extension token with a client marker. Idempotent; applied
-- files stay untouched.
--
-- The shell signs in the way the extension does (a one-time code, PKCE, an opaque `crx_` token) and the token lives in the same
-- table, so the revoke, the standing checks, the per-request re-check and the "thiết bị đã kết nối" list all apply to it unchanged.
-- What tells it apart is a marker the SERVER sets, never one a client states:
--
-- 1. ludy_kernel.extension_token.client ('extension' or 'desktop', default 'extension'). A desktop code is the one bound to the
--    reserved id below (the id the HTTP edge gives a desktop exchange, which has no browser Origin); the exchange copies that to
--    the token. Slice 3 (capture) reads the marker from ctx.actor.extension.client, never from what a request says.
-- 2. A desktop token may hold NO scope (its features are not built yet): the two scope CHECKs allow an empty list when the code is
--    bound to the desktop id or the token is a desktop one. An extension token still needs 1 to 8 known scopes.
-- 3. issue_extension_auth_code allows the empty list for the desktop id only.
-- 4. exchange_extension_auth_code (same signature and result) copies the marker and, for a desktop token, writes the audit row of
--    the exchange itself (command kernel.extension.desktop.exchanged, as the member, naming the token and the code, ids only):
--    the exchange has no member context for a runtime command, and a zero-scope token cannot run a scoped one.
-- 5. verify_extension_token, list_extension_tokens and list_extension_tokens_for_org return the marker as one more, last column
--    (a DROP and CREATE, the result type changes), with the grants they had: the API's login alone.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.extension_token ADD COLUMN IF NOT EXISTS client text NOT NULL DEFAULT 'extension';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_kernel.extension_token'::pg_catalog.regclass AND conname = 'extension_token_client_check'
  ) THEN
    ALTER TABLE ludy_kernel.extension_token
      ADD CONSTRAINT extension_token_client_check CHECK (client IN ('extension', 'desktop'));
  END IF;
END $$;

-- The scope lists: a desktop token or code may hold none.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def FROM pg_catalog.pg_constraint
  WHERE conrelid = 'ludy_kernel.extension_token'::pg_catalog.regclass AND conname = 'extension_token_scopes_check';
  IF v_def IS NULL OR v_def NOT LIKE '%desktop%' THEN
    ALTER TABLE ludy_kernel.extension_token DROP CONSTRAINT IF EXISTS extension_token_scopes_check;
    ALTER TABLE ludy_kernel.extension_token ADD CONSTRAINT extension_token_scopes_check
      CHECK (pg_catalog.cardinality(scopes) <= 8 AND scopes <@ ARRAY['meetings', 'agenda', 'notes']::text[]
             AND (pg_catalog.cardinality(scopes) >= 1 OR client = 'desktop'));
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def FROM pg_catalog.pg_constraint
  WHERE conrelid = 'ludy_kernel.extension_auth_code'::pg_catalog.regclass AND conname = 'extension_auth_code_scopes_check';
  IF v_def IS NULL OR v_def NOT LIKE '%abababab%' THEN
    ALTER TABLE ludy_kernel.extension_auth_code DROP CONSTRAINT IF EXISTS extension_auth_code_scopes_check;
    ALTER TABLE ludy_kernel.extension_auth_code ADD CONSTRAINT extension_auth_code_scopes_check
      CHECK (pg_catalog.cardinality(scopes) <= 8 AND scopes <@ ARRAY['meetings', 'agenda', 'notes']::text[]
             AND (pg_catalog.cardinality(scopes) >= 1 OR extension_id = 'abababababababababababababababab'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- issue_extension_auth_code: the empty scope list for the desktop id only
-- ---------------------------------------------------------------------------
-- The body of 20270115120000 (notes scope) with the lower bound of the scope count moved: 0 for the reserved desktop id, 1 for any other.
CREATE OR REPLACE FUNCTION ludy_kernel.issue_extension_auth_code(
  p_code_hash bytea, p_code_challenge text, p_method text, p_scopes text[], p_device_name text, p_extension_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_scopes text[];
  v_device text := pg_catalog.btrim(p_device_name);
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant_member m
    JOIN ludy_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN ludy_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'EXTENSION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32
     OR p_method IS DISTINCT FROM 'S256'
     OR p_code_challenge IS NULL OR p_code_challenge !~ '^[A-Za-z0-9_-]{43}$'
     OR p_scopes IS NULL OR pg_catalog.cardinality(p_scopes) NOT BETWEEN 0 AND 8
     OR (pg_catalog.cardinality(p_scopes) = 0 AND p_extension_id IS DISTINCT FROM 'abababababababababababababababab')
     OR NOT (p_scopes <@ ARRAY['meetings', 'agenda', 'notes']::text[])
     OR ('agenda' = ANY (p_scopes) AND NOT ('meetings' = ANY (p_scopes)))
     OR v_device IS NULL OR pg_catalog.char_length(v_device) NOT BETWEEN 1 AND 80
     OR p_extension_id IS NULL OR p_extension_id !~ '^[a-p]{32}$' THEN
    RAISE EXCEPTION 'EXTENSION_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT s ORDER BY s), ARRAY[]::text[]) INTO v_scopes FROM pg_catalog.unnest(p_scopes) AS s;
  DELETE FROM ludy_kernel.extension_auth_code c WHERE c.org_id = v_org AND c.created_at < pg_catalog.now() - interval '1 day';
  IF (SELECT pg_catalog.count(*) FROM ludy_kernel.extension_auth_code c
      WHERE c.org_id = v_org AND c.user_id = v_user AND c.consumed_at IS NULL AND c.expires_at > pg_catalog.now()) >= 10 THEN
    RAISE EXCEPTION 'EXTENSION_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO ludy_kernel.extension_auth_code (org_id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, extension_id, created_at, expires_at)
  VALUES (v_org, v_user, p_code_hash, p_code_challenge, 'S256', v_scopes, v_device, p_extension_id, pg_catalog.now(), pg_catalog.now() + interval '5 minutes')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- exchange_extension_auth_code: copy the marker, audit a desktop exchange
-- ---------------------------------------------------------------------------
-- The body of the 4-argument function of 20261201030000 with two additions: the token's client is 'desktop' when the code is bound
-- to the reserved desktop id, and a desktop exchange writes its own audit row in the same transaction (so the client never holds a
-- token whose exchange is unaudited: the row and the token commit or fail together). Signature and result columns are as they were.
CREATE OR REPLACE FUNCTION ludy_kernel.exchange_extension_auth_code(p_code_hash bytea, p_code_verifier text, p_token_hash bytea, p_extension_id text)
RETURNS TABLE (token_id uuid, org_id uuid, user_id uuid, scopes text[], expires_at timestamptz, code_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_code ludy_kernel.extension_auth_code%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_challenge text;
  v_id uuid;
  v_client text;
BEGIN
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32
     OR p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32
     OR p_code_verifier IS NULL OR p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$'
     OR p_extension_id IS NULL OR p_extension_id !~ '^[a-p]{32}$' THEN
    RETURN;
  END IF;
  SELECT c.* INTO v_code FROM ludy_kernel.extension_auth_code c WHERE c.code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR v_code.consumed_at IS NOT NULL OR v_code.expires_at <= v_now OR v_code.failed_attempts >= 5 THEN
    RETURN;
  END IF;
  IF v_code.extension_id IS DISTINCT FROM p_extension_id THEN
    RETURN;
  END IF;
  v_challenge := pg_catalog.translate(
    pg_catalog.rtrim(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code_verifier, 'UTF8')), 'base64'), '='), '+/', '-_');
  IF v_challenge <> v_code.code_challenge THEN
    UPDATE ludy_kernel.extension_auth_code c
    SET failed_attempts = c.failed_attempts + 1,
        consumed_at = CASE WHEN c.failed_attempts + 1 >= 5 THEN v_now ELSE NULL END
    WHERE c.org_id = v_code.org_id AND c.id = v_code.id;
    RETURN;
  END IF;
  PERFORM 1
  FROM ludy_kernel.tenant_member m
  JOIN ludy_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
  JOIN ludy_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
  WHERE m.org_id = v_code.org_id AND m.user_id = v_code.user_id AND m.role IN ('owner', 'admin', 'member')
    AND m.created_at <= v_code.created_at
  FOR SHARE OF m, u;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_client := CASE WHEN v_code.extension_id = 'abababababababababababababababab' THEN 'desktop' ELSE 'extension' END;
  UPDATE ludy_kernel.extension_auth_code c SET consumed_at = v_now WHERE c.org_id = v_code.org_id AND c.id = v_code.id;
  UPDATE ludy_kernel.extension_token t SET revoked_at = v_now
  WHERE t.org_id = v_code.org_id AND t.id IN (
    SELECT o.id FROM ludy_kernel.extension_token o
    WHERE o.org_id = v_code.org_id AND o.user_id = v_code.user_id AND o.revoked_at IS NULL AND o.expires_at > v_now
    ORDER BY o.created_at DESC OFFSET 19);
  INSERT INTO ludy_kernel.extension_token (org_id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by, client)
  VALUES (v_code.org_id, v_code.user_id, p_token_hash, v_code.device_name, v_code.scopes, v_now, v_now + interval '2160 hours', v_code.user_id, v_client)
  RETURNING id INTO v_id;
  IF v_client = 'desktop' THEN
    INSERT INTO ludy_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
    VALUES (v_code.org_id, 'user', v_code.user_id, 'kernel.extension.desktop.exchanged', ludy_kernel.uuid_v7(), 'ok', 'extension_token', v_id,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_code.id::text, 'UTF8')), 'hex'),
            pg_catalog.jsonb_build_object('codeId', v_code.id, 'extensionToken', v_id, 'client', 'desktop'));
  END IF;
  RETURN QUERY SELECT v_id, v_code.org_id, v_code.user_id, v_code.scopes, v_now + interval '2160 hours', v_code.id;
END $$;

-- ---------------------------------------------------------------------------
-- verify_extension_token and the two device lists: the marker as the last column
-- ---------------------------------------------------------------------------
-- The bodies are as they were (20261126140000, 20261128080000); only the result type gains `client`. A new result type needs a DROP;
-- the grants are restated: the API's login alone, nobody else.
-- ludy:contract adr=0055
DROP FUNCTION IF EXISTS ludy_kernel.verify_extension_token(bytea, text);
CREATE FUNCTION ludy_kernel.verify_extension_token(p_token_hash bytea, p_scope text)
RETURNS TABLE (token_id uuid, org_id uuid, user_id uuid, scopes text[], expires_at timestamptz, client text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_row ludy_kernel.extension_token%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RETURN;
  END IF;
  SELECT x.* INTO v_row
  FROM ludy_kernel.extension_token x
  JOIN ludy_kernel.tenant t ON t.org_id = x.org_id AND t.status = 'active'
  JOIN ludy_kernel.tenant_member m ON m.org_id = x.org_id AND m.user_id = x.user_id AND m.role IN ('owner', 'admin', 'member') AND m.created_at <= x.created_at
  JOIN ludy_kernel.user_account u ON u.id = x.user_id AND u.disabled_at IS NULL
  WHERE x.token_hash = p_token_hash AND x.revoked_at IS NULL AND x.expires_at > pg_catalog.clock_timestamp()
    AND (p_scope IS NULL OR p_scope = ANY (x.scopes));
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_row.last_used_at IS NULL OR v_row.last_used_at < pg_catalog.clock_timestamp() - interval '5 minutes' THEN
    UPDATE ludy_kernel.extension_token x SET last_used_at = pg_catalog.clock_timestamp() WHERE x.org_id = v_row.org_id AND x.id = v_row.id;
  END IF;
  RETURN QUERY SELECT v_row.id, v_row.org_id, v_row.user_id, v_row.scopes, v_row.expires_at, v_row.client;
END $$;

-- ludy:contract adr=0055
DROP FUNCTION IF EXISTS ludy_kernel.list_extension_tokens();
CREATE FUNCTION ludy_kernel.list_extension_tokens()
RETURNS TABLE (id uuid, device_name text, scopes text[], created_at timestamptz, expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz, client text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT x.id, x.device_name, x.scopes, x.created_at, x.expires_at, x.last_used_at, x.revoked_at, x.client
  FROM ludy_kernel.extension_token x
  WHERE x.org_id = v_org AND x.user_id = v_user
    AND x.expires_at > pg_catalog.now() - interval '30 days'
    AND (x.revoked_at IS NULL OR x.revoked_at > pg_catalog.now() - interval '30 days')
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 100;
END $$;

-- ludy:contract adr=0055
DROP FUNCTION IF EXISTS ludy_kernel.list_extension_tokens_for_org();
CREATE FUNCTION ludy_kernel.list_extension_tokens_for_org()
RETURNS TABLE (id uuid, user_id uuid, device_name text, scopes text[], created_at timestamptz, expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz, client text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  PERFORM ludy_kernel.ext_device_caller_role();
  RETURN QUERY
  SELECT x.id, x.user_id, x.device_name, x.scopes, x.created_at, x.expires_at, x.last_used_at, x.revoked_at, x.client
  FROM ludy_kernel.extension_token x
  WHERE x.org_id = v_org
    AND x.expires_at > pg_catalog.now() - interval '30 days'
    AND (x.revoked_at IS NULL OR x.revoked_at > pg_catalog.now() - interval '30 days')
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 200;
END $$;

-- The grants of the five functions (CREATE OR REPLACE keeps them; the lint asks for them stated after every definition): the API's login alone.
REVOKE ALL ON FUNCTION
  ludy_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text),
  ludy_kernel.exchange_extension_auth_code(bytea, text, bytea, text),
  ludy_kernel.verify_extension_token(bytea, text),
  ludy_kernel.list_extension_tokens(),
  ludy_kernel.list_extension_tokens_for_org()
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user AND rolname <> 'ludy_app' LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION ludy_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text), '
      'ludy_kernel.exchange_extension_auth_code(bytea, text, bytea, text), ludy_kernel.verify_extension_token(bytea, text), '
      'ludy_kernel.list_extension_tokens(), ludy_kernel.list_extension_tokens_for_org() FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  ludy_kernel.issue_extension_auth_code(bytea, text, text, text[], text, text),
  ludy_kernel.exchange_extension_auth_code(bytea, text, bytea, text),
  ludy_kernel.verify_extension_token(bytea, text),
  ludy_kernel.list_extension_tokens(),
  ludy_kernel.list_extension_tokens_for_org()
TO ludy_app;
