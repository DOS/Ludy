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
    notTried: z.number().int().min(0).max(300),
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
      const complete = everyLevelListed && result.failed.length === 0 && result.notTried === 0 && youngestAge === null && !notPaused;
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
    // Ids and codes only: the objects the platform refused to pause are listed (bounded) so a person can pause them by hand if Ludy gives up.
    ctx.audit({
      launchId,
      adAccountId: launch.ad_account_id,
      via: input.via,
      tries,
      outcome: settlement.state,
      code: settlement.code,
      ...(result.kind === 'ran'
        ? {
            paused: result.paused.length,
            failed: result.failed.slice(0, 30).map((f) => ({ level: f.level, id: f.id, kind: f.kind, code: f.code })),
            notTried: result.notTried,
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
// with no account, has none (a launch is made with a write connection's token). `blocked` says the revoke must wait for the next try although none of these is left to
// pause: this account has more launches than one page (the rest are read next time), or an account the same person granted in this org has a stopped launch that is not
// paused yet, and the revoke is the person's, for the app: it would cut the token that launch still needs (each account pauses its own with its own copy).
interface PausePending {
  launches: string[];
  blocked: boolean;
  // This try of the obligation is its last (the tenth, or past six of its seven days): the policy gives up after it and wipes the copy without another call, so the revoke
  // is made whatever the pause came to, since a revoke held again would leave the permission valid at the platform for good (the screen says to remove the app by hand).
  lastChance: boolean;
}
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
    if (!obligation || obligation.kind !== 'write' || !obligation.ad_account_id) return { launches: [], blocked: false, lastChance: false };
    const lastChance = obligation.attempts >= REVOKE_MAX_ATTEMPTS || Date.now() - new Date(obligation.created_at).getTime() >= REVOKE_MAX_AGE_MS - 86_400_000;
    const rows = await ctx.trx
      .selectFrom('crove_ads.ad_launch')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('ad_account_id', '=', obligation.ad_account_id)
      .where('state', '=', 'stopped')
      .where('started_at', 'is not', null)
      .where('wound_down_at', 'is', null)
      .where('wind_down_code', 'is', null)
      .orderBy('updated_at')
      .limit(PENDING_PAGE + 1)
      .execute();
    let blocked = rows.length > PENDING_PAGE;
    if (!blocked && obligation.grantor_hash) {
      const { rows: others } = await sql<{ n: number }>`
        SELECT count(*)::int AS n
        FROM crove_ads.ad_launch l
        JOIN crove_ads.ad_account a ON a.org_id = l.org_id AND a.id = l.ad_account_id
        WHERE l.org_id = ${ctx.orgId}::uuid AND a.id <> ${obligation.ad_account_id}::uuid AND a.write_granted_by_hash = ${obligation.grantor_hash}
          AND l.state = 'stopped' AND l.started_at IS NOT NULL AND l.wound_down_at IS NULL AND l.wind_down_code IS NULL`.execute(ctx.trx);
      blocked = (others[0]?.n ?? 0) > 0;
    }
    return { launches: rows.slice(0, PENDING_PAGE).map((r) => r.id), blocked, lastChance };
  },
});

export const launchPauseCommands = [adsLaunchStop, adsPauseBegin, adsPauseRecord];
export const launchPauseQueries = [adsPausePending];
