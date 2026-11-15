-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0051 decision 2, issue #3227, step 3b (owner decision 2026-11-14), closing the notes of the reviews of step 3a before a client can obtain `ludy.social.draft`:
-- - a grant that holds the draft scope holds `ludy.read` with it (Platform PO note 1 on #3244): the CHECK says so, mcp_grant_approve refuses a draft-only consent, and the draft entry requires both, so a
--   draft-only grant can never enter the read context either;
-- - the draft entry checks that the grant row it locks is the one whose user it read first (the order a demotion takes: member row, then grant row).
-- Forward only: 20261231180000 is applied and untouched; the two functions are restated whole from it with the lines above changed. Idempotent.
SET LOCAL lock_timeout = '2s';

-- A grant that holds the draft scope without the read scope (20261231180000 let the grant definer accept one, though no consent page could ask for it) is ended first, with its tokens: it could
-- enter the read context alone. The CHECK below is then added NOT VALID, so such an ended row (the only kind that can exist) never fails the deploy, and every new or changed row is held to the rule.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT g.org_id, g.id, g.oauth_grant_id FROM crove_kernel.agent_grant g
           WHERE 'ludy.social.draft' = ANY (g.scopes) AND NOT ('ludy.read' = ANY (g.scopes)) AND g.revoked_at IS NULL LOOP
    UPDATE crove_kernel.agent_grant g SET revoked_at = pg_catalog.clock_timestamp() WHERE g.org_id = r.org_id AND g.id = r.id;
    PERFORM crove_kernel.oauth_record_revoke_by_grant(r.oauth_grant_id);
  END LOOP;
END $$;

DO $$
BEGIN
  ALTER TABLE crove_kernel.agent_grant DROP CONSTRAINT IF EXISTS agent_grant_scopes_ck;
  ALTER TABLE crove_kernel.agent_grant ADD CONSTRAINT agent_grant_scopes_ck
    CHECK (pg_catalog.cardinality(scopes) BETWEEN 1 AND 4
           AND scopes <@ ARRAY['ludy.read', 'ludy.member.read', 'ludy.social.draft']::text[]
           AND (NOT ('ludy.member.read' = ANY (scopes)) OR kind = 'member')
           AND (NOT ('ludy.social.draft' = ANY (scopes)) OR (kind = 'company' AND 'ludy.read' = ANY (scopes)))) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- Validated whenever every row already holds (the usual case: no draft-only grant ever existed); left NOT VALID only if an ended one does, which still holds every new row to the rule.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.agent_grant g WHERE 'ludy.social.draft' = ANY (g.scopes) AND NOT ('ludy.read' = ANY (g.scopes))) THEN
    ALTER TABLE crove_kernel.agent_grant VALIDATE CONSTRAINT agent_grant_scopes_ck;
  END IF;
END $$;

-- The company grant's definer, restated whole from 20261231180000 with one more condition on the scopes: the read scope is always among them.
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
     OR p_scopes IS NULL OR pg_catalog.cardinality(p_scopes) NOT BETWEEN 1 AND 4 OR NOT (p_scopes <@ ARRAY['ludy.read', 'ludy.social.draft']::text[])
     OR NOT ('ludy.read' = ANY (p_scopes))
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
  UPDATE crove_kernel.oauth_record o SET expires_at = GREATEST(o.expires_at, pg_catalog.clock_timestamp() + interval '400 days')
  WHERE o.model = 'Client' AND o.key_hash = pg_catalog.sha256(pg_catalog.convert_to(p_client_id, 'UTF8'));
  RETURN v_id;
END $$;

-- The write context of the draft command, restated whole from 20261231180000.
CREATE OR REPLACE FUNCTION crove_kernel.enter_mcp_company_draft_context(p_org_id uuid, p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid;
  v_user_before uuid;
  v_kind text;
  v_scopes text[];
  v_revoked timestamptz;
  v_expires timestamptz;
  v_role text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_app', 'MEMBER') THEN
    RAISE EXCEPTION 'MCP_CONTEXT_API_ONLY' USING ERRCODE = '42501';
  END IF;
  -- A write context is for a transaction that may write: a read-only one is a bug in the caller.
  IF pg_catalog.current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'MCP_WRITE_READ_ONLY' USING ERRCODE = '25006';
  END IF;
  -- Lock order: the member row, then the grant row, as a demotion takes them (the update of the member row, then the trigger's revoke of the grants), so a draft racing a demotion waits and
  -- never deadlocks. The grant's user is read first without a lock, only to know which member row to lock; every value used below is read again under both locks.
  SELECT g.user_id INTO v_user_before FROM crove_kernel.agent_grant g WHERE g.org_id = p_org_id AND g.id = p_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user_before FOR SHARE;
  SELECT g.user_id, g.kind, g.scopes, g.revoked_at, g.expires_at INTO v_user, v_kind, v_scopes, v_revoked, v_expires
  FROM crove_kernel.agent_grant g WHERE g.org_id = p_org_id AND g.id = p_grant_id FOR SHARE OF g;
  -- The member row locked above is the grant's own: a grant row whose user is not the one read first is not served (it cannot change today; this keeps the lock and the row it guards the same).
  IF NOT FOUND OR v_user IS DISTINCT FROM v_user_before THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  IF v_kind <> 'company' THEN
    RAISE EXCEPTION 'MCP_GRANT_NOT_COMPANY' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.mcp_grant_standing(p_grant_id, p_org_id, v_user) THEN
    IF v_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'MCP_GRANT_REVOKED' USING ERRCODE = '42501';
    END IF;
    IF v_expires <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'MCP_GRANT_EXPIRED' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  -- A grant that holds the draft scope holds the read scope with it (the CHECK says so too); one that does not is never served here.
  IF NOT ('ludy.social.draft' = ANY (v_scopes)) OR NOT ('ludy.read' = ANY (v_scopes)) THEN
    RAISE EXCEPTION 'MCP_GRANT_SCOPE' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1, 'org', p_org_id, 'actor', 'agent', 'user', NULL, 'role', v_role, 'agent', p_grant_id, 'run', NULL, 'position', NULL,
    'module', 'social', 'max_risk', 'R1', 'tainted', true, 'le_scope', pg_catalog.jsonb_build_array('*'), 'flags', '[]'::jsonb,
    'kind', 'mcp_company_draft', 'grantor', v_user));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'grantor', v_user, 'maxRisk', 'R1', 'tainted', true);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.enter_mcp_company_draft_context(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_mcp_company_draft_context(uuid, uuid) TO crove_app;
