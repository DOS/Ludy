// SPDX-License-Identifier: AGPL-3.0-only
// Pushing vouchers to MISA AMIS Kế toán as the requests a person approved (#3902, S3b of #3854; design in the issue, modelled on the e-invoice issue, ADR-0044 points 3 to 5).
// - finance.misa_amis.push (owners and admins; R2 external; never an agent): the person confirms the previewed batch. The command rebuilds the batch from the live data (misa-amis-build.ts, the preview's
//   own path), refuses it when the data changed since the person looked (the digest, MISA_AMIS_PUSH_STALE) or when anything is blocked, and records one `queued` row per voucher part with ON CONFLICT
//   (org_id, org_refid) DO NOTHING: pressing twice, a double click or a replay queues nothing twice. A `refused` or `failed` row goes back to `queued` only here (a new confirmed push, one more attempt).
//   A row that is queued, sending, sent, accepted or ambiguous is never touched; an accepted voucher whose source was revised since is counted, never sent again (what a second `save` under one
//   `org_refid` does is unconfirmed until the sandbox check).
// - finance.misa_amis.push_target (system; query): the connection the worker may push for, or why not.
// - finance.misa_amis.push_begin (system; R2 external): decides the worker's next step for one connection and commits the call to the external_call ledger BEFORE it is made: check MISA for the results of
//   the rows it took or whose answer was lost (`sent`, `ambiguous`, or `sending` for too long, which becomes `ambiguous`), once per run, then send the next batch of queued rows (at most AMIS_SAVE_BATCH_MAX, one
//   voucher type and one set of choices). A batch whose call was begun before is never sent again.
// - finance.misa_amis.push_record (system; R1): writes what came back into the rows and the call. Only moves the graph allows (the table's guard says the same).
// - finance.misa_amis.push_resolve (owners and admins; R2 internal): after three days without MISA's answer a person who looked in AMIS says "it is in AMIS" (`sent`, no call) or "it is not in AMIS" (`failed`: only a new
//   confirmed push sends it again).
// - finance.misa_amis.push_list (every member; query): the rows of a connection with their state and MISA's reason (untrusted text: the screen shows it escaped).
// No voucher body is stored, and no row, audit fact, ledger row or error carries a credential, a party name or an amount: ids, codes, dates, counts and states. MISA's own text is only the `reason` of a refused row.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { MISA_AMIS_PREVIEW_LIMIT, zId, zMisaAmisPreviewAsk, type MisaAmisPreviewAsk } from '@crove/kernel-contract';
import type { MemberRole, MisaAmisPushSource, MisaAmisPushState } from '@crove/db';
import { AMIS_SAVE_BATCH_MAX } from '@crove/misa-amis';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { amisBatchDigest, amisContextOf, amisPartRows, loadAmisEntries, type AmisQuery } from './misa-amis-build.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// The event that starts the worker's job for a connection (apps/kernel/src/worker.ts relays it to the queue). Ids only.
export const MISA_AMIS_PUSH_REQUESTED = 'finance.misa_amis.push_requested';

// A `sending` row older than this has an unknown fate (the worker died between the commit and the answer): it is asked about, never sent again.
export const PUSH_IN_FLIGHT_SECONDS = 120;
// The most rows one check asks about (MISA's own page of results is as large).
const CHECK_ROWS_MAX = 1000;
// How long MISA is asked for the result of a row it took (or whose answer was lost) before the row is left as it is for a person to read.
export const PUSH_RESULT_WINDOW_HOURS = 24;
// A queued row older than this is `failed` (EXPIRED): the person's confirmation does not last for ever.
export const PUSH_QUEUED_EXPIRY_DAYS = 7;
// MISA's text for a refusal, capped like the column.
const REASON_MAX = 500;

const zDigest = z.string().regex(/^[0-9a-f]{64}$/);
const zOrgRefid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const notFound = () => new DomainError('MISA_AMIS_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối MISA AMIS này');

const queryOf =
  (ctx: QueryContext): AmisQuery =>
  async <T>(name: string, input: unknown): Promise<T> => {
    const answer = await ctx.query<T>(name, input);
    if (answer.status !== 'ok') throw new DomainError('MODULE_OFF', 409, 'Mô-đun Tài chính chưa được bật');
    return answer.value;
  };

// What rebuilds a batch from its sources: the ask without the entity (the connection's) and without the connection id and the digest. Kept on every row; ids, codes and dates only.
export type PushParams = Omit<MisaAmisPreviewAsk, 'legalEntityId'>;
const paramsOf = (ask: MisaAmisPreviewAsk): PushParams => {
  const { legalEntityId: _entity, ...rest } = ask;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as PushParams;
};
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// The external call ledger (ADR-0025 decision 5), as the e-invoice job writes it: a call is committed as started before it is made.

async function startCall(ctx: CommandContext, key: string): Promise<'new' | 'again' | 'closed'> {
  const inserted = await ctx.trx
    .insertInto('crove_kernel.external_call')
    .values({ org_id: ctx.orgId, key, module: 'finance', target: 'misa_amis', step: 'save', retry_safety: 'reconcile_only', started_at: ctx.now })
    .onConflict((oc) => oc.columns(['org_id', 'key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return 'new';
  const again = await ctx.trx
    .updateTable('crove_kernel.external_call')
    .set({ state: 'started', calls: sql<number>`calls + 1`, updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('key', '=', key)
    .where('state', 'in', ['started', 'ambiguous'])
    .where('calls', '<', 1000)
    .returning('id')
    .executeTakeFirst();
  return again ? 'again' : 'closed';
}

export type PushCallEnd = { state: 'succeeded' } | { state: 'failed'; kind: 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient' | 'unknown'; code: string } | { state: 'ambiguous'; kind: 'transient' | 'unknown'; code: string };

async function endCall(ctx: CommandContext, key: string, end: PushCallEnd): Promise<void> {
  const set =
    end.state === 'succeeded'
      ? { state: 'succeeded' as const, finished_at: ctx.now, updated_at: ctx.now }
      : end.state === 'failed'
        ? { state: 'failed' as const, error_kind: end.kind, error_code: end.code, finished_at: ctx.now, updated_at: ctx.now }
        : { state: 'ambiguous' as const, error_kind: end.kind, error_code: end.code, updated_at: ctx.now };
  await ctx.trx.updateTable('crove_kernel.external_call').set(set).where('org_id', '=', ctx.orgId).where('key', '=', key).where('state', 'in', ['started', 'ambiguous']).execute();
}

// ---------------------------------------------------------------------------------------------------------------
// The command a person gives

export const zMisaAmisPush = zMisaAmisPreviewAsk.extend({
  connectionId: zId,
  // What the person saw: the preview's digest. A different digest now means the data changed, and nothing is queued.
  digest: zDigest,
});
export interface MisaAmisPushResult {
  queued: number;
  requeued: number;
  already: number;
  revised: number;
}

const CHUNK = 200;
const chunks = <T>(list: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export const misaAmisPush = defineCommand({
  name: 'finance.misa_amis.push',
  input: zMisaAmisPush,
  // The event it emits starts a job that calls AMIS with the org's sealed access code and sends the confirmed vouchers: R2 external (plan section 4.7). AMIS only receives a request ("đề nghị sinh chứng từ")
  // that a person in AMIS turns into a voucher, so this is not R3; the approval is the person's, bound to the digest of what they saw (owner decision of the PO on #3902).
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx, input): Promise<MisaAmisPushResult> => {
    const connection = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.legal_entity_id', 'c.last_test_state', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection) throw notFound();
    if (connection.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    // Only a connection whose last test worked (S2b): a wrong code or an unreachable AMIS is found by the test, not by a half-sent batch.
    if (connection.last_test_state !== 'works') throw new DomainError('MISA_AMIS_NOT_TESTED', 409, 'Hãy kiểm tra kết nối MISA AMIS thành công trước khi gửi');
    if (input.legalEntityId !== undefined && input.legalEntityId !== connection.legal_entity_id) throw new DomainError('MISA_AMIS_ENTITY_MISMATCH', 422, 'Kết nối này thuộc pháp nhân khác');

    const { connectionId: _id, digest, ...ask } = input;
    const buildAsk: MisaAmisPreviewAsk = { ...ask, legalEntityId: connection.legal_entity_id };
    // One more than the list holds, as the preview asks: a longer period is never pushed from a partial view.
    const { entries, loaded } = await loadAmisEntries(queryOf(ctx), buildAsk, amisContextOf(buildAsk), MISA_AMIS_PREVIEW_LIMIT + 1);
    if (loaded > MISA_AMIS_PREVIEW_LIMIT) throw new DomainError('MISA_AMIS_PUSH_TOO_MANY', 422, 'Kỳ này có quá nhiều chứng từ, hãy chọn khoảng ngắn hơn');
    if (entries.some((e) => e.mapping.blockers.length > 0)) throw new DomainError('MISA_AMIS_PUSH_BLOCKED', 409, 'Có chứng từ chưa đủ điều kiện gửi, hãy xem lại bản xem trước');
    if (amisBatchDigest(entries) !== digest) throw new DomainError('MISA_AMIS_PUSH_STALE', 409, 'Dữ liệu đã thay đổi từ lúc bạn xem, hãy xem trước lại');
    const rows = amisPartRows(entries);
    if (rows.length === 0) throw new DomainError('MISA_AMIS_PUSH_EMPTY', 422, 'Không có chứng từ nào để gửi');

    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const params = JSON.stringify(paramsOf(buildAsk));
    const result: MisaAmisPushResult = { queued: 0, requeued: 0, already: 0, revised: 0 };
    for (const part of chunks(rows, CHUNK)) {
      const inserted = await ctx.trx
        .insertInto('crove_finance.misa_amis_push')
        .values(
          part.map((r) => ({
            org_id: ctx.orgId,
            legal_entity_id: connection.legal_entity_id,
            connection_id: connection.id,
            source_type: r.sourceType,
            source_id: r.sourceId,
            voucher_type: r.voucherType,
            part: r.part,
            org_refid: r.orgRefid,
            org_refno: r.orgRefno,
            payload_digest: r.digest,
            params,
            requested_by: userId,
          })),
        )
        // The idempotency key: a second press, a replay or a concurrent push finds the row and queues nothing.
        .onConflict((oc) => oc.columns(['org_id', 'org_refid']).doNothing())
        .returning('org_refid')
        .execute();
      result.queued += inserted.length;
      const fresh = new Set(inserted.map((r) => r.org_refid));
      const rest = part.filter((r) => !fresh.has(r.orgRefid));
      if (rest.length === 0) continue;
      const existing = await ctx.trx
        .selectFrom('crove_finance.misa_amis_push')
        .select(['id', 'org_refid', 'state', 'payload_digest', 'connection_id'])
        .where('org_id', '=', ctx.orgId)
        .where('org_refid', 'in', rest.map((r) => r.orgRefid))
        .forUpdate()
        .execute();
      const byRefid = new Map(existing.map((e) => [e.org_refid, e]));
      for (const r of rest) {
        const row = byRefid.get(r.orgRefid);
        if (!row || row.connection_id !== connection.id) {
          result.already += 1;
        } else if (row.state === 'refused' || row.state === 'failed') {
          // A person's new confirmed push: one more attempt, with the digest and the choices approved now. Nothing else moves a refused or failed row.
          const moved = await ctx.trx
            .updateTable('crove_finance.misa_amis_push')
            .set({ state: 'queued', reason: null, attempts: sql<number>`attempts + 1`, sent_at: null, answered_at: null, payload_digest: r.digest, params, requested_by: userId, requested_at: ctx.now, updated_at: ctx.now })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', row.id)
            .where('state', 'in', ['refused', 'failed'])
            .executeTakeFirst();
          if (Number(moved.numUpdatedRows) > 0) result.requeued += 1;
          else result.already += 1;
        } else if (row.state === 'accepted' && row.payload_digest !== r.digest) {
          // Revised after AMIS took it: not sent again by anything until the sandbox check says what a second save does.
          result.revised += 1;
        } else {
          result.already += 1;
        }
      }
    }
    // Always: a press that queued nothing new still nudges the job (rows left `queued` after a refused connection are sent once the connection works again, within a week; a run with nothing to do ends at once).
    await ctx.emit(MISA_AMIS_PUSH_REQUESTED, { connection_id: connection.id });
    ctx.audit({ connectionId: connection.id, kind: ask.kind, queued: result.queued, requeued: result.requeued, already: result.already, revised: result.revised });
    return result;
  },
});

// ---------------------------------------------------------------------------------------------------------------
// What the worker needs

export type MisaAmisPushTarget = { action: 'none'; reason: 'not_found' | 'not_active' } | { action: 'push'; id: string; channelConnectionId: string; orgCompanyCode: string; legalEntityId: string };

export const misaAmisPushTarget = defineQuery({
  name: 'finance.misa_amis.push_target',
  input: z.strictObject({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<MisaAmisPushTarget> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.channel_connection_id', 'c.org_company_code', 'c.legal_entity_id', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.connectionId)
      .executeTakeFirst();
    if (!row) return { action: 'none', reason: 'not_found' };
    if (row.status !== 'active') return { action: 'none', reason: 'not_active' };
    return { action: 'push', id: row.id, channelConnectionId: row.channel_connection_id, orgCompanyCode: row.org_company_code, legalEntityId: row.legal_entity_id };
  },
});

export interface PushRowRef {
  orgRefid: string;
  digest: string;
  sourceId: string;
  part: number;
}

export type MisaAmisPushBegin =
  // `waiting`: rows MISA took (or may have) still await their result inside the window, so the job comes back later.
  | { action: 'none'; reason: 'not_found' | 'not_active' | 'nothing'; waiting: boolean }
  // The AMIS branch is read from AMIS's dictionary by the worker; the batch is not begun without it.
  | { action: 'need_branch' }
  | { action: 'send'; callKey: string; voucherType: number; params: PushParams; rows: PushRowRef[]; sourceType: MisaAmisPushSource }
  // Rows MISA took (`sent`) or whose answer was lost (`ambiguous`): MISA is asked for their results. `from` is the first day it is asked about (YYYY-MM-DD).
  | { action: 'check'; rows: Array<{ orgRefid: string; state: MisaAmisPushState }>; from: string };

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

export const misaAmisPushBegin = defineCommand({
  name: 'finance.misa_amis.push_begin',
  // `checked`: this run of the job has already asked MISA for results, so the next step is to send. `branchKnown`: the worker has read the AMIS branch.
  input: z.strictObject({ connectionId: zId, branchKnown: z.boolean(), checked: z.boolean() }),
  // Commits the call to AMIS the worker makes next: an effect outside Ludy. A system actor does R2, never R3: the approval was the person's confirmed push.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<MisaAmisPushBegin> => {
    const connection = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.connectionId)
      .forUpdate('c')
      .executeTakeFirst();
    if (!connection) return { action: 'none', reason: 'not_found', waiting: false };
    if (connection.status !== 'active') return { action: 'none', reason: 'not_active', waiting: false };

    const table = 'crove_finance.misa_amis_push';
    const windowStart = new Date(ctx.now.getTime() - PUSH_RESULT_WINDOW_HOURS * 3600 * 1000);
    // A batch begun and never answered for too long: its fate is unknown, so it is asked about and never sent again.
    await ctx.trx
      .updateTable(table)
      .set({ state: 'ambiguous', reason: 'LOST_ANSWER', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('state', '=', 'sending')
      .where('updated_at', '<', new Date(ctx.now.getTime() - PUSH_IN_FLIGHT_SECONDS * 1000))
      .execute();

    // A confirmation does not wait forever: a row still queued a week later (the worker off, the connection unusable) is `failed` as EXPIRED and needs a new confirmed push, so turning the push on later never
    // sends an old approval.
    await ctx.trx
      .updateTable(table)
      .set({ state: 'failed', reason: 'EXPIRED', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('state', '=', 'queued')
      .where('requested_at', '<', new Date(ctx.now.getTime() - PUSH_QUEUED_EXPIRY_DAYS * 24 * 3600 * 1000))
      .execute();

    // 1. Rows MISA took, or whose answer was lost (a batch begun and never answered is `ambiguous` above): MISA is asked for their results once per run, before anything else is sent.
    if (!input.checked) {
      const checkable = await ctx.trx
        .selectFrom(table)
        .select(['org_refid', 'state', 'sent_at', 'updated_at'])
        .where('org_id', '=', ctx.orgId)
        .where('connection_id', '=', input.connectionId)
        .where('state', 'in', ['ambiguous', 'sent'])
        .where('updated_at', '>', windowStart)
        .orderBy('requested_at')
        .orderBy('id')
        .limit(CHECK_ROWS_MAX)
        .execute();
      if (checkable.length > 0) {
        const earliest = checkable.reduce((min, r) => (new Date(r.sent_at ?? r.updated_at) < min ? new Date(r.sent_at ?? r.updated_at) : min), ctx.now);
        return { action: 'check', rows: checkable.map((r) => ({ orgRefid: r.org_refid, state: r.state })), from: dayOf(earliest) };
      }
    }

    // 2. The next batch of queued rows: one voucher type and one set of choices, oldest first, at most the batch size.
    const first = await ctx.trx
      .selectFrom(table)
      .select(['voucher_type', 'params', 'source_type'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('state', '=', 'queued')
      .orderBy('requested_at')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    if (first) {
      if (!input.branchKnown) return { action: 'need_branch' };
      const batch = await ctx.trx
        .selectFrom(table)
        .select(['id', 'org_refid', 'payload_digest', 'source_id', 'part', 'attempts', 'params', 'updated_at'])
        .where('org_id', '=', ctx.orgId)
        .where('connection_id', '=', input.connectionId)
        .where('state', '=', 'queued')
        .where('voucher_type', '=', first.voucher_type)
        .where('source_type', '=', first.source_type)
        .where(sql<boolean>`params = ${JSON.stringify(first.params)}::jsonb`)
        .orderBy('requested_at')
        .orderBy('id')
        .limit(AMIS_SAVE_BATCH_MAX)
        .forUpdate()
        .execute();
      // The key names the rows, their attempt and when they were last queued, so rows put back in the queue (a person's retry, or a call that never left Ludy: a refused connection, an unreachable AMIS) are a new
      // call, while a call that ended (a finished call never changes) is never made again for the same queueing.
      const callKey = `misa_amis:save:${input.connectionId}:${sha256(batch.map((r) => `${r.org_refid}:${r.attempts}:${new Date(r.updated_at).getTime()}`).sort().join(','))}`;
      const started = await startCall(ctx, callKey);
      if (started === 'closed') {
        // The same rows and attempt were begun before and that call has ended: never sent again. The rows are `failed` (a person may confirm a new push, a new attempt, a new call).
        await ctx.trx
          .updateTable(table)
          .set({ state: 'failed', reason: 'CALL_ENDED', updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', 'in', batch.map((r) => r.id))
          .where('state', '=', 'queued')
          .execute();
        return { action: 'none', reason: 'nothing', waiting: true };
      }
      await ctx.trx
        .updateTable(table)
        .set({ state: 'sending', updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', 'in', batch.map((r) => r.id))
        .where('state', '=', 'queued')
        .execute();
      ctx.audit({ connectionId: input.connectionId, step: 'send', rows: batch.length });
      return {
        action: 'send',
        callKey,
        voucherType: first.voucher_type,
        sourceType: first.source_type,
        params: (typeof first.params === 'string' ? JSON.parse(first.params) : first.params) as PushParams,
        rows: batch.map((r) => ({ orgRefid: r.org_refid, digest: r.payload_digest, sourceId: r.source_id, part: r.part })),
      };
    }

    // 3. Nothing to send: the job comes back later while rows wait for MISA's answer inside the window.
    const waiting = await ctx.trx
      .selectFrom(table)
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('state', 'in', ['sending', 'sent', 'ambiguous'])
      .where('updated_at', '>', windowStart)
      .limit(1)
      .executeTakeFirst();
    return { action: 'none', reason: 'nothing', waiting: Boolean(waiting) };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// What came back

const zRowMove = z.strictObject({
  orgRefid: zOrgRefid,
  // Where the row stood when the worker acted (a row another step moved meanwhile is left alone) and where it goes.
  from: z.enum(['sending', 'sent', 'ambiguous']),
  to: z.enum(['sent', 'accepted', 'refused', 'ambiguous', 'failed', 'queued']),
  // MISA's text (untrusted) for a refusal, or the code of a failure of ours (STALE, BLOCKED, CREDENTIALS...).
  reason: z.string().max(2000).nullable(),
});
const zCallEnd = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('succeeded') }),
  z.strictObject({ state: z.literal('failed'), kind: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown']), code: z.string().max(64) }),
  z.strictObject({ state: z.literal('ambiguous'), kind: z.enum(['transient', 'unknown']), code: z.string().max(64) }),
]);
export const zMisaAmisPushRecord = z.strictObject({
  connectionId: zId,
  rows: z.array(zRowMove).min(1).max(1000),
  // The ledger call these rows were sent under (a send), with how it ended.
  call: z.strictObject({ key: z.string().max(200), end: zCallEnd }).nullable(),
});
export type MisaAmisPushRecord = z.infer<typeof zMisaAmisPushRecord>;

const ALLOWED: Readonly<Record<'sending' | 'sent' | 'ambiguous', readonly string[]>> = {
  sending: ['sent', 'ambiguous', 'failed', 'refused', 'queued'],
  sent: ['accepted', 'refused'],
  ambiguous: ['accepted', 'refused'],
};

export const misaAmisPushRecord = defineCommand({
  name: 'finance.misa_amis.push_record',
  input: zMisaAmisPushRecord,
  // States on rows and the end of a ledger call; nothing leaves Ludy.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ applied: number; ignored: number }> => {
    let applied = 0;
    let ignored = 0;
    for (const move of input.rows) {
      if (!ALLOWED[move.from].includes(move.to)) throw new DomainError('MISA_AMIS_PUSH_STATE', 422, 'Trạng thái chứng từ không hợp lệ');
      const answered = move.to === 'accepted' || move.to === 'refused';
      const done = await ctx.trx
        .updateTable('crove_finance.misa_amis_push')
        .set({
          state: move.to,
          reason: move.reason === null ? null : move.reason.slice(0, REASON_MAX),
          ...(move.to === 'sent' ? { sent_at: ctx.now } : {}),
          ...(answered ? { answered_at: ctx.now } : {}),
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('connection_id', '=', input.connectionId)
        .where('org_refid', '=', move.orgRefid)
        .where('state', '=', move.from)
        .executeTakeFirst();
      if (Number(done.numUpdatedRows) > 0) applied += 1;
      else ignored += 1;
    }
    if (input.call) await endCall(ctx, input.call.key, input.call.end);
    ctx.audit({ connectionId: input.connectionId, applied, ignored });
    return { applied, ignored };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// What a person decides about a row MISA never answered for

// After this long without MISA's answer an `ambiguous` row is shown to an owner or admin to look at in AMIS.
export const PUSH_AMBIGUOUS_REVIEW_DAYS = 3;

export const zMisaAmisPushResolve = z.strictObject({
  connectionId: zId,
  orgRefid: zOrgRefid,
  // "It is in AMIS": the row is `sent` (no call is made; MISA's result is read as for any sent row). "It is not in AMIS": the row is `failed` and only a new confirmed push sends it again.
  outcome: z.enum(['in_amis', 'not_in_amis']),
});

export const misaAmisPushResolve = defineCommand({
  name: 'finance.misa_amis.push_resolve',
  input: zMisaAmisPushResolve,
  // A person records what they found in AMIS about a request whose answer was lost. Nothing is sent; a resend needs a new confirmed push (finance.misa_amis.push).
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ resolved: boolean }> => {
    const [state, reason] = input.outcome === 'in_amis' ? (['sent', 'CONFIRMED_IN_AMIS'] as const) : (['failed', 'NOT_IN_AMIS'] as const);
    const moved = await ctx.trx
      .updateTable('crove_finance.misa_amis_push')
      .set({ state, reason, ...(state === 'sent' ? { sent_at: ctx.now } : {}), updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('org_refid', '=', input.orgRefid)
      .where('state', '=', 'ambiguous')
      .where('updated_at', '<', new Date(ctx.now.getTime() - PUSH_AMBIGUOUS_REVIEW_DAYS * 24 * 3600 * 1000))
      .executeTakeFirst();
    const resolved = Number(moved.numUpdatedRows) > 0;
    if (!resolved) throw new DomainError('MISA_AMIS_PUSH_STATE', 409, 'Chứng từ này chưa thể xác nhận: chỉ chứng từ chưa có phản hồi từ MISA quá ba ngày mới xác nhận được');
    ctx.audit({ connectionId: input.connectionId, outcome: input.outcome });
    return { resolved };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// What a person reads

export interface MisaAmisPushRow {
  id: string;
  sourceType: MisaAmisPushSource;
  sourceId: string;
  voucherType: number;
  part: number;
  orgRefno: string;
  state: MisaAmisPushState;
  // MISA's own text for a refused voucher (untrusted: shown escaped) or the code of a failure of ours.
  reason: string | null;
  attempts: number;
  requestedAt: string;
  sentAt: string | null;
  answeredAt: string | null;
}

export const MISA_AMIS_PUSH_LIST_LIMIT = 200;

export const misaAmisPushList = defineQuery({
  name: 'finance.misa_amis.push_list',
  input: z.strictObject({ connectionId: zId, state: z.enum(['queued', 'sending', 'sent', 'accepted', 'refused', 'ambiguous', 'failed']).optional(), limit: z.number().int().min(1).max(MISA_AMIS_PUSH_LIST_LIMIT).optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<MisaAmisPushRow[]> => {
    let query = ctx.trx
      .selectFrom('crove_finance.misa_amis_push')
      .select(['id', 'source_type', 'source_id', 'voucher_type', 'part', 'org_refno', 'state', 'reason', 'attempts', 'requested_at', 'sent_at', 'answered_at'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId);
    if (input.state) query = query.where('state', '=', input.state);
    const rows = await query
      .orderBy('requested_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit ?? MISA_AMIS_PUSH_LIST_LIMIT)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      voucherType: r.voucher_type,
      part: r.part,
      orgRefno: r.org_refno,
      state: r.state,
      reason: r.reason,
      attempts: r.attempts,
      requestedAt: new Date(r.requested_at).toISOString(),
      sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
      answeredAt: r.answered_at ? new Date(r.answered_at).toISOString() : null,
    }));
  },
});

export const misaAmisPushCommands = [misaAmisPush, misaAmisPushBegin, misaAmisPushRecord, misaAmisPushResolve];
export const misaAmisPushQueries = [misaAmisPushTarget, misaAmisPushList];
