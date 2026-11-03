// SPDX-License-Identifier: AGPL-3.0-only
// The launch ledger of running ads (W2-2, issue #2296, plan docs/plan/ads-write.md sections 3.3 and 9, ADR-0043 point 2): the row an approved plan leaves behind
// and the commitment it holds against the spend caps. Nothing here calls a platform and nothing launches: a ledger row is queued by the execution of an approved
// ads.campaign.launch proposal, and holds its plan's amount against the caps until a person cancels it or a stop command releases it. W2-3's writer runs a queued
// launch; W2-4 stops what is launched.
//
// The caps are checked under the org's lock (lockedSetting), by the commands that take it, against the plan AND every launch that still commits (launch-caps.ts is
// the arithmetic, in decimal): at the request for approval as an early warning, and at the approval as the authoritative check, in the transaction that writes the
// commitment, so two launches approved together serialise and the second sees the first. The database holds the ledger itself (crove_ads.launch_guard): a row exists
// only for an approved plan, its commitment only shortens, and a state moves only along its graph.
import { sql } from 'kysely';
import { DomainError, type CommandContext } from '@crove/kernel-runtime';
import type { AdsLaunchView } from '@crove/kernel-contract';
import { addDays } from './domain.ts';
import { committedProblems, type Commitment, type CommittedCap, type CommittedPlan } from './launch-caps.ts';

type Db = Pick<CommandContext, 'trx' | 'orgId'>;

export const LAUNCH_STATES = ['queued', 'launching', 'live', 'needs_attention', 'stopped', 'failed', 'cancelled'] as const;
export type LaunchState = (typeof LAUNCH_STATES)[number];

const launchMissing = () => new DomainError('ADS_LAUNCH_NOT_FOUND', 404, 'Không tìm thấy lần chạy quảng cáo này');

// The first and the last day of the months a plan's flight touches: the commitments are read for that window, whatever the caller's legal entity scope.
export function monthsWindow(startOn: string, endOn: string): { from: string; to: string } {
  const [y, m] = endOn.split('-').map(Number) as [number, number];
  return { from: `${startOn.slice(0, 7)}-01`, to: addDays(`${new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)}`, -1) };
}

// Every launch of the org that still commits some of its budget in the window, in the currency (crove_ads.launch_commitments: owners, admins and the system,
// across the org's entities, since an org cap counts every account).
export async function committedLaunches(ctx: Db, currency: string, startOn: string, endOn: string): Promise<Commitment[]> {
  const { from, to } = monthsWindow(startOn, endOn);
  const { rows } = await sql<{ ad_account_id: string; currency: string; daily_budget: string; start_on: string; commit_until: string }>`
    SELECT ad_account_id, currency, daily_budget, start_on::text AS start_on, commit_until::text AS commit_until
    FROM crove_ads.launch_commitments(${currency}, ${from}::date, ${to}::date)`.execute(ctx.trx);
  return rows.map((r) => ({ adAccountId: r.ad_account_id, currency: r.currency, dailyBudget: r.daily_budget, startOn: r.start_on, endOn: r.commit_until }));
}

// What a plan would pass, in words the card can show: the cap, what is committed, what the plan adds, the first day or the month.
const where = (p: ReturnType<typeof committedProblems>[number]) => (p.day ? `ngày ${p.day}` : `tháng ${p.month}`);
const scopeWords = { org: 'của tổ chức', account: 'của tài khoản' } as const;
const periodWords = { daily: 'theo ngày', monthly: 'theo tháng' } as const;

// Refuses a plan that, with the launches already committed, would pass a cap in force (ADS_SPEND_CAP, with the numbers). The caller holds the org's lock and
// passes the caps in force for the plan's account (the account's and the org's, the newest row of each).
export async function refuseOverCaps(ctx: Db, plan: CommittedPlan, caps: readonly CommittedCap[]): Promise<void> {
  const others = await committedLaunches(ctx, plan.currency, plan.startOn, plan.endOn);
  const problems = committedProblems(plan, others, caps);
  if (problems.length === 0) return;
  const first = problems[0] as (typeof problems)[number];
  throw new DomainError(
    'ADS_SPEND_CAP',
    409,
    `Kế hoạch này cùng với các chiến dịch đã được duyệt sẽ vượt hạn mức ${periodWords[first.period]} ${scopeWords[first.scope]} (${where(first)}): hạn mức ${first.cap}, đã giữ chỗ ${first.committed}, kế hoạch thêm ${first.plan} ${plan.currency}`,
    { problems },
  );
}

export interface QueuedLaunch {
  draftId: string;
  adAccountId: string;
  legalEntityId: string;
  proposalId: string;
  planHash: string;
  currency: string;
  dailyBudget: string;
  startOn: string;
  endOn: string;
  amount: string;
  approverId: string;
}

// Writes the ledger row of an approved plan. The database accepts it only inside the execution of that plan's approved proposal, for the approved draft, while the
// switches are on (crove_ads.launch_guard), and stamps the proposal, the commitment window and who and when.
export async function queueLaunch(ctx: Db, launch: QueuedLaunch): Promise<{ id: string; tag: string }> {
  const row = await ctx.trx
    .insertInto('crove_ads.ad_launch')
    .values({
      org_id: ctx.orgId,
      ad_account_id: launch.adAccountId,
      legal_entity_id: launch.legalEntityId,
      draft_id: launch.draftId,
      proposal_id: launch.proposalId,
      plan_hash: launch.planHash,
      currency: launch.currency,
      daily_budget: launch.dailyBudget,
      start_on: launch.startOn,
      end_on: launch.endOn,
      amount: launch.amount,
      created_by: launch.approverId,
    })
    .returning(['id', 'tag'])
    .executeTakeFirstOrThrow();
  return { id: row.id, tag: row.tag as string };
}

// Cancels the launches that have not started (queued), of the org or of one account: they commit nothing any more. A launch the writer has started is the
// stop's (W2-4), not this. Returns how many. The guard lets an owner, an admin or the system do it.
export async function cancelQueuedLaunches(ctx: Db, reason: 'cancelled' | 'switch_off' | 'account_off' | 'launches_blocked', adAccountId?: string, launchId?: string): Promise<number> {
  let query = ctx.trx
    .updateTable('crove_ads.ad_launch')
    .set({ state: 'cancelled', stop_reason: reason })
    .where('org_id', '=', ctx.orgId)
    .where('state', '=', 'queued');
  if (adAccountId) query = query.where('ad_account_id', '=', adAccountId);
  if (launchId) query = query.where('id', '=', launchId);
  const rows = await query.returning('id').execute();
  return rows.length;
}

// The launch of a draft, if one was queued (the builder shows it on an approved draft).
const launchSelect = (db: Db['trx']) =>
  db.selectFrom('crove_ads.ad_launch as l').select([
    'l.id',
    'l.draft_id',
    'l.ad_account_id',
    'l.state',
    'l.step',
    'l.attempt',
    'l.currency',
    'l.tag',
    'l.stop_reason',
    'l.created_at',
    'l.finished_at',
    sql<string>`l.daily_budget::text`.as('daily_budget'),
    sql<string>`l.amount::text`.as('amount'),
    sql<string>`l.start_on::text`.as('start_on'),
    sql<string>`l.end_on::text`.as('end_on'),
    sql<string | null>`l.commit_until::text`.as('commit_until'),
  ]);
type LaunchRow = Awaited<ReturnType<ReturnType<typeof launchSelect>['execute']>>[number];

export function launchView(row: LaunchRow): AdsLaunchView {
  return {
    id: row.id,
    draftId: row.draft_id,
    adAccountId: row.ad_account_id,
    state: row.state as LaunchState,
    step: row.step,
    attempt: row.attempt,
    currency: row.currency,
    tag: row.tag as string,
    dailyBudget: row.daily_budget,
    amount: row.amount,
    startOn: row.start_on,
    endOn: row.end_on,
    commitUntil: row.commit_until,
    stopReason: row.stop_reason,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

export async function launchesOfDrafts(ctx: Db, draftIds: readonly string[]): Promise<Map<string, AdsLaunchView>> {
  const out = new Map<string, AdsLaunchView>();
  if (draftIds.length === 0) return out;
  const rows = await launchSelect(ctx.trx).where('l.org_id', '=', ctx.orgId).where('l.draft_id', 'in', [...draftIds]).execute();
  for (const row of rows) out.set(row.draft_id, launchView(row));
  return out;
}

// One launch, locked for the command that moves it.
export async function lockedLaunch(ctx: Db, launchId: string) {
  const row = await launchSelect(ctx.trx).where('l.org_id', '=', ctx.orgId).where('l.id', '=', launchId).forUpdate().executeTakeFirst();
  if (!row) throw launchMissing();
  return row;
}
