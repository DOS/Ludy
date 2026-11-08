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
  // After it was sent (#2502): the number the provider gave, and the code of what stopped it (a rejection that sent it back to a draft, a failure), never a provider's text.
  issuedNumber: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export type EInvoiceDraft = z.infer<typeof zEInvoiceDraft>;

export const zEInvoiceDraftSummary = z.object({
  id: zId,
  state: z.string(),
  date: z.string(),
  buyerName: z.string().nullable(),
  total: z.string(),
  issueCount: z.number().int(),
  issuedNumber: z.string().nullable(),
  errorCode: z.string().nullable(),
  // The signed XML is stored with the draft (an issued invoice's original).
  evidenceStored: z.boolean(),
  // When it last changed: a request made for an earlier state is not the one to approve.
  updatedAt: z.string(),
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

// ---------------------------------------------------------------------------
// The connection to a provider (#2501, ADR-0044 point 2)
// ---------------------------------------------------------------------------

// What a connection test answers: a state, never the provider's own text. The same list the port (`@crove/einvoice`) and the database's CHECK keep.
export const EINVOICE_CONNECTION_STATES = ['works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable', 'signing_needs_person'] as const;
export type EInvoiceConnectionState = (typeof EINVOICE_CONNECTION_STATES)[number];

// A provider this deployment offers (`EINVOICE_SANDBOX` and, later, one entry per real adapter): its id, whether it is the offline one (no host, nothing sent), and the
// fields its connect form asks for (their names; the offline provider asks for none).
export const zEInvoiceProviderInfo = z.object({ id: z.string(), offline: z.boolean(), connectFields: z.array(z.string()) });
export type EInvoiceProviderInfo = z.infer<typeof zEInvoiceProviderInfo>;

// The seller's tax code as the entity keeps it: 10 digits, 10 and a branch suffix, or 12 digits.
export const zSellerTaxCode = z.string().regex(/^([0-9]{10}(-[0-9]{3})?|[0-9]{12})$/);

export const zEInvoiceConnection = z.object({
  id: zId,
  // The channel connection that holds the sealed credential. The credential itself is never in any answer.
  connectionId: zId,
  legalEntityId: zId,
  provider: z.string(),
  sellerTaxCode: z.string(),
  displayName: z.string(),
  status: z.enum(['active', 'expired', 'revoked', 'error']),
  lastTestState: z.enum(EINVOICE_CONNECTION_STATES).nullable(),
  lastTestedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type EInvoiceConnection = z.infer<typeof zEInvoiceConnection>;

// The names are the adapter's; each value is a secret the org typed once, sealed at the edge and never shown back.
export const zEInvoiceConnectFields = z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), z.string().min(1).max(500)).refine((fields) => Object.keys(fields).length <= 10);
export const zEInvoiceConnect = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9_]{0,21}$/),
  legalEntityId: zId.nullable(),
  // Left out, it is the entity's own tax code; the entity must have one.
  sellerTaxCode: zSellerTaxCode.nullable(),
  fields: zEInvoiceConnectFields,
});
export type EInvoiceConnect = z.infer<typeof zEInvoiceConnect>;

// Reading the provider's templates and series on a test: the template number and the symbol, as the provider holds them.
export const zEInvoiceTemplate = z.strictObject({
  templateNo: z.string().regex(/^[0-9]$/),
  symbol: z.string().regex(/^[CK][0-9]{2}[A-Z][A-Z0-9]{2}$/),
  description: z.string().max(200),
});
export type EInvoiceSeriesTemplate = z.infer<typeof zEInvoiceTemplate>;
export const zEInvoiceConnectionRecordTest = z.strictObject({
  id: zId,
  state: z.enum(EINVOICE_CONNECTION_STATES),
  templates: z.array(zEInvoiceTemplate).max(100),
});
export const zEInvoiceConnectionTested = z.object({ state: z.enum(EINVOICE_CONNECTION_STATES), added: z.number().int(), series: z.array(zEInvoiceSeries) });
export type EInvoiceConnectionTested = z.infer<typeof zEInvoiceConnectionTested>;

export const zEInvoiceSeriesSetDefault = z.strictObject({ seriesId: zId });

// Issuing a draft (ADR-0044 point 3, #2502): the request for approval and what it holds. The payload names the draft, the hash of everything it is issued from (the database
// computes it from the stored rows: einvoice_content_hash) and the total, so a draft changed after the request cannot be issued under it. No personal data: the card reads the
// draft itself.
export const EINVOICE_ISSUE_COMMAND = 'finance.einvoice.issue';
export const EINVOICE_ISSUE_KIND = 'finance.einvoice_issue';
export const zEInvoiceIssuePayload = z.strictObject({
  draftId: zId,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  // The draft's total, a decimal string: the database matches it against the draft's own at the approval.
  amount: z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,4})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  lineCount: z.number().int().min(1).max(EINVOICE_DRAFT_MAX_LINES),
});
export type EInvoiceIssuePayload = z.infer<typeof zEInvoiceIssuePayload>;

// What the Inbox card of a request to issue shows: the draft as it stands now, and whether it is still the one the request was made for (its content hash is the same).
export const zEInvoiceIssueView = z.object({
  draftId: zId,
  state: z.string(),
  date: z.string(),
  currency: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  buyerKind: z.string(),
  buyerName: z.string().nullable(),
  buyerTaxCode: z.string().nullable(),
  series: z.string().nullable(),
  // What the approval puts to the provider besides the total: every line and the VAT, as the draft holds them now.
  subtotal: z.string(),
  vatAmount: z.string(),
  lines: z.array(zEInvoiceDraftLine),
  // False once the draft was edited after the request, or has left `draft`: an approval then fails with EINVOICE_DRAFT_CHANGED.
  current: z.boolean(),
});
export type EInvoiceIssueView = z.infer<typeof zEInvoiceIssueView>;

// The finance coworker on a draft (#2505, plan einvoice-issue.md section 9). A person types or pastes a text about a sale and asks; the server reads which customers and which earlier VAT rates
// the model may see, asks the model outside any transaction through the AI budget meter, checks the answer in code, and gives back PROPOSALS that fill the form marked as the coworker's. Nothing is
// stored and nothing is issued: a person reads the whole draft, saves it, and the issue keeps its own approval.
export const EINVOICE_SUGGEST_TEXT_MAX = 2000;
export const zEInvoiceSuggestInput = z
  .strictObject({
    text: z.string().trim().min(1).max(EINVOICE_SUGGEST_TEXT_MAX),
    // The date of the invoice on the form: it decides which VAT rates are allowed.
    date: zLocalDate,
    // An issued invoice of the org that is part of the source (#2721, the previous invoice to the buyer): its lines go to the model with the text, so a figure it holds is a figure the
    // source holds. It must be an invoice to `buyerPartyId`, in the books of the form's legal entity (#2883); a draft that is not issued, another buyer's, another entity's or another org's is
    // refused (EINVOICE_DRAFT_NOT_FOUND).
    invoiceDraftId: zId.optional(),
    // The buyer the form is for, with `invoiceDraftId`.
    buyerPartyId: zId.optional(),
    // The legal entity of the form, as in zLegalEntityChoice: the default (or only visible) one when omitted.
    legalEntityId: zId.optional(),
  })
  .refine((v) => v.invoiceDraftId === undefined || v.buyerPartyId !== undefined, { message: 'buyerPartyId is required with invoiceDraftId', path: ['buyerPartyId'] });
export type EInvoiceSuggestInput = z.infer<typeof zEInvoiceSuggestInput>;

// ai: used (a proposal came), off (the deployment has no model), busy (too many asks at once), budget (the org's AI budget of the month is spent), failed (the call failed), refused (the answer
// held a figure or a VAT rate that the text or the date does not allow, or nothing usable). Without a proposal the form works as it does with AI off.
export const EINVOICE_SUGGEST_STATES = ['used', 'off', 'busy', 'budget', 'failed', 'refused'] as const;
export type EInvoiceSuggestState = (typeof EINVOICE_SUGGEST_STATES)[number];
// Where a line's VAT rate came from: the text states it, or it is the rate of earlier drafts (the customer's, else the org's), or none was found and the form's own default stands.
export const EINVOICE_VAT_FROM = ['text', 'earlier', 'default'] as const;
export const zEInvoiceSuggested = z.object({
  ai: z.enum(EINVOICE_SUGGEST_STATES),
  lines: z.array(zEInvoiceLineInput.extend({ vatFrom: z.enum(EINVOICE_VAT_FROM) })),
  // From the customer's own record (the name, the address and the tax code are never the model's); a tax code that fails its checksum is left out.
  buyer: zEInvoiceBuyerInput.nullable(),
});
export type EInvoiceSuggested = z.infer<typeof zEInvoiceSuggested>;

// The previous issued invoice to the same buyer (#2721), for a copy by code with no model: the buyer as that invoice held it and its lines, with whether each line's VAT rate is still one the
// date of the new invoice allows (`vatAllowed`; a rate that is not is the person's to choose, never carried silently). Only an invoice that was issued, in the books of an entity the caller may
// see; none gives `invoice: null`. The buyer's name, tax code, address and email are the party record's now (#2883), the invoice's own where the record has none; `legalEntityId` names the form's
// entity (the default one when omitted) and only that entity's invoices count.
export const zEInvoicePreviousInput = z.strictObject({ buyerPartyId: zId, date: zLocalDate, legalEntityId: zId.optional() });
export const zEInvoicePrevious = z.strictObject({
  invoice: z
    .strictObject({
      draftId: zId,
      date: z.string(),
      number: z.string().nullable(),
      buyer: zEInvoiceBuyerInput,
      lines: z.array(zEInvoiceLineInput.extend({ vatAllowed: z.boolean() })),
    })
    .nullable(),
});
export type EInvoicePrevious = z.infer<typeof zEInvoicePrevious>;
