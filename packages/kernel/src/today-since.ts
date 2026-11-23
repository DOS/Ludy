// SPDX-License-Identifier: AGPL-3.0-only
// "Since yesterday" on Home (Vy plan C1c, issue #3256): how many things each AI coworker prepared over the last day. It is a
// count of the activity rows whose `agent_id` is the coworker (ADR-0029: the database stamps the agent from the sealed context
// of the run that wrote the row), grouped by agent and named with the agent's display name now, so a rename shows at once.
//
// The read runs in the member's own transaction and role, so the activity table's policies decide what is counted: the org's
// rows, minus those of legal entities outside the member's scope (le_scope, #1716). The count is therefore of the rows that
// member can open, and a viewer's follows their own access. Nothing here calls a model, writes a row or returns a row's text,
// a record or an id of one: the answer is the coworker, its count and a link, and it is the same with AI off.
import { sql } from 'kysely';
import { z } from 'zod';
import { SINCE_YESTERDAY_HOURS, SINCE_YESTERDAY_MAX, type SinceYesterday } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { defineQuery } from '@ludy/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// Where what a coworker prepared waits for a person: the AI inbox, where every proposal is approved (a person approves money,
// messages and spend).
export const SINCE_YESTERDAY_HREF = '/inbox';

export function sinceYesterdayQuery(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return defineQuery({
    name: 'kernel.since_yesterday',
    input: z.object({}),
    access: ALL,
    handler: async (ctx): Promise<SinceYesterday> => {
      const since = new Date(now().getTime() - SINCE_YESTERDAY_HOURS * 3_600_000);
      // activity_agent_idx (org_id, agent_id) narrows the scan to the rows an agent wrote. The agent row is joined for the
      // name; the foreign key (activity_agent_fk) guarantees it exists. Only the org's coworkers (kind 'org_chart') count: a
      // member's own Vy (kind 'member_vy') works in that member's private context and is never counted here (ADR-0049).
      const { rows } = await sql<{ agent_id: string; name: string; n: string }>`
        SELECT a.agent_id, g.display_name AS name, count(*)::text AS n
        FROM ludy_kernel.activity a
        JOIN ludy_kernel.agent g ON g.org_id = a.org_id AND g.id = a.agent_id
        WHERE a.org_id = ${ctx.orgId}::uuid AND a.agent_id IS NOT NULL AND g.kind = 'org_chart'
          AND a.occurred_at > ${since.toISOString()}::timestamptz
        GROUP BY a.agent_id, g.display_name
        ORDER BY count(*) DESC, g.display_name, a.agent_id
        LIMIT ${SINCE_YESTERDAY_MAX}`.execute(ctx.trx);
      return { items: rows.map((r) => ({ agentId: r.agent_id, name: r.name, count: Number(r.n), href: SINCE_YESTERDAY_HREF })) };
    },
  });
}
