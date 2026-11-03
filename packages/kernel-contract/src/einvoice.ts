// SPDX-License-Identifier: AGPL-3.0-only
// Sales e-invoice drafts and their series (#2500, ADR-0044): the shapes the finance commands and the "Hóa đơn bán ra" screen share. A draft
// carries no total, no amount and no VAT figure on the way in: they are computed from the lines by the server, and a caller that sends one
// is refused by the strict schema.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

export const BUYER_KINDS = ['business', 'individual', 'consumer'] as const;
export type BuyerKind = (typeof BUYER_KINDS)[number];

// The most lines a draft holds (the providers' own limits are 400 or fewer).
export const EINVOICE_DRAFT_MAX_LINES = 200;

// What a check can say about a draft; `field` names the place on the form: 'date', 'series', 'buyer.taxCode', 'lines.2.quantity' (the line's position from 1).
export const DRAFT_ISSUE_CODES = [
  'DATE_REQUIRED',
  'DATE_INVALID',
  'DATE_FUTURE',
  'CURRENCY_UNSUPPORTED',
  'SERIES_REQUIRED',
  'BUYER_TAX_CODE_REQUIRED',
  'BUYER_TAX_CODE_INVALID',
  'BUYER_TAX_CODE_CHECKSUM',
  'BUYER_NAME_REQUIRED',
  'BUYER_ADDRESS_REQUIRED',
  'BUYER_EMAIL_INVALID',
  'LINES_REQUIRED',
  'LINE_DESCRIPTION_REQUIRED',
  'LINE_QUANTITY_INVALID',
  'LINE_PRICE_INVALID',
  'LINE_VAT_RATE_INVALID',
  'TOTAL_TOO_LARGE',
] as const;
export type DraftIssueCode = (typeof DRAFT_ISSUE_CODES)[number];

export const zDraftIssue = z.object({ field: z.string(), code: z.enum(DRAFT_ISSUE_CODES) });
export type DraftIssue = z.infer<typeof zDraftIssue>;

const zText = (max: number) => z.string().trim().max(max);
const zDecimal = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);

export const zEInvoiceBuyerInput = z.strictObject({
  kind: z.enum(BUYER_KINDS),
  // A customer of the org, when the buyer was picked from them.
  partyId: zId.nullable(),
  taxCode: zText(20).nullable(),
  name: zText(400).nullable(),
  address: zText(500).nullable(),
  email: zText(254).nullable(),
});

export const zEInvoiceLineInput = z.strictObject({
  description: zText(500),
  unit: zText(50).nullable(),
  quantity: zDecimal,
  unitPrice: zDecimal,
  vatRate: zText(20),
});

// The form as the person holds it, without saving it (the live check): everything but the draft's identity.
export const zEInvoiceDraftForm = z.strictObject({
  date: zLocalDate,
  seriesId: zId.nullable(),
  buyer: zEInvoiceBuyerInput,
  lines: z.array(zEInvoiceLineInput).max(EINVOICE_DRAFT_MAX_LINES),
});
export type EInvoiceDraftForm = z.infer<typeof zEInvoiceDraftForm>;

// The live check takes what is typed so far: a quantity or a price that is not a number yet is answered with an issue on its field, not refused.
export const zEInvoiceDraftCheckInput = zEInvoiceDraftForm.extend({
  lines: z.array(zEInvoiceLineInput.extend({ quantity: z.string().max(40), unitPrice: z.string().max(40) })).max(EINVOICE_DRAFT_MAX_LINES),
});

export const zEInvoiceDraftSave = zEInvoiceDraftForm.extend({
  // The draft to replace; null makes a new one.
  draftId: zId.nullable(),
  legalEntityId: zId.nullable(),
});
export type EInvoiceDraftSave = z.infer<typeof zEInvoiceDraftSave>;

export const zEInvoiceDraftLine = z.object({
  lineNo: z.number().int(),
  description: z.string(),
  unit: z.string().nullable(),
  quantity: z.string(),
  unitPrice: z.string(),
  amount: z.string(),
  vatRate: z.string(),
  vatAmount: z.string(),
});
export type EInvoiceDraftLine = z.infer<typeof zEInvoiceDraftLine>;

export const zEInvoiceDraftCheck = z.object({
  lines: z.array(zEInvoiceDraftLine),
  subtotal: z.string(),
  vatAmount: z.string(),
  total: z.string(),
  issues: z.array(zDraftIssue),
});
export type EInvoiceDraftCheck = z.infer<typeof zEInvoiceDraftCheck>;

export const zEInvoiceDraft = z.object({
  id: zId,
  legalEntityId: zId,
  state: z.string(),
  seriesId: zId.nullable(),
  date: z.string(),
  currency: z.string(),
  buyer: z.object({
    kind: z.string(),
    partyId: zId.nullable(),
    taxCode: z.string().nullable(),
    name: z.string().nullable(),
    address: z.string().nullable(),
    email: z.string().nullable(),
  }),
  lines: z.array(zEInvoiceDraftLine),
  subtotal: z.string(),
  vatAmount: z.string(),
  total: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  issues: z.array(zDraftIssue),
});
export type EInvoiceDraft = z.infer<typeof zEInvoiceDraft>;

export const zEInvoiceDraftSummary = z.object({
  id: zId,
  state: z.string(),
  date: z.string(),
  buyerName: z.string().nullable(),
  total: z.string(),
  issueCount: z.number().int(),
});
export type EInvoiceDraftSummary = z.infer<typeof zEInvoiceDraftSummary>;

export const zEInvoiceSeries = z.object({
  id: zId,
  legalEntityId: zId,
  provider: z.string(),
  templateNo: z.string(),
  symbol: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
});
export type EInvoiceSeries = z.infer<typeof zEInvoiceSeries>;

export const zEInvoiceSeriesSync = z.strictObject({ legalEntityId: zId.nullable(), provider: z.literal('sandbox') });
export const zEInvoiceSeriesSynced = z.object({ added: z.number().int(), series: z.array(zEInvoiceSeries) });
export type EInvoiceSeriesSynced = z.infer<typeof zEInvoiceSeriesSynced>;

// What the deployment offers: whether the offline sandbox provider is on (EINVOICE_SANDBOX).
export const zEInvoiceStatus = z.object({ sandbox: z.boolean() });
