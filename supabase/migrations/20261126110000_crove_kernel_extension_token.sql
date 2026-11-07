-- SPDX-License-Identifier: AGPL-3.0-only
-- The Ludy extension token (issue #2582, ADR-0047 point 10, AI Meeting Notes plan M8). Idempotent; applied files stay
-- untouched. Step 2 of 2: step 1 (#2661) merged the invariants (extension-tokens.db.test.ts, the RLS matrix rows).
--
-- extension_auth_code  one row per sign-in the member approved for the extension: the SHA-256 of a one-time code, the
--                      PKCE challenge (S256) the extension sent, the scopes and a 5 minute life. Single use: the
--                      exchange marks it consumed in the statement that makes the token. Five wrong verifiers burn it.
-- extension_token      one row per connected device: the SHA-256 of an opaque token, one org, one member, the scopes
--                      of the features the member turned on, 90 days at most, revocable. Neither the code nor the
--                      token is ever stored or passed to SQL in clear; the kernel hashes them first.
-- Both are definer-only machinery (RLS on, no grant to any Crove role; the RLS matrix lists them in MACHINERY):
--   issue_extension_auth_code    the signed-in member (owner, admin or member) in the org in context records a code.
--   exchange_extension_auth_code the API, with no member context (the extension holds no session), trades a code and
--                                its PKCE verifier for a token, once.
--   verify_extension_token       the API turns a presented token's hash into (token, org, member, scopes), or no row
--                                when it is revoked, expired, its member was removed (or removed and re-added since),
--                                is a viewer, is disabled, the org is not active or the scope is not one it holds.
--   extension_token_check        the runtime re-checks the same facts in each request's own transaction, so a revoke
--                                or a removal applies at once, also to a request already past authentication.
--   list_extension_tokens        the member's own devices in the org in context, never a hash.
--   revoke_extension_token       the member revokes one of their own devices.
-- A token is void when its member is removed from the org: verify and check read tenant_member live. The member row's
-- created_at must not be later than the token's, so removing a member and adding them back does not revive tokens.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.extension_token (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- Not tied to tenant_member: removing the member must not be blocked, and verify reads the membership live.
  user_id uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  token_hash bytea NOT NULL CHECK (pg_catalog.octet_length(token_hash) = 32),
  device_name text NOT NULL CHECK (pg_catalog.char_length(device_name) BETWEEN 1 AND 80),
  -- The scopes of the features the member turned on. A new scope is a migration that widens this list.
  scopes text[] NOT NULL CHECK (pg_catalog.cardinality(scopes) BETWEEN 1 AND 8 AND scopes <@ ARRAY['meetings']::text[]),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid NOT NULL,
  PRIMARY KEY (org_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '2160 hours')
);
CREATE UNIQUE INDEX IF NOT EXISTS extension_token_hash_uq ON crove_kernel.extension_token (token_hash);
CREATE INDEX IF NOT EXISTS extension_token_member_idx ON crove_kernel.extension_token (org_id, user_id, created_at DESC);
ALTER TABLE crove_kernel.extension_token ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS crove_kernel.extension_auth_code (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  code_hash bytea NOT NULL CHECK (pg_catalog.octet_length(code_hash) = 32),
  -- RFC 7636 S256: the unpadded base64url SHA-256 of the verifier, 43 characters.
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_challenge_method text NOT NULL CHECK (code_challenge_method = 'S256'),
  scopes text[] NOT NULL CHECK (pg_catalog.cardinality(scopes) BETWEEN 1 AND 8 AND scopes <@ ARRAY['meetings']::text[]),
  device_name text NOT NULL CHECK (pg_catalog.char_length(device_name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  PRIMARY KEY (org_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE UNIQUE INDEX IF NOT EXISTS extension_auth_code_hash_uq ON crove_kernel.extension_auth_code (code_hash);
CREATE INDEX IF NOT EXISTS extension_auth_code_open_idx ON crove_kernel.extension_auth_code (org_id, user_id) WHERE consumed_at IS NULL;
ALTER TABLE crove_kernel.extension_auth_code ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON crove_kernel.extension_token, crove_kernel.extension_auth_code FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_kernel.extension_token, crove_kernel.extension_auth_code FROM %I', r.rolname);
  END LOOP;
END $$;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard (#285) on tenant tables; an agent
-- context never issues, lists or revokes a device.
SELECT crove_kernel.agent_write_guard_install('crove_kernel.extension_token');
SELECT crove_kernel.agent_write_guard_install('crove_kernel.extension_auth_code');

-- ---------------------------------------------------------------------------
-- issue_extension_auth_code
-- ---------------------------------------------------------------------------
-- Records the one-time code the signed-in member approved for the extension, in the org in context; returns its id.
-- Raises NO_CONTEXT (42501) without a user context, EXTENSION_FORBIDDEN (42501) for a viewer, a disabled user or an
-- org that is not active, EXTENSION_INVALID (22023) for a malformed hash, challenge, method, scope list or device name,
-- and EXTENSION_TOO_MANY (54000) with 10 open codes of the member in the org. Rows a day past their end are cleared.
CREATE OR REPLACE FUNCTION crove_kernel.issue_extension_auth_code(
  p_code_hash bytea, p_code_challenge text, p_method text, p_scopes text[], p_device_name text)
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
     OR v_device IS NULL OR pg_catalog.char_length(v_device) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'EXTENSION_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT s ORDER BY s) INTO v_scopes FROM pg_catalog.unnest(p_scopes) AS s;
  DELETE FROM crove_kernel.extension_auth_code c WHERE c.org_id = v_org AND c.created_at < pg_catalog.now() - interval '1 day';
  IF (SELECT pg_catalog.count(*) FROM crove_kernel.extension_auth_code c
      WHERE c.org_id = v_org AND c.user_id = v_user AND c.consumed_at IS NULL AND c.expires_at > pg_catalog.now()) >= 10 THEN
    RAISE EXCEPTION 'EXTENSION_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_kernel.extension_auth_code (org_id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, created_at, expires_at)
  VALUES (v_org, v_user, p_code_hash, p_code_challenge, 'S256', v_scopes, v_device, pg_catalog.now(), pg_catalog.now() + interval '5 minutes')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- exchange_extension_auth_code
-- ---------------------------------------------------------------------------
-- Trades a code and its PKCE verifier for a token, once, with no member context (the extension holds no session).
-- Answers one row, or none for every refusal alike, so nothing tells an unknown code from a used, expired or wrong one:
-- the code is unknown, consumed or expired, the verifier is not the one the challenge came from (the code survives
-- until the fifth wrong verifier burns it), or the member is no longer an owner, admin or member of an active org or
-- is disabled. The code is consumed and the token inserted in one statement sequence under the code's row lock, so
-- two exchanges of one code cannot both win. The token lives 90 days (2160 hours, so a session time zone cannot move the bound); a member keeps at most 20 live tokens in an
-- org, the oldest revoked past that.
CREATE OR REPLACE FUNCTION crove_kernel.exchange_extension_auth_code(p_code_hash bytea, p_code_verifier text, p_token_hash bytea)
RETURNS TABLE (token_id uuid, org_id uuid, user_id uuid, scopes text[], expires_at timestamptz)
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
  v_challenge := pg_catalog.translate(
    pg_catalog.rtrim(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code_verifier, 'UTF8')), 'base64'), '='), '+/', '-_');
  IF v_challenge <> v_code.code_challenge THEN
    UPDATE crove_kernel.extension_auth_code c
    SET failed_attempts = c.failed_attempts + 1,
        consumed_at = CASE WHEN c.failed_attempts + 1 >= 5 THEN v_now ELSE NULL END
    WHERE c.org_id = v_code.org_id AND c.id = v_code.id;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_code.org_id AND m.user_id = v_code.user_id AND m.role IN ('owner', 'admin', 'member')
      AND m.created_at <= v_code.created_at
  ) THEN
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
  RETURN QUERY SELECT v_id, v_code.org_id, v_code.user_id, v_code.scopes, v_now + interval '2160 hours';
END $$;

-- ---------------------------------------------------------------------------
-- verify_extension_token and extension_token_check
-- ---------------------------------------------------------------------------
-- The one test of a token's standing, shared by both: not revoked, not expired, the org active, the member still an
-- owner, admin or member who joined no later than the token was made, and not disabled.
-- verify_extension_token turns a presented token's hash into its row, or none (every refusal alike); with a scope it
-- also needs the token to hold it. It stamps last_used_at at most every 5 minutes.
CREATE OR REPLACE FUNCTION crove_kernel.verify_extension_token(p_token_hash bytea, p_scope text)
RETURNS TABLE (token_id uuid, org_id uuid, user_id uuid, scopes text[], expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_row crove_kernel.extension_token%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RETURN;
  END IF;
  SELECT x.* INTO v_row
  FROM crove_kernel.extension_token x
  JOIN crove_kernel.tenant t ON t.org_id = x.org_id AND t.status = 'active'
  JOIN crove_kernel.tenant_member m ON m.org_id = x.org_id AND m.user_id = x.user_id AND m.role IN ('owner', 'admin', 'member') AND m.created_at <= x.created_at
  JOIN crove_kernel.user_account u ON u.id = x.user_id AND u.disabled_at IS NULL
  WHERE x.token_hash = p_token_hash AND x.revoked_at IS NULL AND x.expires_at > pg_catalog.clock_timestamp()
    AND (p_scope IS NULL OR p_scope = ANY (x.scopes));
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_row.last_used_at IS NULL OR v_row.last_used_at < pg_catalog.clock_timestamp() - interval '5 minutes' THEN
    UPDATE crove_kernel.extension_token x SET last_used_at = pg_catalog.clock_timestamp() WHERE x.org_id = v_row.org_id AND x.id = v_row.id;
  END IF;
  RETURN QUERY SELECT v_row.id, v_row.org_id, v_row.user_id, v_row.scopes, v_row.expires_at;
END $$;

-- The runtime's own re-check, in the transaction of each request an extension token makes, before the context is
-- entered: raises EXTENSION_TOKEN_INVALID (28000, answered 401) unless the token is this member's, for this org, and in
-- good standing. So a revoke, an expiry or a removal applies to the next statement, not only to the next request.
CREATE OR REPLACE FUNCTION crove_kernel.extension_token_check(p_token_id uuid, p_user_id uuid, p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_token_id IS NULL OR p_user_id IS NULL OR p_org_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM crove_kernel.extension_token x
    JOIN crove_kernel.tenant t ON t.org_id = x.org_id AND t.status = 'active'
    JOIN crove_kernel.tenant_member m ON m.org_id = x.org_id AND m.user_id = x.user_id AND m.role IN ('owner', 'admin', 'member') AND m.created_at <= x.created_at
    JOIN crove_kernel.user_account u ON u.id = x.user_id AND u.disabled_at IS NULL
    WHERE x.id = p_token_id AND x.org_id = p_org_id AND x.user_id = p_user_id
      AND x.revoked_at IS NULL AND x.expires_at > pg_catalog.clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'EXTENSION_TOKEN_INVALID' USING ERRCODE = '28000';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- list_extension_tokens and revoke_extension_token
-- ---------------------------------------------------------------------------
-- The member's own devices in the org in context (never another member's, never a hash): live ones, and those that
-- ended or were revoked in the last 30 days, newest first. Any member role may list and revoke their own devices, so a
-- member demoted to viewer can still cut theirs off. Raises NO_CONTEXT (42501) without a user context.
CREATE OR REPLACE FUNCTION crove_kernel.list_extension_tokens()
RETURNS TABLE (id uuid, device_name text, scopes text[], created_at timestamptz, expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT x.id, x.device_name, x.scopes, x.created_at, x.expires_at, x.last_used_at, x.revoked_at
  FROM crove_kernel.extension_token x
  WHERE x.org_id = v_org AND x.user_id = v_user
    AND x.expires_at > pg_catalog.now() - interval '30 days'
    AND (x.revoked_at IS NULL OR x.revoked_at > pg_catalog.now() - interval '30 days')
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 100;
END $$;

-- Revokes one of the member's own devices in the org in context. true when it was live and is now revoked; false for
-- any other case alike (unknown id, another member's or org's device, already revoked), so nothing tells them apart.
CREATE OR REPLACE FUNCTION crove_kernel.revoke_extension_token(p_token_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_count integer;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.extension_token x SET revoked_at = pg_catalog.clock_timestamp()
  WHERE x.org_id = v_org AND x.user_id = v_user AND x.id = p_token_id AND x.revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- ---------------------------------------------------------------------------
-- Grants: the API's login alone. The worker never takes part in an extension sign-in or request.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.issue_extension_auth_code(bytea, text, text, text[], text),
  crove_kernel.exchange_extension_auth_code(bytea, text, bytea),
  crove_kernel.verify_extension_token(bytea, text),
  crove_kernel.extension_token_check(uuid, uuid, uuid),
  crove_kernel.list_extension_tokens(),
  crove_kernel.revoke_extension_token(uuid)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_kernel.issue_extension_auth_code(bytea, text, text, text[], text), '
      'crove_kernel.exchange_extension_auth_code(bytea, text, bytea), crove_kernel.verify_extension_token(bytea, text), '
      'crove_kernel.extension_token_check(uuid, uuid, uuid), crove_kernel.list_extension_tokens(), '
      'crove_kernel.revoke_extension_token(uuid) FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  crove_kernel.issue_extension_auth_code(bytea, text, text, text[], text),
  crove_kernel.exchange_extension_auth_code(bytea, text, bytea),
  crove_kernel.verify_extension_token(bytea, text),
  crove_kernel.extension_token_check(uuid, uuid, uuid),
  crove_kernel.list_extension_tokens(),
  crove_kernel.revoke_extension_token(uuid)
TO crove_app;
