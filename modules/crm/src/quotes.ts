// SPDX-License-Identifier: AGPL-3.0-only
// Quotes of a deal (issue #2693, plan docs/plan/crm-quotes.md section 4 and step Q1): a person makes a draft from a deal in one click, edits its lines and
// fields, deletes it, or revises a quote that has left `draft`. Owners, admins and members write; viewers read. Every command is R1 and internal: it changes
// only the org's own records and posts nothing to the books; sending a quote is a person's click (by email it queues one mail), and no agent runs one (the commands refuse a caller that is not a person).
//
// A quote leaves `draft` in one place only, crm.quote.send (Q2, #2694): it takes the number, writes the buyer snapshot and the issuing entity, and, for a revision,
// replaces the older quote. Accepting and declining are Q4. The database holds the line (a guard trigger lets a tenant role make exactly those transitions, and
// freezes a quote and its lines once it is sent). The totals are computed here by the rule of
// @crove/l10n-vn (the one an e-invoice draft uses), never taken from the caller. The audit rows and the timeline hold ids and counts, never a customer
// value, a price or a line text.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  QUOTE_DEFAULT_VAT,
  QUOTE_HINTS_MAX,
  QUOTE_LOGO_MAX_BYTES,
  QUOTE_LOGO_MAX_PIXELS,
  QUOTE_LOGO_MAX_SIDE,
  QUOTE_LOGO_TYPES,
  QUOTE_LINKS_MAX,
  QUOTE_LINK_DAYS_AFTER_VALID,
  QUOTE_PAGE_PATH,
  QUOTE_PAGE_SIZE,
  QUOTE_VAT_RATE_MAX,
  QUOTE_VALID_DAYS_DEFAULT,
  vietnamToday,
  zDealQuotesQuery,
  zQuoteDefaultsQuery,
  zQuoteLinkRevoke,
  zQuoteLogoSet,
  zQuoteListQuery,
  zQuoteRef,
  zQuoteSave,
  zQuoteSend,
  zQuoteSettingSet,
  type Quote,
  type QuoteDefaults,
  type QuoteDeleted,
  type QuoteHint,
  type QuoteLinkCreated,
  type QuoteLinkRevoked,
  type QuoteLinkSummary,
  type QuoteLine,
  type QuoteLineInput,
  type QuotePage,
  type QuoteSent,
  type QuoteSetting,
  type QuoteStatus,
  type QuoteSummary,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { createMailMessage } from '@crove/kernel';
import { computeLineTotals, money, normalizeVatRate, sumLineTotals } from '@crove/l10n-vn';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { QUOTE_MAIL_SOURCE, QUOTE_MAIL_TEMPLATE, zQuoteMail } from './quote-mail.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const PLAIN_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const row = await ctx.trx
    .selectFrom('crove_crm.quote_setting')
    .select(['valid_days', 'default_vat', 'default_terms', 'phone', 'email', 'bank_note', 'logo_file_id'])
    .where('org_id', '=', ctx.orgId)
    .executeTakeFirst();
  return row
    ? { validDays: row.valid_days, defaultVat: row.default_vat, defaultTerms: row.default_terms, phone: row.phone, email: row.email, bankNote: row.bank_note, logoFileId: row.logo_file_id }
    : { validDays: QUOTE_VALID_DAYS_DEFAULT, defaultVat: QUOTE_DEFAULT_VAT, defaultTerms: null, phone: null, email: null, bankNote: null, logoFileId: null };
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
    const text = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim());
    const terms = text(input.defaultTerms);
    const phone = text(input.phone);
    const email = text(input.email);
    const bankNote = text(input.bankNote);
    if (email !== null && !PLAIN_ADDRESS.test(email)) throw new DomainError('QUOTE_EMAIL_INVALID', 422, 'Địa chỉ email không hợp lệ');
    const values = { valid_days: input.validDays, default_vat: vat, default_terms: terms, phone, email, bank_note: bankNote, set_by: userId, updated_at: ctx.now };
    await ctx.trx
      .insertInto('crove_crm.quote_setting')
      .values({ org_id: ctx.orgId, created_at: ctx.now, ...values })
      .onConflict((oc) => oc.column('org_id').doUpdateSet(values))
      .execute();
    ctx.audit({ validDays: input.validDays });
    return loadSetting(ctx);
  },
});

// The logo of the letterhead (#2814). It is an image of the org's own library (a file uploaded for a Social post, as the watermark's and the report brand's logos are, so it is never
// sent to extraction), a PNG or a JPEG, small. The settings row may not exist yet (every default applies): setting a logo makes it with those defaults. The audit holds the file id only.
export const quoteLogoSet = defineCommand({
  name: 'crm.quote_setting.logo_set',
  input: zQuoteLogoSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<QuoteSetting> => {
    const userId = userOf(ctx.actor);
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['content_type', 'size_bytes', 'source', 'image_width', 'image_height'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .executeTakeFirst();
    if (!file || file.source !== 'social') throw new DomainError('QUOTE_LOGO_NOT_FOUND', 404, 'Không tìm thấy ảnh này');
    if (!(QUOTE_LOGO_TYPES as readonly string[]).includes(file.content_type)) throw new DomainError('QUOTE_LOGO_TYPE', 422, 'Logo chỉ nhận ảnh PNG hoặc JPEG');
    if (Number(file.size_bytes) > QUOTE_LOGO_MAX_BYTES) throw new DomainError('QUOTE_LOGO_TOO_LARGE', 422, `Logo lớn hơn ${QUOTE_LOGO_MAX_BYTES / 1024} KB; hãy thu nhỏ ảnh rồi chọn lại`);
    // The picture's size as the upload recorded it from the file's own header: a logo is decoded for the PDF, so its size is bounded here, and one whose size is not known is refused.
    if (file.image_width === null || file.image_height === null) throw new DomainError('QUOTE_LOGO_DIMENSIONS', 422, 'Không đọc được kích thước ảnh; hãy chọn ảnh PNG hoặc JPEG khác');
    if (file.image_width > QUOTE_LOGO_MAX_SIDE || file.image_height > QUOTE_LOGO_MAX_SIDE || file.image_width * file.image_height > QUOTE_LOGO_MAX_PIXELS) {
      throw new DomainError('QUOTE_LOGO_DIMENSIONS', 422, `Logo lớn hơn ${QUOTE_LOGO_MAX_SIDE} x ${QUOTE_LOGO_MAX_SIDE} điểm ảnh; hãy thu nhỏ ảnh rồi chọn lại`);
    }
    const values = { logo_file_id: input.fileId, set_by: userId, updated_at: ctx.now };
    await ctx.trx
      .insertInto('crove_crm.quote_setting')
      .values({ org_id: ctx.orgId, created_at: ctx.now, ...values })
      .onConflict((oc) => oc.column('org_id').doUpdateSet(values))
      .execute();
    ctx.audit({ fileId: input.fileId });
    return loadSetting(ctx);
  },
});

// Where a logo is stored, for the HTTP route to read the bytes with (the PDF's): the document itself holds no file. Only a PNG or a JPEG within the size the upload allows.
export interface QuoteLogoFile {
  id: string;
  storageKey: string;
  generation: string | null;
  sha256: string;
  contentType: string;
  sizeBytes: number;
}

// The logo a file id names, if it is still a file of this org that the upload checks let in (from the photo library, a PNG or a JPEG, small); else none. Used at the send, to freeze it, and by the PDF.
export async function logoFileOf(ctx: Pick<Reader, 'trx' | 'orgId'>, fileId: string | null): Promise<QuoteLogoFile | null> {
  if (fileId === null) return null;
  const file = await ctx.trx
    .selectFrom('crove_kernel.file')
    .select(['id', 'storage_key', 'generation', 'sha256', 'content_type', 'size_bytes', 'source'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (!file || file.source !== 'social' || !(QUOTE_LOGO_TYPES as readonly string[]).includes(file.content_type) || Number(file.size_bytes) > QUOTE_LOGO_MAX_BYTES) return null;
  return { id: file.id, storageKey: file.storage_key, generation: file.generation, sha256: file.sha256, contentType: file.content_type, sizeBytes: Number(file.size_bytes) };
}

export const quoteLogoRemove = defineCommand({
  name: 'crm.quote_setting.logo_remove',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx): Promise<QuoteSetting> => {
    const userId = userOf(ctx.actor);
    await ctx.trx.updateTable('crove_crm.quote_setting').set({ logo_file_id: null, set_by: userId, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).execute();
    ctx.audit({ removed: true });
    return loadSetting(ctx);
  },
});

export const quoteSettingGet = defineQuery({
  name: 'crm.quote_setting.get',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<QuoteSetting> => loadSetting(ctx),
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
  sent_at: Date | string | null;
  sent_via: string | null;
  first_viewed_at: Date | string | null;
  buyer_name: string | null;
  buyer_tax_code: string | null;
  buyer_address: string | null;
  buyer_email: string | null;
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
      'q.sent_at',
      'q.sent_via',
      'q.first_viewed_at',
      'q.buyer_name',
      'q.buyer_tax_code',
      'q.buyer_address',
      'q.buyer_email',
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
    sentAt: r.sent_at === null ? null : iso(r.sent_at),
    sentVia: r.sent_via as QuoteSummary['sentVia'],
    firstViewedAt: r.first_viewed_at === null ? null : iso(r.first_viewed_at),
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

// The links of a quote, newest first, without any token: the database holds only its hash.
async function loadLinks(ctx: Reader, quoteId: string, now: Date): Promise<QuoteLinkSummary[]> {
  const rows = await ctx.trx
    .selectFrom('crove_crm.quote_link')
    .select(['id', 'created_at', 'expires_at', 'revoked_at', 'first_viewed_at', 'views'])
    .where('org_id', '=', ctx.orgId)
    .where('quote_id', '=', quoteId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(QUOTE_LINKS_MAX * 5)
    .execute();
  return rows.map((l) => ({
    id: l.id,
    createdAt: iso(l.created_at),
    expiresAt: iso(l.expires_at),
    revokedAt: l.revoked_at === null ? null : iso(l.revoked_at),
    firstViewedAt: l.first_viewed_at === null ? null : iso(l.first_viewed_at),
    views: l.views,
    live: l.revoked_at === null && new Date(l.expires_at).getTime() > now.getTime(),
  }));
}

export async function loadQuote(ctx: Reader, quoteId: string, now: Date = new Date()): Promise<Quote> {
  const row = await base(ctx).where('q.id', '=', quoteId).executeTakeFirst();
  if (!row) throw notFound();
  const buyer = row.buyer_name === null ? null : { name: row.buyer_name, taxCode: row.buyer_tax_code, address: row.buyer_address, email: row.buyer_email };
  return { ...summary(row, now), notes: row.remarks, terms: row.terms, buyer, lines: await loadLines(ctx, quoteId), links: await loadLinks(ctx, quoteId, now) };
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

// ---------------------------------------------------------------------------------------------------------------
// Sending (Q2, #2694)
// ---------------------------------------------------------------------------------------------------------------

// 32 random bytes, base64url: the format quote_link_view() accepts (QUOTE_TOKEN_PATTERN). The database keeps only the SHA-256.
export const newQuoteToken = (): string => randomBytes(32).toString('base64url');
export const quoteTokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const DAY_MS = 86_400_000;
// The table's CHECK allows a link 120 days from its making.
const LINK_MAX_DAYS = 119;

// A link to a sent quote: it opens until the quote's validity plus 30 days (never more than 119 days from now), and a quote keeps a few at once. The token is in the
// answer only. The caller holds the quote and has read that it is sent (or decided).
async function makeLink(ctx: CommandContext, quote: { id: string; valid_until: Date | string }, userId: string, options: { limit: boolean } = { limit: true }): Promise<QuoteLinkCreated> {
  const live = await ctx.trx
    .selectFrom('crove_crm.quote_link')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('org_id', '=', ctx.orgId)
    .where('quote_id', '=', quote.id)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', ctx.now)
    .executeTakeFirstOrThrow();
  if (options.limit && Number(live.n) >= QUOTE_LINKS_MAX) throw new DomainError('QUOTE_LINK_LIMIT', 409, `Báo giá này đã có ${QUOTE_LINKS_MAX} liên kết còn hạn; hãy thu hồi bớt`);
  const natural = new Date(`${addDays(day(quote.valid_until), QUOTE_LINK_DAYS_AFTER_VALID)}T23:59:59+07:00`).getTime();
  const expires = Math.min(natural, ctx.now.getTime() + LINK_MAX_DAYS * DAY_MS);
  if (expires <= ctx.now.getTime() + 60_000) throw new DomainError('QUOTE_LINK_EXPIRED', 409, 'Báo giá đã hết hạn từ lâu; hãy tạo bản sửa đổi rồi gửi lại');
  const token = newQuoteToken();
  const row = await ctx.trx
    .insertInto('crove_crm.quote_link')
    .values({ org_id: ctx.orgId, quote_id: quote.id, token_sha256: quoteTokenHash(token), expires_at: new Date(expires), created_by: userId, created_at: ctx.now })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { linkId: row.id, token, expiresAt: new Date(expires).toISOString(), path: `${QUOTE_PAGE_PATH}#${token}` };
}

const NOT_SENDABLE = 'Báo giá cần ít nhất một dòng hàng có giá và tổng tiền lớn hơn 0 trước khi gửi';

// A person sends a draft: it needs a priced line, a total above zero and a validity date that has not passed. The quote takes its number (a revision keeps the
// number of the quote it revises, which it replaces and whose links it revokes, and so the entity that issued that one), the buyer is copied from the customer as they are now,
// and the issuing entity of a new quote is the org's default (a number is unique within its entity, #2832). By email it also queues one mail, whose link is made when the mail is sent (a suppressed address refuses the whole send); by link the person makes the link next
// (crm.quote.create_link) and sends it in the chat. Nothing leaves without this click, and no agent can run it.
export const quoteSend = defineCommand({
  name: 'crm.quote.send',
  input: zQuoteSend,
  // It may queue a mail to a customer: a send, an effect outside Ludy (R2), always from a person's click.
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  target: (input) => ({ type: 'crm.quote', id: input.quoteId }),
  handler: async (ctx, input): Promise<QuoteSent> => {
    const userId = userOf(ctx.actor);
    const quote = await ctx.trx
      .selectFrom('crove_crm.quote')
      .select(['id', 'deal_id', 'party_id', 'status', 'valid_until', 'total', 'revises_id', 'revision'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.quoteId)
      .executeTakeFirst();
    if (!quote) throw notFound();
    if (quote.status !== 'draft') throw notDraft();
    const locked = await lockDraft(ctx, quote.id);
    if (!locked) throw notFound();
    if (locked.version !== input.version) throw stale();
    const items = await ctx.trx
      .selectFrom('crove_crm.quote_line')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('quote_id', '=', quote.id)
      .where('kind', '=', 'item')
      .executeTakeFirstOrThrow();
    if (Number(items.n) === 0 || money(quote.total).lessThanOrEqualTo(0)) throw new DomainError('QUOTE_NOT_SENDABLE', 422, NOT_SENDABLE);
    const today = vietnamToday(ctx.now);
    if (day(quote.valid_until) < today) throw new DomainError('QUOTE_VALIDITY_PAST', 422, 'Ngày hiệu lực đã qua; hãy chọn ngày hiệu lực mới rồi gửi');
    const party = await ctx.trx.selectFrom('crove_kernel.party').select(['name', 'tax_code', 'address', 'email']).where('org_id', '=', ctx.orgId).where('id', '=', quote.party_id).executeTakeFirst();
    if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy liên hệ hoặc công ty này');
    const recipient = (input.to ?? party.email ?? '').trim();
    if (input.via === 'email' && !PLAIN_ADDRESS.test(recipient)) {
      throw new DomainError('QUOTE_EMAIL_REQUIRED', 422, 'Khách hàng này chưa có email hợp lệ; hãy nhập email người nhận hoặc cập nhật hồ sơ khách hàng');
    }
    let issuer =
      (await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst()) ??
      (await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).orderBy('created_at').orderBy('id').executeTakeFirst());
    if (!issuer) throw new DomainError('QUOTE_ISSUER_MISSING', 422, 'Tổ chức chưa có pháp nhân để phát hành báo giá');
    let number: string;
    if (quote.revises_id) {
      const source = await ctx.trx.selectFrom('crove_crm.quote').select(['number', 'status', 'issuer_entity_id']).where('org_id', '=', ctx.orgId).where('id', '=', quote.revises_id).executeTakeFirst();
      if (!source?.number || (source.status !== 'sent' && source.status !== 'declined')) throw new DomainError('QUOTE_NOT_REVISABLE', 409, 'Báo giá gốc của bản sửa đổi này không còn gửi lại được');
      number = source.number;
      // The revision keeps the number, so it keeps the entity whose series gave it: with the default entity changed in between, the number would otherwise sit in another
      // entity's key and collide with a quote of that entity's own series.
      if (source.issuer_entity_id && source.issuer_entity_id !== issuer.id) {
        const sourceIssuer = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', source.issuer_entity_id).executeTakeFirst();
        if (sourceIssuer) issuer = sourceIssuer;
      }
    } else {
      // The kernel's gapless yearly series of this entity: one number for this quote, given back if the command fails.
      const allocated = await ctx.numbering.allocate({ legalEntityId: issuer.id, docType: 'crm.quote', documentDate: today, targetType: 'crm.quote', targetId: quote.id });
      const year = /^\d{4}/.test(allocated.periodKey) ? allocated.periodKey.slice(0, 4) : today.slice(0, 4);
      number = `BG-${year}-${String(allocated.number).padStart(4, '0')}`;
    }
    // The seller as the document will show it, frozen with the quote (#2826): a change to the letterhead later does not change a quote that was sent.
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['name', 'address']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const letterhead = await ctx.trx.selectFrom('crove_crm.quote_setting').select(['phone', 'email', 'bank_note', 'logo_file_id']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    const text = (value: string | null | undefined, max: number): string | null => {
      const trimmed = value?.trim() ?? '';
      return trimmed === '' ? null : trimmed.slice(0, max);
    };
    // The logo goes with them (#2814): the id of the org's logo as it is now if it is still an image the upload checks let in, else none. The marker says the snapshot was taken, so a quote
    // sent without a logo stays without one when the org adds one later.
    const logo = await logoFileOf(ctx, letterhead?.logo_file_id ?? null);
    await ctx.trx
      .updateTable('crove_crm.quote')
      .set({
        seller_name: text(issuer.name, 400) ?? text(org.name, 400) ?? 'Người bán',
        seller_tax_code: text(issuer.tax_code, 40),
        seller_address: text(org.address, 1000),
        seller_phone: text(letterhead?.phone, 40),
        seller_email: text(letterhead?.email, 254),
        seller_bank_note: text(letterhead?.bank_note, 500),
        seller_logo_file_id: logo?.id ?? null,
        seller_logo_frozen: true,
        status: 'sent',
        number,
        sent_at: ctx.now,
        sent_via: input.via,
        issuer_entity_id: issuer.id,
        buyer_name: party.name.slice(0, 400),
        buyer_tax_code: party.tax_code,
        buyer_address: party.address,
        // The address the mail goes to when the person typed one, else the customer's own.
        buyer_email: input.via === 'email' ? recipient : party.email,
        version: locked.version + 1,
        updated_by: userId,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', quote.id)
      .execute()
      // A number already taken in this entity (a reseeded series, say) is told apart from any other violation by the constraint's name.
      .catch((error: unknown) => {
        const { code, constraint } = error as { code?: string; constraint?: string };
        if (code === '23505' && constraint === 'quote_number_entity_uq') throw new DomainError('QUOTE_NUMBER_TAKEN', 409, 'Số báo giá này đã có trong pháp nhân; hãy thử lại');
        throw error;
      });
    let revoked = 0;
    if (quote.revises_id) {
      // The older quote is replaced, and no link of it opens any more.
      await ctx.trx.updateTable('crove_crm.quote').set({ status: 'superseded', updated_by: userId, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', quote.revises_id).execute();
      const links = await ctx.trx
        .updateTable('crove_crm.quote_link')
        .set({ revoked_at: ctx.now, revoked_by: userId })
        .where('org_id', '=', ctx.orgId)
        .where('quote_id', '=', quote.revises_id)
        .where('revoked_at', 'is', null)
        .returning('id')
        .execute();
      revoked = links.length;
    }
    let mail: 'queued' | null = null;
    let messageId: string | null = null;
    if (input.via === 'email') {
      // The merge data names the quote and holds no token: the template mints the link when the mail is sent (crm.quote.mail_data), so only its hash is ever stored.
      const total = money(quote.total).toFixed();
      const payload = zQuoteMail.parse({ lang: 'vi', org: issuer.name, number, revision: quote.revision, total, validUntil: day(quote.valid_until), quoteId: quote.id });
      const queued = await createMailMessage(ctx, {
        stream: 'transactional',
        source: QUOTE_MAIL_SOURCE,
        sourceId: quote.id,
        templateKey: QUOTE_MAIL_TEMPLATE,
        to: recipient,
        subject: `Báo giá ${number} của ${issuer.name}`.slice(0, 300),
        payload,
        status: 'queued',
      });
      // A blocked address refuses the whole send: the quote stays a draft.
      if (queued.status === 'suppressed') throw new DomainError('QUOTE_EMAIL_SUPPRESSED', 422, 'Địa chỉ email này đang bị chặn nên không gửi được báo giá; hãy dùng địa chỉ khác hoặc gửi bằng liên kết');
      mail = 'queued';
      messageId = queued.id;
    }
    ctx.audit({ quoteId: quote.id, dealId: quote.deal_id, partyId: quote.party_id, via: input.via, revision: quote.revision, supersedes: quote.revises_id, linksRevoked: revoked, messageId });
    await ctx.activity('kernel.party', quote.party_id, 'quote.sent', input.via === 'email' ? 'Gửi báo giá bằng email' : 'Gửi báo giá bằng liên kết');
    return { quote: await loadQuote(ctx, quote.id, ctx.now), mail };
  },
});

// What a quote mail being sent now needs beyond its merge data (the worker's mail template asks for it): a new link to the quote, made at send time, so the queue never
// holds a token. A quote that is no longer the current sent one (replaced, or decided) gets none and its mail is not sent. The link is made in the name of the person
// who sent the quote; a mail that is tried again makes another (a few at most, the queue's attempts), each opening only this quote and each revocable.
export const quoteMailData = defineCommand({
  name: 'crm.quote.mail_data',
  input: zQuoteRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ token: string | null }> => {
    const quote = await ctx.trx
      .selectFrom('crove_crm.quote')
      .select(['id', 'status', 'valid_until', 'updated_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.quoteId)
      // Held, so a revision sent in between cannot leave this link open on a replaced quote.
      .forShare()
      .executeTakeFirst();
    if (!quote || quote.status !== 'sent' || !quote.updated_by) return { token: null };
    try {
      return { token: (await makeLink(ctx, quote, quote.updated_by, { limit: false })).token };
    } catch (error) {
      // A quote whose validity ran out long ago has no link to make: the mail is not sent.
      if (error instanceof DomainError && error.code === 'QUOTE_LINK_EXPIRED') return { token: null };
      throw error;
    }
  },
});

// A link to a quote that was sent, for the person to send in the chat: the token comes back once and is kept nowhere.
export const quoteLinkCreate = defineCommand({
  name: 'crm.quote.create_link',
  input: zQuoteRef,
  risk: 'R2',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'crm.quote', id: input.quoteId }),
  handler: async (ctx, input): Promise<QuoteLinkCreated> => {
    const userId = userOf(ctx.actor);
    const quote = await ctx.trx.selectFrom('crove_crm.quote').select(['id', 'deal_id', 'party_id', 'status', 'valid_until']).where('org_id', '=', ctx.orgId).where('id', '=', input.quoteId).executeTakeFirst();
    if (!quote) throw notFound();
    if (quote.status !== 'sent') throw new DomainError('QUOTE_NOT_SENT', 409, 'Chỉ tạo được liên kết cho báo giá đã gửi và chưa có bản mới');
    // The quote row is held, so a revision sent in between cannot leave this link open on a replaced quote.
    await lockDraft(ctx, quote.id);
    const current = await ctx.trx.selectFrom('crove_crm.quote').select('status').where('org_id', '=', ctx.orgId).where('id', '=', quote.id).executeTakeFirst();
    if (current?.status !== 'sent') throw new DomainError('QUOTE_NOT_SENT', 409, 'Chỉ tạo được liên kết cho báo giá đã gửi và chưa có bản mới');
    const link = await makeLink(ctx, quote, userId);
    ctx.audit({ quoteId: quote.id, dealId: quote.deal_id, partyId: quote.party_id, linkId: link.linkId });
    return link;
  },
});

export const quoteLinkRevoke = defineCommand({
  name: 'crm.quote.revoke_link',
  input: zQuoteLinkRevoke,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<QuoteLinkRevoked> => {
    const userId = userOf(ctx.actor);
    const link = await ctx.trx.selectFrom('crove_crm.quote_link').select(['id', 'quote_id', 'revoked_at']).where('org_id', '=', ctx.orgId).where('id', '=', input.linkId).executeTakeFirst();
    if (!link) throw new DomainError('QUOTE_LINK_NOT_FOUND', 404, 'Không tìm thấy liên kết này');
    // Revoking twice is the same answer; only the first writes.
    if (link.revoked_at === null) {
      await ctx.trx.updateTable('crove_crm.quote_link').set({ revoked_at: ctx.now, revoked_by: userId }).where('org_id', '=', ctx.orgId).where('id', '=', link.id).where('revoked_at', 'is', null).execute();
      ctx.audit({ quoteId: link.quote_id, linkId: link.id });
    }
    return { linkId: link.id, revoked: true };
  },
});

// The refusal `crm.deal.delete` makes while the deal has a quote: a quote the customer holds is a document.
export async function dealHasQuotes(ctx: Pick<CommandContext, 'trx' | 'orgId'>, dealId: string): Promise<boolean> {
  const row = await ctx.trx.selectFrom('crove_crm.quote').select('id').where('org_id', '=', ctx.orgId).where('deal_id', '=', dealId).limit(1).executeTakeFirst();
  return row !== undefined;
}

export const quoteCommands = [quoteSave, quoteDeleteDraft, quoteRevise, quoteSend, quoteMailData, quoteLinkCreate, quoteLinkRevoke, quoteSettingSet, quoteLogoSet, quoteLogoRemove];
export const quoteQueries = [quoteGet, quoteList, dealQuotes, quoteDefaults, quoteSettingGet];
