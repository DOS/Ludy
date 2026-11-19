// SPDX-License-Identifier: AGPL-3.0-only
// The check of a connection's vouchers against the firm's own MISA catalogue (#4112, S3a of #4103; plan accounting-software-sync.md step 5).
// The access code is sealed and only the worker opens it, so the API never reads the catalogue: a person asks, the worker reads the catalogue pages in its memory, matches, and records what it found.
// - finance.misa_amis_match.request_check (owners and admins; R2 external): files the request (the batch the person is looking at, as the preview's own ask) and queues the worker's job. A second press while
//   a check asked in the last ten minutes still waits returns that one and queues nothing.
// - finance.misa_amis_match.check_target (system; query): what the worker needs for one connection, or why it must not check it.
// - finance.misa_amis_match.record_check (system only): replaces the connection's results whole and marks the check done or failed.
// - finance.misa_amis_match.results (every member; query): the last check of an entity's connection and what it found, which the preview and the push read.
// The matching itself is pure and lives in misa-amis-matching.ts: a party is looked up by its tax code ONLY (never by name), an item by its exact code. The catalogue's names, addresses and tax codes are not
// kept, only the matched entry's code and id.
import { z } from 'zod';
import { zId, zMisaAmisMatchRecordCheck, zMisaAmisPreviewAsk, type MisaAmisMatchCheckQueued, type MisaAmisMatchStatus, type MisaAmisPreviewAsk } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// ---------------------------------------------------------------------------------------------------------------
// The check, as the mapper reads it

/** What the preview and the push read of a connection's last check. `partyCodes` and `itemCodes` are null until a check is `done`: then they are the matched ones, and everything else is not matched. */
export interface MisaAmisMatchResults {
  connectionId: string | null;
  status: MisaAmisMatchStatus;
  partyCodes: ReadonlyMap<string, string> | null;
  itemCodes: ReadonlySet<string> | null;
}

export const NO_MATCH_RESULTS: MisaAmisMatchResults = { connectionId: null, status: { state: 'none', failure: null, requestedAt: null, checkedAt: null }, partyCodes: null, itemCodes: null };

// A check asked this recently and still waiting is the running one; later than that a press asks again (a lost job must not block the connection for ever).
const RUNNING_MS = 10 * 60 * 1000;

export const MISA_AMIS_MATCH_CHECK_REQUESTED = 'finance.misa_amis_match.check_requested';

const iso = (value: Date | string): string => new Date(value).toISOString();

/** Whether a stored request is for the batch a caller asks about: the kind, the period and the item codes (the entity is the connection's, the purchase purpose changes no look-up). */
export function sameBatch(stored: unknown, asked: MisaAmisPreviewAsk): boolean {
  const parsed = zMisaAmisPreviewAsk.safeParse(stored);
  if (!parsed.success) return false;
  const a = parsed.data;
  return a.kind === asked.kind && (a.from ?? null) === (asked.from ?? null) && (a.to ?? null) === (asked.to ?? null) && (a.serviceItemCode ?? null) === (asked.serviceItemCode ?? null) && (a.salesItemCode ?? null) === (asked.salesItemCode ?? null);
}

export const misaAmisMatchRequestCheck = defineCommand({
  name: 'finance.misa_amis_match.request_check',
  input: z.strictObject({ id: zId, ask: zMisaAmisPreviewAsk }),
  // The event it emits starts a job that calls MISA with the org's sealed access code: it derives R2 external (plan section 4.7), though the call only reads (catalogue pages).
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.misa_amis_connection', id: input.id }),
  handler: async (ctx, input): Promise<MisaAmisMatchCheckQueued> => {
    const conn = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.legal_entity_id', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!conn) throw new DomainError('MISA_AMIS_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối MISA AMIS này');
    if (conn.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    // The check is of the connection's own entity: an ask that names another one is refused rather than answered for the wrong books.
    if (input.ask.legalEntityId !== undefined && input.ask.legalEntityId !== conn.legal_entity_id) {
      throw new DomainError('MISA_AMIS_MATCH_ENTITY', 422, 'Kết nối này thuộc pháp nhân khác với chứng từ đang xem');
    }
    const params = JSON.stringify({ ...input.ask, legalEntityId: conn.legal_entity_id });
    const by = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const existing = await ctx.trx
      .selectFrom('crove_finance.misa_amis_match_check')
      .select(['id', 'state', 'params', 'requested_at'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.id)
      .forUpdate()
      .executeTakeFirst();
    // The waiting one is returned only when it is for this same batch: a press for another batch files it anew (an older job's record is then ignored).
    if (existing && existing.state === 'requested' && ctx.now.getTime() - new Date(existing.requested_at).getTime() < RUNNING_MS && sameBatch(existing.params, input.ask)) {
      ctx.audit({ requested: false, running: true });
      return { queued: false, running: true };
    }
    if (existing) {
      await ctx.trx
        .updateTable('crove_finance.misa_amis_match_check')
        .set({ params, state: 'requested', failure: null, requested_by: by, requested_at: ctx.now, finished_at: null })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
    } else {
      await ctx.trx
        .insertInto('crove_finance.misa_amis_match_check')
        .values({ org_id: ctx.orgId, connection_id: input.id, legal_entity_id: conn.legal_entity_id, params, requested_by: by, requested_at: ctx.now })
        .execute();
    }
    await ctx.emit(MISA_AMIS_MATCH_CHECK_REQUESTED, { connection_id: input.id });
    ctx.audit({ requested: true, running: false });
    return { queued: true, running: false };
  },
});

// What the worker needs to check one connection, or why it must not: a connection that is gone or whose channel is no longer active, or a check that is not waiting (done by an earlier run of the same job),
// is left alone. The company code is the opaque one MISA is told (not a secret); it reaches the worker and nothing else.
export type MisaAmisMatchTarget =
  | { action: 'none'; reason: 'not_found' | 'not_active' | 'not_requested' }
  | { action: 'check'; id: string; channelConnectionId: string; orgCompanyCode: string; legalEntityId: string; ask: MisaAmisPreviewAsk; requestedAt: string };

export const misaAmisMatchCheckTarget = defineQuery({
  name: 'finance.misa_amis_match.check_target',
  input: z.strictObject({ id: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<MisaAmisMatchTarget> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .leftJoin('crove_finance.misa_amis_match_check as k', (join) => join.onRef('k.org_id', '=', 'c.org_id').onRef('k.connection_id', '=', 'c.id'))
      .select(['c.id', 'c.channel_connection_id', 'c.org_company_code', 'c.legal_entity_id', 'ch.status', 'k.state as check_state', 'k.params', 'k.requested_at'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!row) return { action: 'none', reason: 'not_found' };
    if (row.status !== 'active') return { action: 'none', reason: 'not_active' };
    if (row.check_state !== 'requested') return { action: 'none', reason: 'not_requested' };
    // What was stored is read back through the ask's own schema, so a row that was changed outside the command is refused, not trusted.
    const parsed = zMisaAmisPreviewAsk.safeParse(row.params);
    if (!parsed.success) return { action: 'none', reason: 'not_requested' };
    if (row.requested_at === null) return { action: 'none', reason: 'not_requested' };
    return { action: 'check', id: row.id, channelConnectionId: row.channel_connection_id, orgCompanyCode: row.org_company_code, legalEntityId: row.legal_entity_id, ask: parsed.data, requestedAt: iso(row.requested_at) };
  },
});

export const misaAmisMatchRecordCheck = defineCommand({
  name: 'finance.misa_amis_match.record_check',
  input: zMisaAmisMatchRecordCheck,
  // A state and a time on a row and the codes of the matched entries; no voucher, no money, no credential.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'finance.misa_amis_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<{ recorded: boolean; results: number }> => {
    const check = await ctx.trx
      .selectFrom('crove_finance.misa_amis_match_check')
      .select(['id', 'legal_entity_id', 'state', 'requested_at'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    // A connection closed while its check ran, a check another run already recorded, or a request filed again since this run took it (a newer batch is waiting): nothing to record.
    if (!check || check.state !== 'requested' || iso(check.requested_at) !== input.requestedAt) return { recorded: false, results: 0 };
    if (input.state === 'done' && input.failure !== null) throw new DomainError('MISA_AMIS_MATCH_INVALID', 422, 'Một lần kiểm tra thành công không có lý do lỗi');
    if (input.state === 'failed' && (input.failure === null || input.results.length > 0)) throw new DomainError('MISA_AMIS_MATCH_INVALID', 422, 'Một lần kiểm tra lỗi cần một lý do và không có kết quả');
    // The results are replaced whole: what an earlier check found about a party is never kept beside a newer one.
    await ctx.trx.deleteFrom('crove_finance.misa_amis_match').where('org_id', '=', ctx.orgId).where('connection_id', '=', input.connectionId).execute();
    const seen = new Set<string>();
    for (const r of input.results) {
      const key = `${r.kind}:${r.ref}`;
      if (seen.has(key)) throw new DomainError('MISA_AMIS_MATCH_INVALID', 422, 'Một mục xuất hiện hai lần trong kết quả kiểm tra');
      seen.add(key);
      if ((r.state === 'matched') !== (r.code !== null)) throw new DomainError('MISA_AMIS_MATCH_INVALID', 422, 'Chỉ mục khớp mới có mã danh mục');
    }
    if (input.results.length > 0) {
      await ctx.trx
        .insertInto('crove_finance.misa_amis_match')
        .values(input.results.map((r) => ({ org_id: ctx.orgId, connection_id: input.connectionId, legal_entity_id: check.legal_entity_id, kind: r.kind, match_key: r.ref, state: r.state, catalogue_code: r.code, catalogue_id: r.entryId, checked_at: ctx.now })))
        .execute();
    }
    await ctx.trx
      .updateTable('crove_finance.misa_amis_match_check')
      .set({ state: input.state, failure: input.failure, finished_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', check.id)
      .execute();
    ctx.audit({ state: input.state, failure: input.failure, results: input.results.length });
    return { recorded: true, results: input.results.length };
  },
});

export const misaAmisMatchResultsQuery = defineQuery({
  name: 'finance.misa_amis_match.results',
  // `ask`: the batch the caller looks at. A check applies to the batch it was asked about: for another one the answer is the same as for no check (nothing is judged against a catalogue that was never asked about it).
  input: z.strictObject({ legalEntityId: zId.optional(), ask: zMisaAmisPreviewAsk.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<MisaAmisMatchResults> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId ?? null);
    const check = await ctx.trx
      .selectFrom('crove_finance.misa_amis_match_check')
      .select(['connection_id', 'state', 'failure', 'params', 'requested_at', 'finished_at'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .executeTakeFirst();
    if (!check) return NO_MATCH_RESULTS;
    if (input.ask !== undefined && !sameBatch(check.params, input.ask)) return { ...NO_MATCH_RESULTS, connectionId: check.connection_id };
    const status: MisaAmisMatchStatus = {
      state: check.state,
      failure: check.failure,
      requestedAt: iso(check.requested_at),
      checkedAt: check.state === 'done' && check.finished_at ? iso(check.finished_at) : null,
    };
    if (check.state !== 'done') return { connectionId: check.connection_id, status, partyCodes: null, itemCodes: null };
    const rows = await ctx.trx
      .selectFrom('crove_finance.misa_amis_match')
      .select(['kind', 'match_key', 'state', 'catalogue_code'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', check.connection_id)
      .where('state', '=', 'matched')
      .execute();
    const partyCodes = new Map<string, string>();
    const itemCodes = new Set<string>();
    for (const row of rows) {
      if (row.catalogue_code === null) continue;
      if (row.kind === 'party') partyCodes.set(row.match_key, row.catalogue_code);
      else itemCodes.add(row.match_key);
    }
    return { connectionId: check.connection_id, status, partyCodes, itemCodes };
  },
});

export const misaAmisMatchCommands = [misaAmisMatchRequestCheck, misaAmisMatchRecordCheck];
export const misaAmisMatchQueries = [misaAmisMatchCheckTarget, misaAmisMatchResultsQuery];
