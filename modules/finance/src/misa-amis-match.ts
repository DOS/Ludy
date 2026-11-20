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
import {
  zId,
  zMisaAmisMatchRecordCheck,
  zMisaAmisNameDecision,
  zMisaAmisNameProposalsAsk,
  zMisaAmisPreviewAsk,
  zMisaAmisUnitsAsk,
  type MisaAmisMatchCheckQueued,
  type MisaAmisMatchStatus,
  type MisaAmisNameDecided,
  type MisaAmisNameProposal,
  type MisaAmisPreviewAsk,
  type MisaAmisProduct,
  type MisaAmisUnitRow,
} from '@crove/kernel-contract';
import type { Database, MemberRole } from '@crove/db';
import { sql, type Transaction } from 'kysely';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { aliasesOf } from './misa-amis-connections.ts';
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
  // The party tax codes that more than one active catalogue entry carries (the check's `ambiguous` rows): the preview names them apart from a party the catalogue does not have (#4114). Null with the codes.
  partyAmbiguous: ReadonlySet<string> | null;
  itemCodes: ReadonlySet<string> | null;
  /** The codes a person confirmed for parties with no tax code, by the party's id (S3b, #4124); null with the others until a check is done. */
  partyNameCodes?: ReadonlyMap<string, string> | null;
  /** MISA ASP only (#4125): the matched units by the normalized unit name (the catalogue's own name and its id), the unit names several active units carry, and the matched stocks by stock code (its id). */
  unitIds?: ReadonlyMap<string, { name: string; id: string }> | null;
  unitAmbiguous?: ReadonlySet<string> | null;
  stockIds?: ReadonlyMap<string, string> | null;
  /** MISA ASP only: the matched items by code (the entry's id), which an ASP line writes. */
  itemIds?: ReadonlyMap<string, string> | null;
  /** The product of the checked connection; absent while there is no check. */
  product?: 'amis' | 'asp';
  /** MISA ASP: the stock code kept for the connection's sales lines; null for none. */
  salesStockCode?: string | null;
  /** MISA ASP: the typed unit names, by the unit of Ludy (folded); the push reads the units again with them. */
  unitAliases?: Readonly<Record<string, string>>;
}

export const NO_MATCH_RESULTS: MisaAmisMatchResults = { connectionId: null, status: { state: 'none', failure: null, requestedAt: null, checkedAt: null }, partyCodes: null, partyAmbiguous: null, itemCodes: null, partyNameCodes: null };

// How many confirmed names one check verifies (the oldest checked first): the verdicts are part of the results, which are bounded, and a confirmation not reached here is still checked by the re-read before every send.
const MISA_AMIS_CONFIRMED_VERIFY_MAX = 500;

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
        .set({ params, state: 'requested', failure: null, requested_by: by, requested_at: ctx.now })
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
  // `confirmed`: the parties a person confirmed by name (S3b): the worker checks their codes are still in the catalogue and active.
  | { action: 'check'; id: string; product: MisaAmisProduct; channelConnectionId: string; orgCompanyCode: string; legalEntityId: string; ask: MisaAmisPreviewAsk; requestedAt: string; confirmed: Array<{ partyId: string; code: string }>; defaultSalesStockCode: string | null; unitAliases: Record<string, string> };

export const misaAmisMatchCheckTarget = defineQuery({
  name: 'finance.misa_amis_match.check_target',
  input: z.strictObject({ id: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<MisaAmisMatchTarget> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .leftJoin('crove_finance.misa_amis_match_check as k', (join) => join.onRef('k.org_id', '=', 'c.org_id').onRef('k.connection_id', '=', 'c.id'))
      .select(['c.id', 'c.product', 'c.channel_connection_id', 'c.org_company_code', 'c.legal_entity_id', 'c.default_sales_stock_code', 'c.unit_aliases', 'ch.status', 'k.state as check_state', 'k.params', 'k.requested_at'])
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
    const confirmed = await ctx.trx
      .selectFrom('crove_finance.misa_amis_match')
      .select(['match_key', 'catalogue_code'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.id)
      .where('kind', '=', 'party_name')
      .where('state', '=', 'confirmed')
      .orderBy('checked_at')
      .orderBy('match_key')
      .limit(MISA_AMIS_CONFIRMED_VERIFY_MAX)
      .execute();
    return {
      action: 'check',
      id: row.id,
      product: row.product,
      channelConnectionId: row.channel_connection_id,
      orgCompanyCode: row.org_company_code,
      legalEntityId: row.legal_entity_id,
      ask: parsed.data,
      requestedAt: iso(row.requested_at),
      confirmed: confirmed.flatMap((r) => (r.catalogue_code === null ? [] : [{ partyId: r.match_key, code: r.catalogue_code }])),
      // MISA ASP (#4125): the stock a person keeps for the sales lines, checked against the catalogue with the batch's own stock codes.
      defaultSalesStockCode: row.product === 'asp' ? row.default_sales_stock_code : null,
      // MISA ASP: the unit names a person typed for units of Ludy, matched exactly instead of the unit's own name.
      unitAliases: row.product === 'asp' ? aliasesOf(row.unit_aliases) : {},
    };
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
    // A done check replaces the results whole: what an earlier check found about a party is never kept beside a newer one. A failed check changes none: the earlier results stay, so a re-check that cannot be made does
    // not lift the blocks the last one raised.
    // The one thing a check does not replace is a name a person confirmed (S3b, #4124): it stays until the worker says its code is gone from the catalogue.
    const seen = new Set<string>();
    for (const r of input.results) {
      const key = `${r.kind}:${r.ref}`;
      if (seen.has(key)) throw new DomainError('MISA_AMIS_MATCH_INVALID', 422, 'Một mục xuất hiện hai lần trong kết quả kiểm tra');
      seen.add(key);
      const hasEntry = r.state === 'matched' || r.state === 'name_proposal' || r.state === 'confirmed';
      if (hasEntry !== (r.code !== null)) throw new DomainError('MISA_AMIS_MATCH_INVALID', 422, 'Chỉ mục khớp mới có mã danh mục');
      if ((r.state === 'name_proposal') !== (r.candidateName != null)) throw new DomainError('MISA_AMIS_MATCH_INVALID', 422, 'Chỉ đề xuất theo tên mới có tên ứng viên');
      // `party` and `item` rows are what the tax code and the item code found; `party_name` rows are what the name match found (a proposal, several entries) and the verdict on a name a person confirmed.
      const allowed: readonly string[] = r.kind === 'party_name' ? ['name_proposal', 'ambiguous', 'confirmed', 'unknown'] : ['matched', 'unknown', 'ambiguous'];
      if (!allowed.includes(r.state)) throw new DomainError('MISA_AMIS_MATCH_INVALID', 422, 'Trạng thái này không dùng cho loại mục đó');
    }
    const confirmed = new Map(
      (
        await ctx.trx
          .selectFrom('crove_finance.misa_amis_match')
          .select(['id', 'match_key'])
          .where('org_id', '=', ctx.orgId)
          .where('connection_id', '=', input.connectionId)
          .where('kind', '=', 'party_name')
          .where('state', '=', 'confirmed')
          .execute()
      ).map((r) => [r.match_key, r.id]),
    );
    // A done check replaces the results whole (parties, items, and name matches that no person confirmed); the confirmed names the worker says are gone go too.
    if (input.state === 'done') {
      await ctx.trx
        .deleteFrom('crove_finance.misa_amis_match')
        .where('org_id', '=', ctx.orgId)
        .where('connection_id', '=', input.connectionId)
        .where((eb) => eb.or([eb('kind', '<>', 'party_name'), eb('state', '<>', 'confirmed')]))
        .execute();
      const gone = input.results.filter((r) => r.kind === 'party_name' && r.state === 'unknown' && confirmed.has(r.ref)).map((r) => confirmed.get(r.ref) as string);
      if (gone.length > 0) await ctx.trx.deleteFrom('crove_finance.misa_amis_match').where('org_id', '=', ctx.orgId).where('id', 'in', gone).execute();
    }
    // What is written is what the check found anew: the markers for a confirmed name (`confirmed`, or `unknown` for one that is gone) and a party with no row to speak of are not rows.
    const written = input.results.filter((r) => !(r.kind === 'party_name' && (r.state === 'confirmed' || r.state === 'unknown')) && !(r.kind === 'party_name' && confirmed.has(r.ref)));
    if (input.state === 'done' && written.length > 0) {
      await ctx.trx
        .insertInto('crove_finance.misa_amis_match')
        .values(written.map((r) => ({ org_id: ctx.orgId, connection_id: input.connectionId, legal_entity_id: check.legal_entity_id, kind: r.kind, match_key: r.ref, state: r.state, catalogue_code: r.code, catalogue_id: r.entryId, candidate_name: r.candidateName ?? null, confirmed_by: null, confirmed_at: null, checked_at: ctx.now })))
        .execute();
    }
    await ctx.trx
      .updateTable('crove_finance.misa_amis_match_check')
      .set(input.state === 'done' ? { state: 'done', failure: null, finished_at: ctx.now } : { state: input.state, failure: input.failure })
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
    const connection = await ctx.trx.selectFrom('crove_finance.misa_amis_connection').select(['product', 'default_sales_stock_code', 'unit_aliases']).where('org_id', '=', ctx.orgId).where('id', '=', check.connection_id).executeTakeFirst();
    const product = connection?.product;
    const salesStockCode = product === 'asp' ? (connection?.default_sales_stock_code ?? null) : null;
    const unitAliases = product === 'asp' ? aliasesOf(connection?.unit_aliases) : {};
    const rows = await ctx.trx
      .selectFrom('crove_finance.misa_amis_match')
      .select(['kind', 'match_key', 'state', 'catalogue_code', 'catalogue_id'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', check.connection_id)
      .execute();
    // While a re-check waits, or after one failed, the results of the last done check still stand (a block it raised is not lifted by asking again); with none stored there is nothing to judge against.
    // A connection that was checked once (a done check finished) and has no stored result (its batch needed none) is still checked: the sets are empty, not null.
    if (check.state !== 'done' && rows.length === 0 && check.finished_at === null) return { connectionId: check.connection_id, status, partyCodes: null, partyAmbiguous: null, itemCodes: null, partyNameCodes: null, salesStockCode, unitAliases, ...(product === undefined ? {} : { product }) };
    const partyCodes = new Map<string, string>();
    const partyAmbiguous = new Set<string>();
    const itemCodes = new Set<string>();
    const partyNameCodes = new Map<string, string>();
    const unitIds = new Map<string, { name: string; id: string }>();
    const unitAmbiguous = new Set<string>();
    const stockIds = new Map<string, string>();
    const itemIds = new Map<string, string>();
    for (const row of rows) {
      if (row.kind === 'party' && row.state === 'ambiguous') partyAmbiguous.add(row.match_key);
      if (row.kind === 'unit' && row.state === 'ambiguous') unitAmbiguous.add(row.match_key);
      if (row.catalogue_code === null) continue;
      // A party with no tax code has a code only once a person confirmed the catalogue entry proposed for its name; a proposal is not a match.
      if (row.kind === 'party_name') {
        if (row.state === 'confirmed') partyNameCodes.set(row.match_key, row.catalogue_code);
      } else if (row.state === 'matched') {
        if (row.kind === 'party') partyCodes.set(row.match_key, row.catalogue_code);
        else if (row.kind === 'unit') {
          if (row.catalogue_id !== null) unitIds.set(row.match_key, { name: row.catalogue_code, id: row.catalogue_id });
        } else if (row.kind === 'stock') {
          if (row.catalogue_id !== null) stockIds.set(row.match_key, row.catalogue_id);
        } else {
          itemCodes.add(row.match_key);
          if (row.catalogue_id !== null) itemIds.set(row.match_key, row.catalogue_id);
        }
      }
    }
    return { connectionId: check.connection_id, status, partyCodes, partyAmbiguous, itemCodes, partyNameCodes, unitIds, unitAmbiguous, stockIds, itemIds, salesStockCode, unitAliases, ...(product === undefined ? {} : { product }) };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Name proposals (S3b, #4124): a party of Ludy with no tax code and the one active catalogue entry of the same name, which a person confirms or rejects. Nothing else makes a name match count.

// The connection and its check row, locked, so that a person's decision and a worker's record of a check never run over each other; the check row is the lock the worker's record takes too.
async function lockedConnection(ctx: { trx: Transaction<Database>; orgId: string }, connectionId: string) {
  const conn = await ctx.trx.selectFrom('crove_finance.misa_amis_connection').select(['id']).where('org_id', '=', ctx.orgId).where('id', '=', connectionId).executeTakeFirst();
  if (!conn) throw new DomainError('MISA_AMIS_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối MISA AMIS này');
  await ctx.trx.selectFrom('crove_finance.misa_amis_match_check').select(['id']).where('org_id', '=', ctx.orgId).where('connection_id', '=', connectionId).forUpdate().execute();
}

export const misaAmisMatchConfirmName = defineCommand({
  name: 'finance.misa_amis_match.confirm_name',
  input: zMisaAmisNameDecision,
  // A person says the catalogue entry proposed for a party is that party; nothing leaves Ludy and no amount moves. It changes what the vouchers are written with, so the preview's digest changes and a
  // confirmation made before it is stale.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.misa_amis_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<MisaAmisNameDecided> => {
    await lockedConnection(ctx, input.connectionId);
    const proposal = await ctx.trx
      .selectFrom('crove_finance.misa_amis_match')
      .select(['id', 'legal_entity_id', 'catalogue_code', 'catalogue_id', 'checked_at'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('id', '=', input.proposalId)
      .where('kind', '=', 'party_name')
      .where('match_key', '=', input.partyId)
      .where('state', '=', 'name_proposal')
      .where('catalogue_code', '=', input.candidateCode)
      .executeTakeFirst();
    // The row the person saw is gone (a newer check replaced it, someone decided it), is not a proposal any more, or holds another candidate than the one on screen: the person looks again.
    // Bound to the row and its code, never to "the party's proposal", so a confirmation can only be of what was shown.
    if (!proposal || proposal.catalogue_code === null) throw new DomainError('MISA_AMIS_NAME_PROPOSAL_GONE', 409, 'Đề xuất này không còn; hãy xem lại danh sách đề xuất');
    // The row is replaced, not updated: a result is never changed in place, and the candidate's name goes with the proposal row, so a confirmed row keeps the code and the entry's id only.
    await ctx.trx.deleteFrom('crove_finance.misa_amis_match').where('org_id', '=', ctx.orgId).where('id', '=', proposal.id).execute();
    await ctx.trx
      .insertInto('crove_finance.misa_amis_match')
      .values({
        org_id: ctx.orgId,
        connection_id: input.connectionId,
        legal_entity_id: proposal.legal_entity_id,
        kind: 'party_name',
        match_key: input.partyId,
        state: 'confirmed',
        catalogue_code: proposal.catalogue_code,
        catalogue_id: proposal.catalogue_id,
        candidate_name: null,
        confirmed_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        confirmed_at: ctx.now,
        checked_at: proposal.checked_at,
      })
      .execute();
    // A check that is waiting or running read the confirmed names before this one existed, so it cannot say whether this code is still in the catalogue; moving its request time (always forward, even by a millisecond) makes that run's record a no-op
    // and the next run, which the worker starts when it sees the record dropped, verifies the new confirmation (the same step erasure takes). A done or failed check is left as it is.
    await ctx.trx
      .updateTable('crove_finance.misa_amis_match_check')
      .set({ requested_at: sql<Date>`GREATEST(${ctx.now}::timestamptz, requested_at + interval '1 millisecond')` })
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('state', '=', 'requested')
      .execute();
    ctx.audit({ decided: true, decision: 'confirmed' });
    return { decided: true };
  },
});

export const misaAmisMatchRejectName = defineCommand({
  name: 'finance.misa_amis_match.reject_name',
  input: zMisaAmisNameDecision,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.misa_amis_connection', id: input.connectionId }),
  handler: async (ctx, input): Promise<MisaAmisNameDecided> => {
    await lockedConnection(ctx, input.connectionId);
    // The proposal is deleted with the name of the candidate it holds; the party stays blocked, and a later check may propose the same entry again.
    const deleted = await ctx.trx
      .deleteFrom('crove_finance.misa_amis_match')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.proposalId)
      .where('connection_id', '=', input.connectionId)
      .where('kind', '=', 'party_name')
      .where('match_key', '=', input.partyId)
      .where('state', '=', 'name_proposal')
      .where('catalogue_code', '=', input.candidateCode)
      .executeTakeFirst();
    const decided = Number(deleted.numDeletedRows) > 0;
    if (!decided) throw new DomainError('MISA_AMIS_NAME_PROPOSAL_GONE', 409, 'Đề xuất này không còn; hãy xem lại danh sách đề xuất');
    ctx.audit({ decided: true, decision: 'rejected' });
    return { decided };
  },
});

export const misaAmisMatchProposalsQuery = defineQuery({
  name: 'finance.misa_amis_match.proposals',
  input: zMisaAmisNameProposalsAsk,
  // The names are the catalogue's and the party's: owners and admins, who decide, read them; they are shown and never logged.
  access: MANAGERS,
  handler: async (ctx, input): Promise<MisaAmisNameProposal[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.misa_amis_match')
      .select(['id', 'match_key', 'catalogue_code', 'candidate_name', 'checked_at'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('kind', '=', 'party_name')
      .where('state', '=', 'name_proposal')
      .orderBy('checked_at')
      .orderBy('match_key')
      .limit(200)
      .execute();
    if (rows.length === 0) return [];
    const parties = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['id', 'name'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', rows.map((r) => r.match_key))
      .execute();
    const nameOf = new Map(parties.map((p) => [p.id, p.name]));
    return rows.flatMap((r) => {
      const partyName = nameOf.get(r.match_key);
      // A proposal for a party that no longer exists says nothing a person can act on.
      if (partyName === undefined || r.catalogue_code === null || r.candidate_name === null) return [];
      return [{ id: r.id, partyId: r.match_key, partyName, candidateName: r.candidate_name, candidateCode: r.catalogue_code, checkedAt: iso(r.checked_at) }];
    });
  },
});

export const misaAmisMatchCommands = [misaAmisMatchRequestCheck, misaAmisMatchRecordCheck, misaAmisMatchConfirmName, misaAmisMatchRejectName];
// The units of the last check a person can give a MISA name (#4125, MISA ASP): the unit of Ludy as the check folded it, what the check found (none, several, or one) and the name typed for it, if any. A unit that matched
// with no name typed is not listed (nothing to do). Owner or admin; the unit names are the firm's own words for a unit of measure, shown as text.
export const misaAmisMatchUnitsQuery = defineQuery({
  name: 'finance.misa_amis_match.units',
  input: zMisaAmisUnitsAsk,
  access: MANAGERS,
  handler: async (ctx, input): Promise<MisaAmisUnitRow[]> => {
    const connection = await ctx.trx.selectFrom('crove_finance.misa_amis_connection').select(['unit_aliases']).where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).executeTakeFirst();
    if (!connection) return [];
    const aliases = aliasesOf(connection.unit_aliases);
    const rows = await ctx.trx
      .selectFrom('crove_finance.misa_amis_match')
      .select(['match_key', 'state'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('kind', '=', 'unit')
      .orderBy('match_key')
      .limit(2000)
      .execute();
    const listed = rows.flatMap((r) => {
      const alias = aliases[r.match_key] ?? null;
      if (r.state === 'matched' && alias === null) return [];
      return [{ unit: r.match_key, state: r.state === 'matched' ? ('matched' as const) : r.state === 'ambiguous' ? ('ambiguous' as const) : ('unknown' as const), alias }];
    });
    // A name typed for a unit no check has asked about yet is listed too, so it can be cleared.
    const seen = new Set(listed.map((r) => r.unit));
    for (const [unit, alias] of Object.entries(aliases)) if (!seen.has(unit) && !rows.some((r) => r.match_key === unit)) listed.push({ unit, state: 'unknown', alias });
    return listed.slice(0, 200);
  },
});

export const misaAmisMatchQueries = [misaAmisMatchCheckTarget, misaAmisMatchResultsQuery, misaAmisMatchProposalsQuery, misaAmisMatchUnitsQuery];
