// SPDX-License-Identifier: AGPL-3.0-only
// CRM quotes (issue #2693, plan docs/plan/crm-quotes.md section 4 and step Q1): a quote of a deal with its lines, saved by a person as a draft. Every amount and
// quantity is a decimal string, never a number; the totals are computed by the command from the lines (the rule of @crove/l10n-vn, the one an e-invoice draft
// uses), never taken from the caller.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The sets are the product's: the CHECK constraints of crove_crm.quote say the same (packages/db/test/check-unions.db.test.ts compares them).
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'superseded'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_SENT_VIA = ['link', 'email'] as const;
export const QUOTE_LINE_KINDS = ['item', 'text'] as const;
export type QuoteLineKind = (typeof QUOTE_LINE_KINDS)[number];

export const QUOTE_LINES_MAX = 100;
export const QUOTE_DESCRIPTION_MAX = 500;
export const QUOTE_UNIT_MAX = 30;
// The column holds 20 characters of a VAT rate as an invoice writes it; a rate typed without the percent sign gains one, so the input stops one short.
export const QUOTE_VAT_RATE_MAX = 20;
const QUOTE_VAT_RATE_INPUT_MAX = QUOTE_VAT_RATE_MAX - 1;
export const QUOTE_TEXT_MAX = 2000;
export const QUOTE_PAGE_SIZE = 50;
// How long a new quote stays valid: the org's setting, between the two, 14 until set.
export const QUOTE_VALID_DAYS_DEFAULT = 14;
export const QUOTE_VALID_DAYS_MIN = 7;
export const QUOTE_VALID_DAYS_MAX = 60;
// The VAT rate of a new line when the org has set none and no earlier quote to the customer names one.
export const QUOTE_DEFAULT_VAT = '10%';
// Earlier lines offered as price hints for a customer.
export const QUOTE_HINTS_MAX = 50;

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
// The columns' domains: quantity numeric(20,6), unit price numeric(24,8), a discount of at most two decimals.
const zQuantity = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, 'decimal string, at most six decimals');
const zUnitPrice = z.string().regex(/^\d{1,16}(\.\d{1,8})?$/, 'decimal string, at most eight decimals');
const zDiscount = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'decimal string, at most two decimals');
const zText = z.string().trim().max(QUOTE_TEXT_MAX);

export const zQuoteLineInput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('item'),
    description: z.string().trim().min(1).max(QUOTE_DESCRIPTION_MAX),
    unit: z.string().trim().min(1).max(QUOTE_UNIT_MAX).nullable().optional(),
    quantity: zQuantity,
    unitPrice: zUnitPrice,
    discountPercent: zDiscount.optional(),
    // As an invoice writes it ('10%', 'KCT'); the command checks it against the allowed set of @crove/l10n-vn.
    vatRate: z.string().trim().min(1).max(QUOTE_VAT_RATE_INPUT_MAX),
    // A stock item of Kế toán, by id only (no cross-module key): optional, empty on a free-text line.
    stockItemId: zId.nullable().optional(),
  }),
  z.strictObject({ kind: z.literal('text'), description: z.string().trim().min(1).max(QUOTE_DESCRIPTION_MAX) }),
]);
export type QuoteLineInput = z.infer<typeof zQuoteLineInput>;

// One call creates a draft from a deal (dealId, no quoteId: "Tạo báo giá" sends no lines) or saves the lines and fields of a draft (quoteId and the version the
// caller read, so a second person's save in between is refused instead of overwritten). `notes` is the free text printed on the quote.
export const zQuoteSave = z
  .strictObject({
    quoteId: zId.optional(),
    dealId: zId.optional(),
    version: z.number().int().min(1).optional(),
    validUntil: zDate.optional(),
    notes: zText.nullable().optional(),
    terms: zText.nullable().optional(),
    lines: z.array(zQuoteLineInput).max(QUOTE_LINES_MAX),
  })
  .superRefine((v, ctx) => {
    if (v.quoteId === undefined && v.dealId === undefined) ctx.addIssue({ code: 'custom', message: 'dealId or quoteId required', path: ['dealId'] });
    if (v.quoteId !== undefined && v.version === undefined) ctx.addIssue({ code: 'custom', message: 'version required to save a quote', path: ['version'] });
  });
export type QuoteSave = z.infer<typeof zQuoteSave>;

export const zQuoteRef = z.strictObject({ quoteId: zId });
export const zDealQuotesQuery = z.strictObject({ dealId: zId });
export const zQuoteDefaultsQuery = z.strictObject({ partyId: zId });
export const zQuoteListQuery = z.strictObject({
  dealId: zId.optional(),
  partyId: zId.optional(),
  status: z.enum(QUOTE_STATUSES).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.strictObject({ createdAt: z.iso.datetime(), id: zId }).optional(),
});
export const zQuoteSettingSet = z.strictObject({
  validDays: z.number().int().min(QUOTE_VALID_DAYS_MIN).max(QUOTE_VALID_DAYS_MAX),
  defaultVat: z.string().trim().min(1).max(QUOTE_VAT_RATE_INPUT_MAX),
  defaultTerms: zText.nullable(),
});

export const zQuoteLine = z.strictObject({
  lineNo: z.number().int(),
  kind: z.enum(QUOTE_LINE_KINDS),
  description: z.string(),
  unit: z.string().nullable(),
  quantity: z.string().nullable(),
  unitPrice: z.string().nullable(),
  discountPercent: z.string(),
  vatRate: z.string().nullable(),
  amount: z.string(),
  vatAmount: z.string(),
  stockItemId: z.string().nullable(),
});
export type QuoteLine = z.infer<typeof zQuoteLine>;

// A quote without its lines, for lists and the deal's tab. `number` is the number of the quote this one revises until it has its own (taken when sent, Q2);
// `expired` is derived from the validity date, never stored.
export const zQuoteSummary = z.strictObject({
  id: z.string(),
  dealId: z.string(),
  dealTitle: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  number: z.string().nullable(),
  revision: z.number().int(),
  revisesId: z.string().nullable(),
  status: z.enum(QUOTE_STATUSES),
  expired: z.boolean(),
  validUntil: z.string(),
  subtotal: z.string(),
  vatAmount: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  version: z.number().int(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type QuoteSummary = z.infer<typeof zQuoteSummary>;

export const zQuote = zQuoteSummary.extend({ notes: z.string().nullable(), terms: z.string().nullable(), lines: z.array(zQuoteLine) });
export type Quote = z.infer<typeof zQuote>;

export const zQuotePage = z.strictObject({ items: z.array(zQuoteSummary), next: z.strictObject({ createdAt: z.string(), id: z.string() }).nullable() });
export type QuotePage = z.infer<typeof zQuotePage>;
export const zQuoteDeleted = z.strictObject({ quoteId: z.string(), deleted: z.literal(true) });
export type QuoteDeleted = z.infer<typeof zQuoteDeleted>;

// What the editor starts from: the org's settings (or their defaults), the VAT rate last used on a quote to the customer, and the customer's earlier item lines
// (the latest of each description) for the "last sold price" default. Deterministic: no model.
export const zQuoteHint = z.strictObject({ description: z.string(), unit: z.string().nullable(), unitPrice: z.string(), vatRate: z.string(), quoteId: z.string() });
export type QuoteHint = z.infer<typeof zQuoteHint>;
export const zQuoteDefaults = z.strictObject({
  validDays: z.number().int(),
  defaultVat: z.string(),
  defaultTerms: z.string().nullable(),
  hints: z.array(zQuoteHint),
});
export type QuoteDefaults = z.infer<typeof zQuoteDefaults>;
export const zQuoteSetting = z.strictObject({ validDays: z.number().int(), defaultVat: z.string(), defaultTerms: z.string().nullable() });
export type QuoteSetting = z.infer<typeof zQuoteSetting>;
