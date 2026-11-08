// SPDX-License-Identifier: AGPL-3.0-only
// Quotes of a deal (issue #2693, plan docs/plan/crm-quotes.md section 4 and step Q1): a person makes a draft from a deal in one click, edits its lines and
// fields, deletes it, or revises a quote that has left `draft`. Owners, admins and members write; viewers read. Every command is R1 and internal: it changes
// only the org's own records, posts nothing to the books and sends nothing, and no agent runs one (the commands refuse a caller that is not a person).
//
// Nothing here moves a quote out of `draft`: sending, accepting and declining are later steps (Q2, Q4), and the database holds the line (a tenant role can
// insert only a fresh draft and cannot update the status, the number or the sent and decided columns). The totals are computed here by the rule of
// @crove/l10n-vn (the one an e-invoice draft uses), never taken from the caller. The audit rows and the timeline hold ids and counts, never a customer
// value, a price or a line text.
import { sql } from 'kysely';
import {
  QUOTE_DEFAULT_VAT,
  QUOTE_HINTS_MAX,
  QUOTE_PAGE_SIZE,
  QUOTE_VAT_RATE_MAX,
  QUOTE_VALID_DAYS_DEFAULT,
  vietnamToday,
  zDealQuotesQuery,
  zQuoteDefaultsQuery,
  zQuoteListQuery,
  zQuoteRef,
  zQuoteSave,
  zQuoteSettingSet,
  type Quote,
  type QuoteDefaults,
  type QuoteDeleted,
  type QuoteHint,
  type QuoteLine,
  type QuoteLineInput,
  type QuotePage,
  type QuoteSetting,
  type QuoteStatus,
  type QuoteSummary,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { computeLineTotals, money, normalizeVatRate, sumLineTotals } from '@crove/l10n-vn';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

export type Reader = Pick<QueryContext, 'trx' | 'orgId' | 'actor' | 'role'>;

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const day = (value: Date | string): string => (typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));
// The row lock of a draft. It is taken after the status is read, because a SELECT ... FOR UPDATE applies the UPDATE policy too, which shows a tenant role
// drafts only: a quote that has left `draft` is read plainly and refused by its status, not reported as missing.
async function lockDraft(ctx: Pick<CommandContext, 'trx' | 'orgId'>, quoteId: string): Promise<{ version: number } | undefined> {
  return ctx.trx.selectFrom('crove_crm.quote').select('version').where('org_id', '=', ctx.orgId).where('id', '=', quoteId).forUpdate().executeTakeFirst();
}
const notFound = () => new DomainError('QUOTE_NOT_FOUND', 404, 'Không tìm thấy báo giá này');
const stale = () => new DomainError('STALE_VERSION', 409, 'Báo giá này vừa được người khác sửa; hãy mở lại để xem bản mới');
const notDraft = () => new DomainError('QUOTE_NOT_DRAFT', 409, 'Báo giá đã gửi không sửa được; hãy tạo bản sửa đổi');

// Most digits before the point of a line amount or a total (the column holds more; this keeps every sum inside it).
const MAX_AMOUNT_DIGITS = 15;

// ---------------------------------------------------------------------------------------------------------------
// Settings and defaults
// ---------------------------------------------------------------------------------------------------------------

async function loadSetting(ctx: Reader): Promise<QuoteSetting> {
  const row = await ctx.trx.selectFrom('crove_crm.quote_setting').select(['valid_days', 'default_vat', 'default_terms']).where('org_id', '=', ctx.orgId).executeTakeFirst();
  return row ? { validDays: row.valid_days, defaultVat: row.default_vat, defaultTerms: row.default_terms } : { validDays: QUOTE_VALID_DAYS_DEFAULT, defaultVat: QUOTE_DEFAULT_VAT, defaultTerms: null };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export const quoteSettingSet = defineCommand({
  name: 'crm.quote_setting.set',
  input: zQuoteSettingSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<QuoteSetting> => {
    const userId = userOf(ctx.actor);
    const vat = normalizeVatRate(input.defaultVat);
    if (vat === null || vat.length > QUOTE_VAT_RATE_MAX) throw new DomainError('QUOTE_VAT_RATE_INVALID', 422, 'Thuế suất không hợp lệ');
    const terms = input.defaultTerms === null || input.defaultTerms === '' ? null : input.defaultTerms;
    await ctx.trx
      .insertInto('crove_crm.quote_setting')
      .values({ org_id: ctx.orgId, valid_days: input.validDays, default_vat: vat, default_terms: terms, set_by: userId, created_at: ctx.now, updated_at: ctx.now })
      .onConflict((oc) => oc.column('org_id').doUpdateSet({ valid_days: input.validDays, default_vat: vat, default_terms: terms, set_by: userId, updated_at: ctx.now }))
      .execute();
    ctx.audit({ validDays: input.validDays });
    return { validDays: input.validDays, defaultVat: vat, defaultTerms: terms };
  },
});

// What the editor starts from for a customer: the org's settings (or their defaults), the VAT rate last used on a quote to the customer, and the customer's
// earlier item lines, the latest of each description, for the "last sold price" default (MISA's idea; no model).
export const quoteDefaults = defineQuery({
  name: 'crm.quote.defaults',
  input: zQuoteDefaultsQuery,
  access: ALL,
  handler: async (ctx, input): Promise<QuoteDefaults> => {
    const setting = await loadSetting(ctx);
    const rows = await sql<{ description: string; unit: string | null; unit_price: string; vat_rate: string; quote_id: string }>`
      SELECT h.description, h.unit, h.unit_price, h.vat_rate, h.quote_id FROM (
        SELECT DISTINCT ON (pg_catalog.lower(l.description)) l.description, l.unit, l.unit_price::text AS unit_price, l.vat_rate, q.id AS quote_id, q.created_at
        FROM crove_crm.quote_line l
        JOIN crove_crm.quote q ON q.org_id = l.org_id AND q.id = l.quote_id
        WHERE q.org_id = ${ctx.orgId}::uuid AND q.party_id = ${input.partyId}::uuid AND l.kind = 'item'
        ORDER BY pg_catalog.lower(l.description), q.created_at DESC, l.line_no
      ) h
      ORDER BY h.created_at DESC, h.description
      LIMIT ${QUOTE_HINTS_MAX}`.execute(ctx.trx);
    const hints: QuoteHint[] = rows.rows.map((r) => ({ description: r.description, unit: r.unit, unitPrice: trimDecimal(r.unit_price), vatRate: r.vat_rate, quoteId: r.quote_id }));
    return { validDays: setting.validDays, defaultVat: hints[0]?.vatRate ?? setting.defaultVat, defaultTerms: setting.defaultTerms, hints };
  },
});

// numeric(24,8) comes back as "1500000.00000000": the shortest form of the same amount.
function trimDecimal(value: string): string {
  return money(value).toFixed();
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

interface SummaryRow {
  id: string;
  deal_id: string;
  party_id: string;
  revision: number;
  revises_id: string | null;
  status: string;
  valid_until: Date | string;
  remarks: string | null;
  terms: string | null;
  subtotal: string;
  vat_amount: string;
  total: string;
  version: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  deal_title: string;
  party_name: string;
  shown_number: string | null;
  line_count: number;
}

function base(ctx: Reader) {
  return ctx.trx
    .selectFrom('crove_crm.quote as q')
    .innerJoin('crove_crm.deal as d', (j) => j.onRef('d.org_id', '=', 'q.org_id').onRef('d.id', '=', 'q.deal_id'))
    .innerJoin('crove_kernel.party as p', (j) => j.onRef('p.org_id', '=', 'q.org_id').onRef('p.id', '=', 'q.party_id'))
    // A revision shows the number of the quote it revises until it has its own.
    .leftJoin('crove_crm.quote as r', (j) => j.onRef('r.org_id', '=', 'q.org_id').onRef('r.id', '=', 'q.revises_id'))
    .select([
      'q.id',
      'q.deal_id',
      'q.party_id',
      'q.revision',
      'q.revises_id',
      'q.status',
      'q.valid_until',
      'q.remarks',
      'q.terms',
      'q.subtotal',
      'q.vat_amount',
      'q.total',
      'q.version',
      'q.created_by',
      'q.created_at',
      'q.updated_at',
      'd.title as deal_title',
      'p.name as party_name',
      sql<string | null>`coalesce(q.number, r.number)`.as('shown_number'),
      sql<number>`(SELECT pg_catalog.count(*)::int FROM crove_crm.quote_line l WHERE l.org_id = q.org_id AND l.quote_id = q.id)`.as('line_count'),
    ])
    .where('q.org_id', '=', ctx.orgId);
}

// Expired is derived, never stored: a sent quote whose validity date is before today in Vietnam's calendar.
function summary(r: SummaryRow, now: Date): QuoteSummary {
  const validUntil = day(r.valid_until);
  return {
    id: r.id,
    dealId: r.deal_id,
    dealTitle: r.deal_title,
    partyId: r.party_id,
    partyName: r.party_name,
    number: r.shown_number,
    revision: r.revision,
    revisesId: r.revises_id,
    status: r.status as QuoteStatus,
    expired: r.status === 'sent' && validUntil < vietnamToday(now),
    validUntil,
    subtotal: money(r.subtotal).toFixed(),
    vatAmount: money(r.vat_amount).toFixed(),
    total: money(r.total).toFixed(),
    lineCount: r.line_count,
    version: r.version,
    createdBy: r.created_by,
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
    quantity: l.quantity === null ? null : money(l.quantity).toFixed(),
    unitPrice: l.unit_price === null ? null : money(l.unit_price).toFixed(),
    discountPercent: money(l.discount_percent).toFixed(),
    vatRate: l.vat_rate,
    amount: money(l.amount).toFixed(),
    vatAmount: money(l.vat_amount).toFixed(),
    stockItemId: l.stock_item_id,
  }));
}

export async function loadQuote(ctx: Reader, quoteId: string, now: Date = new Date()): Promise<Quote> {
  const row = await base(ctx).where('q.id', '=', quoteId).executeTakeFirst();
  if (!row) throw notFound();
  return { ...summary(row, now), notes: row.remarks, terms: row.terms, lines: await loadLines(ctx, quoteId) };
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
    const limit = input.limit ?? QUOTE_PAGE_SIZE;
    let q = base(ctx);
    if (input.dealId) q = q.where('q.deal_id', '=', input.dealId);
    if (input.partyId) q = q.where('q.party_id', '=', input.partyId);
    if (input.status) q = q.where('q.status', '=', input.status);
    if (input.cursor) q = q.where(sql<boolean>`(q.created_at, q.id) < (${new Date(input.cursor.createdAt)}::timestamptz, ${input.cursor.id}::uuid)`);
    const rows = await q.orderBy('q.created_at', 'desc').orderBy('q.id', 'desc').limit(limit + 1).execute();
    const now = new Date();
    const items = rows.slice(0, limit).map((r) => summary(r, now));
    const last = items.at(-1);
    return { items, next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
  },
});

// The quotes of one deal, newest first: the deal panel's tab.
export const dealQuotes = defineQuery({
  name: 'crm.deal.quotes',
  input: zDealQuotesQuery,
  access: ALL,
  handler: async (ctx, input): Promise<QuoteSummary[]> => {
    const rows = await base(ctx).where('q.deal_id', '=', input.dealId).orderBy('q.created_at', 'desc').orderBy('q.id', 'desc').limit(100).execute();
    const now = new Date();
    return rows.map((r) => summary(r, now));
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------

interface LineRow {
  line_no: number;
  kind: 'item' | 'text';
  description: string;
  unit: string | null;
  quantity: string | null;
  unit_price: string | null;
  discount_percent: string;
  vat_rate: string | null;
  amount: string;
  vat_amount: string;
  stock_item_id: string | null;
}

const tooLarge = () => new DomainError('QUOTE_TOTAL_TOO_LARGE', 422, 'Số tiền của báo giá quá lớn');

// The lines as rows, with each amount and its VAT from the shared rule, and the totals as the sums of the rounded lines. A line with a quantity or price of
// zero or below, a rate outside the set or a discount over 100 is refused with a typed error.
function computeRows(lines: readonly QuoteLineInput[]): { rows: LineRow[]; subtotal: string; vatAmount: string; total: string } {
  const rows: LineRow[] = lines.map((line, i): LineRow => {
    const lineNo = i + 1;
    if (line.kind === 'text') {
      return { line_no: lineNo, kind: 'text', description: line.description, unit: null, quantity: null, unit_price: null, discount_percent: '0', vat_rate: null, amount: '0', vat_amount: '0', stock_item_id: null };
    }
    if (money(line.quantity).lessThanOrEqualTo(0) || money(line.unitPrice).lessThanOrEqualTo(0)) {
      throw new DomainError('QUOTE_LINE_INVALID', 422, `Dòng ${lineNo}: số lượng và đơn giá phải lớn hơn 0`);
    }
    const discount = line.discountPercent ?? '0';
    if (money(discount).greaterThan(100)) throw new DomainError('QUOTE_LINE_INVALID', 422, `Dòng ${lineNo}: giảm giá không được quá 100%`);
    const rate = normalizeVatRate(line.vatRate);
    if (rate === null || rate.length > QUOTE_VAT_RATE_MAX) throw new DomainError('QUOTE_VAT_RATE_INVALID', 422, `Dòng ${lineNo}: thuế suất không hợp lệ`);
    const totals = computeLineTotals({ quantity: line.quantity, unitPrice: line.unitPrice, discountPercent: discount, vatRate: rate });
    if (money(totals.amount).toFixed(0).length > MAX_AMOUNT_DIGITS) throw tooLarge();
    return {
      line_no: lineNo,
      kind: 'item',
      description: line.description,
      unit: line.unit ?? null,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      discount_percent: discount,
      vat_rate: totals.vatRate,
      amount: totals.amount,
      vat_amount: totals.vatAmount,
      stock_item_id: line.stockItemId ?? null,
    };
  });
  const totals = sumLineTotals(rows.map((r) => ({ amount: r.amount, vatAmount: r.vat_amount })));
  if (money(totals.total).toFixed(0).length > MAX_AMOUNT_DIGITS) throw tooLarge();
  return { rows, ...totals };
}

async function insertLines(ctx: CommandContext, quoteId: string, rows: readonly LineRow[]): Promise<void> {
  if (rows.length === 0) return;
  await ctx.trx
    .insertInto('crove_crm.quote_line')
    .values(rows.map((r) => ({ org_id: ctx.orgId, quote_id: quoteId, ...r })))
    .execute();
}

const oneText = (value: string | null | undefined): string | null | undefined => (value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim());

// "Tạo báo giá" (a deal, no lines) makes a draft for the deal's customer with the org's validity and default terms; saving a draft (its id and the version the
// caller read) replaces its fields and lines. A quote that has left `draft` is refused.
export const quoteSave = defineCommand({
  name: 'crm.quote.save',
  input: zQuoteSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => (input.quoteId ? { type: 'crm.quote', id: input.quoteId } : null),
  handler: async (ctx, input): Promise<Quote> => {
    const userId = userOf(ctx.actor);
    if (input.validUntil !== undefined && !validDate(input.validUntil)) throw new DomainError('QUOTE_DATE_INVALID', 422, 'Ngày hiệu lực không hợp lệ');
    const computed = computeRows(input.lines);
    const notes = oneText(input.notes);
    const terms = oneText(input.terms);
    if (input.quoteId === undefined) {
      const deal = await ctx.trx.selectFrom('crove_crm.deal').select(['id', 'party_id']).where('org_id', '=', ctx.orgId).where('id', '=', input.dealId as string).executeTakeFirst();
      if (!deal) throw new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
      const setting = await loadSetting(ctx);
      const row = await ctx.trx
        .insertInto('crove_crm.quote')
        .values({
          org_id: ctx.orgId,
          deal_id: deal.id,
          party_id: deal.party_id,
          valid_until: input.validUntil ?? addDays(vietnamToday(ctx.now), setting.validDays),
          remarks: notes ?? null,
          terms: terms === undefined ? setting.defaultTerms : terms,
          subtotal: computed.subtotal,
          vat_amount: computed.vatAmount,
          total: computed.total,
          created_by: userId,
          created_at: ctx.now,
          updated_by: userId,
          updated_at: ctx.now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await insertLines(ctx, row.id, computed.rows);
      ctx.audit({ quoteId: row.id, dealId: deal.id, partyId: deal.party_id, lines: computed.rows.length, created: true });
      await ctx.activity('kernel.party', deal.party_id, 'quote.created', 'Tạo báo giá');
      return loadQuote(ctx, row.id, ctx.now);
    }
    const before = await ctx.trx
      .selectFrom('crove_crm.quote')
      .select(['id', 'deal_id', 'party_id', 'status', 'version', 'valid_until', 'remarks', 'terms'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.quoteId)
      .executeTakeFirst();
    if (!before) throw notFound();
    if (input.dealId !== undefined && input.dealId !== before.deal_id) throw new DomainError('QUOTE_DEAL_MISMATCH', 422, 'Báo giá này thuộc về một cơ hội khác');
    if (before.status !== 'draft') throw notDraft();
    const locked = await lockDraft(ctx, before.id);
    if (!locked) throw notFound();
    if (locked.version !== input.version) throw stale();
    await ctx.trx.deleteFrom('crove_crm.quote_line').where('org_id', '=', ctx.orgId).where('quote_id', '=', before.id).execute();
    await insertLines(ctx, before.id, computed.rows);
    await ctx.trx
      .updateTable('crove_crm.quote')
      .set({
        valid_until: input.validUntil ?? day(before.valid_until),
        remarks: notes === undefined ? before.remarks : notes,
        terms: terms === undefined ? before.terms : terms,
        subtotal: computed.subtotal,
        vat_amount: computed.vatAmount,
        total: computed.total,
        version: locked.version + 1,
        updated_by: userId,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', before.id)
      .execute();
    ctx.audit({ quoteId: before.id, dealId: before.deal_id, partyId: before.party_id, lines: computed.rows.length, created: false });
    return loadQuote(ctx, before.id, ctx.now);
  },
});

export const quoteDeleteDraft = defineCommand({
  name: 'crm.quote.delete_draft',
  input: zQuoteRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.quote', id: input.quoteId }),
  handler: async (ctx, input): Promise<QuoteDeleted> => {
    userOf(ctx.actor);
    const quote = await ctx.trx
      .selectFrom('crove_crm.quote')
      .select(['id', 'deal_id', 'party_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.quoteId)
      .executeTakeFirst();
    if (!quote) throw notFound();
    if (quote.status !== 'draft') throw new DomainError('QUOTE_NOT_DRAFT', 409, 'Chỉ xóa được báo giá nháp');
    // A draft that was sent or removed between the read and the lock is refused, and nothing is audited for it.
    if (!(await lockDraft(ctx, quote.id))) throw new DomainError('QUOTE_NOT_DRAFT', 409, 'Chỉ xóa được báo giá nháp');
    // The lines go with the quote (the foreign key cascades).
    const removed = await ctx.trx.deleteFrom('crove_crm.quote').where('org_id', '=', ctx.orgId).where('id', '=', quote.id).executeTakeFirst();
    if (removed.numDeletedRows !== 1n) throw new DomainError('QUOTE_NOT_DRAFT', 409, 'Chỉ xóa được báo giá nháp');
    ctx.audit({ quoteId: quote.id, dealId: quote.deal_id, partyId: quote.party_id });
    await ctx.activity('kernel.party', quote.party_id, 'quote.deleted', 'Xóa một báo giá nháp');
    return { quoteId: quote.id, deleted: true };
  },
});

// A sent or declined quote is revised into a new draft with its lines copied, the next revision number and a fresh validity; the older row is untouched. A
// draft is edited in place, an accepted quote is final, and a quote already superseded has a newer one. One revision of a quote exists at a time.
export const quoteRevise = defineCommand({
  name: 'crm.quote.revise',
  input: zQuoteRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.quote', id: input.quoteId }),
  handler: async (ctx, input): Promise<Quote> => {
    const userId = userOf(ctx.actor);
    const source = await ctx.trx
      .selectFrom('crove_crm.quote')
      .select(['id', 'deal_id', 'party_id', 'status', 'revision', 'remarks', 'terms'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.quoteId)
      .executeTakeFirst();
    if (!source) throw notFound();
    if (source.status !== 'sent' && source.status !== 'declined') {
      throw new DomainError('QUOTE_NOT_REVISABLE', 409, source.status === 'draft' ? 'Báo giá nháp được sửa trực tiếp' : 'Báo giá này không tạo được bản sửa đổi');
    }
    const existing = await ctx.trx.selectFrom('crove_crm.quote').select('id').where('org_id', '=', ctx.orgId).where('revises_id', '=', source.id).executeTakeFirst();
    if (existing) throw new DomainError('QUOTE_ALREADY_REVISED', 409, 'Báo giá này đã có một bản sửa đổi');
    const setting = await loadSetting(ctx);
    const lines = await ctx.trx
      .selectFrom('crove_crm.quote_line')
      .select(['line_no', 'kind', 'description', 'unit', 'quantity', 'unit_price', 'discount_percent', 'vat_rate', 'amount', 'vat_amount', 'stock_item_id'])
      .where('org_id', '=', ctx.orgId)
      .where('quote_id', '=', source.id)
      .orderBy('line_no')
      .execute();
    const rows: LineRow[] = lines.map((l) => ({ ...l }));
    const totals = sumLineTotals(rows.map((r) => ({ amount: r.amount, vatAmount: r.vat_amount })));
    const copy = await ctx.trx
      .insertInto('crove_crm.quote')
      .values({
        org_id: ctx.orgId,
        deal_id: source.deal_id,
        party_id: source.party_id,
        revision: source.revision + 1,
        revises_id: source.id,
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
      .executeTakeFirstOrThrow()
      // Two people reviving the same quote at once: the unique index on revises_id lets one in.
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '23505') throw new DomainError('QUOTE_ALREADY_REVISED', 409, 'Báo giá này đã có một bản sửa đổi');
        throw error;
      });
    await insertLines(ctx, copy.id, rows);
    ctx.audit({ quoteId: copy.id, revisesId: source.id, dealId: source.deal_id, partyId: source.party_id, lines: rows.length });
    await ctx.activity('kernel.party', source.party_id, 'quote.revised', 'Tạo bản sửa đổi của một báo giá');
    return loadQuote(ctx, copy.id, ctx.now);
  },
});

// The refusal `crm.deal.delete` makes while the deal has a quote: a quote the customer holds is a document.
export async function dealHasQuotes(ctx: Pick<CommandContext, 'trx' | 'orgId'>, dealId: string): Promise<boolean> {
  const row = await ctx.trx.selectFrom('crove_crm.quote').select('id').where('org_id', '=', ctx.orgId).where('deal_id', '=', dealId).limit(1).executeTakeFirst();
  return row !== undefined;
}

export const quoteCommands = [quoteSave, quoteDeleteDraft, quoteRevise, quoteSettingSet];
export const quoteQueries = [quoteGet, quoteList, dealQuotes, quoteDefaults];
