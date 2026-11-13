-- SPDX-License-Identifier: AGPL-3.0-only
-- The member-bound MCP grant, step 3a-2 (ADR-0051 decision 2, last bullet; design note on #2975, slice 3). A grant is a company grant (an owner or admin consented for the company,
-- as until now) or a member grant (a member consented for themself and it runs under that member's rights). What this migration changes and what it leaves:
-- - agent_grant.kind ('company' default, 'member'). member_id was a placeholder that could only be NULL; it now says whose grant it is: NULL for a company grant and the consenting user
--   for a member grant, nobody else (a CHECK). The private scope `ludy.member.read` is a member grant's alone (a CHECK). It ships dark: no query declares it and no screen asks for it.
-- - tenant.mcp_member_grants, the org's switch, false by default and changed only by an owner (mcp_member_grants_set). While it is off no member or viewer can consent, and turning it off
--   ends every non-admin member grant at its next request (the standing function below reads it live).
-- - mcp_grant_standing branches on kind: a company grant as before (the consenting user is still an owner or admin who joined before the grant); a member grant while its member is still an
--   active member who joined before the grant, whatever the role, and for a member or viewer only while the switch is on. The role is read live by the context that runs the call.
-- - mcp_member_grant_approve records a member grant. mcp_grant_approve (the company grant) and every signature that already exists are untouched.
-- Nothing here gives an MCP call a new reach: reads only, no command, no private data (the context that keeps private tables closed to a member grant is step 3b).

ALTER TABLE crove_kernel.agent_grant ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'company';

DO $$
BEGIN
  -- The placeholder that only allowed NULL, and the scope list, are replaced by named checks that know the kind.
  ALTER TABLE crove_kernel.agent_grant DROP CONSTRAINT IF EXISTS agent_grant_member_id_check;
  ALTER TABLE crove_kernel.agent_grant DROP CONSTRAINT IF EXISTS agent_grant_scopes_check;
  ALTER TABLE crove_kernel.agent_grant ADD CONSTRAINT agent_grant_kind_ck CHECK (kind IN ('company', 'member'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE crove_kernel.agent_grant ADD CONSTRAINT agent_grant_member_ck
    CHECK ((kind = 'member') = (member_id IS NOT NULL) AND (member_id IS NULL OR member_id = user_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE crove_kernel.agent_grant ADD CONSTRAINT agent_grant_scopes_ck
    CHECK (pg_catalog.cardinality(scopes) BETWEEN 1 AND 4
           AND scopes <@ ARRAY['ludy.read', 'ludy.member.read']::text[]
           AND (NOT ('ludy.member.read' = ANY (scopes)) OR kind = 'member'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The org's switch. Off by default: a default install, and a one-person company, change nothing.
ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS mcp_member_grants boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- The switch: set by an owner, read by an owner or admin
-- ---------------------------------------------------------------------------
-- Only an owner of an active org, as a user (never an MCP grant, which the command refuses first). Returns the new value. Raises NO_CONTEXT (42501) without a user context and
-- MCP_FORBIDDEN (42501) for anyone but an owner. A change to false ends every non-admin member grant at its next request without touching a row: the standing function reads the switch.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_member_grants_set(p_on boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_on IS NULL OR NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.tenant t SET mcp_member_grants = p_on WHERE t.org_id = v_org;
  RETURN p_on;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.mcp_member_grants_get()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_on boolean;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT t.mcp_member_grants INTO v_on
  FROM crove_kernel.tenant_member m JOIN crove_kernel.tenant t ON t.org_id = m.org_id
  WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_on;
END $$;

-- For the consent page (the API's login, the page's user): for each org the user is an active member of, whether the org lets members connect their own AI app. A boolean per org
-- of the user's own memberships and nothing else.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_member_grants_for_user(p_user_id uuid)
RETURNS TABLE (org_id uuid, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.org_id, t.mcp_member_grants
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
  JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
  WHERE m.user_id = p_user_id
$$;

-- ---------------------------------------------------------------------------
-- Standing, per request: the same signature, a branch on the kind
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_standing(p_grant_id uuid, p_org_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crove_kernel.agent_grant g
    JOIN crove_kernel.tenant t ON t.org_id = g.org_id AND t.status = 'active'
    JOIN crove_kernel.tenant_member m ON m.org_id = g.org_id AND m.user_id = g.user_id AND m.created_at <= g.created_at
      AND CASE g.kind
            WHEN 'company' THEN m.role IN ('owner', 'admin')
            -- A member grant: any role, but a member or viewer only while the org's switch is on (the live value).
            ELSE m.role IN ('owner', 'admin') OR t.mcp_member_grants
          END
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
-- mcp_member_grant_approve: a member records a grant for themself
-- ---------------------------------------------------------------------------
-- The consenting user is the member (a user context, never an MCP grant). An owner or admin always; a member or viewer only while the org's switch is on. The same client's live
-- grant of the same user (of either kind) ends first, with its tokens, as for a company grant; at most 5 live member grants per user and org. Raises NO_CONTEXT (42501) without a
-- user context, MCP_FORBIDDEN (42501) for anyone who may not, a disabled user, a stopped org, a kill switch, MCP_INVALID (22023) for a bad client, name, host, scope list or end, and
-- MCP_TOO_MANY (54000) for the sixth live grant.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_member_grant_approve(
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
  v_live integer;
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
    WHERE m.org_id = v_org AND m.user_id = v_user AND (m.role IN ('owner', 'admin') OR t.mcp_member_grants)
  ) OR crove_kernel.global_kill_switch_on('ai') OR EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k WHERE k.org_id = v_org AND k.scope = 'org' AND k.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_client_id IS NULL OR pg_catalog.char_length(p_client_id) NOT BETWEEN 1 AND 512
     OR v_name IS NULL OR pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 120
     OR v_host IS NULL OR pg_catalog.char_length(v_host) NOT BETWEEN 1 AND 253 OR v_host !~ '^[a-z0-9.:\[\]-]+$'
     OR p_scopes IS NULL OR pg_catalog.cardinality(p_scopes) NOT BETWEEN 1 AND 4 OR NOT (p_scopes <@ ARRAY['ludy.read', 'ludy.member.read']::text[])
     OR p_oauth_grant_id IS NULL OR pg_catalog.char_length(p_oauth_grant_id) NOT BETWEEN 1 AND 200
     OR p_expires_at IS NULL OR p_expires_at <= pg_catalog.clock_timestamp()
     OR p_expires_at > pg_catalog.clock_timestamp() + interval '2150 hours' THEN
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT s ORDER BY s) INTO v_scopes FROM pg_catalog.unnest(p_scopes) AS s;
  SELECT g.oauth_grant_id INTO v_old FROM crove_kernel.agent_grant g
  WHERE g.org_id = v_org AND g.user_id = v_user AND g.client_id = p_client_id AND g.revoked_at IS NULL;
  IF FOUND THEN
    UPDATE crove_kernel.agent_grant g SET revoked_at = pg_catalog.clock_timestamp()
    WHERE g.org_id = v_org AND g.user_id = v_user AND g.client_id = p_client_id AND g.revoked_at IS NULL;
    PERFORM crove_kernel.oauth_record_revoke_by_grant(v_old);
  END IF;
  SELECT pg_catalog.count(*)::integer INTO v_live FROM crove_kernel.agent_grant g
  WHERE g.org_id = v_org AND g.user_id = v_user AND g.kind = 'member' AND g.revoked_at IS NULL AND g.expires_at > pg_catalog.clock_timestamp();
  IF v_live >= 5 THEN
    RAISE EXCEPTION 'MCP_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_kernel.agent_grant (org_id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
  VALUES (v_org, v_user, p_client_id, v_name, v_host, v_scopes, p_oauth_grant_id, pg_catalog.clock_timestamp(), p_expires_at, v_user, 'member', v_user)
  RETURNING id INTO v_id;
  UPDATE crove_kernel.oauth_record o SET expires_at = GREATEST(o.expires_at, pg_catalog.clock_timestamp() + interval '400 days')
  WHERE o.model = 'Client' AND o.key_hash = pg_catalog.sha256(pg_catalog.convert_to(p_client_id, 'UTF8'));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- mcp_grant_list: an owner or admin sees the org's grants, any other member only their own (a member must be able to see and cut off what they connected)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_list()
RETURNS TABLE (id uuid, user_id uuid, client_id text, client_name text, client_host text, scopes text[], created_at timestamptz, expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_all boolean;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT m.role IN ('owner', 'admin') INTO v_all FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_all IS NULL THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT g.id, g.user_id, g.client_id, g.client_name, g.client_host, g.scopes, g.created_at, g.expires_at, g.last_used_at, g.revoked_at
  FROM crove_kernel.agent_grant g
  WHERE g.org_id = v_org
    AND (v_all OR g.user_id = v_user)
    AND g.expires_at > pg_catalog.now() - interval '30 days'
    AND (g.revoked_at IS NULL OR g.revoked_at > pg_catalog.now() - interval '30 days')
  ORDER BY g.created_at DESC, g.id DESC
  LIMIT 200;
END $$;

-- ---------------------------------------------------------------------------
-- Grants: the API's login alone, nothing to PUBLIC or any other login
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.mcp_member_grants_set(boolean),
  crove_kernel.mcp_member_grants_get(),
  crove_kernel.mcp_member_grants_for_user(uuid),
  crove_kernel.mcp_member_grant_approve(text, text, text, text[], text, timestamptz)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_kernel.mcp_member_grants_set(boolean), crove_kernel.mcp_member_grants_get(), crove_kernel.mcp_member_grants_for_user(uuid), '
      'crove_kernel.mcp_member_grant_approve(text, text, text, text[], text, timestamptz) FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  crove_kernel.mcp_member_grants_set(boolean),
  crove_kernel.mcp_member_grants_get(),
  crove_kernel.mcp_member_grants_for_user(uuid),
  crove_kernel.mcp_member_grant_approve(text, text, text, text[], text, timestamptz)
TO crove_app;
