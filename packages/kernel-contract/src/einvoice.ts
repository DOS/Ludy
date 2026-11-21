// SPDX-License-Identifier: AGPL-3.0-only
// Sales e-invoice drafts and their series (#2500, ADR-0044): the shapes the finance commands and the "Hóa đơn bán ra" screen share. A draft
// carries no total, no amount and no VAT figure on the way in: they are computed from the lines by the server, and a caller that sends one
// is refused by the strict schema.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

export const BUYER_KINDS = ['business', 'individual', 'consumer'] as const;
export type BuyerKind = (typeof BUYER_KINDS)[number];

// What an individual buyer may give instead of a tax code (Decree 123/2020 as read in plan einvoice-issue.md section 3a, row 4): the personal ID number (CCCD, 12 digits), a passport
// number or the code of a unit with a budget relation (7 digits), one at a time. Personal data (class `national_id` in the finance manifest); the shapes are checked, never the person.
export const BUYER_IDENTITY_KINDS = ['cccd', 'passport', 'budget_code'] as const;
export type BuyerIdentityKind = (typeof BUYER_IDENTITY_KINDS)[number];

// The most lines a draft holds (the providers' own limits are 400 or fewer).
export const EINVOICE_DRAFT_MAX_LINES = 200;

// What a person says a correction is about (#3709, research E row 7): it decides which VAT rate the correcting invoice keeps. A correction that changes no amount, a return and a trade discount set
// later keep the rate of the original ("original" basis); an error in quantity or price that changes the amount and the VAT uses the rate in force on the correction date.
export const EINVOICE_RATE_NATURES = ['no_amount_change', 'return', 'trade_discount', 'amount_change'] as const;
export type EInvoiceRateNature = (typeof EINVOICE_RATE_NATURES)[number];
// The day the 8% of a correction's lines is judged on: the original's date, or the correction's own (the draft's sale or invoice date).
export const EINVOICE_RATE_BASES = ['original', 'correction_date'] as const;
export type EInvoiceRateBasis = (typeof EINVOICE_RATE_BASES)[number];

// What a check can say about a draft; `field` names the place on the form: 'date', 'series', 'buyer.taxCode', 'lines.2.quantity' (the line's position from 1).
export const DRAFT_ISSUE_CODES = [
  'DATE_REQUIRED',
  'DATE_INVALID',
  'DATE_FUTURE',
  'SALE_DATE_INVALID',
  'SALE_DATE_AFTER_INVOICE',
  'LATE_REASON_REQUIRED',
  'CURRENCY_UNSUPPORTED',
  'SERIES_REQUIRED',
  'BUYER_TAX_CODE_REQUIRED',
  'BUYER_TAX_CODE_INVALID',
  'BUYER_TAX_CODE_CHECKSUM',
  'BUYER_NAME_REQUIRED',
  'BUYER_ADDRESS_REQUIRED',
  'BUYER_EMAIL_INVALID',
  'BUYER_IDENTITY_INVALID',
  // A passport carries the buyer's nationality (Decree 254 Appendix point 4.b; #3709): required with it, two capital letters (ISO 3166-1 alpha-2).
  'BUYER_NATIONALITY_REQUIRED',
  'BUYER_NATIONALITY_INVALID',
  'LINES_REQUIRED',
  'LINE_DESCRIPTION_REQUIRED',
  'LINE_QUANTITY_INVALID',
  'LINE_PRICE_INVALID',
  'LINE_VAT_RATE_INVALID',
  // 8% on a date outside the periods the reduced rate applied (REDUCED_RATE_PERIODS), judged on the sale date, or the invoice date when it has none; an adjustment or a replacement is judged on the original's.
  'LINE_VAT_RATE_REDUCED_OUTSIDE_PERIOD',
  'TOTAL_TOO_LARGE',
] as const;
export type DraftIssueCode = (typeof DRAFT_ISSUE_CODES)[number];

export const zDraftIssue = z.object({ field: z.string(), code: z.enum(DRAFT_ISSUE_CODES) });
export type DraftIssue = z.infer<typeof zDraftIssue>;

const zText = (max: number) => z.string().trim().max(max);
const zDecimal = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
// A unit price may be signed: the difference of an adjusting invoice is a decrease with a minus (the checks refuse a minus on any other invoice).
const zSignedDecimal = z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/);

// `nationality` (#3709): the ISO 3166-1 alpha-2 code of a foreign buyer, two capital letters (the limit here is wider so a wrong length is answered by the check, not a bare 422). A passport carries one and nothing else does (the server drops it from any other kind); it is checked as a
// field of the draft, so a draft that still lacks it is shown with the issue and the save refuses it with EINVOICE_BUYER_NATIONALITY_REQUIRED (422) or EINVOICE_BUYER_NATIONALITY_INVALID (422).
export const zEInvoiceBuyerIdentity = z.strictObject({ kind: z.enum(BUYER_IDENTITY_KINDS), value: zText(20), nationality: zText(10).nullable().default(null) });
export type EInvoiceBuyerIdentity = z.infer<typeof zEInvoiceBuyerIdentity>;

export const zEInvoiceBuyerInput = z.strictObject({
  kind: z.enum(BUYER_KINDS),
  // A customer of the org, when the buyer was picked from them.
  partyId: zId.nullable(),
  taxCode: zText(20).nullable(),
  name: zText(400).nullable(),
  address: zText(500).nullable(),
  email: zText(254).nullable(),
  // For an individual buyer only (the server clears it for any other kind): one of CCCD, passport or budget code. Optional.
  identity: zEInvoiceBuyerIdentity.nullable().default(null),
});

export const zEInvoiceLineInput = z.strictObject({
  description: zText(500),
  unit: zText(50).nullable(),
  quantity: zDecimal,
  unitPrice: zSignedDecimal,
  vatRate: zText(20),
});

// The form as the person holds it, without saving it (the live check): everything but the draft's identity.
export const zEInvoiceDraftForm = z.strictObject({
  // The date the invoice is issued and printed.
  date: zLocalDate,
  // The moment of the sale (Decree 254 Art. 9), when it is not the invoice's day (#3535); null is "the same day". A sale issued after the next working day is a late invoice
  // and needs the person's reason; the sale stays in the VAT period of its own date.
  saleDate: zLocalDate.nullable().default(null),
  lateReason: zText(500).nullable().default(null),
  seriesId: zId.nullable(),
  buyer: zEInvoiceBuyerInput,
  lines: z.array(zEInvoiceLineInput).max(EINVOICE_DRAFT_MAX_LINES),
});
export type EInvoiceDraftForm = z.infer<typeof zEInvoiceDraftForm>;

// The live check takes what is typed so far: a quantity or a price that is not a number yet is answered with an issue on its field, not refused.
export const zEInvoiceDraftCheckInput = zEInvoiceDraftForm.extend({
  lines: z.array(zEInvoiceLineInput.extend({ quantity: z.string().max(40), unitPrice: z.string().max(40) })).max(EINVOICE_DRAFT_MAX_LINES),
  // The form of an adjusting or a replacing invoice (#2504): an adjustment may carry a negative price, and the VAT rate of a correction is judged on its original's date. Omitted for any other draft.
  // `rateBasis` is the basis the person confirmed for the VAT rate (#3709): the 8% is judged on the original's date ('original', and when absent) or on the draft's own ('correction_date').
  correction: z.strictObject({ kind: z.enum(['adjustment', 'replacement']), originalDraftId: zId, rateBasis: z.enum(EINVOICE_RATE_BASES).nullable().default(null) }).nullable().default(null),
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
  // The sale is later invoiced than its next working day (#3535): the warning on the form, with the fine that goes with it.
  lateSale: z.boolean(),
});
export type EInvoiceDraftCheck = z.infer<typeof zEInvoiceDraftCheck>;

export const EINVOICE_CORRECTION_KINDS = ['adjustment', 'replacement'] as const;
export type EInvoiceCorrectionKind = (typeof EINVOICE_CORRECTION_KINDS)[number];

export const zEInvoiceCorrection = z.object({
  kind: z.enum(EINVOICE_CORRECTION_KINDS),
  originalDraftId: zId,
  reasonCode: z.string(),
  agreementFileId: zId.nullable(),
  // The basis the person confirmed for the VAT rate (#3709); null on a correction made before it existed, which is judged on the original's date as it always was.
  rateBasis: z.enum(EINVOICE_RATE_BASES).nullable().default(null),
});
export type EInvoiceCorrection = z.infer<typeof zEInvoiceCorrection>;

// Starts a correcting draft from an issued invoice (#2504): "Điều chỉnh" or "Thay thế". The original's series, number and date are read from its stored row. The reason code is one of
// Appendix XVII (refused while the list is empty); a buyer with a tax code needs the signed agreement file, an individual buyer none. EINVOICE_DRAFT_NOT_FOUND (404),
// EINVOICE_ORIGINAL_NOT_ISSUED, EINVOICE_ORIGINAL_REPLACED, EINVOICE_CORRECTION_METHOD, EINVOICE_CORRECTION_OPEN (409), EINVOICE_REASON_CODE_INVALID, EINVOICE_AGREEMENT_REQUIRED (422),
// EINVOICE_AGREEMENT_FILE_NOT_FOUND (404). `rateNature` is what the person says the correction is about and `rateBasis` the basis the screen proposed and they confirmed (#3709): the command works the
// basis out from the nature itself and refuses a different one with EINVOICE_RATE_BASIS_MISMATCH (422), so a stale screen cannot confirm a wrong rate.
export const zEInvoiceStartCorrection = z.strictObject({
  originalDraftId: zId,
  kind: z.enum(EINVOICE_CORRECTION_KINDS),
  reasonCode: z.string().trim().min(1).max(50),
  agreementFileId: zId.nullable().default(null),
  rateNature: z.enum(EINVOICE_RATE_NATURES),
  rateBasis: z.enum(EINVOICE_RATE_BASES),
});
export type EInvoiceStartCorrection = z.infer<typeof zEInvoiceStartCorrection>;

// What the screen needs to start a correction (#2504): the reason codes of Appendix XVII, with their Vietnamese labels. Empty until the list is entered (reason-codes.ts), and the screen
// then says why a correction cannot start.
export const zEInvoiceCorrectionOptions = z.object({
  reasonCodes: z.array(z.object({ code: z.string(), label: z.string() })),
});
export type EInvoiceCorrectionOptions = z.infer<typeof zEInvoiceCorrectionOptions>;

// The VAT rate a correction proposes for the nature a person picked (#3709), worked out by code (modules/finance domain/einvoice-correction-rate.ts), never by a model. `changes` lists each rate of the
// original's lines that the proposal moves (8% to 10%); empty when every rate is kept. `reason` is the fixed Vietnamese sentence the screen shows when no coworker explains it, and `precedentNote`
// names Official Letter 2121/TCT-CS while no guidance for the 2026 to 2027 changeover exists (null when the rate is simply kept). `correctionDate` is the day the proposal was worked out on.
export const EINVOICE_RATE_REASONS = ['kept_no_change', 'kept_return', 'kept_trade_discount', 'amount_change_no_reduced', 'amount_change_still_reduced', 'amount_change_standard'] as const;
export type EInvoiceRateReason = (typeof EINVOICE_RATE_REASONS)[number];
export const zEInvoiceCorrectionRateInput = z.strictObject({ originalDraftId: zId, nature: z.enum(EINVOICE_RATE_NATURES) });
export type EInvoiceCorrectionRateInput = z.infer<typeof zEInvoiceCorrectionRateInput>;
export const zEInvoiceCorrectionRate = z.object({
  nature: z.enum(EINVOICE_RATE_NATURES),
  basis: z.enum(EINVOICE_RATE_BASES),
  originalDate: z.string(),
  correctionDate: z.string(),
  reasonCode: z.enum(EINVOICE_RATE_REASONS),
  changes: z.array(z.strictObject({ from: z.string(), to: z.string() })),
  // The distinct rates of the original's lines that the proposal keeps, and the last day the 8% rate applied (the explanation is told both).
  kept: z.array(z.string()),
  reducedUntil: z.string(),
  reason: z.string(),
  precedentNote: z.string().nullable(),
});
export type EInvoiceCorrectionRate = z.infer<typeof zEInvoiceCorrectionRate>;

// The same proposal for the screen: `explanation` is the accounting coworker's plain Vietnamese explanation of it (packages/agent, through the AI budget meter), or null; `ai` says why there is none
// ('off': no model on this deployment; 'busy': the member asks too often; 'budget': the AI budget is spent; 'failed': the call failed; 'refused': the answer named something the facts do not).
// The rate and the basis are the code's whatever `ai` says, and the person confirms by starting the correction.
export const EINVOICE_RATE_EXPLAIN_STATES = ['used', 'off', 'busy', 'budget', 'failed', 'refused'] as const;
export const zEInvoiceCorrectionRateExplained = zEInvoiceCorrectionRate.extend({
  ai: z.enum(EINVOICE_RATE_EXPLAIN_STATES),
  explanation: z.string().nullable(),
});
export type EInvoiceCorrectionRateExplained = z.infer<typeof zEInvoiceCorrectionRateExplained>;

// The accounting coworker's proposal of the reason code of an adjusting or a replacing invoice (#3690, the AI part of #2504). The person describes the error (`note`, never stored or logged); the code
// the coworker proposes is one of Appendix XVII's list (packages/einvoice reason-codes.ts) by number, checked in code, and the person confirms it by starting the correction, which checks it again.
// `ai` says why there is no proposal: 'no_list' (the list of codes is empty, nothing to propose), 'no_note' (nothing was described), 'off' (no model on this deployment), 'busy' (the member asks too often),
// 'budget' (the AI budget is spent), 'failed' (the call failed) or 'refused' (the answer was not one of the list or stated what the facts do not hold). With any of them the form works as it does with AI off.
export const zEInvoiceReasonInput = z.strictObject({ originalDraftId: zId, kind: z.enum(['adjustment', 'replacement']), note: z.string().trim().max(600) });
export type EInvoiceReasonInput = z.infer<typeof zEInvoiceReasonInput>;
// What the model may see of the original, read in the member's own transaction (finance.einvoice.reason_source): the list, the buyer's kind and the lines without a price or an amount. No name, address,
// tax code, email or ID of the buyer.
export const zEInvoiceReasonSourceInput = z.strictObject({ originalDraftId: zId });
export const zEInvoiceReasonSource = z.object({
  codes: z.array(z.object({ code: z.string(), label: z.string() })),
  buyerKind: z.enum(BUYER_KINDS),
  originalDate: z.string(),
  lines: z.array(z.object({ description: z.string(), unit: z.string().nullable(), quantity: z.string(), vatRate: z.string() })),
});
export type EInvoiceReasonSource = z.infer<typeof zEInvoiceReasonSource>;
export const EINVOICE_REASON_STATES = ['used', 'no_list', 'no_note', 'off', 'busy', 'budget', 'failed', 'refused'] as const;
export const zEInvoiceReasonSuggested = z.object({
  ai: z.enum(EINVOICE_REASON_STATES),
  code: z.string().nullable(),
  label: z.string().nullable(),
  why: z.string().nullable(),
});
export type EInvoiceReasonSuggested = z.infer<typeof zEInvoiceReasonSuggested>;

export const zEInvoiceDraft = z.object({
  id: zId,
  legalEntityId: zId,
  state: z.string(),
  seriesId: zId.nullable(),
  date: z.string(),
  saleDate: z.string().nullable(),
  lateReason: z.string().nullable(),
  lateSale: z.boolean(),
  currency: z.string(),
  buyer: z.object({
    kind: z.string(),
    partyId: zId.nullable(),
    taxCode: z.string().nullable(),
    name: z.string().nullable(),
    address: z.string().nullable(),
    email: z.string().nullable(),
    identity: zEInvoiceBuyerIdentity.nullable(),
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
  // Set on an adjusting or a replacing invoice (#2504): the issued draft it corrects, the method, the reason code and the agreement file; null on an ordinary invoice.
  correction: zEInvoiceCorrection.nullable().default(null),
});
export type EInvoiceDraft = z.infer<typeof zEInvoiceDraft>;

export const zEInvoiceDraftSummary = z.object({
  id: zId,
  state: z.string(),
  date: z.string(),
  buyerName: z.string().nullable(),
  // The identity the buyer gave, masked (the kind and the last three characters): a list never shows the whole value.
  buyerIdentity: z.strictObject({ kind: z.enum(BUYER_IDENTITY_KINDS), masked: z.string() }).nullable(),
  total: z.string(),
  issueCount: z.number().int(),
  issuedNumber: z.string().nullable(),
  errorCode: z.string().nullable(),
  // The signed XML is stored with the draft (an issued invoice's original).
  evidenceStored: z.boolean(),
  // When it last changed: a request made for an earlier state is not the one to approve.
  updatedAt: z.string(),
  // The buyer's kind: a business buyer needs the signed agreement before a correction (#2504).
  buyerKind: z.enum(BUYER_KINDS),
  // Set on an adjusting or a replacing invoice (#2504): its method and the issued draft it corrects.
  correction: z.strictObject({ kind: z.enum(EINVOICE_CORRECTION_KINDS), originalDraftId: zId }).nullable().default(null),
  // On an issued invoice: the method of the first correction that was issued for it, so the screen offers only that one for the next (#2504); null when none was issued.
  correctedBy: z.enum(EINVOICE_CORRECTION_KINDS).nullable().default(null),
  // On an issued invoice: it was replaced, so it is no longer in force and nothing corrects it (#2504).
  replaced: z.boolean().default(false),
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

// What a connection test answers: a state, never the provider's own text. The same list the port (`@ludy/einvoice`) and the database's CHECK keep.
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
  // The draft's total, a decimal string: the database matches it against the draft's own at the approval. Negative for an adjusting invoice that lowers the original (#2504).
  amount: z.string().regex(/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,4})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  lineCount: z.number().int().min(1).max(EINVOICE_DRAFT_MAX_LINES),
});
export type EInvoiceIssuePayload = z.infer<typeof zEInvoiceIssuePayload>;

// What the Inbox card of a request to issue shows: the draft as it stands now, and whether it is still the one the request was made for (its content hash is the same).
export const zEInvoiceIssueView = z.object({
  draftId: zId,
  state: z.string(),
  date: z.string(),
  // A sale of an earlier day than the invoice (#3535), and the reason the person gave when the invoice is late: what an approver sees before the invoice is signed.
  saleDate: z.string().nullable().default(null),
  lateReason: z.string().nullable().default(null),
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
  // The sales orders (crm.sales_order) whose lines this draft invoices, each once, in the order of their first line (#2849, ADR-0050 point 2): ids only, so the card can ask Engage whether one was
  // cancelled and say so. Advisory: finance reads no CRM table and the approval does not depend on it.
  sourceOrderIds: z.array(zId),
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
    // The customer the form already names (#2713): a line the text states no VAT rate for takes the usual rate of THIS customer's earlier drafts (else the org's), whichever customer the coworker picked from
    // the text, so the rate history is the one of the buyer the form keeps. Not the previous-invoice source above (`buyerPartyId`, which may be another customer). Unknown, another org's or a merged
    // (duplicate) customer is the same as none.
    formBuyerPartyId: zId.optional(),
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
