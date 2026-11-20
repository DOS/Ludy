-- SPDX-License-Identifier: AGPL-3.0-only
-- Telling the approvers when an AI coworker's proposal arrives (epic #3857, E5, issue #4180; ADR-0051 decision 10, owner decision 2026-11-19, "Cho làm, việc lớn chờ duyệt").
--
-- kernel.mcp.propose runs in the sealed proposal context, which inserts ONE proposal row and nothing else (no event, no notification: outbox_pending refuses it), so a proposal of a grant
-- cannot tell anyone itself. The worker does, from outside that context, with the same notification the proposals of people and org-chart agents already use (kernel.approval_waiting):
--   crove_kernel.proposal.approvers_told_at   when the approvers of a pending proposal of an MCP grant were told (stamped once by kernel.mcp.proposal_notify, even when nobody could be told).
--   crove_kernel.mcp_proposals_to_tell        the worker's scan, across active orgs, of the pending proposals of a grant not told yet. Ids only. At most 100 pending proposals of grants
--                                             exist per org (the cap), so the scan is bounded; proposal_mcp_grant_pending_idx serves it.
-- No policy, no grant of the sealed context and no guard changes: the proposal's insert shape is as it was (the column starts null and the context never writes it).
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
