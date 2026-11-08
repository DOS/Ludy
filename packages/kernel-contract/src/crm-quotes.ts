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
// A link to a sent quote lives until the quote's validity plus these days (the table's CHECK allows 120 days from the link's making), and a quote keeps at most
// this many links at once.
export const QUOTE_LINK_DAYS_AFTER_VALID = 30;
export const QUOTE_LINKS_MAX = 20;
export const QUOTE_BANK_NOTE_MAX = 500;
export const QUOTE_PHONE_MAX = 40;
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
// The org's defaults and the letterhead its quotes print (phone, email, a free bank note); an empty letterhead field prints nothing.
export const zQuoteSettingSet = z.strictObject({
  validDays: z.number().int().min(QUOTE_VALID_DAYS_MIN).max(QUOTE_VALID_DAYS_MAX),
  defaultVat: z.string().trim().min(1).max(QUOTE_VAT_RATE_INPUT_MAX),
  defaultTerms: zText.nullable(),
  phone: z.string().trim().max(QUOTE_PHONE_MAX).nullable().optional(),
  email: z.string().trim().max(254).nullable().optional(),
  bankNote: z.string().trim().max(QUOTE_BANK_NOTE_MAX).nullable().optional(),
});
// A person sends a draft, by a link they copy or by an email the system queues (to the given address, else the customer's); the version is the one they read.
export const zQuoteSend = z.strictObject({
  quoteId: zId,
  version: z.number().int().min(1),
  via: z.enum(QUOTE_SENT_VIA),
  to: z.string().trim().max(254).optional(),
});
export const zQuoteLinkRevoke = z.strictObject({ linkId: zId });

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
  // When and how the quote was sent, and the first time the customer opened a link (null until then).
  sentAt: z.string().nullable(),
  sentVia: z.enum(QUOTE_SENT_VIA).nullable(),
  firstViewedAt: z.string().nullable(),
  version: z.number().int(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type QuoteSummary = z.infer<typeof zQuoteSummary>;

// A link to a sent quote: no token (the database keeps only its hash), how often it was opened, and whether it still opens.
export const zQuoteLinkSummary = z.strictObject({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  firstViewedAt: z.string().nullable(),
  views: z.number().int(),
  live: z.boolean(),
});
export type QuoteLinkSummary = z.infer<typeof zQuoteLinkSummary>;
// The buyer as it was when the quote was sent (null on a draft): editing the contact later does not rewrite it.
export const zQuoteBuyer = z.strictObject({ name: z.string(), taxCode: z.string().nullable(), address: z.string().nullable(), email: z.string().nullable() });
export const zQuote = zQuoteSummary.extend({
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  buyer: zQuoteBuyer.nullable(),
  lines: z.array(zQuoteLine),
  links: z.array(zQuoteLinkSummary),
});
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
export const zQuoteSetting = z.strictObject({
  validDays: z.number().int(),
  defaultVat: z.string(),
  defaultTerms: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  bankNote: z.string().nullable(),
});
export type QuoteSetting = z.infer<typeof zQuoteSetting>;

// What a send answers: the quote as it now stands, and whether a mail was queued (by email only; a suppressed address refuses the whole send).
export const zQuoteSent = z.strictObject({ quote: zQuote, mail: z.literal('queued').nullable() });
export type QuoteSent = z.infer<typeof zQuoteSent>;
// A link just made: the token is in this answer and nowhere else (the person copies it); `path` is the page it opens on this deployment.
export const zQuoteLinkCreated = z.strictObject({ linkId: z.string(), token: z.string(), expiresAt: z.string(), path: z.string() });
export type QuoteLinkCreated = z.infer<typeof zQuoteLinkCreated>;
export const zQuoteLinkRevoked = z.strictObject({ linkId: z.string(), revoked: z.literal(true) });
export type QuoteLinkRevoked = z.infer<typeof zQuoteLinkRevoked>;

// The public document of a quote (crm.quote_link_view): one quote and the seller's letterhead, nothing else of the org. Amounts are decimal strings.
export interface QuoteDocument {
  number: string;
  revision: number;
  status: QuoteStatus;
  expired: boolean;
  validUntil: string;
  sentAt: string;
  notes: string | null;
  terms: string | null;
  subtotal: string;
  vatAmount: string;
  total: string;
  seller: { name: string; taxCode: string | null; address: string | null; phone: string | null; email: string | null; bankNote: string | null };
  buyer: { name: string; taxCode: string | null; address: string | null };
  lines: { lineNo: number; kind: QuoteLineKind; description: string; unit: string | null; quantity: string | null; unitPrice: string | null; discountPercent: string; vatRate: string | null; amount: string; vatAmount: string }[];
}
// The token of a public link: 32 random bytes in base64url, 43 characters.
export const QUOTE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Where the page of a link is: the token stays after the # and goes to the API in a POST body only.
export const QUOTE_PAGE_PATH = '/-/quote';

// Dy's proposal for the lines of a quote (#2698, plan docs/plan/crm-quotes.md section 7): a read, never stored. ai: used (a proposal came), off (the deployment has no model), busy (too many
// asks at once), budget (the org's AI budget of the month is spent), failed (the call failed), refused (the answer held a figure, link or VAT rate no source holds, or nothing usable),
// words_off (the org's switch for AI on customers' words is off, so nothing was sent to the model), no_text (the customer has written nothing that may be read). Without a proposal the editor works as
// it does with AI off. A line's price is empty when no source holds one; priceFrom says where a price came from.
export const QUOTE_SUGGEST_STATES = ['used', 'off', 'busy', 'budget', 'failed', 'refused', 'words_off', 'no_text'] as const;
export type QuoteSuggestState = (typeof QUOTE_SUGGEST_STATES)[number];
export const QUOTE_PRICE_FROM = ['earlier', 'message', 'deal'] as const;
export const zQuoteSuggestInput = z.strictObject({ dealId: zId });
export type QuoteSuggestInput = z.infer<typeof zQuoteSuggestInput>;
export const zQuoteSuggestedLine = z.strictObject({
  description: z.string().min(1).max(QUOTE_DESCRIPTION_MAX),
  unit: z.string().max(QUOTE_UNIT_MAX).nullable(),
  quantity: z.string(),
  unitPrice: z.string().nullable(),
  priceFrom: z.enum(QUOTE_PRICE_FROM).nullable(),
  vatRate: z.string().max(QUOTE_VAT_RATE_MAX).nullable(),
});
export const zQuoteSuggested = z.strictObject({ ai: z.enum(QUOTE_SUGGEST_STATES), lines: z.array(zQuoteSuggestedLine) });
export type QuoteSuggested = z.infer<typeof zQuoteSuggested>;

// The "Báo giá" tab of the Reports screen (#2699): how many quotes are in each status and what they are worth, over the last 30, 90 or 365 days (by the day each was
// made) or ever (null). Every amount is a decimal string the server summed; the app never adds numbers. `sent` is the quotes that left `draft` and were not replaced by a
// revision (sent, accepted and declined): a revised quote counts once.
export const QUOTE_REPORT_DAYS = [30, 90, 365] as const;
export const zQuoteReportQuery = z.strictObject({ days: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).optional() });
export type QuoteReportQuery = z.infer<typeof zQuoteReportQuery>;
export const zQuoteReportFigure = z.strictObject({ count: z.number().int(), total: z.string() });
export const zQuoteReport = z.strictObject({
  days: z.number().int().nullable(),
  sent: zQuoteReportFigure,
  byStatus: z.array(zQuoteReportFigure.extend({ status: z.enum(QUOTE_STATUSES) })),
});
export type QuoteReport = z.infer<typeof zQuoteReport>;
