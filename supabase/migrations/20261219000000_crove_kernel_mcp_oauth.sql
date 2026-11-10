-- SPDX-License-Identifier: AGPL-3.0-only
-- The MCP endpoint's authorization server and its grants (issue #2975, ADR-0051 decision 2, ADR-0032). Idempotent; applied
-- files stay untouched.
--
-- oauth_record   the storage of the embedded OAuth 2.1 authorization server (the `oidc-provider` adapter): one row per
--                model and key, the key stored only as its SHA-256 (an authorization code, a refresh token, a session, an
--                interaction, a registered client), the library's payload as jsonb, its grant, its uid and its end.
--                No org (the authorization server knows no org until a person consents): definer-only machinery, no login
--                role grant, six functions the API alone may call.
-- agent_grant    what an owner or admin gave one MCP client: one org, the consenting user, a client, the scope
--                `ludy.read`, risk R0 and no member (a member-bound grant is a later step, so the column is there and a
--                CHECK keeps it empty). Definer-only, like extension_token; the commands reach it through definers.
--   mcp_grant_approve  an owner or admin in the org in context records a grant for a client; a grant of the same client by
--                      the same user is revoked first (one live grant per org, client and user).
--   mcp_grant_verify   the API turns a token's grant claim into (grant, org, user), or no row for every refusal.
--   mcp_grant_check    the runtime's re-check in each request's own transaction: a revoke, an expiry, a role lost, a member
--                      removed, a disabled user, an org stopped, the org's "Dung AI" or the deployment's AI switch applies
--                      to the next statement, not only to the next request.
--   mcp_grant_list     the grants of the org in context (owner and admin only), never a token.
--   mcp_grant_revoke   an owner or admin revokes any grant of the org, the consenting user revokes their own; the
--                      authorization server's refresh tokens and codes of that grant are destroyed with it.
-- A grant is void when its consenting user is no longer an owner or admin of the org (read live, never copied): it never
-- exceeds the rights of the person who gave it.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- oauth_record: the authorization server's storage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.oauth_record (
  model text NOT NULL CHECK (model ~ '^[A-Za-z]{1,40}$'),
  key_hash bytea NOT NULL CHECK (pg_catalog.octet_length(key_hash) = 32),
  payload jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(payload) = 'object' AND pg_catalog.pg_column_size(payload) <= 32768),
  grant_id text CHECK (grant_id IS NULL OR pg_catalog.char_length(grant_id) BETWEEN 1 AND 200),
  uid text CHECK (uid IS NULL OR pg_catalog.char_length(uid) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (model, key_hash)
);
CREATE INDEX IF NOT EXISTS oauth_record_grant_idx ON crove_kernel.oauth_record (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_record_uid_idx ON crove_kernel.oauth_record (model, uid) WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_record_expires_idx ON crove_kernel.oauth_record (expires_at);
ALTER TABLE crove_kernel.oauth_record ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- agent_grant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.agent_grant (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The consenting user. Not tied to tenant_member: removing the member must not be blocked, and every check reads the
  -- membership live.
  user_id uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  -- What the client calls itself: the client_id the authorization server holds (a registered id or a metadata URL), a
  -- name the client declared (shown as self-declared) and the host its redirect URI points to.
  client_id text NOT NULL CHECK (pg_catalog.char_length(client_id) BETWEEN 1 AND 512),
  client_name text NOT NULL CHECK (pg_catalog.char_length(client_name) BETWEEN 1 AND 120),
  client_host text NOT NULL CHECK (pg_catalog.char_length(client_host) BETWEEN 1 AND 253),
  -- A new scope is a migration that widens this list.
  scopes text[] NOT NULL CHECK (pg_catalog.cardinality(scopes) BETWEEN 1 AND 4 AND scopes <@ ARRAY['ludy.read']::text[]),
  -- Reads only in this step.
  max_risk text NOT NULL DEFAULT 'R0' CHECK (max_risk = 'R0'),
  -- Empty until the member-bound grant (ADR-0049 over MCP) is built; the CHECK keeps it so.
  member_id uuid CHECK (member_id IS NULL),
  -- The authorization server's own grant id, so a revoke destroys that grant's refresh tokens.
  oauth_grant_id text CHECK (oauth_grant_id IS NULL OR pg_catalog.char_length(oauth_grant_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid NOT NULL,
  PRIMARY KEY (org_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '2160 hours')
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_grant_live_uq ON crove_kernel.agent_grant (org_id, user_id, client_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_grant_oauth_uq ON crove_kernel.agent_grant (oauth_grant_id) WHERE oauth_grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_grant_org_idx ON crove_kernel.agent_grant (org_id, created_at DESC);
ALTER TABLE crove_kernel.agent_grant ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON crove_kernel.oauth_record, crove_kernel.agent_grant FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_kernel.oauth_record, crove_kernel.agent_grant FROM %I', r.rolname);
  END LOOP;
END $$;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard (#285) on tenant tables; an agent
-- context never approves, lists or revokes a grant.
SELECT crove_kernel.agent_write_guard_install('crove_kernel.oauth_record');
SELECT crove_kernel.agent_write_guard_install('crove_kernel.agent_grant');

-- ---------------------------------------------------------------------------
-- oauth_record functions (the adapter's six calls)
-- ---------------------------------------------------------------------------
-- Writes one record (insert or replace the payload, grant, uid and end; a consumed mark survives a replace). A few
-- records a day past their end are cleared with it, so no sweep is needed. Raises OAUTH_INVALID (22023) for a bad key
-- hash, model or end.
CREATE OR REPLACE FUNCTION crove_kernel.oauth_record_upsert(
  p_model text, p_key_hash bytea, p_payload jsonb, p_grant_id text, p_uid text, p_expires_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_model IS NULL OR p_model !~ '^[A-Za-z]{1,40}$' OR p_key_hash IS NULL OR pg_catalog.octet_length(p_key_hash) <> 32
     OR p_payload IS NULL OR p_expires_at IS NULL OR p_expires_at <= pg_catalog.clock_timestamp()
     OR p_expires_at > pg_catalog.clock_timestamp() + interval '400 days' THEN
    RAISE EXCEPTION 'OAUTH_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.oauth_record o
  WHERE (o.model, o.key_hash) IN (
    SELECT x.model, x.key_hash FROM crove_kernel.oauth_record x
    WHERE x.expires_at < pg_catalog.clock_timestamp() - interval '1 day' LIMIT 50);
  INSERT INTO crove_kernel.oauth_record (model, key_hash, payload, grant_id, uid, expires_at)
  VALUES (p_model, p_key_hash, p_payload, p_grant_id, p_uid, p_expires_at)
  ON CONFLICT (model, key_hash) DO UPDATE
    SET payload = EXCLUDED.payload, grant_id = EXCLUDED.grant_id, uid = EXCLUDED.uid, expires_at = EXCLUDED.expires_at;
END $$;

-- One live record: not expired. Answers its payload and whether it was consumed.
CREATE OR REPLACE FUNCTION crove_kernel.oauth_record_find(p_model text, p_key_hash bytea)
RETURNS TABLE (payload jsonb, consumed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT o.payload, o.consumed_at FROM crove_kernel.oauth_record o
  WHERE o.model = p_model AND o.key_hash = p_key_hash AND o.expires_at > pg_catalog.clock_timestamp()
$$;

CREATE OR REPLACE FUNCTION crove_kernel.oauth_record_find_by_uid(p_model text, p_uid text)
RETURNS TABLE (payload jsonb, consumed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT o.payload, o.consumed_at FROM crove_kernel.oauth_record o
  WHERE o.model = p_model AND o.uid = p_uid AND o.expires_at > pg_catalog.clock_timestamp()
  ORDER BY o.created_at DESC LIMIT 1
$$;

-- Marks a record consumed, once: true when this call did it.
CREATE OR REPLACE FUNCTION crove_kernel.oauth_record_consume(p_model text, p_key_hash bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE crove_kernel.oauth_record o SET consumed_at = pg_catalog.clock_timestamp()
  WHERE o.model = p_model AND o.key_hash = p_key_hash AND o.consumed_at IS NULL AND o.expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.oauth_record_destroy(p_model text, p_key_hash bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  DELETE FROM crove_kernel.oauth_record o WHERE o.model = p_model AND o.key_hash = p_key_hash
$$;

-- Destroys every record of one authorization grant (its refresh tokens, codes and the grant itself).
CREATE OR REPLACE FUNCTION crove_kernel.oauth_record_revoke_by_grant(p_grant_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_grant_id IS NULL OR pg_catalog.char_length(p_grant_id) = 0 THEN
    RETURN 0;
  END IF;
  DELETE FROM crove_kernel.oauth_record o WHERE o.grant_id = p_grant_id OR (o.model = 'Grant' AND o.payload ->> 'jti' = p_grant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------------------
-- The standing of a grant, shared by verify and check
-- ---------------------------------------------------------------------------
-- True when the grant is live (not revoked, not expired), the org is active and not stopped (the org's "Dung AI" or the
-- deployment's AI switch), and the consenting user is still an owner or admin of the org who joined no later than the
-- grant was made, and not disabled. No other role, no copy of a role: read live.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_standing(p_grant_id uuid, p_org_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crove_kernel.agent_grant g
    JOIN crove_kernel.tenant t ON t.org_id = g.org_id AND t.status = 'active'
    JOIN crove_kernel.tenant_member m ON m.org_id = g.org_id AND m.user_id = g.user_id AND m.role IN ('owner', 'admin') AND m.created_at <= g.created_at
    JOIN crove_kernel.user_account u ON u.id = g.user_id AND u.disabled_at IS NULL
    WHERE g.id = p_grant_id AND g.org_id = p_org_id AND g.user_id = p_user_id
      AND g.revoked_at IS NULL AND g.expires_at > pg_catalog.clock_timestamp()
      AND NOT crove_kernel.global_kill_switch_on('ai')
      AND NOT EXISTS (
        SELECT 1 FROM crove_kernel.kill_switch k
        WHERE k.org_id = g.org_id AND k.scope = 'org' AND k.released_at IS NULL)
  )
$$;

-- ---------------------------------------------------------------------------
-- mcp_grant_approve
-- ---------------------------------------------------------------------------
-- An owner or admin of the org in context records a grant for a client. Revokes a live grant of the same client by the
-- same user first, and destroys that grant's tokens. Extends the registered client's record to 30 days from now, so a
-- registration that never obtained a grant expires while one that did stays. Returns the grant's id. Raises NO_CONTEXT
-- (42501) without a user context, MCP_FORBIDDEN (42501) for anyone but an owner or admin of an active org, a disabled
-- user, or an org that is stopped, MCP_INVALID (22023) for a bad client id, name, host, scope list or end.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_approve(
  p_client_id text, p_client_name text, p_client_host text, p_scopes text[], p_oauth_grant_id text, p_expires_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_name text := pg_catalog.btrim(p_client_name);
  v_host text := pg_catalog.lower(pg_catalog.btrim(p_client_host));
  v_scopes text[];
  v_old text;
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
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) OR crove_kernel.global_kill_switch_on('ai') OR EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k WHERE k.org_id = v_org AND k.scope = 'org' AND k.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_client_id IS NULL OR pg_catalog.char_length(p_client_id) NOT BETWEEN 1 AND 512
     OR v_name IS NULL OR pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 120
     OR v_host IS NULL OR pg_catalog.char_length(v_host) NOT BETWEEN 1 AND 253 OR v_host !~ '^[a-z0-9.:\[\]-]+$'
     OR p_scopes IS NULL OR pg_catalog.cardinality(p_scopes) NOT BETWEEN 1 AND 4 OR NOT (p_scopes <@ ARRAY['ludy.read']::text[])
     OR p_oauth_grant_id IS NULL OR pg_catalog.char_length(p_oauth_grant_id) NOT BETWEEN 1 AND 200
     OR p_expires_at IS NULL OR p_expires_at <= pg_catalog.clock_timestamp()
     OR p_expires_at > pg_catalog.clock_timestamp() + interval '2150 hours' THEN
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT s ORDER BY s) INTO v_scopes FROM pg_catalog.unnest(p_scopes) AS s;
  -- The same user's live grant of the same client ends, with its tokens (the new one is a new consent).
  SELECT g.oauth_grant_id INTO v_old FROM crove_kernel.agent_grant g
  WHERE g.org_id = v_org AND g.user_id = v_user AND g.client_id = p_client_id AND g.revoked_at IS NULL;
  IF FOUND THEN
    UPDATE crove_kernel.agent_grant g SET revoked_at = pg_catalog.clock_timestamp()
    WHERE g.org_id = v_org AND g.user_id = v_user AND g.client_id = p_client_id AND g.revoked_at IS NULL;
    PERFORM crove_kernel.oauth_record_revoke_by_grant(v_old);
  END IF;
  INSERT INTO crove_kernel.agent_grant (org_id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
  VALUES (v_org, v_user, p_client_id, v_name, v_host, v_scopes, p_oauth_grant_id, pg_catalog.clock_timestamp(), p_expires_at, v_user)
  RETURNING id INTO v_id;
  UPDATE crove_kernel.oauth_record o SET expires_at = pg_catalog.greatest(o.expires_at, pg_catalog.clock_timestamp() + interval '400 days')
  WHERE o.model = 'Client' AND o.key_hash = pg_catalog.sha256(pg_catalog.convert_to(p_client_id, 'UTF8'));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- mcp_grant_verify and mcp_grant_check
-- ---------------------------------------------------------------------------
-- The API turns a token's grant claim into its row, or none (every refusal alike); the client must be the grant's. It
-- stamps last_used_at at most every 5 minutes.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_verify(p_grant_id uuid, p_client_id text)
RETURNS TABLE (grant_id uuid, org_id uuid, user_id uuid, scopes text[], client_name text, client_host text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_row crove_kernel.agent_grant%ROWTYPE;
BEGIN
  IF p_grant_id IS NULL OR p_client_id IS NULL THEN
    RETURN;
  END IF;
  SELECT g.* INTO v_row FROM crove_kernel.agent_grant g WHERE g.id = p_grant_id AND g.client_id = p_client_id;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(v_row.id, v_row.org_id, v_row.user_id) THEN
    RETURN;
  END IF;
  IF v_row.last_used_at IS NULL OR v_row.last_used_at < pg_catalog.clock_timestamp() - interval '5 minutes' THEN
    UPDATE crove_kernel.agent_grant g SET last_used_at = pg_catalog.clock_timestamp() WHERE g.org_id = v_row.org_id AND g.id = v_row.id;
  END IF;
  RETURN QUERY SELECT v_row.id, v_row.org_id, v_row.user_id, v_row.scopes, v_row.client_name, v_row.client_host, v_row.expires_at;
END $$;

-- The runtime's own re-check, in the transaction of each request an MCP grant makes, before the context is entered:
-- raises MCP_GRANT_INVALID (28000, answered 401) unless the grant is this user's, for this org, and in good standing.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_check(p_grant_id uuid, p_user_id uuid, p_org_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_grant_id IS NULL OR p_user_id IS NULL OR p_org_id IS NULL OR NOT crove_kernel.mcp_grant_standing(p_grant_id, p_org_id, p_user_id) THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- mcp_grant_list and mcp_grant_revoke
-- ---------------------------------------------------------------------------
-- The grants of the org in context, newest first, for an owner or admin: the live ones, and those that ended or were
-- revoked in the last 30 days. Never a token. Raises NO_CONTEXT (42501) without a user context, MCP_FORBIDDEN (42501)
-- for any other role.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_list()
RETURNS TABLE (id uuid, user_id uuid, client_id text, client_name text, client_host text, scopes text[], created_at timestamptz, expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT g.id, g.user_id, g.client_id, g.client_name, g.client_host, g.scopes, g.created_at, g.expires_at, g.last_used_at, g.revoked_at
  FROM crove_kernel.agent_grant g
  WHERE g.org_id = v_org
    AND g.expires_at > pg_catalog.now() - interval '30 days'
    AND (g.revoked_at IS NULL OR g.revoked_at > pg_catalog.now() - interval '30 days')
  ORDER BY g.created_at DESC, g.id DESC
  LIMIT 200;
END $$;

-- Revokes one grant of the org in context: an owner or admin any, the consenting user their own. true when it was live and
-- is now revoked; false for every other case alike (unknown id, another org's grant, already revoked, not allowed), so
-- nothing tells them apart. Its refresh tokens and codes are destroyed with it.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_revoke(p_grant_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_oauth text;
  v_count integer;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.agent_grant g SET revoked_at = pg_catalog.clock_timestamp()
  WHERE g.org_id = v_org AND g.id = p_grant_id AND g.revoked_at IS NULL
    AND (g.user_id = v_user OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')))
  RETURNING g.oauth_grant_id INTO v_oauth;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 1 THEN
    PERFORM crove_kernel.oauth_record_revoke_by_grant(v_oauth);
  END IF;
  RETURN v_count = 1;
END $$;

-- ---------------------------------------------------------------------------
-- Grants: the API's login alone. The worker never takes part in an authorization or an MCP request.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.oauth_record_upsert(text, bytea, jsonb, text, text, timestamptz),
  crove_kernel.oauth_record_find(text, bytea),
  crove_kernel.oauth_record_find_by_uid(text, text),
  crove_kernel.oauth_record_consume(text, bytea),
  crove_kernel.oauth_record_destroy(text, bytea),
  crove_kernel.oauth_record_revoke_by_grant(text),
  crove_kernel.mcp_grant_standing(uuid, uuid, uuid),
  crove_kernel.mcp_grant_approve(text, text, text, text[], text, timestamptz),
  crove_kernel.mcp_grant_verify(uuid, text),
  crove_kernel.mcp_grant_check(uuid, uuid, uuid),
  crove_kernel.mcp_grant_list(),
  crove_kernel.mcp_grant_revoke(uuid)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_kernel.oauth_record_upsert(text, bytea, jsonb, text, text, timestamptz), '
      'crove_kernel.oauth_record_find(text, bytea), crove_kernel.oauth_record_find_by_uid(text, text), '
      'crove_kernel.oauth_record_consume(text, bytea), crove_kernel.oauth_record_destroy(text, bytea), '
      'crove_kernel.oauth_record_revoke_by_grant(text), crove_kernel.mcp_grant_standing(uuid, uuid, uuid), '
      'crove_kernel.mcp_grant_approve(text, text, text, text[], text, timestamptz), crove_kernel.mcp_grant_verify(uuid, text), '
      'crove_kernel.mcp_grant_check(uuid, uuid, uuid), crove_kernel.mcp_grant_list(), crove_kernel.mcp_grant_revoke(uuid) FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  crove_kernel.oauth_record_upsert(text, bytea, jsonb, text, text, timestamptz),
  crove_kernel.oauth_record_find(text, bytea),
  crove_kernel.oauth_record_find_by_uid(text, text),
  crove_kernel.oauth_record_consume(text, bytea),
  crove_kernel.oauth_record_destroy(text, bytea),
  crove_kernel.oauth_record_revoke_by_grant(text),
  crove_kernel.mcp_grant_standing(uuid, uuid, uuid),
  crove_kernel.mcp_grant_approve(text, text, text, text[], text, timestamptz),
  crove_kernel.mcp_grant_verify(uuid, text),
  crove_kernel.mcp_grant_check(uuid, uuid, uuid),
  crove_kernel.mcp_grant_list(),
  crove_kernel.mcp_grant_revoke(uuid)
TO crove_app;
