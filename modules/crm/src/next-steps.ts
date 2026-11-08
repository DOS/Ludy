// SPDX-License-Identifier: AGPL-3.0-only
// The next steps of stale deals (issue #2381, docs/plan/crm.md and the AI-first map 5.3): an open deal that nobody changed for N days, or whose
// expected close has passed, raises one next step for the member in charge. The rule is deterministic (no model, no text, no network), so it can
// run unattended: the worker runs crm.next_step.raise once a day in each org's system context (apps/kernel/src/crm-worker.ts). A next step is a
// reason code, a day and who it is for; the deal's title stays in the deal. People mark a step done or snooze it for 3, 7 or 14 days, one at a time
// or up to NEXT_STEP_BULK_MAX at once (the same commands, one audit row with the ids); a step closes by itself when its deal is edited, moved or
// closed (deals.ts calls closeNextSteps in the same transaction). Owners and admins set N (7 to 60 days, 14 until set).
//
// The rule, for one org:
//   - An open deal (no close time) is stale when its updated_at is N days old, or its expected_close is before today (Vietnam's calendar).
//     Every deal command (create, edit, move) sets updated_at, and a deal has no activity of its own, so "no change" is updated_at.
//   - past_close wins when both hold, and is raised even when the deal was edited yesterday.
//   - A deal gets a step only when it has none open and none resolved in the last N days. The second part is what keeps "done" (which does not
//     touch the deal) from raising the same step again tomorrow, and an edit that leaves the deal overdue from raising past_close again at once.
//   - At most RAISE_LIMIT new steps per run, the longest quiet first; running it again raises nothing new (one open step per deal, by index).
//   - Steps of deals that left the open stages are closed (the commands already do it; this is the safety net).
//   - After that pass, a sent quote nobody answered (or about to expire) raises quote_unanswered or quote_expiring on its deal, if the deal has no step yet (raiseQuoteSteps, #2699).
import { sql } from 'kysely';
import {
  DEAL_STALE_DAYS_DEFAULT,
  NEXT_STEP_PAGE_SIZE,
  QUOTE_EXPIRING_DAYS,
  QUOTE_UNANSWERED_DAYS,
  vietnamToday,
  zDealSettingSet,
  zNextStepDone,
  zNextStepListQuery,
  zNextStepSnooze,
  type DealNextStepReason,
  type DealSetting,
  type NextStep,
  type NextStepChanged,
  type NextStepPage,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { z } from 'zod';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// New steps one run raises in one org; the rest wait for the next day.
const RAISE_LIMIT = 500;
const DAY_MS = 86_400_000;

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const dayOf = (value: Date | string): string => (typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));

// The org's N: the setting, or the product's default while it has none.
export async function staleDays(ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<DealSetting> {
  const row = await ctx.trx.selectFrom('crove_crm.deal_setting').select('stale_days').where('org_id', '=', ctx.orgId).executeTakeFirst();
  return row ? { staleDays: row.stale_days, isDefault: false } : { staleDays: DEAL_STALE_DAYS_DEFAULT, isDefault: true };
}

// Closes the open next step of a deal whose own change made it moot, in the transaction of the command that changed it.
export async function closeNextSteps(ctx: CommandContext, dealId: string, reason: 'deal_edited' | 'deal_moved' | 'deal_closed'): Promise<void> {
  await ctx.trx
    .updateTable('crove_crm.deal_next_step')
    .set({ status: 'closed', closed_reason: reason, resolved_at: ctx.now, snoozed_until: null })
    .where('org_id', '=', ctx.orgId)
    .where('deal_id', '=', dealId)
    .where('status', '=', 'open')
    .execute();
}

// The daily rule in one org (the definer crove_crm.deal_stale_orgs lists the orgs): the system context shows this org's rows alone. Counts only
// in the audit row.
export const nextStepRaise = defineCommand({
  name: 'crm.next_step.raise',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx): Promise<{ raised: number; closed: number }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới thực hiện được việc này');
    const { staleDays: days } = await staleDays(ctx);
    const today = vietnamToday(ctx.now);
    const quietSince = new Date(ctx.now.getTime() - days * DAY_MS);
    const closedRows = await ctx.trx
      .updateTable('crove_crm.deal_next_step')
      .set({ status: 'closed', closed_reason: 'deal_closed', resolved_at: ctx.now, snoozed_until: null })
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'open')
      .where('deal_id', 'in', ctx.trx.selectFrom('crove_crm.deal').select('id').where('org_id', '=', ctx.orgId).where('closed_at', 'is not', null))
      .returning('id')
      .execute();
    // A deal being edited right now is skipped (its edit sets updated_at); a deal read here cannot be edited until this commits, so the step
    // raised for it is never one for a deal that just changed.
    const candidates = await ctx.trx
      .selectFrom('crove_crm.deal as d')
      .select(['d.id', 'd.owner_user_id', 'd.expected_close', 'd.updated_at', sql<string | null>`(SELECT m.role FROM crove_kernel.tenant_member m WHERE m.org_id = d.org_id AND m.user_id = d.owner_user_id)`.as('owner_role')])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.closed_at', 'is', null)
      .where((eb) => eb.or([eb('d.expected_close', '<', today), eb('d.updated_at', '<=', quietSince)]))
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_crm.deal_next_step n WHERE n.org_id = d.org_id AND n.deal_id = d.id AND (n.status = 'open' OR n.resolved_at > ${quietSince}))`,
      )
      .orderBy('d.updated_at')
      .orderBy('d.id')
      .limit(RAISE_LIMIT)
      .forShare()
      .skipLocked()
      .execute();
    let raised = 0;
    if (candidates.length > 0) {
      const inserted = await ctx.trx
        .insertInto('crove_crm.deal_next_step')
        .values(
          candidates.map((d) => {
            const overdue = d.expected_close !== null && dayOf(d.expected_close) < today;
            const reason: DealNextStepReason = overdue ? 'past_close' : 'no_activity';
            return {
              org_id: ctx.orgId,
              deal_id: d.id,
              reason,
              // A viewer cannot act on a step, so a deal a viewer owns is raised for the owners and admins (no assignee), as an unowned one is.
              assignee_user_id: d.owner_role === 'viewer' ? null : d.owner_user_id,
              since_on: overdue && d.expected_close !== null ? dayOf(d.expected_close) : vietnamToday(new Date(d.updated_at)),
              raised_at: ctx.now,
            };
          }),
        )
        .onConflict((oc) => oc.columns(['org_id', 'deal_id']).where('status', '=', 'open').doNothing())
        .returning('id')
        .execute();
      raised = inserted.length;
    }
    // The follow-up of sent quotes (#2699): the same one-step-per-deal rule, after the stale pass, so a deal that just got a stale step keeps that one.
    const quotes = await raiseQuoteSteps(ctx, today);
    raised += quotes.raised;
    ctx.audit({ raised, closed: closedRows.length + quotes.closed });
    return { raised, closed: closedRows.length + quotes.closed };
  },
});

// A sent quote of an open deal that nobody answered (the follow-up of docs/plan/crm-quotes.md section 7), while it is still valid (expiry is not stored, so a quote past
// its last day would stay `sent` and raise a step every week for ever): a quote sent QUOTE_UNANSWERED_DAYS ago or more, or valid for
// QUOTE_EXPIRING_DAYS more or fewer, raises one next step for the member in charge of the deal. The reason code and the day are all it holds: no quote number, amount
// or text. A step whose quote is no longer waiting (accepted, declined, replaced by a revision or deleted: no quote of the deal is `sent`) closes by itself with
// quote_decided. A deal gets a step only when it has none open and none resolved in the last 7 days, as for a stale deal, so "done" does not raise it again tomorrow.
async function raiseQuoteSteps(ctx: CommandContext, today: string): Promise<{ raised: number; closed: number }> {
  const decided = await ctx.trx
    .updateTable('crove_crm.deal_next_step')
    .set({ status: 'closed', closed_reason: 'quote_decided', resolved_at: ctx.now, snoozed_until: null })
    .where('org_id', '=', ctx.orgId)
    .where('status', '=', 'open')
    .where('reason', 'in', ['quote_unanswered', 'quote_expiring'])
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = deal_next_step.org_id AND q.deal_id = deal_next_step.deal_id AND q.status = 'sent')`)
    .returning('id')
    .execute();
  const resolvedSince = new Date(ctx.now.getTime() - 7 * DAY_MS);
  const soon = sql<boolean>`(q.valid_until >= ${today}::date AND q.valid_until <= ${today}::date + ${QUOTE_EXPIRING_DAYS}::int)`;
  const found = await sql<{ deal_id: string; owner_user_id: string | null; owner_role: string | null; reason: DealNextStepReason; since_on: Date | string }>`
    SELECT DISTINCT ON (d.id) d.id AS deal_id, d.owner_user_id,
           (SELECT m.role FROM crove_kernel.tenant_member m WHERE m.org_id = d.org_id AND m.user_id = d.owner_user_id) AS owner_role,
           CASE WHEN ${soon} THEN 'quote_expiring' ELSE 'quote_unanswered' END AS reason,
           CASE WHEN ${soon} THEN q.valid_until ELSE (coalesce(q.sent_at, q.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date END AS since_on
    FROM crove_crm.quote q
    JOIN crove_crm.deal d ON d.org_id = q.org_id AND d.id = q.deal_id
    WHERE q.org_id = ${ctx.orgId}::uuid AND q.status = 'sent' AND d.closed_at IS NULL
      AND q.valid_until >= ${today}::date
      AND (${soon} OR coalesce(q.sent_at, q.created_at) <= ${new Date(ctx.now.getTime() - QUOTE_UNANSWERED_DAYS * DAY_MS)})
      AND NOT EXISTS (SELECT 1 FROM crove_crm.deal_next_step n WHERE n.org_id = d.org_id AND n.deal_id = d.id AND (n.status = 'open' OR n.resolved_at > ${resolvedSince}))
    ORDER BY d.id, (CASE WHEN ${soon} THEN 0 ELSE 1 END), q.valid_until, q.id
    LIMIT ${RAISE_LIMIT}`.execute(ctx.trx);
  let raised = 0;
  if (found.rows.length > 0) {
    const inserted = await ctx.trx
      .insertInto('crove_crm.deal_next_step')
      .values(
        found.rows.map((r) => ({
          org_id: ctx.orgId,
          deal_id: r.deal_id,
          reason: r.reason,
          // A viewer cannot act on a step, so a deal a viewer owns is raised for the owners and admins (no assignee), as an unowned one is.
          assignee_user_id: r.owner_role === 'viewer' ? null : r.owner_user_id,
          since_on: dayOf(r.since_on),
          raised_at: ctx.now,
        })),
      )
      .onConflict((oc) => oc.columns(['org_id', 'deal_id']).where('status', '=', 'open').doNothing())
      .returning('id')
      .execute();
    raised = inserted.length;
  }
  return { raised, closed: decided.length };
}

// Marks next steps done in the caller's name. A step already resolved, or gone with its deal, is skipped, not an error: a second click on the
// same row does nothing. The audit row holds step ids and a count.
export const nextStepDone = defineCommand({
  name: 'crm.next_step.done',
  input: zNextStepDone,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<NextStepChanged> => {
    const userId = userOf(ctx.actor);
    const open = await lockOpen(ctx, input.nextStepIds);
    if (open.length > 0) {
      await ctx.trx
        .updateTable('crove_crm.deal_next_step')
        .set({ status: 'done', resolved_at: ctx.now, resolved_by: userId, snoozed_until: null })
        .where('org_id', '=', ctx.orgId)
        .where('status', '=', 'open')
        .where('id', 'in', open)
        .execute();
    }
    const skipped = input.nextStepIds.filter((id) => !open.includes(id));
    ctx.audit({ nextStepIds: open, unchanged: skipped.length });
    return { changed: open, skipped };
  },
});

// Hides next steps from the lists for 3, 7 or 14 days; they show again after, while the deal is still stale (a step closes when its deal changes).
export const nextStepSnooze = defineCommand({
  name: 'crm.next_step.snooze',
  input: zNextStepSnooze,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<NextStepChanged> => {
    userOf(ctx.actor);
    const open = await lockOpen(ctx, input.nextStepIds);
    if (open.length > 0) {
      await ctx.trx
        .updateTable('crove_crm.deal_next_step')
        .set({ snoozed_until: new Date(ctx.now.getTime() + input.days * DAY_MS) })
        .where('org_id', '=', ctx.orgId)
        .where('status', '=', 'open')
        .where('id', 'in', open)
        .execute();
    }
    const skipped = input.nextStepIds.filter((id) => !open.includes(id));
    ctx.audit({ nextStepIds: open, unchanged: skipped.length, days: input.days });
    return { changed: open, skipped };
  },
});

// The open ones among the ids, locked in id order (two bulk actions on overlapping rows cannot wait on each other).
async function lockOpen(ctx: CommandContext, ids: readonly string[]): Promise<string[]> {
  const rows = await ctx.trx
    .selectFrom('crove_crm.deal_next_step')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('status', '=', 'open')
    .where('id', 'in', [...ids])
    .orderBy('id')
    .forUpdate()
    .execute();
  return rows.map((r) => r.id);
}

// The next steps the lists show: open and not snoozed. Mine: the steps of my deals, and for an owner or admin the ones of deals nobody owns.
const shownSql = sql<boolean>`(n.status = 'open' AND (n.snoozed_until IS NULL OR n.snoozed_until <= now()))`;
function mineSql(ctx: Pick<QueryContext, 'actor' | 'role'>) {
  const me = ctx.actor.type === 'user' ? ctx.actor.userId : null;
  const admin = ctx.role === 'owner' || ctx.role === 'admin';
  return admin ? sql<boolean>`(n.assignee_user_id = ${me}::uuid OR n.assignee_user_id IS NULL)` : sql<boolean>`n.assignee_user_id = ${me}::uuid`;
}

// One page of the list, the longest quiet first. The Home read (today.ts) takes the same rows through the same rule.
export async function loadNextSteps(ctx: QueryContext, scope: 'mine' | 'all', cursor: { sinceOn: string; id: string } | null | undefined, limit: number): Promise<{ items: NextStep[]; next: { sinceOn: string; id: string } | null }> {
  let q = ctx.trx
    .selectFrom('crove_crm.deal_next_step as n')
    .innerJoin('crove_crm.deal as d', (j) => j.onRef('d.org_id', '=', 'n.org_id').onRef('d.id', '=', 'n.deal_id'))
    .innerJoin('crove_kernel.party as p', (j) => j.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
    .innerJoin('crove_crm.pipeline_stage as s', (j) => j.onRef('s.org_id', '=', 'd.org_id').onRef('s.id', '=', 'd.stage_id'))
    .select(['n.id', 'n.deal_id', 'n.reason', 'n.since_on', 'n.raised_at', 'n.assignee_user_id', 'd.title', 'd.party_id', 'd.amount', 'd.expected_close', 'p.name as party_name', 's.name as stage_name'])
    .where('n.org_id', '=', ctx.orgId)
    .where(shownSql);
  if (scope === 'mine') q = q.where(mineSql(ctx));
  if (cursor) q = q.where(sql<boolean>`(n.since_on, n.id) > (${cursor.sinceOn}::date, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('n.since_on').orderBy('n.id').limit(limit + 1).execute();
  const items: NextStep[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    dealId: r.deal_id,
    dealTitle: r.title,
    partyId: r.party_id,
    partyName: r.party_name,
    amount: r.amount,
    currency: 'VND',
    stageName: r.stage_name,
    expectedClose: r.expected_close === null ? null : dayOf(r.expected_close),
    assigneeUserId: r.assignee_user_id,
    reason: r.reason,
    sinceOn: dayOf(r.since_on),
    raisedAt: iso(r.raised_at),
  }));
  const last = items.at(-1);
  return { items, next: rows.length > limit && last ? { sinceOn: last.sinceOn, id: last.id } : null };
}

// How many next steps the lists show, mine and everyone's.
export async function countNextSteps(ctx: QueryContext): Promise<{ mine: number; all: number }> {
  const counted = await sql<{ mine: number; all: number }>`
    SELECT (count(*) FILTER (WHERE ${mineSql(ctx)}))::int AS mine, count(*)::int AS "all"
    FROM crove_crm.deal_next_step n WHERE n.org_id = ${ctx.orgId}::uuid AND ${shownSql}`.execute(ctx.trx);
  const counts = counted.rows[0] ?? { mine: 0, all: 0 };
  return { mine: counts.mine, all: counts.all };
}

export const nextStepList = defineQuery({
  name: 'crm.next_step.list',
  input: zNextStepListQuery,
  access: ALL,
  handler: async (ctx, input): Promise<NextStepPage> => {
    const page = await loadNextSteps(ctx, input.scope ?? 'mine', input.cursor, input.limit ?? NEXT_STEP_PAGE_SIZE);
    return { ...page, counts: await countNextSteps(ctx) };
  },
});

export const dealSettingGet = defineQuery({
  name: 'crm.deal_setting.get',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<DealSetting> => staleDays(ctx),
});

// Owners and admins set after how many days without a change an open deal raises a next step. It applies from the next daily run; the steps
// already raised stay as they are.
export const dealSettingSet = defineCommand({
  name: 'crm.deal_setting.set',
  input: zDealSettingSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<DealSetting> => {
    const userId = userOf(ctx.actor);
    await ctx.trx
      .insertInto('crove_crm.deal_setting')
      .values({ org_id: ctx.orgId, stale_days: input.staleDays, set_by: userId, created_at: ctx.now, updated_at: ctx.now })
      .onConflict((oc) => oc.column('org_id').doUpdateSet({ stale_days: input.staleDays, set_by: userId, updated_at: ctx.now }))
      .execute();
    ctx.audit({ staleDays: input.staleDays });
    return { staleDays: input.staleDays, isDefault: false };
  },
});

export const nextStepCommands = [nextStepRaise, nextStepDone, nextStepSnooze, dealSettingSet];
export const nextStepQueries = [nextStepList, dealSettingGet];
