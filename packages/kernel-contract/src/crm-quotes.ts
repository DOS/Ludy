// SPDX-License-Identifier: AGPL-3.0-only
// CRM quotes (docs/plan/crm-quotes.md, slice 2, step Q1, #2693): a quote is made from a deal, holds priced lines and is a draft until a later step sends it.
// Quantities, prices and amounts are decimal strings, never numbers. The amounts of a line and the totals are computed by the server (and are not input), by
// the one rule of `@crove/l10n-vn` `totalLines`.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'superseded'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_LINE_KINDS = ['item', 'text'] as const;
export type QuoteLineKind = (typeof QUOTE_LINE_KINDS)[number];

// The VAT rates of a line, written as an invoice writes them (the same set as `LINE_VAT_RATES` of @crove/l10n-vn).
export const QUOTE_VAT_RATES = ['10%', '8%', '5%', '0%', 'KCT', 'KKKNT'] as const;
export type QuoteVatRate = (typeof QUOTE_VAT_RATES)[number];

export const QUOTE_LINES_MAX = 100;
export const QUOTE_DESCRIPTION_MAX = 500;
export const QUOTE_UNIT_MAX = 50;
export const QUOTE_TEXT_MAX = 2000;
export const QUOTE_LIST_MAX = 100;
// The days a quote stays valid, the org's setting: between the two, 14 until set. The VAT rate of a new line: 10% until set.
export const QUOTE_VALID_DAYS_DEFAULT = 14;
export const QUOTE_VALID_DAYS_MIN = 7;
export const QUOTE_VALID_DAYS_MAX = 60;
export const QUOTE_VAT_DEFAULT: QuoteVatRate = '10%';

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
// numeric(20,6) and numeric(24,8): the same domains as a sales e-invoice draft's lines, so a line copies to one with no rounding.
export const zQuoteQuantity = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, 'decimal string, at most six decimals');
export const zQuoteUnitPrice = z.string().regex(/^\d{1,16}(\.\d{1,8})?$/, 'decimal string, at most eight decimals');
export const zQuoteDiscount = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'decimal string, at most two decimals')
  .refine((v) => Number(v) <= 100, 'at most 100');
export const zQuoteVatRate = z.enum(QUOTE_VAT_RATES);

// What a person writes on a line. No amount and no VAT amount: a caller that sends one is refused by the strict schema.
export const zQuoteLineInput = z.strictObject({
  kind: z.enum(QUOTE_LINE_KINDS),
  description: z.string().trim().max(QUOTE_DESCRIPTION_MAX),
  unit: z.string().trim().min(1).max(QUOTE_UNIT_MAX).nullable(),
  quantity: zQuoteQuantity,
  unitPrice: zQuoteUnitPrice,
  discountPercent: zQuoteDiscount,
  vatRate: zQuoteVatRate,
  // A stock item of Kế toán, named only when the line was picked from it; no foreign key, finance matches it (the plan, 6.2).
  stockItemId: zId.nullable().optional(),
});
export type QuoteLineInput = z.infer<typeof zQuoteLineInput>;

export const zQuoteLine = z.object({
  lineNo: z.number().int().min(1),
  kind: z.enum(QUOTE_LINE_KINDS),
  description: z.string(),
  unit: z.string().nullable(),
  quantity: z.string(),
  unitPrice: z.string(),
  discountPercent: z.string(),
  vatRate: zQuoteVatRate,
  amount: z.string(),
  vatAmount: z.string(),
  stockItemId: z.string().nullable(),
});
export type QuoteLine = z.infer<typeof zQuoteLine>;

// Makes a draft from a deal (`dealId`), or replaces the lines and fields of a draft (`quoteId` and the version the editor read). Both may leave out the
// validity (the org's days from today) and the terms (the org's default terms on a new draft).
export const zQuoteSave = z
  .strictObject({
    dealId: zId.optional(),
    quoteId: zId.optional(),
    version: z.number().int().min(1).optional(),
    validUntil: zDate.optional(),
    notes: z.string().trim().max(QUOTE_TEXT_MAX).optional(),
    terms: z.string().trim().max(QUOTE_TEXT_MAX).optional(),
    lines: z.array(zQuoteLineInput).max(QUOTE_LINES_MAX),
  })
  .refine((v) => (v.dealId === undefined) !== (v.quoteId === undefined), { message: 'name either dealId (a new draft) or quoteId (an edit)' })
  .refine((v) => (v.quoteId === undefined) === (v.version === undefined), { message: 'an edit names the version it read, a new draft names none' });
export type QuoteSave = z.infer<typeof zQuoteSave>;

export const zQuoteRef = z.strictObject({ quoteId: zId });
export const zQuoteVersionRef = z.strictObject({ quoteId: zId, version: z.number().int().min(1) });
export const zQuoteDeleted = z.object({ quoteId: zId, deleted: z.literal(true) });

export const zQuoteSummary = z.object({
  id: z.string(),
  dealId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  number: z.string().nullable(),
  revision: z.number().int().min(1),
  status: z.enum(QUOTE_STATUSES),
  // A sent quote whose validity has passed: shown as expired, never stored.
  expired: z.boolean(),
  validUntil: z.string(),
  total: z.string(),
  currency: z.literal('VND'),
  lineCount: z.number().int().min(0),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type QuoteSummary = z.infer<typeof zQuoteSummary>;

export const zQuote = zQuoteSummary.extend({
  dealTitle: z.string(),
  revisionOf: z.string().nullable(),
  notes: z.string(),
  terms: z.string(),
  subtotal: z.string(),
  vatAmount: z.string(),
  lines: z.array(zQuoteLine),
});
export type Quote = z.infer<typeof zQuote>;

export const zQuoteListQuery = z.strictObject({
  dealId: zId.optional(),
  partyId: zId.optional(),
  status: z.enum(QUOTE_STATUSES).optional(),
  limit: z.number().int().min(1).max(QUOTE_LIST_MAX).optional(),
  cursor: z.strictObject({ createdAt: z.string(), id: zId }).optional(),
});
export type QuoteListQuery = z.infer<typeof zQuoteListQuery>;

export const zQuotePage = z.object({ items: z.array(zQuoteSummary), next: z.object({ createdAt: z.string(), id: z.string() }).nullable() });
export type QuotePage = z.infer<typeof zQuotePage>;

export const zQuoteDealRef = z.strictObject({ dealId: zId });

// The org's quote setting: how long a quote stays valid, the VAT rate of a new line and the terms a new draft starts with.
export const zQuoteSettingSet = z.strictObject({
  validDays: z.number().int().min(QUOTE_VALID_DAYS_MIN).max(QUOTE_VALID_DAYS_MAX),
  defaultVat: zQuoteVatRate,
  defaultTerms: z.string().trim().max(QUOTE_TEXT_MAX),
});
export type QuoteSettingSet = z.infer<typeof zQuoteSettingSet>;

export const zQuoteSetting = zQuoteSettingSet.extend({
  // False while the org has set none: the product's defaults apply.
  isSet: z.boolean(),
});
export type QuoteSetting = z.infer<typeof zQuoteSetting>;
