// SPDX-License-Identifier: AGPL-3.0-only
// `ludy_seats_list`: the org chart's active seats an AI coworker may name as the one that gets a task it proposes (#4369, follow-up of #4148; epic #3857, ADR-0051 decisions 2 and 11). A coworker that proposes
// a follow-up task (`ludy_conversation_follow_up`) passes `assigneePositionId: null`, which sends the task to the owner at the root of the chart, unless a person gave it a seat id: no read listed the seats.
// This is that read, for a company grant's owner or admin only (a member-bound grant is neither offered the tool nor allowed the query).
//
// Privacy review. What leaves: for each active seat (at most MCP_SEATS_MAX, oldest first), its id and its title as one plain line (the title is text an owner or admin typed: data for the client, never an
// instruction). Never returned: who holds the seat (member, user id, email, agent), whether a person or an AI coworker does, the module, the role key, the reporting line, the job description, the seat's
// legal entities or flags, a seat that is paused or archived, or the member's own Vy (it has no seat in the chart). The read writes nothing, calls no model and moves no money; Row-level security and the
// `org_id` filter keep other orgs out.
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { plainLine } from '@ludy/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
// The most seats one read returns: a small org's chart has a handful; the cap bounds a long one.
export const MCP_SEATS_MAX = 50;
const TITLE_MAX = 200;

export const zMcpSeatsInput = z.strictObject({});

export interface McpSeat {
  id: string;
  title: string;
}

// A company grant's alone, as the Ads and Meetings reads are: the tool list does not offer this to a member-bound grant, and the query refuses one too, so the two layers say the same thing.
function requireGrant(ctx: Pick<QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp || ctx.actor.mcp.kind === 'member') throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP của công ty mới dùng được truy vấn này');
}

export const mcpSeats = defineQuery({
  name: 'kernel.mcp.seats',
  input: zMcpSeatsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<{ seats: McpSeat[]; truncated: boolean }> => {
    requireGrant(ctx);
    const rows = await ctx.trx
      .selectFrom('ludy_kernel.position')
      .select(['id', 'title'])
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'active')
      .orderBy('created_at')
      .orderBy('id')
      .limit(MCP_SEATS_MAX + 1)
      .execute();
    const seats = rows.slice(0, MCP_SEATS_MAX).map((p): McpSeat => ({ id: p.id, title: plainLine(p.title, TITLE_MAX) }));
    return { seats, truncated: rows.length > seats.length };
  },
});

export const mcpSeatQueries = [mcpSeats];
