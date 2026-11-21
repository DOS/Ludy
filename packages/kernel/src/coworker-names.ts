// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworkers' names now (Vy plan C1a, issue #3265): what Home calls the coworker that raised an item. Each coworker covers
// modules (COWORKER_BY_MODULE: Ly finance, Dy crm and conversations, Uy social and ads); its name in an org is the display name of the
// org's own org-chart agent of one of those modules, so a rename (agent.display_name) shows at once, and the roster's default when
// the org has no such agent yet. Vy, the general manager, is no template agent: her name is the roster's. When an org holds several
// agents of one coworker (two finance templates), the oldest one that is not retired speaks for it, so the name is stable.
// Read in the member's own transaction (the agent table's own policy); nothing is written and no model is called.
import { sql } from 'kysely';
import { COWORKER_BY_MODULE, COWORKER_ROSTER, type CoworkerKey, type TodayCoworkers } from '@ludy/kernel-contract';
import type { QueryContext } from '@ludy/kernel-runtime';

// The roster's names, for an org with no agent of the coworker (and for Vy).
export function defaultCoworkers(): TodayCoworkers {
  return { gm: COWORKER_ROSTER.gm, finance: COWORKER_ROSTER.finance, sales: COWORKER_ROSTER.sales, marketing: COWORKER_ROSTER.marketing };
}

const MODULES = Object.keys(COWORKER_BY_MODULE);
// An org holds a handful of agents; the cap only bounds the scan.
const AGENTS_MAX = 200;

export async function coworkerNames(ctx: Pick<QueryContext, 'orgId' | 'trx'>): Promise<TodayCoworkers> {
  const names = defaultCoworkers();
  const { rows } = await sql<{ module: string; name: string }>`
    SELECT t.module, a.display_name AS name
    FROM crove_kernel.agent a
    JOIN crove_kernel.agent_template t ON t.key = a.template_key
    WHERE a.org_id = ${ctx.orgId}::uuid AND a.kind = 'org_chart' AND a.status <> 'retired'
      AND t.module IN (${sql.join(MODULES)})
    ORDER BY a.created_at, a.id
    LIMIT ${AGENTS_MAX}`.execute(ctx.trx);
  const seen = new Set<CoworkerKey>();
  for (const row of rows) {
    const key = COWORKER_BY_MODULE[row.module];
    if (key === undefined || key === 'system' || seen.has(key)) continue;
    seen.add(key);
    names[key] = row.name;
  }
  return names;
}
