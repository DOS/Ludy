// SPDX-License-Identifier: AGPL-3.0-only
// Retry and activation of a launch (W2-4b, issue #2296, ADR-0043 points 4 and 5, plan docs/plan/ads-write.md sections 3.6 and 9). Three commands:
//
// - `ads.launch.retry` (an owner's or an admin's): a launch that needs attention runs again. The move itself is the system's, so this stamps the request through a definer
//   (crove_ads.launch_request_retry) and writes `ads.launch.queued`; `ads.launch.begin` takes the request with the move and counts the attempt.
// - `ads.activate.begin` and `ads.activate.record` (the system's, the activation job's): the last steps of the approved launch, which switch on what the launch made, one
//   object per platform call, each ad first, then the ad set, then the campaign LAST (nothing delivers until the campaign is on, so a failure half way spends nothing). The
//   activation CONTINUES the launch's own `ads.campaign.launch` approval (ruling of 2026-11-04): there is no second approval, and the authority is the database, which refuses
//   the move of the launch to live unless the stamped approved proposal, the recorded objects, the settled activations, the switches and the flight all hold
//   (crove_ads.launch_guard). A resume of something stopped or paused is not this: it stays a separate approval (W4).
//
// BEFORE EACH CALL, `begin` re-checks everything under the org's lock (the lock every stop and every approval takes, so a stop and this begin queue): the stop conditions (the
// org's switch, the account's, launches blocked, the write connection active), the plan hash, that the flight has begun and not ended in the account's own zone, and the caps
// again (this launch's remaining days against every cap and every other launch, in decimal). A condition that stops the launch ends it stopped, with its commitment kept to at
// least today (never cleared: an activation may have landed), and the pause job pauses what it made; a lowered cap or a missing zone leaves it needing attention, nothing
// called. Each call has its own row in the kernel's `external_call` ledger (`ads.launch:<launch>:<attempt>:activate_<slot>`), committed as started BEFORE the platform is called;
// an answer that cannot be told is settled by reading the object's status (active: recorded; not: the call is made once more, never past the checks above).
// The activation touches only the launch's OWN recorded objects (the ids in `ad_object`), never one found by a tag.
import { z } from 'zod';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { zId } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { planHash } from './campaign-plan.ts';
import { draftPlanOf } from './campaign-draft.ts';
import { todayIn } from './domain.ts';
import { activationCallKey, activationLevel, activationSlots, activationStep, slotOfActivationStep, type ActivationLevel } from './launch-activation.ts';
import { lockedLaunch, stopRunningLaunch } from './launch-ledger.ts';
import { launchAccountOf, callErrorKind, launchCapsProblems, launchSelect, needAttention, reasonOf, requireSystem, setLaunch, stopConditionOf, type Db } from './launch-run.ts';
import { LAUNCH_STEP_PAUSED, STARTED_STALE_SECONDS, UNCLEAR_GIVE_UP_SECONDS, UNCLEAR_MAX_CALLS, parseLaunchCallKey, stepAction, unsettledEarlier, zoneKnown } from './launch-steps.ts';
import { currentSetting, lockedSetting } from './write.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// The step the launch is at while its objects are being switched on.
export const LAUNCH_STEP_ACTIVATE = 'activate';
export const LAUNCH_STEP_LIVE = 'live';

// ---------------------------------------------------------------------------------------------------------------
// The retry
// ---------------------------------------------------------------------------------------------------------------

export interface AdsLaunchRetried {
  launchId: string;
  // The request is waiting for the launch job (true), or one was already waiting (false).
  requested: boolean;
}

export const adsLaunchRetry = defineCommand({
  name: 'ads.launch.retry',
  input: z.strictObject({ launchId: zId }),
  // It asks for the creates and the activation to run again for a launch the person has looked at: it moves nothing itself (the job does, after its own checks) and
  // writes the event that queues the launch job, so it is declared as an external effect.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: (input) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() }),
  handler: async (ctx, input): Promise<AdsLaunchRetried> => {
    // The org's lock, as every command that moves a launch or the caps takes it, so a retry and a stop queue.
    await lockedSetting(ctx);
    const launch = await lockedLaunch(ctx, input.launchId.toLowerCase());
    if (launch.state !== 'needs_attention') throw new DomainError('ADS_LAUNCH_NOT_RETRYABLE', 409, 'Chỉ chạy lại được lần chạy đang chờ người xử lý');
    const { rows } = await sql<{ requested: boolean }>`SELECT crove_ads.launch_request_retry(${ctx.orgId}::uuid, ${launch.id}::uuid) AS requested`.execute(ctx.trx);
    const requested = rows[0]?.requested === true;
    await ctx.emit('ads.launch.queued', { launchId: launch.id, adAccountId: launch.ad_account_id });
    ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, draftId: launch.draft_id, attempt: launch.attempt, stopReason: launch.stop_reason, requested });
    return { launchId: launch.id, requested };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// The activation: begin and record
// ---------------------------------------------------------------------------------------------------------------

export type ActivateBegin =
  | { action: 'none'; reason: string }
  | {
      action: 'call' | 'reconcile';
      launchId: string;
      callKey: string;
      step: string;
      // The object, as the launch recorded it: its slot, its level and the platform's id (never one found by a tag).
      slot: string;
      level: ActivationLevel;
      objectId: string;
      connectionId: string;
      provider: string;
      account: { externalAccountId: string; currency: string };
    };

const none = (reason: string): ActivateBegin => ({ action: 'none', reason });

export const zActivateBeginInput = z.strictObject({
  launchId: zId,
  // The providers this worker has an activator for: a launch whose write connection is of another is left as it is, paused, until a deployment that has one runs it.
  providers: z.array(z.string().min(1).max(32)).max(8),
});

const zCode = z.string().regex(/^[A-Za-z0-9_.]{1,64}$/);
// What came of a call, as the job tells it. There is no object id in an answer: the object is the one begin named.
export const zActivateResult = z.discriminatedUnion('kind', [
  // The platform accepted the change, or a read of the status shows the object active.
  z.strictObject({ kind: z.literal('accepted') }),
  z.strictObject({ kind: z.literal('found') }),
  // A read of the status shows the object is not active: the call may be made once more.
  z.strictObject({ kind: z.literal('missing') }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['bad_request', 'permission']), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('token'), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('unknown'), error: z.enum(['rate_limited', 'transient', 'unknown']), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('unknowable'), code: zCode.nullable() }),
  z.strictObject({ kind: z.literal('blocked'), code: zCode }),
]);
export type ActivateResult = z.infer<typeof zActivateResult>;

export interface ActivateRecorded {
  recorded: boolean;
  reason?: 'not_found' | 'stale' | 'settled';
  state?: string;
  step?: string | null;
  // What the job does next: ask for the next object, make the call now (a read showed the object is not on), or stop.
  next?: 'continue' | 'call' | 'stop';
}

interface CallRow {
  id: string;
  key: string;
  state: string;
  calls: number;
  error_code: string | null;
  started_at: Date;
  updated_at: Date;
}

// The ledger rows of every activation call of a launch, of every attempt, locked.
async function activationRows(ctx: Db, launchId: string): Promise<CallRow[]> {
  const { rows } = await sql<CallRow>`
    SELECT id, key, state, calls, error_code, started_at, updated_at FROM crove_kernel.external_call
    WHERE org_id = ${ctx.orgId}::uuid AND key LIKE ${`ads.launch:${launchId}:%:activate\\_%`} FOR UPDATE`.execute(ctx.trx);
  return rows.filter((r) => {
    const parsed = parseLaunchCallKey(r.key);
    return parsed !== null && parsed.launchId === launchId && slotOfActivationStep(parsed.step) !== null;
  });
}

// The slots whose activation has succeeded, in any attempt: an object switched on stays on.
function doneSlots(rows: readonly CallRow[]): Set<string> {
  const done = new Set<string>();
  for (const row of rows) {
    const slot = row.state === 'succeeded' ? slotOfActivationStep(parseLaunchCallKey(row.key)?.step ?? '') : null;
    if (slot) done.add(slot);
  }
  return done;
}

export const adsActivateBegin = defineCommand({
  name: 'ads.activate.begin',
  input: zActivateBeginInput,
  // The platform is called by the job, not here. It is the system's and R2 external, because an R3 command cannot run as the system: the authority to start spend is the
  // approval the launch already carries (stamped on the row, checked by the database in the move to live), and nothing here calls a platform without the checks above.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() }),
  handler: async (ctx, input): Promise<ActivateBegin> => {
    requireSystem(ctx);
    const launchId = input.launchId.toLowerCase();
    const seen = await launchSelect(ctx).where('id', '=', launchId).executeTakeFirst();
    if (!seen) return none('not_found');
    if (seen.state === 'live') return none('live');
    if (seen.state === 'stopped' || seen.state === 'failed' || seen.state === 'cancelled') return none('final');
    if (seen.state === 'queued') return none('not_created');
    if (seen.state === 'needs_attention') return none('needs_attention');
    if (seen.step !== LAUNCH_STEP_PAUSED && seen.step !== LAUNCH_STEP_ACTIVATE) return none('creating');
    // The org's lock first (the stops, the approvals and the retries take it, so a stop and this begin queue), then the account, then the launch.
    const setting = await lockedSetting(ctx);
    const found = await launchAccountOf(ctx, seen.ad_account_id);
    if (!found) return none('no_account');
    const { account, connection } = found;
    const launch = await launchSelect(ctx).where('id', '=', launchId).forUpdate().executeTakeFirst();
    if (!launch || launch.state !== 'launching' || (launch.step !== LAUNCH_STEP_PAUSED && launch.step !== LAUNCH_STEP_ACTIVATE)) return none('settled');
    // A worker with no activator for the connection's provider leaves the launch as it is, paused.
    if (connection && !input.providers.includes(connection.provider)) return none('no_activator');

    // Every stop condition, before EVERY call. A stop ends the launch stopped, its commitment kept to at least today, and the pause job pauses what it made.
    const stop = stopConditionOf(setting, account, connection);
    if (stop) {
      const stopped = await stopRunningLaunch(ctx, stop, launch.id);
      for (const s of stopped) await ctx.emit('ads.pause.queued', { launchId: s.id, adAccountId: s.adAccountId });
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, stopped: stop, state: launch.state, phase: 'activate' });
      return none(stop);
    }
    if (!connection) return none('no_activator');

    // The plan that was approved is the plan that runs. A plan that is not (it cannot change; the account's currency can) ends the launch stopped, as above.
    const drafted = await draftPlanOf(ctx, launch.draft_id);
    const plan = drafted?.plan ?? null;
    if (!plan || account.currency !== launch.currency || planHash(plan, launch.ad_account_id, launch.currency) !== launch.plan_hash) {
      const stopped = await stopRunningLaunch(ctx, 'plan_changed', launch.id);
      for (const s of stopped) await ctx.emit('ads.pause.queued', { launchId: s.id, adAccountId: s.adAccountId });
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, stopped: 'plan_changed', phase: 'activate' });
      return none('plan_changed');
    }
    if (!zoneKnown(account.time_zone)) {
      await needAttention(ctx, launch.id, 'zone_unknown');
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, needsAttention: 'zone_unknown', phase: 'activate' });
      return none('zone_unknown');
    }
    // The flight, in the account's own zone: a flight that has not begun waits (the sweep brings it on its first day); one that is over cannot be started.
    const today = todayIn(account.time_zone, ctx.now);
    if (today < launch.start_text) return none('not_started');
    if (today > launch.end_text) {
      const stopped = await stopRunningLaunch(ctx, 'flight_over', launch.id);
      for (const s of stopped) await ctx.emit('ads.pause.queued', { launchId: s.id, adAccountId: s.adAccountId });
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, stopped: 'flight_over', phase: 'activate' });
      return none('flight_over');
    }
    // The caps again, for the days this launch has left, against every cap and every other launch: a cap lowered since the approval leaves the launch paused and needing
    // attention, nothing called.
    const problems = await launchCapsProblems(ctx, launch, account.id, today > launch.start_text ? today : launch.start_text);
    if (problems.length > 0) {
      await needAttention(ctx, launch.id, 'cap_lowered');
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, needsAttention: 'cap_lowered', phase: 'activate', problems: problems.slice(0, 5).map((p) => `${p.scope}:${p.period}:${p.day ?? p.month ?? ''}:${p.cap}:${p.committed}:${p.plan}`) });
      return none('cap_lowered');
    }

    // Which object is next: each ad, then the ad set, then the campaign last; the first whose activation has not succeeded.
    const objects = await ctx.trx.selectFrom('crove_ads.ad_object').select(['slot', 'external_id']).where('org_id', '=', ctx.orgId).where('launch_id', '=', launch.id).execute();
    const idOf = new Map(objects.map((o) => [o.slot, o.external_id]));
    const rows = await activationRows(ctx, launch.id);
    const done = doneSlots(rows);
    const slots = activationSlots(plan.variants.length);
    const missing = slots.find((slot) => !idOf.has(slot));
    // An object that was never recorded is not the activation's to look for (and nothing is switched on by a tag): the launch goes back to its creates.
    if (missing) {
      await needAttention(ctx, launch.id, 'object_missing');
      return none('object_missing');
    }
    const next = slots.find((slot) => !done.has(slot));
    if (!next) {
      // Every object is on: the launch is live (the database checks the approval, the objects, the switches and the flight in this very statement).
      await setLaunch(ctx, launch.id, { state: 'live', step: LAUNCH_STEP_LIVE });
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, state: 'live', phase: 'activate' });
      return none('live');
    }
    if (launch.step !== LAUNCH_STEP_ACTIVATE) await setLaunch(ctx, launch.id, { step: LAUNCH_STEP_ACTIVATE });

    // The ledger row of this object's call.
    const step = activationStep(next);
    const callKey = activationCallKey(launch.id, launch.attempt, next);
    const row = rows.find((r) => r.key === callKey);
    if (row?.state === 'ambiguous' && row.error_code !== null && (row.calls >= UNCLEAR_MAX_CALLS || (ctx.now.getTime() - row.started_at.getTime()) / 1000 >= UNCLEAR_GIVE_UP_SECONDS)) {
      await needAttention(ctx, launch.id, 'reconcile_unclear');
      ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, step, attempt: launch.attempt, calls: row.calls, stopped: 'reconcile_unclear', phase: 'activate' });
      return none('reconcile_unclear');
    }
    // A retry looks at what the earlier attempts left of this very object first (a call begun and never settled, or an unclear answer): the platform is read before it is asked.
    let earlierUnsettled = false;
    if (!row && launch.attempt > 1) {
      const earlier = unsettledEarlier(rows, launch.id, launch.attempt, step);
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
      // A call the platform refused ended the run (needs attention); one that succeeded is in `done` and not here.
      if (row?.state === 'failed') await needAttention(ctx, launch.id, 'step_failed');
      return none(row?.state === 'failed' ? 'step_failed' : 'settled');
    }
    if (action === 'wait') return none(row?.state === 'started' ? 'in_flight' : 'reconcile_wait');
    if (action === 'call' || earlierUnsettled) {
      await ctx.trx.insertInto('crove_kernel.external_call').values({ org_id: ctx.orgId, key: callKey, module: 'ads', target: 'launch', step, retry_safety: 'idempotent', started_at: ctx.now }).execute();
      if (earlierUnsettled) await ctx.trx.updateTable('crove_kernel.external_call').set({ state: 'ambiguous', updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('key', '=', callKey).execute();
    } else if (row) {
      // A reconcile: the row is taken by this run (a call begun and never settled, and old enough to be lost, is unclear now), so a job that begins at the same moment waits.
      await ctx.trx.updateTable('crove_kernel.external_call').set({ state: 'ambiguous', updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    }
    return {
      action: action === 'reconcile' ? 'reconcile' : 'call',
      launchId: launch.id,
      callKey,
      step,
      slot: next,
      level: activationLevel(next),
      objectId: idOf.get(next) as string,
      connectionId: connection.id,
      provider: connection.provider,
      account: { externalAccountId: account.external_account_id, currency: launch.currency },
    };
  },
});

export const adsActivateRecord = defineCommand({
  name: 'ads.activate.record',
  input: z.strictObject({ launchId: zId, callKey: z.string().min(1).max(200), phase: z.enum(['call', 'reconcile']), result: zActivateResult }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() }),
  handler: async (ctx, input): Promise<ActivateRecorded> => {
    requireSystem(ctx);
    const launchId = input.launchId.toLowerCase();
    const parsed = parseLaunchCallKey(input.callKey);
    const slot = parsed ? slotOfActivationStep(parsed.step) : null;
    const seen = await launchSelect(ctx).where('id', '=', launchId).executeTakeFirst();
    if (!seen) return { recorded: false, reason: 'not_found' };
    if (!parsed || parsed.launchId !== launchId || !slot) return { recorded: false, reason: 'stale' };
    const found = await launchAccountOf(ctx, seen.ad_account_id);
    if (!found) return { recorded: false, reason: 'not_found' };
    const launch = await launchSelect(ctx).where('id', '=', launchId).forUpdate().executeTakeFirst();
    const result = input.result;
    const row = await ctx.trx.selectFrom('crove_kernel.external_call').select(['id', 'state', 'calls']).where('org_id', '=', ctx.orgId).where('key', '=', input.callKey).forUpdate().executeTakeFirst();
    if (!launch || !row) return { recorded: false, reason: 'stale' };
    if (row.state === 'succeeded' || row.state === 'failed') return { recorded: false, reason: 'settled' };
    const settle = (values: { state: 'started' | 'succeeded' | 'failed' | 'ambiguous'; calls?: number; error_kind?: 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient' | 'unknown'; error_code?: string; finished_at?: Date }) =>
      ctx.trx.updateTable('crove_kernel.external_call').set({ updated_at: ctx.now, ...values }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    // Whether this launch is still at the attempt and the state this call was begun under: a result for a launch that moved on (stopped, retried) never moves it.
    const current = launch.state === 'launching' && launch.attempt === parsed.attempt;

    if (result.kind === 'accepted' || result.kind === 'found') {
      // The object is on at the platform: that is a fact whatever became of the launch meanwhile, so the row says so (a stopped launch's pause waits for rows like this one
      // and then pauses it with the rest). The launch itself moves only if it is still the run this call belongs to.
      await settle({ state: 'succeeded', finished_at: ctx.now });
      ctx.audit({ launchId, adAccountId: launch.ad_account_id, step: parsed.step, attempt: parsed.attempt, phase: input.phase, outcome: result.kind, launchState: launch.state });
      if (!current) return { recorded: true, state: launch.state, step: launch.step, next: 'stop' };
      // Every object on: the launch is live, when the conditions still hold (a stop is the database's own state, so one that landed has changed `current` above; the
      // checks here are for the days and the switches, and the database holds the rest).
      const rows = await activationRows(ctx, launchId);
      const drafted = await draftPlanOf(ctx, launch.draft_id);
      const slots = drafted?.plan ? activationSlots(drafted.plan.variants.length) : [];
      const done = doneSlots(rows);
      if (slots.length === 0 || !slots.every((s) => done.has(s))) return { recorded: true, state: 'launching', step: launch.step, next: 'continue' };
      const setting = await currentSetting(ctx);
      const today = found.account.time_zone && zoneKnown(found.account.time_zone) ? todayIn(found.account.time_zone, ctx.now) : null;
      if (stopConditionOf(setting, found.account, found.connection) || today === null || today < launch.start_text || today > launch.end_text) return { recorded: true, state: 'launching', step: launch.step, next: 'stop' };
      await setLaunch(ctx, launch.id, { state: 'live', step: LAUNCH_STEP_LIVE });
      ctx.audit({ launchId, adAccountId: launch.ad_account_id, state: 'live', phase: 'activate' });
      return { recorded: true, state: 'live', step: LAUNCH_STEP_LIVE, next: 'stop' };
    }
    if (!current) return { recorded: false, reason: 'stale' };
    if (result.kind === 'missing') {
      // A read shows the object is not on: the call may be made again, once, from an unclear row (a second `missing` for the same row is stale, so two jobs never both make
      // it), and only if nothing has stopped the launch since: the owner can stop while the read runs, and the job still holds the token it opened before.
      if (row.state !== 'ambiguous') return { recorded: false, reason: 'stale' };
      if (stopConditionOf(await currentSetting(ctx), found.account, found.connection)) return { recorded: true, state: launch.state, step: launch.step, next: 'stop' };
      await settle({ state: 'started', calls: row.calls + 1 });
      ctx.audit({ launchId, adAccountId: launch.ad_account_id, step: parsed.step, attempt: parsed.attempt, phase: input.phase, outcome: 'missing' });
      return { recorded: true, state: 'launching', step: launch.step, next: 'call' };
    }
    if (result.kind === 'unknown' || result.kind === 'unknowable') {
      // An answer that cannot be told: the object may be on, so the row is unclear until a read shows it. The sweep asks again.
      const code = result.code ?? 'UNKNOWN';
      await settle({ state: 'ambiguous', error_kind: result.kind === 'unknown' ? result.error : 'unknown', error_code: code });
      ctx.audit({ launchId, adAccountId: launch.ad_account_id, step: parsed.step, attempt: parsed.attempt, phase: input.phase, outcome: result.kind, code });
      return { recorded: true, state: 'launching', step: launch.step, next: 'stop' };
    }
    // The rest ends this run: the platform refused the change, the token is refused, or the call was not made. Nothing is on that was not already, and the person decides.
    if (result.kind === 'rejected') {
      await settle({ state: 'failed', error_kind: result.error, error_code: result.code ?? 'REFUSED', finished_at: ctx.now });
      await needAttention(ctx, launch.id, 'platform_refused');
    } else if (result.kind === 'token') {
      await settle({ state: 'failed', error_kind: 'token_expired', error_code: result.code ?? 'TOKEN', finished_at: ctx.now });
      await needAttention(ctx, launch.id, 'token_expired');
    } else {
      await settle({ state: 'failed', error_kind: callErrorKind(result.code.toLowerCase()), error_code: result.code, finished_at: ctx.now });
      await needAttention(ctx, launch.id, reasonOf(result.code));
    }
    ctx.audit({ launchId, adAccountId: launch.ad_account_id, step: parsed.step, attempt: parsed.attempt, phase: input.phase, outcome: result.kind });
    return { recorded: true, state: 'needs_attention', step: launch.step, next: 'stop' };
  },
});

export const launchActivateCommands = [adsLaunchRetry, adsActivateBegin, adsActivateRecord];
