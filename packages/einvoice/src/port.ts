// SPDX-License-Identifier: AGPL-3.0-only
// E-invoice providers (ADR-0044 point 1): the adapters behind the finance module's issue port. The org brings its own account
// at a provider; the provider numbers, signs and obtains the tax authority's code, and Ludy keeps the draft, the state and the
// signed XML it fetched. A credential is sealed in the kernel's channel layer (ADR-0025) and handed to a provider call only by
// the worker; the port takes it as an opaque string and never logs it.
// There is no `cancel` on the port: e-invoice cancellation appears to be gone from the rules (plan einvoice-issue.md section 3,
// rule 7). Each adapter declares static capability data, its hosts and the retry safety of each step; the offline sandbox
// reaches no host.
export const EINVOICE_PROVIDERS = ['sandbox', 'misa'] as const;
export type EInvoiceProviderId = (typeof EINVOICE_PROVIDERS)[number];

export function isEInvoiceProvider(value: string): value is EInvoiceProviderId {
  return (EINVOICE_PROVIDERS as readonly string[]).includes(value);
}

// How a step may be repeated after an answer was lost: `safe` (a read), `idempotent` (the provider dedupes on Ludy's key) or
// `reconcile_only` (ask the provider for the key first, never send again blindly).
export type RetrySafety = 'safe' | 'idempotent' | 'reconcile_only';
export const EINVOICE_STEPS = ['testConnection', 'listTemplates', 'issue', 'status', 'files', 'adjust', 'replace'] as const;
export type EInvoiceStep = (typeof EINVOICE_STEPS)[number];

export interface EInvoiceCapabilities {
  // Always false: see the header.
  readonly cancel: false;
  // The provider has a draft call and an issue call (the adapter hides it behind the one `issue`).
  readonly draftCall: boolean;
  // Whether the signature is made by the provider (its HSM or remote certificate) or needs the seller's own token on a PC,
  // which is not a server path and is refused (ADR-0044 point 2).
  readonly signing: 'provider_hsm' | 'seller_token';
  // Invoices per call, and whether requests must be sequential per series.
  readonly batchSize: number;
  // Lines one invoice may carry (null: no limit known); an adapter refuses a longer one before anything is sent.
  readonly maxLinesPerInvoice: number | null;
  readonly sequentialPerSeries: boolean;
  readonly retry: Readonly<Record<EInvoiceStep, RetrySafety>>;
}

// What a connection test answers: a state, never the provider's own text.
export const CONNECTION_STATES = ['works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable', 'signing_needs_person'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

// A template and series the provider holds: the template number (one digit) and the symbol (six characters), read and
// displayed, never built by Ludy.
export interface EInvoiceTemplate {
  templateNo: string;
  symbol: string;
  description: string;
}

export type BuyerKind = 'business' | 'individual' | 'consumer';
// What an individual buyer may give instead of a tax code (#3678); the same list as the contract's and the database's CHECK.
export type BuyerIdentityKind = 'cccd' | 'passport' | 'budget_code';
export interface EInvoiceBuyer {
  kind: BuyerKind;
  taxCode: string | null;
  name: string | null;
  address: string | null;
  email: string | null;
  // An individual's CCCD, passport number or budget-relation unit code (#3678); personal data, never in a log or an audit fact.
  identity?: { kind: BuyerIdentityKind; value: string } | null;
}

// Amounts are decimal strings, computed by the caller's code; an adapter never recomputes them.
export interface EInvoiceLine {
  description: string;
  unit: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  vatRate: string;
  vatAmount: string;
}

// The original an adjustment or a replacement refers to.
export interface EInvoiceOriginal {
  kind: 'adjustment' | 'replacement';
  templateNo: string;
  symbol: string;
  number: string;
  date: string;
  // Why the original is adjusted or replaced: a code of the Appendix XVII list (reason-codes.ts), required by MISA from 2026-12-15 (#3571). An adapter refuses a missing or unknown
  // code as `invalid_data` before any call.
  reasonCode: string;
}

export interface EInvoiceRequest {
  // Ludy's idempotency key for the draft (a UUID), sent as the provider's own field where one exists.
  key: string;
  templateNo: string;
  symbol: string;
  date: string;
  currency: string;
  seller: { taxCode: string; name: string };
  buyer: EInvoiceBuyer;
  lines: readonly EInvoiceLine[];
  subtotal: string;
  vatAmount: string;
  total: string;
  original?: EInvoiceOriginal;
}

export const REJECT_CODES = ['invalid_data', 'series_unknown', 'rejected_by_tax_authority', 'provider_refused'] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export type EInvoiceOutcome =
  // Accepted by the provider and waiting for the tax authority.
  | { state: 'pending'; ref: string }
  // Numbered, signed and, for a coded invoice, carrying the tax authority's code.
  | { state: 'issued'; ref: string; number: string; signedAt: string; taxAuthorityCode: string | null }
  | { state: 'rejected'; ref: string | null; code: RejectCode };

// What `status` answers when the provider has no record under the key or the reference.
export type EInvoiceStatusAnswer = EInvoiceOutcome | { state: 'unknown' };

export interface EInvoiceFiles {
  // The signed XML, the original of the invoice.
  xml: Uint8Array;
  // The display copy; null when the provider has none.
  pdf: Uint8Array | null;
}

// A failure the caller maps to a state on screen, never to the provider's own text.
export const PROVIDER_ERROR_KINDS = ['unreachable', 'timeout', 'credentials', 'lost_answer', 'unavailable'] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export class EInvoiceProviderError extends Error {
  readonly kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind) {
    super(`e-invoice provider error: ${kind}`);
    this.name = 'EInvoiceProviderError';
    this.kind = kind;
  }
}

export interface EInvoiceProvider {
  readonly id: EInvoiceProviderId;
  // The hosts this adapter's fetch is bound to.
  readonly hosts: readonly string[];
  // The fields the org types to connect its own account (a user, a password, an app key): their names, in the order the form shows them. They are
  // sealed together at the edge and reach the adapter only as the opaque secret of a call; the offline sandbox needs none.
  readonly connectFields: readonly string[];
  readonly capabilities: EInvoiceCapabilities;
  testConnection(secret: string): Promise<ConnectionState>;
  listTemplates(secret: string): Promise<EInvoiceTemplate[]>;
  issue(secret: string, request: EInvoiceRequest): Promise<EInvoiceOutcome>;
  // By Ludy's key (and the provider's reference when known): the answer a retry asks before anything is sent again.
  status(secret: string, query: { key: string; ref: string | null }): Promise<EInvoiceStatusAnswer>;
  files(secret: string, ref: string): Promise<EInvoiceFiles>;
  adjust(secret: string, request: EInvoiceRequest & { original: EInvoiceOriginal }): Promise<EInvoiceOutcome>;
  replace(secret: string, request: EInvoiceRequest & { original: EInvoiceOriginal }): Promise<EInvoiceOutcome>;
}
