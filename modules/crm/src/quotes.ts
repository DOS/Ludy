// SPDX-License-Identifier: AGPL-3.0-only
// Quotes of a deal, step Q1 of docs/plan/crm-quotes.md (#2693): a quote is made from a deal, holds priced lines and stays a draft. Owners, admins and members
// write; viewers read. Every command is R1 and internal: it changes only the org's own records, sends nothing and posts nothing to the ledger, and no agent
// runs one (the commands refuse a caller that is not a person, and no agent role writes crove_crm).
//
// What this step does not do, on purpose: send a quote, give it a number, freeze it or move it out of draft. The columns for that exist but no login role may
// write them (the migration's column grants), and the commands here refuse a quote that is not a draft; step Q2 adds the send command, the number counter and
// the guard that freezes a sent quote. A revision is for a quote that has been sent, so in this step `revise` only meets a row a test or a later step made.
//
// The amounts of a line and the totals are computed here by `totalLines` of @crove/l10n-vn, whole dong, half up: the input names none, and a caller that sends
// one is refused by the strict schema. The audit rows, the activity on the party's timeline and the invalidation hints carry ids, field names and counts, never
// a price, a description or a customer's value (a line may name a person, and audit rows outlive an erasure).
import { sql } from 'kysely';
import {
  QUOTE_LINES_MAX,
  QUOTE_LIST_MAX,
  QUOTE_VALID_DAYS_DEFAULT,
  QUOTE_VAT_DEFAULT,
  vietnamToday,
  zQuoteDealRef,
  zQuoteListQuery,
  zQuoteRef,
  zQuoteSave,
  zQuoteSettingSet,
  zQuoteVersionRef,
  type Quote,
  type QuoteLine,
  type QuoteLineInput,
  type QuotePage,
  type QuoteSetting,
  type QuoteStatus,
  type QuoteSummary,
  type QuoteVatRate,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { money, totalLines } from '@crove/l10n-vn';
import { z } from 'zod';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

type Reader = Pick<QueryContext, 'trx' | 'orgId' | 'actor' | 'role'>;

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const day = (value: Date | string): string => (typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));
const notFound = () => new DomainError('QUOTE_NOT_FOUND', 404, 'Không tìm thấy báo giá này');
const stale = () => new DomainError('STALE_VERSION', 409, 'Báo giá này vừa được người khác sửa; hãy mở lại để xem bản mới');
const notDraft = () => new DomainError('QUOTE_NOT_DRAFT', 409, 'Báo giá đã gửi không sửa được; hãy tạo bản sửa mới');
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
// A real calendar date (the schema checks the shape only).
const isDate = (value: string): boolean => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// ---------------------------------------------------------------------------------------------------------------
// The org's setting
// ---------------------------------------------------------------------------------------------------------------

// The setting, or the product's defaults while the org has set none.
export async function quoteSetting(ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<QuoteSetting> {
  const row = await ctx.trx.selectFrom('crove_crm.quote_setting').select(['valid_days', 'default_vat', 'default_terms']).where('org_id', '=', ctx.orgId).executeTakeFirst();
  return row
    ? { validDays: row.valid_days, defaultVat: row.default_vat as QuoteVatRate, defaultTerms: row.default_terms, isSet: true }
    : { validDays: QUOTE_VALID_DAYS_DEFAULT, defaultVat: QUOTE_VAT_DEFAULT, defaultTerms: '', isSet: false };
}

export const quoteSettingGet = defineQuery({
  name: 'crm.quote_setting.get',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<QuoteSetting> => quoteSetting(ctx),
});

// Owners and admins set the days a quote stays valid, the VAT rate a new line starts with and the terms a new draft starts with. It applies to the quotes made
// from now on; a draft already made keeps its own.
export const quoteSettingSet = defineCommand({
  name: 'crm.quote_setting.set',
  input: zQuoteSettingSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<QuoteSetting> => {
    const userId = userOf(ctx.actor);
    const terms = input.defaultTerms;
    await ctx.trx
      .insertInto('crove_crm.quote_setting')
      .values({ org_id: ctx.orgId, valid_days: input.validDays, default_vat: input.defaultVat, default_terms: terms, set_by: userId, created_at: ctx.now, updated_at: ctx.now })
      .onConflict((oc) => oc.column('org_id').doUpdateSet({ valid_days: input.validDays, default_vat: input.defaultVat, default_terms: terms, set_by: userId, updated_at: ctx.now }))
      .execute();
    // The terms are the org's own text, not a customer's, but the audit row keeps the shape only.
    ctx.audit({ validDays: input.validDays, defaultVat: input.defaultVat, termsLength: terms.length });
    return { validDays: input.validDays, defaultVat: input.defaultVat, defaultTerms: terms, isSet: true };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

interface Row {
  id: string;
  deal_id: string;
  party_id: string;
  number: string | null;
  revision: number;
  revision_of: string | null;
  status: string;
  valid_until: Date | string;
  remarks: string;
  terms: string;
  subtotal: string;
  vat_amount: string;
  total: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  party_name: string;
  deal_title: string;
  // The number of the quote this one revises, until this one has its own (a revision keeps the number of the quote it revises).
  prior_number: string | null;
  line_count: number | string;
}

// Amounts as the columns store them (four decimals): "1200000.0000" shows as "1200000".
const plain = (value: string): string => money(value).toFixed();

function base(ctx: Reader) {
  return ctx.trx
    .selectFrom('crove_crm.quote as q')
    .innerJoin('crove_crm.deal as d', (j) => j.onRef('d.org_id', '=', 'q.org_id').onRef('d.id', '=', 'q.deal_id'))
    .innerJoin('crove_kernel.party as p', (j) => j.onRef('p.org_id', '=', 'q.org_id').onRef('p.id', '=', 'q.party_id'))
    .leftJoin('crove_crm.quote as prev', (j) => j.onRef('prev.org_id', '=', 'q.org_id').onRef('prev.id', '=', 'q.revision_of'))
    .select([
      'q.id',
      'q.deal_id',
      'q.party_id',
      'q.number',
      'q.revision',
      'q.revision_of',
      'q.status',
      'q.valid_until',
      'q.remarks',
      'q.terms',
      'q.subtotal',
      'q.vat_amount',
      'q.total',
      'q.version',
      'q.created_at',
      'q.updated_at',
      'p.name as party_name',
      'd.title as deal_title',
      'prev.number as prior_number',
      sql<number>`(SELECT count(*) FROM crove_crm.quote_line l WHERE l.org_id = q.org_id AND l.quote_id = q.id)`.as('line_count'),
    ])
    .where('q.org_id', '=', ctx.orgId);
}

function summary(r: Row, today: string): QuoteSummary {
  const status = r.status as QuoteStatus;
  return {
    id: r.id,
    dealId: r.deal_id,
    partyId: r.party_id,
    partyName: r.party_name,
    number: r.number ?? r.prior_number,
    revision: r.revision,
    status,
    expired: status === 'sent' && day(r.valid_until) < today,
    validUntil: day(r.valid_until),
    total: plain(r.total),
    currency: 'VND',
    lineCount: Number(r.line_count),
    version: r.version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

async function loadLines(ctx: Reader, quoteId: string): Promise<QuoteLine[]> {
  const rows = await ctx.trx
    .selectFrom('crove_crm.quote_line')
    .select(['line_no', 'kind', 'description', 'unit', 'quantity', 'unit_price', 'discount_percent', 'vat_rate', 'amount', 'vat_amount', 'stock_item_id'])
    .where('org_id', '=', ctx.orgId)
    .where('quote_id', '=', quoteId)
    .orderBy('line_no')
    .execute();
  return rows.map((l) => ({
    lineNo: l.line_no,
    kind: l.kind,
    description: l.description,
    unit: l.unit,
    quantity: plain(l.quantity),
    unitPrice: plain(l.unit_price),
    discountPercent: plain(l.discount_percent),
    vatRate: l.vat_rate,
    amount: plain(l.amount),
    vatAmount: plain(l.vat_amount),
    stockItemId: l.stock_item_id,
  }));
}

async function loadQuote(ctx: Reader, quoteId: string): Promise<Quote> {
  const row = await base(ctx).where('q.id', '=', quoteId).executeTakeFirst();
  if (!row) throw notFound();
  const today = vietnamToday(new Date());
  return {
    ...summary(row, today),
    dealTitle: row.deal_title,
    revisionOf: row.revision_of,
    notes: row.remarks,
    terms: row.terms,
    subtotal: plain(row.subtotal),
    vatAmount: plain(row.vat_amount),
    lines: await loadLines(ctx, quoteId),
  };
}

export const quoteGet = defineQuery({
  name: 'crm.quote.get',
  input: zQuoteRef,
  access: ALL,
  handler: async (ctx, input): Promise<Quote> => loadQuote(ctx, input.quoteId),
});

export const quoteList = defineQuery({
  name: 'crm.quote.list',
  input: zQuoteListQuery,
  access: ALL,
  handler: async (ctx, input): Promise<QuotePage> => {
    const limit = input.limit ?? QUOTE_LIST_MAX;
    let q = base(ctx);
    if (input.dealId) q = q.where('q.deal_id', '=', input.dealId);
    if (input.partyId) q = q.where('q.party_id', '=', input.partyId);
    if (input.status) q = q.where('q.status', '=', input.status);
    if (input.cursor) q = q.where(sql<boolean>`(q.created_at, q.id) < (${new Date(input.cursor.createdAt)}::timestamptz, ${input.cursor.id}::uuid)`);
    const rows = await q.orderBy('q.created_at', 'desc').orderBy('q.id', 'desc').limit(limit + 1).execute();
    const today = vietnamToday(new Date());
    const items = rows.slice(0, limit).map((r) => summary(r, today));
    const last = items.at(-1);
    return { items, next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
  },
});

// The quotes of one deal, newest first: the deal panel's list.
export const dealQuotes = defineQuery({
  name: 'crm.deal.quotes',
  input: zQuoteDealRef,
  access: ALL,
  handler: async (ctx, input): Promise<QuoteSummary[]> => {
    const rows = await base(ctx).where('q.deal_id', '=', input.dealId).orderBy('q.created_at', 'desc').orderBy('q.id', 'desc').limit(QUOTE_LIST_MAX).execute();
    const today = vietnamToday(new Date());
    return rows.map((r) => summary(r, today));
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Writing a draft
// ---------------------------------------------------------------------------------------------------------------

// The lines as the columns keep them: a text line is a note with no amounts, an item line is priced by totalLines. Whole dong, half up.
function priced(lines: readonly QuoteLineInput[]) {
  const items = lines.map((line, i) => ({ ...line, lineNo: i + 1 }));
  const forTotals = items.map((l) => (l.kind === 'text' ? { ...l, quantity: '0', unitPrice: '0', discountPercent: '0' } : l));
  const totals = totalLines(forTotals);
  return {
    rows: totals.lines.map((l) => ({
      line_no: l.lineNo,
      kind: l.kind,
      description: l.description,
      unit: l.kind === 'text' ? null : l.unit,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      discount_percent: l.discountPercent,
      vat_rate: l.vatRate,
      amount: l.amount,
      vat_amount: l.vatAmount,
      stock_item_id: l.kind === 'text' ? null : (l.stockItemId ?? null),
    })),
    subtotal: totals.subtotal,
    vatAmount: totals.vatAmount,
    total: totals.total,
  };
}

async function writeLines(ctx: CommandContext, quoteId: string, rows: ReturnType<typeof priced>['rows']): Promise<void> {
  await ctx.trx.deleteFrom('crove_crm.quote_line').where('org_id', '=', ctx.orgId).where('quote_id', '=', quoteId).execute();
  if (rows.length === 0) return;
  await ctx.trx
    .insertInto('crove_crm.quote_line')
    .values(rows.map((r) => ({ org_id: ctx.orgId, quote_id: quoteId, ...r })))
    .execute();
}

function checkLines(lines: readonly QuoteLineInput[]): void {
  if (lines.length > QUOTE_LINES_MAX) throw new DomainError('QUOTE_TOO_MANY_LINES', 422, `Một báo giá có tối đa ${QUOTE_LINES_MAX} dòng`);
}

export const quoteSave = defineCommand({
  name: 'crm.quote.save',
  input: zQuoteSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => (input.quoteId ? { type: 'crm.quote', id: input.quoteId } : null),
  handler: async (ctx, input): Promise<Quote> => {
    const userId = userOf(ctx.actor);
    checkLines(input.lines);
    const today = vietnamToday(ctx.now);
    if (input.validUntil !== undefined && !isDate(input.validUntil)) throw new DomainError('QUOTE_VALID_UNTIL_INVALID', 422, 'Ngày hết hạn không hợp lệ');
    const totals = priced(input.lines);

    if (input.quoteId === undefined) {
      // A new draft for a deal: the customer is the deal's, the validity and the terms the org's defaults unless named.
      const deal = await ctx.trx.selectFrom('crove_crm.deal').select(['id', 'party_id']).where('org_id', '=', ctx.orgId).where('id', '=', input.dealId as string).executeTakeFirst();
      if (!deal) throw new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
      const setting = await quoteSetting(ctx);
      const validUntil = input.validUntil ?? addDays(today, setting.validDays);
      if (validUntil < today) throw new DomainError('QUOTE_VALID_UNTIL_PAST', 422, 'Ngày hết hạn không được ở quá khứ');
      const row = await ctx.trx
        .insertInto('crove_crm.quote')
        .values({
          org_id: ctx.orgId,
          deal_id: deal.id,
          party_id: deal.party_id,
          valid_until: validUntil,
          remarks: input.notes ?? '',
          terms: input.terms ?? setting.defaultTerms,
          subtotal: totals.subtotal,
          vat_amount: totals.vatAmount,
          total: totals.total,
          created_by: userId,
          created_at: ctx.now,
          updated_by: userId,
          updated_at: ctx.now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeLines(ctx, row.id, totals.rows);
      ctx.audit({ quoteId: row.id, dealId: deal.id, partyId: deal.party_id, lineCount: totals.rows.length });
      await ctx.activity('kernel.party', deal.party_id, 'quote.created', 'Tạo báo giá');
      return loadQuote(ctx, row.id);
    }

    // An edit replaces the fields and the lines of a draft, under the version the editor read.
    const before = await ctx.trx
      .selectFrom('crove_crm.quote')
      .select(['id', 'deal_id', 'party_id', 'status', 'version', 'valid_until', 'remarks', 'terms'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.quoteId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw notFound();
    if (before.version !== input.version) throw stale();
    if (before.status !== 'draft') throw notDraft();
    const validUntil = input.validUntil ?? day(before.valid_until);
    if (validUntil !== day(before.valid_until) && validUntil < today) throw new DomainError('QUOTE_VALID_UNTIL_PAST', 422, 'Ngày hết hạn không được ở quá khứ');
    await ctx.trx
      .updateTable('crove_crm.quote')
      .set({
        valid_until: validUntil,
        remarks: input.notes ?? before.remarks,
        terms: input.terms ?? before.terms,
        subtotal: totals.subtotal,
        vat_amount: totals.vatAmount,
        total: totals.total,
        version: before.version + 1,
        updated_by: userId,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.quoteId)
      .execute();
    await writeLines(ctx, input.quoteId, totals.rows);
    ctx.audit({ quoteId: input.quoteId, dealId: before.deal_id, partyId: before.party_id, lineCount: totals.rows.length });
    return loadQuote(ctx, input.quoteId);
  },
});

export const quoteDeleteDraft = defineCommand({
  name: 'crm.quote.delete_draft',
  input: zQuoteVersionRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.quote', id: input.quoteId }),
  handler: async (ctx, input): Promise<{ quoteId: string; deleted: true }> => {
    userOf(ctx.actor);
    const quote = await ctx.trx
      .selectFrom('crove_crm.quote')
      .select(['id', 'deal_id', 'party_id', 'status', 'version'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.quoteId)
      .forUpdate()
      .executeTakeFirst();
    if (!quote) throw notFound();
    if (quote.version !== input.version) throw stale();
    if (quote.status !== 'draft') throw notDraft();
    // The lines go with it (the foreign key's cascade).
    await ctx.trx.deleteFrom('crove_crm.quote').where('org_id', '=', ctx.orgId).where('id', '=', input.quoteId).execute();
    ctx.audit({ quoteId: input.quoteId, dealId: quote.deal_id, partyId: quote.party_id });
    await ctx.activity('kernel.party', quote.party_id, 'quote.deleted', 'Xóa một bản nháp báo giá');
    return { quoteId: input.quoteId, deleted: true };
  },
});

// A new draft from a quote that has been sent (a sent, declined or expired one): the lines, notes and terms are copied, the validity starts from today, the
// customer's snapshot is taken again at send. It keeps the number of the quote it revises (read through `revision_of` until the send gives it its own) and
// counts the revision. An accepted quote is final, a draft is edited, a superseded one has a newer revision, and a quote with an open draft revision is refused.
export const quoteRevise = defineCommand({
  name: 'crm.quote.revise',
  input: zQuoteVersionRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.quote', id: input.quoteId }),
  handler: async (ctx, input): Promise<Quote> => {
    const userId = userOf(ctx.actor);
    const source = await ctx.trx
      .selectFrom('crove_crm.quote')
      .select(['id', 'deal_id', 'party_id', 'status', 'version', 'revision', 'remarks', 'terms'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.quoteId)
      .forUpdate()
      .executeTakeFirst();
    if (!source) throw notFound();
    if (source.version !== input.version) throw stale();
    if (source.status === 'draft') throw new DomainError('QUOTE_IS_DRAFT', 409, 'Bản nháp thì sửa trực tiếp, không cần tạo bản sửa');
    if (source.status === 'accepted') throw new DomainError('QUOTE_ACCEPTED', 409, 'Báo giá đã được đồng ý, không tạo bản sửa');
    if (source.status === 'superseded') throw new DomainError('QUOTE_SUPERSEDED', 409, 'Báo giá này đã có bản sửa mới hơn');
    const open = await ctx.trx
      .selectFrom('crove_crm.quote')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('revision_of', '=', source.id)
      .where('status', '=', 'draft')
      .executeTakeFirst();
    if (open) throw new DomainError('QUOTE_REVISION_OPEN', 409, 'Báo giá này đã có một bản sửa đang soạn');
    const setting = await quoteSetting(ctx);
    const lines = await loadLines(ctx, source.id);
    const totals = priced(
      lines.map((l) => ({ kind: l.kind, description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: l.discountPercent, vatRate: l.vatRate, stockItemId: l.stockItemId })),
    );
    const row = await ctx.trx
      .insertInto('crove_crm.quote')
      .values({
        org_id: ctx.orgId,
        deal_id: source.deal_id,
        party_id: source.party_id,
        revision: source.revision + 1,
        revision_of: source.id,
        valid_until: addDays(vietnamToday(ctx.now), setting.validDays),
        remarks: source.remarks,
        terms: source.terms,
        subtotal: totals.subtotal,
        vat_amount: totals.vatAmount,
        total: totals.total,
        created_by: userId,
        created_at: ctx.now,
        updated_by: userId,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeLines(ctx, row.id, totals.rows);
    ctx.audit({ quoteId: row.id, revisionOf: source.id, dealId: source.deal_id, partyId: source.party_id, revision: source.revision + 1 });
    await ctx.activity('kernel.party', source.party_id, 'quote.revised', 'Tạo bản sửa của một báo giá');
    return loadQuote(ctx, row.id);
  },
});

export const quoteCommands = [quoteSave, quoteDeleteDraft, quoteRevise, quoteSettingSet];
export const quoteQueries = [quoteGet, quoteList, dealQuotes, quoteSettingGet];
