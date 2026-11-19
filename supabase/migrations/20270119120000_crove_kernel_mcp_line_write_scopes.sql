-- SPDX-License-Identifier: AGPL-3.0-only
-- Per-line write scopes of an MCP grant (#3858 slice c; ADR-0051 decision 11, owner decision 2026-11-18/19): `ludy.engage.write` (Hộp thư and CRM) and `ludy.ads.draft` (ads drafts), beside `ludy.social.draft`.
-- This migration only lets a company grant HOLD them; it adds no way to use them:
--   - agent_grant_scopes_ck lists the five scopes, up to five per row; a write scope (any of the three) belongs to a company grant that also holds `ludy.read`, `ludy.member.read` to a member grant alone, as before;
--   - mcp_grant_approve (the company grant's definer) accepts the three write scopes with the read scope, restated whole from 20270101030000 with the one list changed (a company grant holds at most four);
--   - mcp_member_grant_approve is untouched: a member grant still cannot hold a write scope (its list does not have them, and the CHECK refuses one);
--   - no write context exists for the two new scopes (enter_mcp_company_draft_context serves `ludy.social.draft` alone, and agent_write_guard lets the draft kind insert a draft post and nothing else), so a grant that
--     holds one still writes nothing: the commands that use them (Engage E2, #3861) bring their own context and guard branch, each reviewed on its own.
-- Existing grants hold none of the new scopes, so the CHECK is added NOT VALID and validated at once (it holds for every row). Idempotent; applied files untouched.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  ALTER TABLE crove_kernel.agent_grant DROP CONSTRAINT IF EXISTS agent_grant_scopes_ck;
  ALTER TABLE crove_kernel.agent_grant ADD CONSTRAINT agent_grant_scopes_ck
    CHECK (pg_catalog.cardinality(scopes) BETWEEN 1 AND 5
           AND scopes <@ ARRAY['ludy.read', 'ludy.member.read', 'ludy.social.draft', 'ludy.engage.write', 'ludy.ads.draft']::text[]
           AND (NOT ('ludy.member.read' = ANY (scopes)) OR kind = 'member')
           AND (NOT (scopes && ARRAY['ludy.social.draft', 'ludy.engage.write', 'ludy.ads.draft']::text[]) OR (kind = 'company' AND 'ludy.read' = ANY (scopes)))) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE crove_kernel.agent_grant VALIDATE CONSTRAINT agent_grant_scopes_ck;

-- The company grant's definer, restated whole from 20270101030000 with the scope list changed.
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
     OR p_scopes IS NULL OR pg_catalog.cardinality(p_scopes) NOT BETWEEN 1 AND 4
     OR NOT (p_scopes <@ ARRAY['ludy.read', 'ludy.social.draft', 'ludy.engage.write', 'ludy.ads.draft']::text[])
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
