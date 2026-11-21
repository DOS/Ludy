// SPDX-License-Identifier: AGPL-3.0-only
// The worker's pass that tells the approvers of an AI coworker's proposal (E5, #4180; ADR-0051 decision 10). kernel.mcp.propose runs in a sealed context that writes the proposal row and nothing else,
// so it leaves no event; this pass finds the pending proposals of a grant that were not told yet (crove_kernel.mcp_proposals_to_tell, ids only, across active orgs) and runs
// kernel.mcp.proposal_notify for each, which checks again under the proposal's lock, writes one notification per eligible approver and stamps the proposal. A failure for one proposal never
// stops the others; it is tried again on the next pass.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type Runtime, type SystemActor } from '@crove/kernel-runtime';

const ACTOR: SystemActor = { type: 'system', component: 'kernel.mcp.proposal_notice' };
// How often the worker looks, and how many proposals it takes per pass (at most 100 pending proposals of grants wait per org, so a pass drains an ordinary backlog; the rest waits for the next).
export const MCP_PROPOSAL_NOTICE_SWEEP_MS = 30_000;
export const MCP_PROPOSAL_NOTICE_LIMIT = 100;

// One pass; the number of proposals whose approvers were handled (told or found to have nobody to tell).
export async function sweepMcpProposalNotices(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; proposal_id: string }>`SELECT org_id, proposal_id FROM crove_kernel.mcp_proposals_to_tell(${MCP_PROPOSAL_NOTICE_LIMIT}::int)`.execute(deps.workerDb);
  let done = 0;
  for (const row of rows) {
    try {
      await deps.runtime.execute('kernel.mcp.proposal_notify', { proposalId: row.proposal_id }, { actor: ACTOR, orgId: row.org_id });
      done += 1;
    } catch (error) {
      console.warn(`[mcp-proposal-notice] proposal ${row.proposal_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.message : error);
    }
  }
  return done;
}
