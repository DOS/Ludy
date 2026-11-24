-- SPDX-License-Identifier: AGPL-3.0-only
-- The pairing code of the MCP endpoint (issue #4591; ADR-0051 decision 2, "the pairing code stays only as the fallback for clients without OAuth"; docs/plan/vy.md V7 and Q7).
-- An owner or admin gets a short single-use code in Settings; an MCP client that cannot do OAuth (a capability token, a home-made agent) trades it at the redeem route for an opaque bearer
-- token bound to an `agent_grant` of the same shape the consent screen makes (company kind, the read scope, the same standing checks, the same call audit).
--
-- No new table: the code and the token live in the authorization server's own storage, ludy_kernel.oauth_record (definer-only, org-less, the key stored only as its SHA-256), under two
-- models of ours: 'PairingCode' (10 minutes, consumed once) and 'PairingToken' (as long as its grant). That keeps the pairing out of org_purge (an org-less store, the grant it opens is
-- already purged) and keeps one place where a secret is a hash.
--   mcp_pairing_issue   an owner or admin of the org in context stores the hash of a code (the code itself is made by the API and never reaches the database), 10 minutes, at most 5 live per org.
--   mcp_pairing_redeem  the API trades a code's hash for a grant: consumes the code once (an UPDATE that only one of two racing calls can win), re-checks that the person who issued it is still an
--                       owner or admin of an active org with no kill switch, makes the agent_grant (30 days, the read scope, `pairing:<id>` as its client), stores the token's hash with the grant's
--                       authorization id (so a revoke, a lost role or a removed member destroys it with the grant, as for an OAuth grant) and writes the system's audit row. Every refusal alike returns no row.
-- Reading a token needs no new function: the endpoint asks oauth_record_find('PairingToken', hash) and then runs the same mcp_grant_verify and mcp_grant_check as for an OAuth token.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.mcp_pairing_issue(p_code_hash bytea, p_label text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_label text := pg_catalog.btrim(p_label);
  v_live integer;
  v_added integer;
  v_end timestamptz := pg_catalog.clock_timestamp() + interval '10 minutes';
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The same gate as a consent: an owner or admin of an active org, not disabled, with no AI kill switch (the deployment's or the org's).
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant_member m
    JOIN ludy_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN ludy_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) OR ludy_kernel.global_kill_switch_on('ai') OR EXISTS (
    SELECT 1 FROM ludy_kernel.kill_switch k WHERE k.org_id = v_org AND k.scope = 'org' AND k.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32 OR v_label IS NULL OR pg_catalog.char_length(v_label) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  -- One issue at a time per org, so two at once cannot both pass the count.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mcp_pairing_issue:' || v_org::text, 0));
  SELECT pg_catalog.count(*)::integer INTO v_live FROM ludy_kernel.oauth_record o
  WHERE o.model = 'PairingCode' AND o.consumed_at IS NULL AND o.expires_at > pg_catalog.clock_timestamp() AND o.payload ->> 'orgId' = v_org::text;
  IF v_live >= 5 THEN
    RAISE EXCEPTION 'MCP_TOO_MANY' USING ERRCODE = '22023';
  END IF;
  -- A few records a day past their end are cleared with it, as oauth_record_upsert does, so no sweep is needed.
  DELETE FROM ludy_kernel.oauth_record o
  WHERE (o.model, o.key_hash) IN (
    SELECT x.model, x.key_hash FROM ludy_kernel.oauth_record x
    WHERE x.model = 'PairingCode' AND x.expires_at < pg_catalog.clock_timestamp() - interval '1 day' LIMIT 50);
  INSERT INTO ludy_kernel.oauth_record (model, key_hash, payload, expires_at)
  VALUES ('PairingCode', p_code_hash,
          pg_catalog.jsonb_build_object('orgId', v_org, 'userId', v_user, 'label', v_label, 'scopes', pg_catalog.jsonb_build_array('ludy.read')),
          v_end)
  ON CONFLICT (model, key_hash) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  IF v_added <> 1 THEN
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN v_end;
END $$;

CREATE OR REPLACE FUNCTION ludy_kernel.mcp_pairing_redeem(p_code_hash bytea, p_token_hash bytea)
RETURNS TABLE (grant_id uuid, org_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_payload jsonb;
  v_org uuid;
  v_user uuid;
  v_label text;
  v_oauth text := 'pairing-' || pg_catalog.gen_random_uuid()::text;
  v_client text;
  v_end timestamptz := pg_catalog.clock_timestamp() + interval '30 days';
  v_id uuid;
  v_added integer;
BEGIN
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32 OR p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RETURN;
  END IF;
  -- Single use: the code is consumed by one UPDATE that matches only while it is unconsumed and unexpired, so of two calls with the same code exactly one gets the row.
  UPDATE ludy_kernel.oauth_record o SET consumed_at = pg_catalog.clock_timestamp()
  WHERE o.model = 'PairingCode' AND o.key_hash = p_code_hash AND o.consumed_at IS NULL AND o.expires_at > pg_catalog.clock_timestamp()
  RETURNING o.payload INTO v_payload;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_org := (v_payload ->> 'orgId')::uuid;
  v_user := (v_payload ->> 'userId')::uuid;
  v_label := v_payload ->> 'label';
  -- The person who issued it must still be an owner or admin of an active org with no kill switch: a grant never exceeds the rights of the person who gave it.
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant_member m
    JOIN ludy_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN ludy_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) OR ludy_kernel.global_kill_switch_on('ai') OR EXISTS (
    SELECT 1 FROM ludy_kernel.kill_switch k WHERE k.org_id = v_org AND k.scope = 'org' AND k.released_at IS NULL
  ) THEN
    RETURN;
  END IF;
  v_client := 'pairing:' || pg_catalog.substr(v_oauth, 9);
  INSERT INTO ludy_kernel.agent_grant (org_id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
  VALUES (v_org, v_user, v_client, v_label, 'pairing-code', ARRAY['ludy.read']::text[], v_oauth, pg_catalog.clock_timestamp(), v_end, v_user)
  RETURNING id INTO v_id;
  -- The token's record carries the grant's authorization id, so a revoke, a lost role or a removed member (oauth_record_revoke_by_grant) destroys it with the grant.
  INSERT INTO ludy_kernel.oauth_record (model, key_hash, payload, grant_id, expires_at)
  VALUES ('PairingToken', p_token_hash,
          pg_catalog.jsonb_build_object('grantId', v_id, 'orgId', v_org, 'userId', v_user, 'clientId', v_client, 'scopes', pg_catalog.jsonb_build_array('ludy.read')),
          v_oauth, v_end)
  ON CONFLICT (model, key_hash) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  IF v_added <> 1 THEN
    -- A token hash that is already there cannot come from 256 random bits; if it does, nothing is left half made.
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  -- The system's audit row, ids and names only: never the code, the token or a hash of either.
  INSERT INTO ludy_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
  VALUES (v_org, 'system', NULL, 'kernel.mcp.pairing_redeem', ludy_kernel.uuid_v7(), 'ok', 'agent_grant', v_id,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_id::text, 'UTF8')), 'hex'),
          pg_catalog.jsonb_build_object('mcpPairing', true, 'mcpGrant', v_id, 'mcpClient', v_client, 'mcpClientName', v_label, 'issuedBy', v_user));
  RETURN QUERY SELECT v_id, v_org, v_end;
END $$;

-- ---------------------------------------------------------------------------
-- Grants: the API's login alone. The worker never takes part in an authorization or an MCP request; the tenant role reaches nothing.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION ludy_kernel.mcp_pairing_issue(bytea, text), ludy_kernel.mcp_pairing_redeem(bytea, bytea) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.mcp_pairing_issue(bytea, text), ludy_kernel.mcp_pairing_redeem(bytea, bytea) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.mcp_pairing_issue(bytea, text), ludy_kernel.mcp_pairing_redeem(bytea, bytea) TO ludy_app;
