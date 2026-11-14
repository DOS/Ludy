// SPDX-License-Identifier: AGPL-3.0-only
// The member's Vy answering a question across the meetings they read, the parts that never read a private result row (Meetings A3, #3161, plan docs/plan/meetings-integrations.md
// section 4.2, ADR-0049 stage A): the lines the member's own search finds, the box's status and the start of the run. The model call and the checks of the answer are in apps/kernel
// and packages/agent. Nothing here stores a question or an answer, and no table is written: the run's own bookkeeping (the kernel's run and its counts-only result row) is the only trace.
//
// The lines are found with the search of L2 (meetings.search), through the same helper, in the member's own transaction: the definer keeps the lines the member reads (the recorder every
// stage of their own meeting, any other reader the published lines of a meeting they read, an owner or admin who is no reader nothing, a meeting past its text date none) and the rows are read
// under row security, which decides again for each. No new door to a meeting's text exists. The search wants every word, so the question is cut to its significant words in code and asked in a few
// passes (all the words, then the strongest ones alone); the lines are ranked by how many words they hold and cut to at most 40 lines from at most 8 meetings.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  ASK_LINES_MAX,
  ASK_MEETINGS_MAX,
  askKeywords,
  askQueries,
  askRank,
  zAskEmpty,
  zAskInput,
  zAskLines,
  zAskStarted,
  zAskStatus,
  type AskLines,
  type AskStatus,
  type MeetingSearchHit,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { findSearchHits } from './search.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, userOf } from './transcript.ts';

export const ASK_FEATURE = 'meetings.ask';
const MODULE = 'meetings';
// The lines one single-word pass may add: a common word matches a lot, so its pass is short.
const SINGLE_PASS_LINES = 15;

/**
 * The lines to give the model for a question, in the order to give them: found by the passes, one line once, those holding the most of the question's words first (ties in the order the search
 * gave them, which is its own recency order), at most ASK_LINES_MAX of them and from at most ASK_MEETINGS_MAX meetings (a line of a ninth meeting is left out, not another line of an earlier one).
 */
export function pickLines(found: ReadonlyArray<MeetingSearchHit>, words: readonly string[]): MeetingSearchHit[] {
  const ranked = found.map((hit, order) => ({ hit, order, rank: askRank(hit.text, words) })).sort((a, b) => b.rank - a.rank || a.order - b.order);
  const meetings = new Set<string>();
  const picked: MeetingSearchHit[] = [];
  for (const { hit } of ranked) {
    if (picked.length >= ASK_LINES_MAX) break;
    if (!meetings.has(hit.meetingId) && meetings.size >= ASK_MEETINGS_MAX) continue;
    meetings.add(hit.meetingId);
    picked.push(hit);
  }
  return picked;
}

// The lines a question's search finds, as the member reads them: a sensitive read (the question is hashed into its audit row, never kept), run when the member asks.
export const askLines = defineQuery({
  name: 'meetings.ask.lines',
  input: zAskInput,
  access: ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<AskLines> => {
    userOf(ctx.actor);
    const words = askKeywords(input.question);
    const queries = askQueries(words);
    const found = new Map<string, MeetingSearchHit>();
    for (const [index, q] of queries.entries()) {
      // The first pass takes up to the most lines; a later pass only adds while there is room, and only a few lines of a common word.
      if (index > 0 && found.size >= ASK_LINES_MAX) break;
      const { hits } = await findSearchHits(ctx.trx, ctx.orgId, q, index === 0 ? ASK_LINES_MAX : SINGLE_PASS_LINES, 0);
      for (const hit of hits) if (!found.has(hit.segmentId)) found.set(hit.segmentId, hit);
    }
    return zAskLines.parse({ lines: pickLines([...found.values()], words) });
  },
});

// Whether Vy may be asked now (the box): the deployment's switch, the member's right to work with Vy, a kill switch of the org, the meetings module or the operator, and this month's budget of the
// org or the module. The kernel's run.start decides again at the click (and adds the member's own Vy), so this is the answer for the box, not the gate. The expected cost is added by the route, which
// knows the prices; the amount left is not here (only an owner or an admin reads the budgets).
export const askStatus = defineQuery({
  name: 'meetings.ask.status',
  input: zAskEmpty,
  access: ROLES,
  handler: async (ctx): Promise<AskStatus> => {
    userOf(ctx.actor);
    let reason: AskStatus['reason'] = null;
    if (!isSummaryEnabled()) reason = 'off';
    else {
      const allowed = await sql<{ ok: boolean }>`SELECT crove_kernel.ctx_vy_use() AS ok`.execute(ctx.trx);
      if (allowed.rows[0]?.ok !== true) reason = 'forbidden';
      else {
        const stopped = await sql<{ stopped: boolean }>`
          SELECT crove_kernel.global_kill_switch_on('ai') OR EXISTS (
            SELECT 1 FROM crove_kernel.kill_switch k
            WHERE k.org_id = ${ctx.orgId}::uuid AND k.released_at IS NULL AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = ${MODULE}))) AS stopped`.execute(ctx.trx);
        if (stopped.rows[0]?.stopped === true) reason = 'paused';
        else {
          const spent = await sql<{ spent: boolean }>`SELECT crove_kernel.ai_budget_exhausted(${ctx.orgId}::uuid, ${MODULE}, NULL::uuid) AS spent`.execute(ctx.trx);
          if (spent.rows[0]?.spent === true) reason = 'budget';
        }
      }
    }
    return zAskStatus.parse({ enabled: reason === null, reason, estimate: null });
  },
});

// Starts the member's own Vy run for a question: any member with the deployment's switch on. The kernel's run.start then checks vy.use, the org, module and agent kill switches, the global ai switch and
// the budget, makes the member's Vy and this run, and binds the run to a fresh subject ('meetings.ask' and an id no screen sees): a question has no one meeting. Nothing is read or sent here, and the
// run's result row will hold counts only (the route stores them), never the question or the answer.
export const askStart = defineCommand({
  name: 'meetings.ask.start',
  input: zAskEmpty,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx) => {
    userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('ASK_OFF', 422, 'Asking Vy about meetings is not turned on here');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: ASK_FEATURE, subjectType: ASK_FEATURE, subjectId: randomUUID() });
    ctx.audit({ runId: started.runId });
    return zAskStarted.parse({ runId: started.runId });
  },
});

export const askRunCommands = [askStart];
export const askRunQueries = [askLines, askStatus];
