// SPDX-License-Identifier: AGPL-3.0-only
// The stop and the pause of a launch (W2-4a, issue #2296, ADR-0043 points 4 and 7a, plan docs/plan/ads-write.md sections 3.6 and 10). Four things:
// - `ads.launch.stop` (R2, an owner or an admin): a launch that has started is stopped, keeping its commitment against the caps to at least today in the account's own
//   time zone and never cleared (the database holds the rule, crove_ads.launch_guard, and the commands that stop go through stopStartedLaunches in launch-ledger.ts);
// - `ads.pause.begin` (the system's): the pause job's claim of a stopped launch and what there is to pause: the objects Ludy recorded for it, and a ledger row for the
//   run in the kernel's `external_call` table (`ads.pause:<launch>:<try>`, idempotent: pausing a paused object changes nothing);
// - `ads.pause.record` (the system's): what the job did. The objects the platform's list found by the launch's tag and Ludy had not recorded (a create that was in
//   flight when the launch was stopped, or whose record was lost) are recorded now; the launch is wound down when every level was listed in full, every object was
//   paused and no create of it is still in flight, or is due again, or Ludy gives up and the person is told to pause by hand (launch-pause-policy.ts);
// - `ads.pause.pending` (a system query): the stopped launches of an account that are not wound down, for the revoke sweep, which pauses with the sealed copy of a
//   closed connection's token before it revokes (a switch-off closes the write connection in its own transaction, so that copy is the only token left).
//
// NOTHING IN THIS FILE UN-PAUSES. The only change of status the pause job can make at the platform is PAUSED (the narrowed view of @crove/ad-platform, pausers.ts).
// The platform is never called inside a command, so a platform that is down cannot stop a stop. The secret is never here: the commands deal in ids, states, counts and
// the platform's error codes.
import { z } from 'zod';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { zId } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { draftPlanOf } from './campaign-draft.ts';
import { lockedLaunch, STARTED_STATES, stopStartedLaunches } from './launch-ledger.ts';
import { WIND_DOWN_LEASE_SECONDS, isTooOld, settlePause, type PauseSummary } from './launch-pause-policy.ts';
import { REVOKE_MAX_AGE_MS, REVOKE_MAX_ATTEMPTS } from './token-revoke.ts';
import { objectName, slotOfName, stepLevel, STARTED_STALE_SECONDS, type LaunchLevel } from './launch-steps.ts';
import { lockedSetting } from './write.ts';

// The event the stop commands write for the pause job (`ads.pause.queued`, ids only; the sweep writes it again for a launch whose job was lost): the relay turns it into a
// job of the queue ads-pause. Every command that writes it names it as a literal at its own `ctx.emit` call (the job-egress invariant reads the names from the source).

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

type Db = Pick<CommandContext, 'trx' | 'orgId'>;

const requireSystem = (ctx: Pick<CommandContext, 'actor'>) => {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới được thực hiện thao tác này');
};

const notRunning = () => new DomainError('ADS_LAUNCH_NOT_RUNNING', 409, 'Lần chạy này chưa bắt đầu, đã dừng hoặc đã kết thúc nên không dừng được nữa');

// ---------------------------------------------------------------------------------------------------------------
// The stop
// ---------------------------------------------------------------------------------------------------------------

export interface AdsLaunchStopped {
  launchId: string;
  state: 'stopped';
  // The last day the launch still commits its budget against the caps (never cleared by a person's stop).
  commitUntil: string | null;
}

export const adsLaunchStop = defineCommand({
  name: 'ads.launch.stop',
  input: z.strictObject({ launchId: zId }),
  // It only stops spend (the objects at the platform are paused afterwards, from the queue), so it needs no proposal and no second factor, and speed is the point.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: (input) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() }),
  handler: async (ctx, input): Promise<AdsLaunchStopped> => {
    // The org's lock, as every command that moves a launch or the caps takes it, so a stop and an approval queue.
    await lockedSetting(ctx);
    const launch = await lockedLaunch(ctx, input.launchId.toLowerCase());
    if (!(STARTED_STATES as readonly string[]).includes(launch.state)) throw notRunning();
    const stopped = await stopStartedLaunches(ctx, 'stopped', { launchId: launch.id });
    for (const s of stopped) await ctx.emit('ads.pause.queued', { launchId: s.id, adAccountId: s.adAccountId });
    if (stopped.length !== 1) throw notRunning();
    const after = await lockedLaunch(ctx, launch.id);
    ctx.audit({ launchId: launch.id, adAccountId: launch.ad_account_id, draftId: launch.draft_id, previousState: launch.state, step: launch.step, commitUntil: after.commit_until, amount: launch.amount, currency: launch.currency });
    return { launchId: launch.id, state: 'stopped', commitUntil: after.commit_until };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// The pause: begin and record
// ---------------------------------------------------------------------------------------------------------------

export type PauseLevel = 'campaign' | 'ad_set' | 'ad';

export type PauseBegin =
  | { action: 'none'; reason: string }
  | {
      action: 'pause';
      launchId: string;
      callKey: string;
      tries: number;
      via: 'connection' | 'copy';
      tag: string;
      // The write connection's provider and id when there is one (the job opens its token); null for the revoke sweep's run with a sealed copy.
      provider: string | null;
      connectionId: string | null;
      account: { externalAccountId: string; currency: string };
      // What Ludy recorded for the launch: the pause covers these and whatever else the launch's tag finds.
      objects: Array<{ slot: string; level: LaunchLevel; externalId: string }>;
    };

const none = (reason: string): PauseBegin => ({ action: 'none', reason });

export const zPauseBeginInput = z.strictObject({ launchId: zId, via: z.enum(['connection', 'copy']) });

const PAUSE_KEY = /^ads\.pause:([0-9a-f-]{36}):(\d{1,4})$/;
export const pauseCallKey = (launchId: string, tries: number): string => `ads.pause:${launchId}:${tries}`;

// Settles the launch's wind-down through the worker-only definer (the columns are the system's, no column grant): done, due again, or given up with a code.
async function settleWindDown(ctx: Db, launchId: string, done: boolean, next: Date | null, code: string | null): Promise<boolean> {
  const { rows } = await sql<{ settled: boolean }>`SELECT crove_ads.wind_down_settle(${ctx.orgId}::uuid, ${launchId}::uuid, ${done}, ${next ? next.toISOString() : null}::timestamptz, ${code}) AS settled`.execute(ctx.trx);
  return rows[0]?.settled === true;
}

export const adsPauseBegin = defineCommand({
  name: 'ads.pause.begin',
  input: zPauseBeginInput,
  // The platform is called by the job, not here: this claims a stopped launch and says what to pause. It only ever leads to PAUSED.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() }),
  handler: async (ctx, input): Promise<PauseBegin> => {
    requireSystem(ctx);
    const launchId = input.launchId.toLowerCase();
    const launch = await ctx.trx
      .selectFrom('crove_ads.ad_launch')
      .select(['id', 'ad_account_id', 'tag', 'state', 'currency', 'finished_at', 'started_at', 'wound_down_at', 'wind_down_code'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', launchId)
      .executeTakeFirst();
    if (!launch) return none('not_found');
    // A launch that has started whose write connection was closed by any path (the platform's deletion of the grant, the orphan sweep, an expired token, a replacement) is
    // stopped here, before anything else, with the commitment kept to at least today and what it made paused: the closers that are not the stop commands never visited it
    // (W2-4b, #2622 item 1). The revoke sweep lists such launches (`ads.pause.pending`) and pauses before it revokes.
    if ((STARTED_STATES as readonly string[]).includes(launch.state)) {
      const owner = await ctx.trx.selectFrom('crove_ads.ad_account').select('write_connection_id').where('org_id', '=', ctx.orgId).where('id', '=', launch.ad_account_id).executeTakeFirst();
      const open = owner?.write_connection_id
        ? await ctx.trx.selectFrom('crove_kernel.channel_connection').select('status').where('org_id', '=', ctx.orgId).where('id', '=', owner.write_connection_id).executeTakeFirst()
        : undefined;
      if (open?.status === 'active') return none('not_stopped');
      await lockedSetting(ctx);
      const stopped = await stopStartedLaunches(ctx, 'connection_closed', { launchId: launchId });
      for (const s of stopped) await ctx.emit('ads.pause.queued', { launchId: s.id, adAccountId: s.adAccountId });
      ctx.audit({ launchId, adAccountId: launch.ad_account_id, via: input.via, outcome: 'stopped_connection_closed', stopped: stopped.length });
      if (stopped.length !== 1) return none('not_stopped');
      const after = await ctx.trx.selectFrom('crove_ads.ad_launch').select(['state', 'finished_at']).where('org_id', '=', ctx.orgId).where('id', '=', launchId).executeTakeFirst();
      launch.state = (after?.state ?? 'stopped') as typeof launch.state;
      launch.finished_at = after?.finished_at ?? null;
    }
    if (launch.state !== 'stopped') return none('not_stopped');
    if (launch.wound_down_at) return none('wound_down');
    if (launch.wind_down_code) return none('gave_up');
    const stoppedAt = launch.finished_at ?? launch.started_at ?? ctx.now;
    // Seven days after the stop nothing can be paused any more (the sealed copy of a closed connection's token is gone): the person is told.
    if (isTooOld({ stoppedAt }, ctx.now)) {
      await settleWindDown(ctx, launchId, false, null, 'age');
      ctx.audit({ launchId, adAccountId: launch.ad_account_id, via: input.via, outcome: 'gave_up', code: 'age' });
      return none('gave_up');
    }
    const account = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'external_account_id', 'write_connection_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', launch.ad_account_id)
      .forShare()
      .executeTakeFirst();
    if (!account) return none('not_found');
    const connection = account.write_connection_id
      ? await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['id', 'provider', 'status']).where('org_id', '=', ctx.orgId).where('id', '=', account.write_connection_id).executeTakeFirst()
      : undefined;
    // The launch row is locked (the account first, the order every command takes), so a record of the writer, which locks it too, either commits before the lists below
    // are read or waits for this transaction: "nothing to pause" and the objects are one reading, never two with a create between them.
    const locked = await ctx.trx.selectFrom('crove_ads.ad_launch').select(['state', 'wound_down_at', 'wind_down_code']).where('org_id', '=', ctx.orgId).where('id', '=', launchId).forUpdate().executeTakeFirst();
    if (!locked || locked.state !== 'stopped' || locked.wound_down_at || locked.wind_down_code) return none('settled');

    // What there is to pause: the objects Ludy recorded, and a create that was begun and never settled (it may have landed). With neither, nothing was ever made.
    const objects = await ctx.trx.selectFrom('crove_ads.ad_object').select(['slot', 'level', 'external_id']).where('org_id', '=', ctx.orgId).where('launch_id', '=', launchId).orderBy('slot').execute();
    const { rows: unsettled } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM crove_kernel.external_call
      WHERE org_id = ${ctx.orgId}::uuid AND key LIKE ${`ads.launch:${launchId}:%`} AND state IN ('started', 'ambiguous')`.execute(ctx.trx);
    if (objects.length === 0 && (unsettled[0]?.n ?? 0) === 0) {
      await settleWindDown(ctx, launchId, true, null, null);
      ctx.audit({ launchId, adAccountId: launch.ad_account_id, via: input.via, outcome: 'nothing_to_pause' });
      return none('nothing_to_pause');
    }

    // An activation call that was begun and may still be in flight (its row is not settled and is younger than the longest a call can take, with its read) could switch an
    // object on after this run paused it: this run waits (the sweep brings the launch back), and the record of that call settles the row (W2-4b).
    const { rows: inFlight } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM crove_kernel.external_call
      WHERE org_id = ${ctx.orgId}::uuid AND key LIKE ${`ads.launch:${launchId}:%:activate\\_%`} AND state IN ('started', 'ambiguous') AND updated_at > ${new Date(ctx.now.getTime() - ACTIVATION_IN_FLIGHT_SECONDS * 1000)}`.execute(ctx.trx);
    if ((inFlight[0]?.n ?? 0) > 0) return none('activation_in_flight');

    // Which token pauses it. A run on the live connection needs it active; one whose connection is closed (a switch-off closes it in the same transaction as the stop) is
    // the revoke sweep's, with the sealed copy it holds, as long as that obligation is open; with neither there is nothing to pause with and the person is told.
    if (input.via === 'connection' && !(connection && connection.status === 'active')) {
      const { rows: held } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM crove_ads.ad_token_revoke
        WHERE org_id = ${ctx.orgId}::uuid AND ad_account_id = ${account.id}::uuid AND kind = 'write' AND state = 'pending'`.execute(ctx.trx);
      // The revoke sweep pauses it, with its copy, on its own schedule (the five-minute re-queue leaves a launch whose account has such an obligation alone).
      if ((held[0]?.n ?? 0) > 0) return none('revoke_path');
      await settleWindDown(ctx, launchId, false, null, 'no_token');
      ctx.audit({ launchId, adAccountId: launch.ad_account_id, via: input.via, outcome: 'gave_up', code: 'no_token' });
      return none('gave_up');
    }

    // The claim: a lease, and the run is counted. Another run that holds the launch, or one that is not due yet, leaves nothing to do now.
    const { rows: taken } = await sql<{ tries: number | null }>`SELECT crove_ads.wind_down_take(${ctx.orgId}::uuid, ${launchId}::uuid, ${WIND_DOWN_LEASE_SECONDS}::int) AS tries`.execute(ctx.trx);
    const tries = taken[0]?.tries ?? null;
    if (tries === null) return none('in_flight');
    const callKey = pauseCallKey(launchId, tries);
    await ctx.trx.insertInto('crove_kernel.external_call').values({ org_id: ctx.orgId, key: callKey, module: 'ads', target: 'launch', step: 'pause', retry_safety: 'idempotent', started_at: ctx.now }).execute();
    return {
      action: 'pause',
      launchId,
      callKey,
      tries,
      via: input.via,
      tag: launch.tag as string,
      provider: connection?.provider ?? null,
      connectionId: connection?.id ?? null,
      account: { externalAccountId: account.external_account_id, currency: launch.currency },
      objects: objects.map((o) => ({ slot: o.slot, level: o.level as LaunchLevel, externalId: o.external_id })),
    };
  },
});

const zExternalId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const zCode = z.string().regex(/^[A-Za-z0-9_.]{1,64}$/);
const zKind = z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown']);
const zLevel = z.enum(['campaign', 'ad_set', 'ad']);
const zListing = z.union([z.strictObject({ ok: z.literal(true) }), z.strictObject({ ok: z.literal(false), kind: zKind, code: zCode.nullable() })]);

// What a run of the pause job came to: it ran (with the platform's answers), or it could not make a call at all (no token it could open, no pauser for the provider).
export const zPauseResult = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ran'),
    listed: z.strictObject({ campaign: zListing, ad_set: zListing, ad: zListing }),
    found: z.array(z.strictObject({ level: zLevel, id: zExternalId, name: z.string().min(1).max(400) })).max(300),
    paused: z.array(z.strictObject({ level: zLevel, id: zExternalId })).max(300),
    failed: z.array(z.strictObject({ level: zLevel, id: zExternalId, kind: zKind, code: zCode.nullable() })).max(300),
    notTried: z.array(z.strictObject({ level: zLevel, id: zExternalId })).max(300),
    tokenRefused: z.boolean(),
    retryAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  z.strictObject({ kind: z.literal('blocked'), code: zCode }),
]);
export type PauseResultInput = z.infer<typeof zPauseResult>;

export interface PauseRecorded {
  recorded: boolean;
  reason?: 'not_found' | 'stale' | 'settled';
  // Where the wind-down stands after this run, and when the next one is due.
  state?: 'pending' | 'done' | 'gave_up';
  nextAt?: string | null;
  code?: string | null;
  tries?: number;
}

export const adsPauseRecord = defineCommand({
  name: 'ads.pause.record',
  input: z.strictObject({ launchId: zId, callKey: z.string().min(1).max(200), via: z.enum(['connection', 'copy']), result: zPauseResult }),
  // It records what the platform answered to a pause (R1): the call was the job's, it spends nothing, and the only status it can have set is PAUSED.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() }),
  handler: async (ctx, input): Promise<PauseRecorded> => {
    requireSystem(ctx);
    const launchId = input.launchId.toLowerCase();
    const parsed = PAUSE_KEY.exec(input.callKey);
    if (!parsed || parsed[1] !== launchId) return { recorded: false, reason: 'stale' };
    const tries = Number(parsed[2]);
    const launch = await ctx.trx
      .selectFrom('crove_ads.ad_launch')
      .select(['id', 'ad_account_id', 'legal_entity_id', 'draft_id', 'tag', 'state', 'finished_at', 'started_at', 'wound_down_at', 'wind_down_code', 'wind_down_tries'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', launchId)
      .forUpdate()
      .executeTakeFirst();
    if (!launch) return { recorded: false, reason: 'not_found' };
    if (launch.state !== 'stopped' || launch.wound_down_at || launch.wind_down_code) return { recorded: false, reason: 'settled' };
    // Only the run that holds the lease records: a run that stalled past it and was claimed again by a newer one is stale.
    if (launch.wind_down_tries !== tries) return { recorded: false, reason: 'stale' };
    const call = await ctx.trx.selectFrom('crove_kernel.external_call').select(['id', 'state']).where('org_id', '=', ctx.orgId).where('key', '=', input.callKey).forUpdate().executeTakeFirst();
    if (!call || call.state !== 'started') return { recorded: false, reason: 'settled' };

    const result = input.result;
    let recordedObjects = 0;
    const unrecorded: string[] = [];
    let summary: PauseSummary;
    let errorKind: 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient' | 'unknown' = 'unknown';
    let errorCode = 'PAUSE_INCOMPLETE';
    if (result.kind === 'blocked') {
      // The job could not make a call at all. A refused or expired token cannot pause anything; any other reason (no pauser for this deployment, a connection that
      // closed meanwhile) is looked at again by the next run, within the limits.
      const refused = /token|expired/.test(result.code.toLowerCase());
      summary = { complete: false, tokenRefused: refused, retryAt: null };
      errorKind = refused ? 'token_expired' : 'unknown';
      errorCode = result.code;
    } else {
      // The objects the launch's tag found and Ludy had not recorded are recorded now (the database lets the system insert them for a stopped launch): by the tail of
      // the name, which says which object of the launch each is. One whose tail is not this launch's cannot be told, and is paused all the same and listed in the audit.
      const known = await ctx.trx.selectFrom('crove_ads.ad_object').select(['slot', 'level', 'external_id']).where('org_id', '=', ctx.orgId).where('launch_id', '=', launchId).execute();
      const knownIds = new Set(known.map((o) => `${o.level}:${o.external_id}`));
      const usedSlots = new Set(known.map((o) => o.slot));
      const plan = (await draftPlanOf(ctx, launch.draft_id))?.plan ?? null;
      const variants = plan?.variants.length ?? 3;
      for (const object of result.found) {
        if (knownIds.has(`${object.level}:${object.id}`)) continue;
        const slot = slotOfName(launch.tag as string, object.name, variants);
        if (plan && slot && stepLevel(slot) === object.level && !usedSlots.has(slot)) {
          // The name is the one the plan and the tag make, never one the platform sent back (as the writer's own record does), and an id another row already holds (an
          // object a person renamed to carry this tag) is left unrecorded instead of failing the whole record: it is paused all the same.
          const inserted = await ctx.trx
            .insertInto('crove_ads.ad_object')
            .values({ org_id: ctx.orgId, ad_account_id: launch.ad_account_id, legal_entity_id: launch.legal_entity_id, launch_id: launchId, slot, level: object.level, external_id: object.id, name: objectName(plan.name, launch.tag as string, slot) })
            .onConflict((oc) => oc.doNothing())
            .executeTakeFirst();
          if (inserted.numInsertedOrUpdatedRows === 1n) {
            usedSlots.add(slot);
            knownIds.add(`${object.level}:${object.id}`);
            recordedObjects += 1;
          } else unrecorded.push(object.id);
        } else {
          unrecorded.push(object.id);
        }
      }
      // A create of this launch that is still in flight (begun a few minutes ago and not settled) may land after the platform was asked: the launch is not wound down
      // until it has settled or is old enough to be lost, and the next run lists again.
      const { rows: young } = await sql<{ age: number | null }>`
        SELECT min(EXTRACT(EPOCH FROM (${ctx.now.toISOString()}::timestamptz - updated_at)))::float AS age FROM crove_kernel.external_call
        WHERE org_id = ${ctx.orgId}::uuid AND key LIKE ${`ads.launch:${launchId}:%`} AND state = 'started' AND updated_at > ${ctx.now.toISOString()}::timestamptz - make_interval(secs => ${STARTED_STALE_SECONDS}::int)`.execute(ctx.trx);
      const youngestAge = young[0]?.age ?? null;
      const everyLevelListed = result.listed.campaign.ok && result.listed.ad_set.ok && result.listed.ad.ok;
      // Every object recorded for the launch that has a status of its own must be among the ones this run paused: a create that landed after the run's list, and whose record
      // the writer made before this one (a stopped launch still tracks what the platform made), is an object the run did not pause.
      const pausedNow = new Set(result.paused.map((p) => `${p.level}:${p.id}`));
      const recordedAll = await ctx.trx.selectFrom('crove_ads.ad_object').select(['level', 'external_id']).where('org_id', '=', ctx.orgId).where('launch_id', '=', launchId).execute();
      const notPaused = recordedAll.some((o) => (o.level === 'campaign' || o.level === 'ad_set' || o.level === 'ad') && !pausedNow.has(`${o.level}:${o.external_id}`));
      const complete = everyLevelListed && result.failed.length === 0 && result.notTried.length === 0 && youngestAge === null && !notPaused;
      const waitMs = youngestAge === null ? 0 : Math.max(60, STARTED_STALE_SECONDS - youngestAge + 5) * 1000;
      const retryFromPlatform = result.retryAt ? new Date(result.retryAt) : null;
      const retryAt = retryFromPlatform && retryFromPlatform.getTime() > ctx.now.getTime() + waitMs ? retryFromPlatform : waitMs > 0 ? new Date(ctx.now.getTime() + waitMs) : retryFromPlatform;
      summary = { complete, tokenRefused: result.tokenRefused, retryAt };
      const firstFailure = result.failed[0];
      const firstListing = [result.listed.campaign, result.listed.ad_set, result.listed.ad].find((l) => !l.ok);
      if (firstFailure) {
        errorKind = firstFailure.kind;
        errorCode = firstFailure.code ?? 'PAUSE_REFUSED';
      } else if (firstListing && !firstListing.ok) {
        errorKind = firstListing.kind;
        errorCode = firstListing.code ?? 'LIST_FAILED';
      } else if (youngestAge !== null) errorCode = 'CREATE_IN_FLIGHT';
      else if (notPaused) errorCode = 'OBJECT_NOT_PAUSED';
    }

    const settlement = settlePause({ tries: launch.wind_down_tries, stoppedAt: launch.finished_at ?? launch.started_at ?? ctx.now }, summary, ctx.now);
    if (!(await settleWindDown(ctx, launchId, settlement.state === 'done', settlement.nextAt, settlement.code))) return { recorded: false, reason: 'stale' };
    await ctx.trx
      .updateTable('crove_kernel.external_call')
      .set(summary.complete ? { state: 'succeeded', finished_at: ctx.now, updated_at: ctx.now } : { state: 'failed', error_kind: errorKind, error_code: errorCode, finished_at: ctx.now, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', call.id)
      .execute();
    // Ids, levels and codes only. This row is the one per-object evidence of a run (the run's `external_call` row is one per run, not one per object): which objects the
    // platform confirmed as paused, which it refused or could not be asked about, and which were not tried, each list as long as the command accepts (300), so after a
    // refused token or a give-up the record can say which objects may still be running and a person can pause them by hand.
    ctx.audit({
      launchId,
      adAccountId: launch.ad_account_id,
      via: input.via,
      tries,
      outcome: settlement.state,
      code: settlement.code,
      ...(result.kind === 'ran'
        ? {
            paused: result.paused.map((p) => ({ level: p.level, id: p.id })),
            failed: result.failed.map((f) => ({ level: f.level, id: f.id, kind: f.kind, code: f.code })),
            notTried: result.notTried.map((p) => ({ level: p.level, id: p.id })),
            found: result.found.length,
            recordedObjects,
            unrecorded: unrecorded.slice(0, 30),
            listed: { campaign: result.listed.campaign.ok, ad_set: result.listed.ad_set.ok, ad: result.listed.ad.ok },
          }
        : { blocked: result.code }),
    });
    return { recorded: true, state: settlement.state, nextAt: settlement.nextAt ? settlement.nextAt.toISOString() : null, code: settlement.code, tries };
  },
});

// The stopped launches of the account a revoke obligation belongs to that are not wound down, oldest first (the revoke sweep pauses what a closed connection's launches
// made with the sealed copy of its token, before it revokes the permission): ids only, for the system. An obligation of a read token that holds a spend permission, or one
// with no account, lists none (a launch is made with a write connection's token). `blocked` says the revoke must wait for the next try although none of these is left to
// pause: this account has more launches than one page (the rest are read next time), or an account the same person granted in this org has a stopped launch that is not
// paused yet, and the revoke is the person's, for the app: it would cut the token that launch still needs (each account pauses its own with its own copy). The read token's
// obligation lists none but waits the same way: with the default shared app a switch-off makes both obligations, and its revoke would cut the write copy before it paused.
interface PausePending {
  launches: string[];
  blocked: boolean;
  // This try of the obligation is its last (the tenth, or past six of its seven days): the policy gives up after it and wipes the copy without another call, so the revoke
  // is made whatever the pause came to, since a revoke held again would leave the permission valid at the platform for good (the screen says to remove the app by hand).
  lastChance: boolean;
}
// The longest an activation call, and the read that settles it, can be in flight: the job's call timeout and the platform's own, with room.
const ACTIVATION_IN_FLIGHT_SECONDS = 360;
const PENDING_PAGE = 50;
export const adsPausePending = defineQuery({
  name: 'ads.pause.pending',
  input: z.strictObject({ revokeId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<PausePending> => {
    const obligation = await ctx.trx
      .selectFrom('crove_ads.ad_token_revoke')
      .select(['ad_account_id', 'kind', 'grantor_hash', 'attempts', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.revokeId.toLowerCase())
      .executeTakeFirst();
    if (!obligation) return { launches: [], blocked: false, lastChance: false };
    const lastChance = obligation.attempts >= REVOKE_MAX_ATTEMPTS || Date.now() - new Date(obligation.created_at).getTime() >= REVOKE_MAX_AGE_MS - 86_400_000;
    // A write obligation pauses its own account's launches. A read token that holds a spend permission pauses none (a launch is made with a write connection's token), but
    // its revoke removes the same person's grant for the app, which the sealed write copy of a closed connection depends on: with the default shared app, a switch-off
    // makes both obligations, and the read one must not revoke before the write one has paused.
    const own = obligation.kind === 'write' ? obligation.ad_account_id : null;
    if (obligation.kind === 'write' && !own) return { launches: [], blocked: false, lastChance: false };
    let launches: string[] = [];
    let blocked = false;
    if (own) {
      // A launch that has started and is still going counts too while the account's write connection is closed (W2-4b): it was closed by a path that is not a stop command,
      // and `ads.pause.begin` stops the launch first. With the connection open the launch is not this obligation's (the connection that closed is another one).
      const holder = await ctx.trx.selectFrom('crove_ads.ad_account').select('write_connection_id').where('org_id', '=', ctx.orgId).where('id', '=', own).executeTakeFirst();
      const current = holder?.write_connection_id
        ? await ctx.trx.selectFrom('crove_kernel.channel_connection').select('status').where('org_id', '=', ctx.orgId).where('id', '=', holder.write_connection_id).executeTakeFirst()
        : undefined;
      const connectionClosed = current?.status !== 'active';
      const rows = await ctx.trx
        .selectFrom('crove_ads.ad_launch')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('ad_account_id', '=', own)
        .where('started_at', 'is not', null)
        .where((eb) =>
          eb.or([...(connectionClosed ? [eb('state', 'in', [...STARTED_STATES])] : []), eb.and([eb('state', '=', 'stopped'), eb('wound_down_at', 'is', null), eb('wind_down_code', 'is', null)])]),
        )
        .orderBy('updated_at')
        .limit(PENDING_PAGE + 1)
        .execute();
      blocked = rows.length > PENDING_PAGE;
      launches = rows.slice(0, PENDING_PAGE).map((r) => r.id);
    }
    if (!blocked && obligation.grantor_hash) {
      // A launch of the same person's other accounts that is not paused yet: its account either still has a write connection the person granted, or has closed it and holds a
      // write obligation of its own that is pending (closing a connection clears the account's hash, so the obligation is the only trace of whose grant it was). A given-up
      // launch does not hold (it has a code), and a launch of this obligation's own account is its list above.
      const { rows: others } = await sql<{ n: number }>`
        SELECT count(*)::int AS n
        FROM crove_ads.ad_launch l
        WHERE l.org_id = ${ctx.orgId}::uuid
          AND l.ad_account_id IS DISTINCT FROM ${own}::uuid
          AND l.state = 'stopped' AND l.started_at IS NOT NULL AND l.wound_down_at IS NULL AND l.wind_down_code IS NULL
          AND (
            EXISTS (SELECT 1 FROM crove_ads.ad_account a WHERE a.org_id = l.org_id AND a.id = l.ad_account_id AND a.write_granted_by_hash = ${obligation.grantor_hash})
            OR EXISTS (
              SELECT 1 FROM crove_ads.ad_token_revoke r
              WHERE r.org_id = l.org_id AND r.ad_account_id = l.ad_account_id AND r.kind = 'write' AND r.state = 'pending' AND r.grantor_hash = ${obligation.grantor_hash})
          )`.execute(ctx.trx);
      blocked = (others[0]?.n ?? 0) > 0;
    }
    return { launches, blocked, lastChance };
  },
});

export const launchPauseCommands = [adsLaunchStop, adsPauseBegin, adsPauseRecord];
export const launchPauseQueries = [adsPausePending];
