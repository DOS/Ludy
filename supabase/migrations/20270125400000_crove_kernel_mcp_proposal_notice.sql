-- SPDX-License-Identifier: AGPL-3.0-only
-- Telling the approvers when an AI coworker's proposal arrives (epic #3857, E5, issue #4180; ADR-0051 decision 10, owner decision 2026-11-19, "Cho làm, việc lớn chờ duyệt").
--
-- kernel.mcp.propose runs in the sealed proposal context, which inserts ONE proposal row and nothing else (no event, no notification: outbox_pending refuses it), so a proposal of a grant
-- cannot tell anyone itself. The worker does, from outside that context, with the same notification the proposals of people and org-chart agents already use (kernel.approval_waiting):
--   crove_kernel.proposal.approvers_told_at   when the approvers of a pending proposal of an MCP grant were told (stamped once by kernel.mcp.proposal_notify, even when nobody could be told).
--   crove_kernel.mcp_proposals_to_tell        the worker's scan, across active orgs, of the pending proposals of a grant not told yet. Ids only. At most 100 pending proposals of grants
--                                             exist per org (the cap), so the scan is bounded: it reads the partial index proposal_mcp_grant_pending_idx
--                                             (pending proposals of a grant) and filters on the stamp. A partial index on the unstamped ones is for when that is not enough.
-- crove_kernel.mcp_proposal_cap        the stamp and cap trigger of 20270119150000, restated whole with ONE added line: a row of a grant has approvers_told_at reset to null, so a sealed insert can never
--                                             pre-stamp the column and silence its notice.
-- No policy, no grant of the sealed context and no guard changes: the proposal's insert shape is as it was (the column starts null and the context never keeps a value for it).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS approvers_told_at timestamptz;

CREATE OR REPLACE FUNCTION crove_kernel.mcp_proposals_to_tell(p_limit int)
RETURNS TABLE (org_id uuid, proposal_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id
  FROM crove_kernel.proposal p
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  WHERE p.status = 'pending' AND p.requested_by_grant IS NOT NULL AND p.approvers_told_at IS NULL
  ORDER BY p.created_at, p.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
$$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_proposals_to_tell(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_proposals_to_tell(int) TO crove_worker;

-- The trigger itself is unchanged (it is bound by name to this function).
CREATE OR REPLACE FUNCTION crove_kernel.mcp_proposal_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_grant integer;
  v_org integer;
  v_name text;
  v_host text;
  v_user uuid;
BEGIN
  IF NEW.requested_by_grant IS NULL THEN
    RETURN NEW;
  END IF;
  -- Only the worker's step tells the approvers, so what a sealed insert says about it is never kept (E5, #4180): a row of a grant starts not told, whatever the caller wrote, and cannot silence its own notice.
  NEW.approvers_told_at := NULL;
  -- The client the card names is the grant's own record, never what the caller passed: the name the client declared at registration and the host it returns to.
  SELECT g.client_name, g.client_host, g.user_id INTO v_name, v_host, v_user FROM crove_kernel.agent_grant g WHERE g.org_id = NEW.org_id AND g.id = NEW.requested_by_grant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  -- The grant stands at the moment of the insert (not revoked or expired, its grantor still an owner or admin, the org active and not stopped by a kill switch): the one gate every entry uses.
  IF NOT crove_kernel.mcp_grant_standing(NEW.requested_by_grant, NEW.org_id, v_user) THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  NEW.mcp_client_name := pg_catalog.left(v_name, 120);
  NEW.mcp_client_host := pg_catalog.left(v_host, 253);
  -- The title is the database's too: built from the grant's own client name (control and direction characters taken out) and the kind the catalog fixed, never from what the caller passed.
  -- Every format character (Cf: the soft hyphen, the Arabic marks, the zero-width and direction marks and isolates, the word joiners and invisible operators, the byte order mark, the tag characters), every line and
  -- paragraph separator and control character, and every quote character are taken out of the name first, so it can neither reorder the text around it nor close the quote early and read as Ludy's own words.
  NEW.title := pg_catalog.left('Ứng dụng AI “' || pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(NEW.mcp_client_name, '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u08e2\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\U000e0001\U000e0020-\U000e007f"''`´“”„‟‘’‚‛«»‹›「」『』]+', '', 'g'),
    '[[:cntrl:]]+', ' ', 'g')) || '” đề xuất: ' || NEW.kind, 300);
  -- Inserts of one org queue here (the per-grant cap and the org's both count under it), so two calls, of one grant or of two, never both see room for one more.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mcp_proposal:' || NEW.org_id::text, 3858));
  SELECT pg_catalog.count(*) FILTER (WHERE p.requested_by_grant = NEW.requested_by_grant), pg_catalog.count(*) INTO v_grant, v_org
  FROM crove_kernel.proposal p WHERE p.org_id = NEW.org_id AND p.requested_by_grant IS NOT NULL AND p.status = 'pending';
  IF v_grant >= 20 OR v_org >= 100 THEN
    RAISE EXCEPTION 'MCP_PROPOSAL_CAP' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_proposal_cap() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
