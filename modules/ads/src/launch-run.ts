// SPDX-License-Identifier: AGPL-3.0-only
// The two commands of the launch job (W2-3, issue #2296, ADR-0043 points 2 to 5, plan docs/plan/ads-write.md sections 3.4 and 9), both the system's: `ads.launch.begin`
// decides what the next platform call of a queued launch is, and `ads.launch.record` settles it. The job (apps/kernel/src/ads-launch.ts) opens the sealed token
// through the credential broker and makes the call between the two; no command here touches a platform or a token. Social's publish does the same in two
// commands (social.publish.begin and record), and this follows it.
//
// EXACTLY ONCE. Every platform call has a deterministic key in the kernel's `external_call` ledger, `ads.launch:<launch>:<attempt>:<step>`. begin inserts the row as
// `started` and commits it BEFORE the job calls the platform; record settles it. A row begin finds again is never called a second time blind: a row the job began
// and never settled (a worker that died), once it is old enough to be lost, or one the job marked unclear (a timeout, a lost answer), once the platform has had a
// minute, is RECONCILED: the job asks the platform for the object by the launch's tag, and a found object is recorded, never created again; only an object that is
// missing is created (record `missing` re-arms the row for one more call, the job makes it at once). Two begins at the same moment serialise on the launch row.
//
// NOTHING UN-PAUSES. A launch creates the campaign, the ad set and, for each text variant, a creative and an ad, every one PAUSED; when the last is recorded the
// launch is at the step `paused` (state launching, its commitment kept) and waits for W2-4's activation. begin re-checks every stop condition before every step
// (the org's switch, the account's, launches blocked, the write connection active), and before the FIRST step it re-reads the caps under the org's lock: a cap lowered
// since the approval cancels the queued launch and releases its commitment. A plan the writer cannot carry out (no Page, a media file, an objective or a currency
// it has no table for) ends as `failed` before any call, nothing created, nothing spent; a problem of the environment (a refused token, a name the platform does
// not know, a refusal of the platform) ends as `needs_attention` with its code.
import { z } from 'zod';
import { sql } from 'kysely';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { zId, type AdsCampaignPlan } from '@crove/kernel-contract';
import { planHash } from './campaign-plan.ts';
import { todayIn } from './domain.ts';
import { contextBase, draftPlanOf } from './campaign-draft.ts';
import { committedLaunches, stopRunningLaunch, type LaunchState } from './launch-ledger.ts';
import { committedProblems } from './launch-caps.ts';
import {
  LAUNCH_STEP_PAUSED,
  dayAfter,
  launchCallKey,
  UNCLEAR_GIVE_UP_SECONDS,
  UNCLEAR_MAX_CALLS,
  launchSteps,
  nameTail,
  objectName,
  parseLaunchCallKey,
  stepAction,
  stepLevel,
  stepVariant,
  STARTED_STALE_SECONDS,
  targetingNames,
  unsettledEarlier,
  zoneKnown,
  zonedMidnight,
  type LaunchLevel,
  type TargetingNames,
} from './launch-steps.ts';
import { currentSetting, lockedSetting } from './write.ts';

export type Db = Pick<CommandContext, 'trx' | 'orgId'>;

export const requireSystem = (ctx: Pick<CommandContext, 'actor'>) => {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới được thực hiện thao tác này');
};

// What a worker can launch for a provider (the writer's capabilities), so a plan it cannot carry out is stopped before any call.
export const zLaunchWriter = z.strictObject({
  provider: z.string().min(1).max(32),
  objectives: z.array(z.string().max(16)).max(8),
  currencies: z.array(z.string().max(3)).max(64).nullable(),
  media: z.boolean(),
});
export type LaunchWriterCaps = z.infer<typeof zLaunchWriter>;

export type LaunchRequest =
  | { level: 'campaign'; name: string; objective: AdsCampaignPlan['objective'] }
  | { level: 'ad_set'; name: string; campaignId: string; objective: AdsCampaignPlan['objective']; dailyBudget: string; startTime: string; endTime: string; targeting: TargetingNames; pageId: string }
  | { level: 'creative'; name: string; pageId: string; linkUrl: string; headline: string; primaryText: string; callToAction: AdsCampaignPlan['variants'][number]['callToAction'] }
  | { level: 'ad'; name: string; adSetId: string; creativeId: string };

export type LaunchBegin =
  | { action: 'none'; reason: string }
  | {
      action: 'call' | 'reconcile';
      launchId: string;
      callKey: string;
      step: string;
      level: LaunchLevel;
      tag: string;
      // The name the object is created with.
      name: string;
      // What reconcile matches by, since a platform may trim or re-encode the plan's own text in a name: the tail of the name (the tag and what the object is, in
      // ASCII), and the tails of the launch's other objects of the same level. Exactly one object with this tail is the one; one with the tag and another tail
      // that is not a sibling's is not told apart from it, and ends the reconcile as unclear.
      tail: string;
      otherTails: string[];
      connectionId: string;
      provider: string;
      account: { externalAccountId: string; currency: string };
      // The first create of a launch: the job verifies the token reaches the account once, before it.
      verify: boolean;
      request: LaunchRequest;
    };

// Why a step ended without an object, as the job tells it: a refusal of the platform, a refused token, an unclear answer, a reconcile that could not ask, or a
// call that was not made (blocked).
const zExternalId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const zCode = z.string().regex(/^[A-Za-z0-9_.]{1,64}$/);
export const zLaunchResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), externalId: zExternalId }),
  z.strictObject({ kind: z.literal('found'), externalId: zExternalId }),
  z.strictObject({ kind: z.literal('missing') }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['bad_request', 'permission']), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('token'), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('unknown'), error: z.enum(['rate_limited', 'transient', 'unknown']), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('unknowable'), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('blocked'), code: zCode, names: z.array(z.string().max(100)).max(30).optional() }),
]);
export type LaunchResult = z.infer<typeof zLaunchResult>;

export interface LaunchRecorded {
  recorded: boolean;
  reason?: 'not_found' | 'stale' | 'settled';
  state?: string;
  step?: string | null;
  // What the job does next: continue with the next step, make the call now (a reconcile found nothing), or stop.
  next?: 'continue' | 'call' | 'stop';
}

const none = (reason: string): LaunchBegin => ({ action: 'none', reason });

const launchColumns = ['id', 'ad_account_id', 'draft_id', 'plan_hash', 'tag', 'state', 'attempt', 'step', 'currency', 'start_on', 'end_on', 'commit_until', 'legal_entity_id', 'retry_requested_at'] as const;
export const launchSelect = (ctx: Db) =>
  ctx.trx
    .selectFrom('crove_ads.ad_launch')
    .select([...launchColumns, sql<string>`daily_budget::text`.as('daily_budget'), sql<string>`start_on::text`.as('start_text'), sql<string>`end_on::text`.as('end_text'), sql<string | null>`commit_until::text`.as('commit_text')])
    .where('org_id', '=', ctx.orgId);

// The account of a launch, locked FOR SHARE first (an account's move to another legal entity cascades to its launches, so the order account then launch is the one
// every command takes), with the write connection's provider and state.
export async function launchAccountOf(ctx: Db, adAccountId: string) {
  const account = await ctx.trx
    .selectFrom('crove_ads.ad_account')
    .select(['id', 'currency', 'time_zone', 'write_enabled', 'write_connection_id', 'external_account_id', 'legal_entity_id'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', adAccountId)
    .forShare()
    .executeTakeFirst();
  if (!account) return null;
  const connection = account.write_connection_id
    ? await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['id', 'provider', 'status']).where('org_id', '=', ctx.orgId).where('id', '=', account.write_connection_id).executeTakeFirst()
    : undefined;
  return { account, connection: connection ?? null };
}

interface LaunchUpdate {
  state?: LaunchState;
  step?: string;
  stop_reason?: string;
  commit_until?: null;
}
export async function setLaunch(ctx: Db, launchId: string, values: LaunchUpdate): Promise<void> {
  await ctx.trx.updateTable('crove_ads.ad_launch').set(values).where('org_id', '=', ctx.orgId).where('id', '=', launchId).execute();
}

// The moves of the writer, the system's, with what the database holds them to (crove_ads.launch_guard): a launch that never activated anything commits nothing when
// it ends, because nothing ran.
const failLaunch = (ctx: Db, launchId: string, reason: string) => setLaunch(ctx, launchId, { state: 'failed', stop_reason: reason, commit_until: null });
const stopLaunch = (ctx: Db, launchId: string, reason: string) => setLaunch(ctx, launchId, { state: 'stopped', stop_reason: reason, commit_until: null });
export const needAttention = (ctx: Db, launchId: string, reason: string) => setLaunch(ctx, launchId, { state: 'needs_attention', stop_reason: reason });

// The condition that stops a launch right now, or null: the org's switch, the launches blocked, the account's switch, the write connection active. Read before every step
// (`begin`), and again before a create that follows a reconcile that found nothing (`record` of `missing`), since the owner can stop while the lookup runs.
export function stopConditionOf(
  setting: { write_enabled: boolean; launches_blocked: boolean } | undefined,
  account: { write_enabled: boolean },
  connection: { status: string } | null,
): 'switch_off' | 'launches_blocked' | 'account_off' | 'connection_closed' | null {
  if (setting?.write_enabled !== true) return 'switch_off';
  if (setting.launches_blocked) return 'launches_blocked';
  if (account.write_enabled !== true) return 'account_off';
  if (!connection || connection.status !== 'active') return 'connection_closed';
  return null;
}

// What the caps say of a launch right now, as problems (none when it fits), under the org's lock the caller holds. The launch's own commitment is one of the rows the ledger
// lists, so it is taken out first (one row of the same account, budget and window); `from` is the first day that still counts (the launch's first day before it has started,
// today after), so a cap lowered for days that are over does not stop a launch that has days to run.
export async function launchCapsProblems(
  ctx: Db,
  launch: { ad_account_id: string; currency: string; daily_budget: string; start_text: string; end_text: string; commit_text: string | null },
  accountId: string,
  from: string,
) {
  const base = await contextBase(ctx, accountId);
  const committed = await committedLaunches(ctx, launch.currency, from, launch.end_text);
  const own = committed.findIndex((c) => c.adAccountId === launch.ad_account_id && c.dailyBudget === launch.daily_budget && c.startOn === launch.start_text && c.endOn === launch.commit_text);
  const others = committed.filter((_, i) => i !== own);
  return committedProblems({ adAccountId: launch.ad_account_id, currency: launch.currency, dailyBudget: launch.daily_budget, startOn: from, endOn: launch.end_text }, others, base.caps);
}

// Whether the activation of any object of the launch was ever begun (a row of its calls in the ledger, whatever came of it): from then on an object may be on at the
// platform, so a launch that ends keeps its commitment against the caps until it is wound down, and what it made is paused from the queue.
export async function activationEverBegun(ctx: Db, launchId: string): Promise<boolean> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM crove_kernel.external_call WHERE org_id = ${ctx.orgId}::uuid AND key LIKE ${`ads.launch:${launchId}:%:activate\\_%`}`.execute(ctx.trx);
  return (rows[0]?.n ?? 0) > 0;
}

// A code as the ledger holds a reason: lower case letters and underscores, at most 40.
export const reasonOf = (code: string): string => code.toLowerCase().replace(/[^a-z_]/g, '_').slice(0, 40) || 'unknown';

export const adsLaunchBegin = defineCommand({
  name: 'ads.launch.begin',
  input: z.strictObject({ launchId: zId, writers: z.array(zLaunchWriter).max(8) }),
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() }),
  handler: async (ctx, input): Promise<LaunchBegin> => {
    requireSystem(ctx);
    const launchId = input.launchId.toLowerCase();
    const seen = await launchSelect(ctx).where('id', '=', launchId).executeTakeFirst();
    if (!seen) return none('not_found');
    if (seen.state === 'stopped' || seen.state === 'failed' || seen.state === 'cancelled') return none('final');
    if (seen.state === 'live') return none('live');
    // A launch that needs attention runs again only when an owner or an admin asked (ads.launch.retry): the request is taken below, with the move.
    if (seen.state === 'needs_attention' && !seen.retry_requested_at) return none('needs_attention');
    if (seen.state === 'launching' && seen.step === LAUNCH_STEP_PAUSED) return none('paused');
    // The org's lock first for a launch that has not started (the approvals, the cancel and the stops take it, so a stop and this begin queue), then the account, then the launch.
    const setting = seen.state === 'queued' ? await lockedSetting(ctx) : await currentSetting(ctx);
    const found = await launchAccountOf(ctx, seen.ad_account_id);
    if (!found) return none('no_account');
    const { account, connection } = found;
    const launch = await launchSelect(ctx).where('id', '=', launchId).forUpdate().executeTakeFirst();
    if (!launch || (launch.state !== 'queued' && launch.state !== 'launching' && !(launch.state === 'needs_attention' && launch.retry_requested_at)) || (launch.state === 'launching' && launch.step === LAUNCH_STEP_PAUSED)) return none('settled');
    // A worker with no writer for the connection's provider leaves the launch as it is: queued, untouched, until a deployment that has one runs it.
    const writer = connection ? input.writers.find((w) => w.provider === connection.provider) : undefined;
    if (connection && !writer) return none('no_writer');

    // Every stop condition, before every step.
    const stop = stopConditionOf(setting, account, connection);
    if (stop) {
      if (launch.state === 'queued') await setLaunch(ctx, launch.id, { state: 'cancelled', stop_reason: stop, commit_until: null });
      else {
        // A launch whose objects were never switched on commits nothing when it ends (nothing ran); one that ever began an activation keeps its commitment to at least
        // today, like any stop, since an object may be on (W2-4b).
        if (await activationEverBegun(ctx, launch.id)) await stopRunningLaunch(ctx, stop, launch.id);
        else await stopLaunch(ctx, launch.id, stop);
        // What it made at the platform is paused from the queue after the commit (W2-4a): the stop commands of the org and the account write the same event for the launches
        // they stop, and this is the one that finds a launch a condition stopped while the job was running (a connection that closed, a switch that went off between).
        await ctx.emit('ads.pause.queued', { launchId: launch.id, adAccountId: launch.ad_account_id });
      }
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, stopped: stop, state: launch.state });
      return none(stop);
    }
    if (!connection || !writer) return none('no_writer');

    const drafted = await draftPlanOf(ctx, launch.draft_id);
    const plan = drafted?.plan ?? null;
    // The plan that was approved is the plan that runs: its hash is the one the ledger holds.
    if (!plan || account.currency !== launch.currency || planHash(plan, launch.ad_account_id, launch.currency) !== launch.plan_hash) {
      if (launch.state === 'queued') await setLaunch(ctx, launch.id, { state: 'launching' });
      if (launch.state !== 'queued' && (await activationEverBegun(ctx, launch.id))) {
        // An object may be on: the launch is stopped with its commitment kept and what it made is paused, not failed.
        await stopRunningLaunch(ctx, 'plan_changed', launch.id);
        await ctx.emit('ads.pause.queued', { launchId: launch.id, adAccountId: launch.ad_account_id });
      } else await failLaunch(ctx, launch.id, 'plan_changed');
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, failed: 'plan_changed' });
      return none('plan_changed');
    }

    // The flight is put in the account's own time zone, which the platform's sync recorded. Without a zone this runtime knows (none recorded, or a name it cannot
    // read) the window would drift away from the days the commitment holds, so nothing is called. It is not a fault of the frozen plan: a later sync can fill the zone
    // in and a retry can then run, so the launch needs attention and keeps its commitment (a pre-call defect of the plan itself would fail it instead).
    if (!zoneKnown(account.time_zone)) {
      if (launch.state === 'queued') await setLaunch(ctx, launch.id, { state: 'launching' });
      await needAttention(ctx, launch.id, 'zone_unknown');
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, needsAttention: 'zone_unknown' });
      return none('zone_unknown');
    }

    // Page the ads run as (every ad needs one), as a connection of the org that is active.
    const page = drafted?.pageConnectionId
      ? await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['provider', 'status', 'external_account_id']).where('org_id', '=', ctx.orgId).where('id', '=', drafted.pageConnectionId).executeTakeFirst()
      : undefined;

    if (launch.state === 'queued') {
      // What the writer cannot carry out is stopped here, before the first call: nothing is created and nothing is spent, so the commitment is released.
      // A flight whose last day has passed in the account's own zone cannot run: the ad set would carry an expired schedule, or the platform would refuse it after the
      // campaign exists. It ends before any call, and a frozen plan cannot be repaired by a retry (the commitment was already over with the flight).
      const defect = !page
        ? 'page_required'
        : !writer.objectives.includes(plan.objective)
          ? 'objective_unsupported'
          : writer.currencies !== null && !writer.currencies.includes(launch.currency)
            ? 'currency_unsupported'
            : plan.mediaFileId !== null && !writer.media
              ? 'media_unsupported'
              : launch.end_text < todayIn(account.time_zone as string, ctx.now)
                ? 'flight_over'
                : null;
      if (defect) {
        await setLaunch(ctx, launch.id, { state: 'launching' });
        await failLaunch(ctx, launch.id, defect);
        ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, failed: defect });
        return none(defect);
      }
      // The caps again, under the org's lock taken above: a cap lowered since the approval cancels the launch and releases its commitment. The launch's own
      // commitment is one of the rows the ledger lists, so it is taken out first (one row of the same account, budget and window).
      const problems = await launchCapsProblems(ctx, launch, account.id, launch.start_text);
      if (problems.length > 0) {
        await setLaunch(ctx, launch.id, { state: 'cancelled', stop_reason: 'cap_lowered', commit_until: null });
        ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, cancelled: 'cap_lowered', problems: problems.slice(0, 5).map((p) => `${p.scope}:${p.period}:${p.day ?? p.month ?? ''}:${p.cap}:${p.committed}:${p.plan}`) });
        return none('cap_lowered');
      }
      await setLaunch(ctx, launch.id, { state: 'launching' });
    }
    if (!page || page.status !== 'active' || page.provider !== 'facebook_page') {
      await needAttention(ctx, launch.id, 'page_inactive');
      return none('page_inactive');
    }
    // The retry: the request of the person is taken, and the launch runs again as the next attempt (the database counts it, and clears the request in the same statement).
    if (launch.state === 'needs_attention') {
      const { rows: taken } = await sql<{ attempt: number | null }>`SELECT crove_ads.launch_take_retry(${ctx.orgId}::uuid, ${launch.id}::uuid) AS attempt`.execute(ctx.trx);
      if (taken[0]?.attempt == null) return none('settled');
      launch.attempt = taken[0].attempt;
      launch.state = 'launching';
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, retry: true, attempt: launch.attempt });
    }

    // Which object is next: the first of the plan's steps that has no recorded object.
    const objects = await ctx.trx.selectFrom('crove_ads.ad_object').select(['slot', 'external_id']).where('org_id', '=', ctx.orgId).where('launch_id', '=', launch.id).execute();
    const idOf = new Map(objects.map((o) => [o.slot, o.external_id]));
    const next = launchSteps(plan.variants.length).find((s) => !idOf.has(s));
    if (!next) {
      await setLaunch(ctx, launch.id, { step: LAUNCH_STEP_PAUSED });
      // The objects are all created, paused: the approved launch goes on to its activation (the next job, with its own view of the platform), which re-checks everything
      // before each call. The event carries ids only.
      await ctx.emit('ads.activate.queued', { launchId: launch.id, adAccountId: launch.ad_account_id });
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, step: LAUNCH_STEP_PAUSED, objects: objects.length });
      return none('paused');
    }

    // The ledger row of the step's call.
    const callKey = launchCallKey(launch.id, launch.attempt, next);
    const row = await ctx.trx.selectFrom('crove_kernel.external_call').select(['id', 'state', 'updated_at', 'started_at', 'calls', 'error_code']).where('org_id', '=', ctx.orgId).where('key', '=', callKey).forUpdate().executeTakeFirst();
    // A step that stays unclear is not asked about for ever: an unclear row that has already had an answer that could not be told (a code is recorded), once it has
    // been called three times or began an hour ago, tells a person (the launch needs attention) and nothing more is asked or made.
    if (row?.state === 'ambiguous' && row.error_code !== null && (row.calls >= UNCLEAR_MAX_CALLS || (ctx.now.getTime() - row.started_at.getTime()) / 1000 >= UNCLEAR_GIVE_UP_SECONDS)) {
      await needAttention(ctx, launch.id, 'reconcile_unclear');
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, step: next, attempt: launch.attempt, calls: row.calls, stopped: 'reconcile_unclear' });
      return none('reconcile_unclear');
    }
    // A retry looks at what the earlier attempts left of this very step before it creates anything: a call begun and never settled, or one whose answer was unclear, may
    // have made the object. Such a row is reconciled by the launch's tag first (found: recorded, no create; none found: the call is made once more); the earlier row is
    // settled as superseded. A call still young enough to be in flight waits. A row the platform refused, or that succeeded, is not one of these.
    let earlierUnsettled = false;
    if (!row && launch.attempt > 1) {
      const { rows: calls } = await sql<{ id: string; key: string; state: string; updated_at: Date }>`
        SELECT id, key, state, updated_at FROM crove_kernel.external_call
        WHERE org_id = ${ctx.orgId}::uuid AND key LIKE ${`ads.launch:${launch.id}:%:${next}`} AND state IN ('started', 'ambiguous') FOR UPDATE`.execute(ctx.trx);
      const earlier = unsettledEarlier(calls, launch.id, launch.attempt, next);
      if (earlier.some((e) => e.state === 'started' && (ctx.now.getTime() - e.updated_at.getTime()) / 1000 < STARTED_STALE_SECONDS)) return none('in_flight');
      if (earlier.length > 0) {
        earlierUnsettled = true;
        for (const e of earlier) {
          await ctx.trx
            .updateTable('crove_kernel.external_call')
            .set({ state: 'failed', error_kind: 'unknown', error_code: 'SUPERSEDED', finished_at: ctx.now, updated_at: ctx.now })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', e.id)
            .execute();
        }
      }
    }
    const action = earlierUnsettled ? 'reconcile' : stepAction(row ? { state: row.state, updatedAt: row.updated_at } : null, ctx.now);
    if (action === 'settled') {
      // A call the platform refused ended the launch's run (needs attention); one that succeeded has its object. Nothing to do either way.
      if (row?.state === 'failed') await needAttention(ctx, launch.id, 'step_failed');
      return none(row?.state === 'failed' ? 'step_failed' : 'settled');
    }
    if (action === 'wait') return none(row?.state === 'started' ? 'in_flight' : 'reconcile_wait');
    if (action === 'call' || earlierUnsettled) {
      await ctx.trx.insertInto('crove_kernel.external_call').values({ org_id: ctx.orgId, key: callKey, module: 'ads', target: 'launch', step: next, retry_safety: 'reconcile_only', started_at: ctx.now }).execute();
      // The row of a retry's reconcile is unclear from the start: the job asks the platform before anything is made.
      if (earlierUnsettled) await ctx.trx.updateTable('crove_kernel.external_call').set({ state: 'ambiguous', updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('key', '=', callKey).execute();
    } else if (row) {
      // A reconcile: the row is taken by this run. A call begun and never settled, and old enough to be lost, is unclear now, and an unclear one is touched, so a
      // job that begins at the same moment finds it young and waits: only one job reconciles a step, and only it may make the call again if the object is missing.
      await ctx.trx.updateTable('crove_kernel.external_call').set({ state: 'ambiguous', updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    }

    const level = stepLevel(next);
    const tag = launch.tag as string;
    const name = objectName(plan.name, tag, next);
    const pageId = page.external_account_id;
    let request: LaunchRequest;
    if (level === 'campaign') request = { level, name, objective: plan.objective };
    else if (level === 'ad_set') {
      request = {
        level,
        name,
        campaignId: idOf.get('campaign') as string,
        objective: plan.objective,
        dailyBudget: launch.daily_budget,
        startTime: zonedMidnight(launch.start_text, account.time_zone as string),
        endTime: zonedMidnight(dayAfter(launch.end_text), account.time_zone as string),
        targeting: targetingNames(plan),
        pageId,
      };
    } else if (level === 'creative') {
      const variant = plan.variants[stepVariant(next) - 1] as AdsCampaignPlan['variants'][number];
      request = { level, name, pageId, linkUrl: plan.linkUrl ?? `https://www.facebook.com/${pageId}`, headline: variant.headline, primaryText: variant.primaryText, callToAction: variant.callToAction };
    } else {
      request = { level, name, adSetId: idOf.get('ad_set') as string, creativeId: idOf.get(`creative_${stepVariant(next)}`) as string };
    }
    return {
      action: action === 'reconcile' ? 'reconcile' : 'call',
      launchId: launch.id,
      callKey,
      step: next,
      level,
      tag,
      name,
      tail: nameTail(tag, next),
      otherTails: launchSteps(plan.variants.length)
        .filter((s) => s !== next && stepLevel(s) === level)
        .map((s) => nameTail(tag, s)),
      connectionId: connection.id,
      provider: connection.provider,
      account: { externalAccountId: account.external_account_id, currency: launch.currency },
      verify: action === 'call' && objects.length === 0,
      request,
    };
  },
});

export const callErrorKind = (code: string): 'token_expired' | 'permission' | 'bad_request' => (/token|expired/.test(code) ? 'token_expired' : /connector|connection|cannot_run|permission|owner/.test(code) ? 'permission' : 'bad_request');

export const adsLaunchRecord = defineCommand({
  name: 'ads.launch.record',
  input: z.strictObject({ launchId: zId, callKey: z.string().min(1).max(200), phase: z.enum(['call', 'reconcile']), result: zLaunchResult }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() }),
  handler: async (ctx, input): Promise<LaunchRecorded> => {
    requireSystem(ctx);
    const launchId = input.launchId.toLowerCase();
    const parsed = parseLaunchCallKey(input.callKey);
    const seen = await launchSelect(ctx).where('id', '=', launchId).executeTakeFirst();
    if (!seen) return { recorded: false, reason: 'not_found' };
    if (!parsed || parsed.launchId !== launchId) return { recorded: false, reason: 'stale' };
    const found = await launchAccountOf(ctx, seen.ad_account_id);
    if (!found) return { recorded: false, reason: 'not_found' };
    const launch = await launchSelect(ctx).where('id', '=', launchId).forUpdate().executeTakeFirst();
    const result = input.result;
    // A result that is dropped writes nothing, but an object the platform made is never dropped without a trace: the audit row has the step and the platform's id, so
    // whoever stops or pauses the launch later can find it (and its name carries the launch's tag).
    const dropped = (reason: 'stale' | 'settled'): LaunchRecorded => {
      if (result.kind === 'accepted' || result.kind === 'found') ctx.audit({ launchId, step: parsed.step, outcome: 'dropped', reason, externalId: result.externalId });
      return { recorded: false, reason };
    };
    // A result for an attempt that is over, or for a launch that is not running, is stale. The one thing recorded for a launch that is no longer running (stopped,
    // failed, or waiting for a person: a concurrent run stopped it while this call was in flight) is an object the platform made, so it is tracked all the same.
    const holdsObject = result.kind === 'accepted' || result.kind === 'found';
    if (!launch || launch.attempt !== parsed.attempt || !(launch.state === 'launching' || (holdsObject && (launch.state === 'needs_attention' || launch.state === 'stopped' || launch.state === 'failed')))) return dropped('stale');
    const drafted = await draftPlanOf(ctx, launch.draft_id);
    const plan = drafted?.plan ?? null;
    if (!plan) return dropped('stale');
    const steps = launchSteps(plan.variants.length);
    const step = parsed.step;
    if (!steps.includes(step)) return dropped('stale');
    const row = await ctx.trx.selectFrom('crove_kernel.external_call').select(['id', 'state', 'calls']).where('org_id', '=', ctx.orgId).where('key', '=', input.callKey).forUpdate().executeTakeFirst();
    if (!row) return dropped('stale');
    if (row.state === 'succeeded' || row.state === 'failed') return dropped('settled');
    const running = launch.state === 'launching';
    interface CallUpdate {
      state: 'started' | 'succeeded' | 'failed' | 'ambiguous';
      calls?: number;
      external_ref?: string;
      error_kind?: 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient' | 'unknown';
      error_code?: string;
      finished_at?: Date;
    }
    const settle = (values: CallUpdate) =>
      ctx.trx.updateTable('crove_kernel.external_call').set({ updated_at: ctx.now, ...values }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();

    if (result.kind === 'accepted' || result.kind === 'found') {
      await ctx.trx
        .insertInto('crove_ads.ad_object')
        .values({
          org_id: ctx.orgId,
          ad_account_id: launch.ad_account_id,
          legal_entity_id: found.account.legal_entity_id,
          launch_id: launch.id,
          slot: step,
          level: stepLevel(step),
          external_id: result.externalId,
          // The name is the one the plan and the tag make, never one the job sent.
          name: objectName(plan.name, launch.tag as string, step),
        })
        .execute();
      await settle({ state: 'succeeded', external_ref: result.externalId, finished_at: ctx.now });
      const last = steps.at(-1) === step;
      // A launch that is still running moves to the level reached (or to the end); one that was stopped meanwhile is left as it is and the run ends.
      // The last create leaves the level it reached too: the job's next begin finds nothing left to create, settles the step `paused` and queues the activation (an
      // event is written by a command that is declared external, which this one, a record, is not).
      if (running) await setLaunch(ctx, launch.id, { step: stepLevel(step) });
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, step, attempt: launch.attempt, phase: input.phase, outcome: result.kind, externalId: result.externalId, done: last && running });
      if (!running) return { recorded: true, state: launch.state, step: launch.step, next: 'stop' };
      return { recorded: true, state: 'launching', step: stepLevel(step), next: 'continue' };
    }
    if (result.kind === 'missing') {
      // The platform has no such object: the call may be made again, once, and the row says so (a call counted more). Only from an unclear row, which a reconcile
      // took: a second `missing` for the same row finds it begun again and is stale, so two jobs never both make the call.
      if (row.state !== 'ambiguous') return { recorded: false, reason: 'stale' };
      // The stop conditions again before the call is armed: an owner's stop, a switch-off or a closed connection that came while the lookup ran does not change the
      // launch row, and the job still holds the token it opened before. Nothing is armed, and the next begin stops the launch.
      if (stopConditionOf(await currentSetting(ctx), found.account, found.connection)) return { recorded: true, state: launch.state, step: launch.step, next: 'stop' };
      await settle({ state: 'started', calls: row.calls + 1 });
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, step, attempt: launch.attempt, phase: input.phase, outcome: 'missing' });
      return { recorded: true, state: 'launching', step: launch.step, next: 'call' };
    }
    if (result.kind === 'unknown' || result.kind === 'unknowable') {
      // An answer that cannot be told (a timeout, a lost answer, a platform that could not be asked): the object may exist, so the row is unclear until reconcile finds
      // it or finds it missing. The launch stays as it is.
      const code = result.code ?? 'UNKNOWN';
      await settle({ state: 'ambiguous', error_kind: result.kind === 'unknown' ? result.error : 'unknown', error_code: code });
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, step, attempt: launch.attempt, phase: input.phase, outcome: result.kind, code });
      // More than one object, or one with the tag and a name that is not this step's, cannot be told apart by asking again: a person is told at once, and nothing is
      // created (the row stays unclear).
      if (result.kind === 'unknowable' && (code === 'AMBIGUOUS_MATCH' || code === 'NAME_MISMATCH')) {
        await needAttention(ctx, launch.id, 'reconcile_unclear');
        return { recorded: true, state: 'needs_attention', step: launch.step, next: 'stop' };
      }
      return { recorded: true, state: 'launching', step: launch.step, next: 'stop' };
    }
    // The rest ends this run of the launch: the platform refused the call, the token is refused, or the call was not made.
    if (result.kind === 'rejected') {
      await settle({ state: 'failed', error_kind: result.error, error_code: result.code ?? 'REFUSED', finished_at: ctx.now });
      await needAttention(ctx, launch.id, 'platform_refused');
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, step, attempt: launch.attempt, phase: input.phase, outcome: 'rejected', code: result.code });
    } else if (result.kind === 'token') {
      await settle({ state: 'failed', error_kind: 'token_expired', error_code: result.code ?? 'TOKEN', finished_at: ctx.now });
      await needAttention(ctx, launch.id, 'token_expired');
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, step, attempt: launch.attempt, phase: input.phase, outcome: 'token', code: result.code });
    } else {
      const reason = reasonOf(result.code);
      await settle({ state: 'failed', error_kind: callErrorKind(result.code.toLowerCase()), error_code: result.code, finished_at: ctx.now });
      await needAttention(ctx, launch.id, reason);
      // The names the platform does not know are listed for the person (business text of the plan's targeting, never a customer's; bounded).
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, step, attempt: launch.attempt, phase: input.phase, outcome: 'blocked', code: result.code, unknownTargeting: result.names ?? [] });
    }
    return { recorded: true, state: 'needs_attention', step: launch.step, next: 'stop' };
  },
});

export const launchRunCommands = [adsLaunchBegin, adsLaunchRecord];
