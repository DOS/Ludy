// SPDX-License-Identifier: AGPL-3.0-only
// The read of the platform's object states into a launch (issue #3301, plan docs/plan/ads-write.md sections 4, 9 and 10 W2 step 3). A launch creates its objects paused and
// switches them on; the platform then reviews them, and says so in each object's own status (`effective_status`: in review, active, disapproved, with issues) and, for an ad it
// refused, why. The state job (apps/kernel/src/ads-state.ts) asks the platform with the narrowed view of packages/ad-platform (state-readers.ts, a read and nothing else) and
// hands the answer to two things here, both the system's:
// - `ads.object.sync_target` (query): which launches of the account have objects to read, and through which write connection.
// - `ads.object.sync_state` (command, R1 internal): records the answer on the launch's own recorded objects, and the read in the kernel's `external_call` ledger.
// What the platform says is DISPLAY, never a decision: the command writes `effective_status`, `review_reason` and `last_seen_at` of `ad_object` rows (the column grant the writer
// migration gave and the object guard holds to the system) and nothing else. It never touches the launch, its commitment or the caps. The platform's words are tainted: a status
// is upper-case words and a reason is a short code (the adapter made it), checked again here against what the database stores, and the screen renders both as text. A read that
// failed leaves the last known state (a failed row of the ledger says so) and never errors the launch. The same answer twice writes nothing to the objects.
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { defineCommand, defineQuery } from '@crove/kernel-runtime';
import { stateReadKeyPrefix } from './launch-ledger.ts';
import { requireSystem } from './launch-run.ts';

// The levels whose own status is read, as `STATE_LEVELS` of the platform package names them (a creative has none of its own).
const LEVELS = ['campaign', 'ad_set', 'ad'] as const;
export type StateObjectLevel = (typeof LEVELS)[number];

// The states of a launch that still have objects worth asking about: a launch that is running or waiting for a person, and a stopped one for three days after its last
// change (its pause is shown as the platform says it). A launch that ended before that has nothing more to say.
const STOPPED_READ_DAYS = 3;
// The launches one run reads at most, and the objects of each (a launch has at most a campaign, an ad set and three ads).
export const STATE_SYNC_LAUNCHES = 10;
export const STATE_SYNC_OBJECTS = 12;

export const STATE_STATUS = /^[A-Z_]{1,40}$/;
export const STATE_REASON = /^[a-z0-9_]{1,60}$/;
// What an object the platform no longer has shows: its status and the reason code the screen words.
export const STATE_GONE_STATUS = 'DELETED';
export const STATE_GONE_REASON = 'deleted_at_platform';

export interface StateSyncTarget {
  adAccountId: string;
  // The write connection the objects were made through (its sealed token reads them) and its provider.
  writeConnectionId: string;
  provider: string;
  launches: Array<{ launchId: string; objects: Array<{ level: StateObjectLevel; id: string }> }>;
}

export const adsObjectSyncTarget = defineQuery({
  name: 'ads.object.sync_target',
  input: z.object({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<StateSyncTarget | null> => {
    // The account is found by the connection the hourly sync runs for (the read connection); the objects were made through the write connection.
    const account = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'write_connection_id'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .executeTakeFirst();
    if (!account?.write_connection_id) return null;
    const write = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', account.write_connection_id)
      .executeTakeFirst();
    // Without an active write connection there is no token to read with; the last known states stay.
    if (!write || write.status !== 'active') return null;
    const since = new Date(Date.now() - STOPPED_READ_DAYS * 86_400_000);
    const launches = await ctx.trx
      .selectFrom('crove_ads.ad_launch')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('ad_account_id', '=', account.id)
      .where((eb) => eb.or([eb('state', 'in', ['launching', 'live', 'needs_attention']), eb.and([eb('state', '=', 'stopped'), eb('updated_at', '>', since)])]))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(STATE_SYNC_LAUNCHES)
      .execute();
    if (launches.length === 0) return null;
    const objects = await ctx.trx
      .selectFrom('crove_ads.ad_object')
      .select(['launch_id', 'level', 'external_id'])
      .where('org_id', '=', ctx.orgId)
      .where('launch_id', 'in', launches.map((l) => l.id))
      .where('level', 'in', [...LEVELS])
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const byLaunch = new Map<string, Array<{ level: StateObjectLevel; id: string }>>();
    for (const o of objects) {
      const list = byLaunch.get(o.launch_id) ?? [];
      if (list.length < STATE_SYNC_OBJECTS) list.push({ level: o.level as StateObjectLevel, id: o.external_id });
      byLaunch.set(o.launch_id, list);
    }
    const found = launches.map((l) => ({ launchId: l.id, objects: byLaunch.get(l.id) ?? [] })).filter((l) => l.objects.length > 0);
    return found.length === 0 ? null : { adAccountId: account.id, writeConnectionId: write.id, provider: write.provider, launches: found };
  },
});

const zExternalId = z.string().min(1).max(64);
const zLevel = z.enum(LEVELS);
const zCode = z.string().regex(/^[A-Za-z0-9_.]{1,64}$/);
export const zObjectState = z.discriminatedUnion('found', [
  z.strictObject({ id: zExternalId, level: zLevel, found: z.literal(true), status: z.string().regex(STATE_STATUS), reason: z.string().regex(STATE_REASON).nullable() }),
  // The platform no longer has the object (deleted there).
  z.strictObject({ id: zExternalId, level: zLevel, found: z.literal(false) }),
]);
export const zObjectStateFailure = z.strictObject({
  id: zExternalId,
  level: zLevel,
  kind: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown']),
  code: zCode.nullable(),
});
export const zObjectSyncInput = z.strictObject({
  launchId: zId,
  // The objects the platform answered for, and the ones it could not be asked about (each with the kind of failure and a code, never a message).
  states: z.array(zObjectState).max(STATE_SYNC_OBJECTS),
  failed: z.array(zObjectStateFailure).max(STATE_SYNC_OBJECTS),
});
export type ObjectSyncInput = z.infer<typeof zObjectSyncInput>;

export interface ObjectSynced {
  recorded: boolean;
  reason?: 'not_found';
  // Objects whose status or reason changed, objects whose answer was the same (nothing written), answers for an object the launch has no record of, and reads that failed.
  changed?: number;
  unchanged?: number;
  unknown?: number;
  failed?: number;
}

// The key of a read in the kernel's ledger: the launch and the moment of the read (to the millisecond), so each read is a row of its own (a finished row never changes).
export const stateReadKey = (launchId: string, now: Date): string => `${stateReadKeyPrefix(launchId)}${now.toISOString().replace(/[^0-9]/g, '')}`;

export const adsObjectSyncState = defineCommand({
  name: 'ads.object.sync_state',
  input: zObjectSyncInput,
  // Records what the platform reported and posts nothing; the platform was read by the job. Display fields only (R1), the system's: an agent and a member are refused by
  // the access, and the object guard of the database refuses anyone else's write of these columns.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_launch', id: input.launchId.toLowerCase() }),
  handler: async (ctx, input): Promise<ObjectSynced> => {
    requireSystem(ctx);
    const launchId = input.launchId.toLowerCase();
    const launch = await ctx.trx.selectFrom('crove_ads.ad_launch').select(['id', 'ad_account_id']).where('org_id', '=', ctx.orgId).where('id', '=', launchId).executeTakeFirst();
    if (!launch) return { recorded: false, reason: 'not_found' };
    // The launch's own recorded objects, locked: an answer is matched to one by its platform id and level, never by a name, and an id the launch has no record of is counted
    // and ignored (nothing is created from what a platform says).
    const objects = await ctx.trx
      .selectFrom('crove_ads.ad_object')
      .select(['id', 'level', 'external_id', 'effective_status', 'review_reason'])
      .where('org_id', '=', ctx.orgId)
      .where('launch_id', '=', launchId)
      .forUpdate()
      .execute();
    const rowOf = new Map(objects.map((o) => [`${o.level}\u0000${o.external_id}`, o]));
    let changed = 0;
    let unchanged = 0;
    let unknown = 0;
    for (const state of input.states) {
      const row = rowOf.get(`${state.level}\u0000${state.id}`);
      if (!row) {
        unknown += 1;
        continue;
      }
      const status = state.found ? state.status : STATE_GONE_STATUS;
      const reason = state.found ? state.reason : STATE_GONE_REASON;
      // The same answer as the last one writes nothing.
      if (row.effective_status === status && row.review_reason === reason) {
        unchanged += 1;
        continue;
      }
      await ctx.trx.updateTable('crove_ads.ad_object').set({ effective_status: status, review_reason: reason, last_seen_at: ctx.now, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
      changed += 1;
    }
    const failed = input.failed.length;
    const firstFailure = input.failed[0];
    // The read in the kernel's ledger, a row for each: it says whether the read worked, and why not, without a word of what the platform answered. The ledger takes a call as
    // started and then as its outcome, so the row is inserted and settled here, in this one transaction (the platform was asked before, by the job, and the read changes nothing).
    if (input.states.length + failed > 0) {
      const key = stateReadKey(launchId, ctx.now);
      const inserted = await ctx.trx
        .insertInto('crove_kernel.external_call')
        .values({ org_id: ctx.orgId, key, module: 'ads', target: 'launch', step: 'state_read', retry_safety: 'safe', started_at: ctx.now })
        .onConflict((oc) => oc.columns(['org_id', 'key']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted) {
        await ctx.trx
          .updateTable('crove_kernel.external_call')
          .set({ state: failed === 0 ? 'succeeded' : 'failed', error_kind: firstFailure?.kind ?? null, error_code: firstFailure?.code ?? null, finished_at: ctx.now, updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', inserted.id)
          .execute();
      }
    }
    ctx.audit({ launchId, adAccountId: launch.ad_account_id, read: input.states.length, changed, unchanged, unknown, failed, ...(firstFailure ? { failedKind: firstFailure.kind, failedCode: firstFailure.code } : {}) });
    return { recorded: true, changed, unchanged, unknown, failed };
  },
});

export const objectStateCommands = [adsObjectSyncState];
export const objectStateQueries = [adsObjectSyncTarget];
