// SPDX-License-Identifier: AGPL-3.0-only
// E-invoice providers (ADR-0044 point 1): the adapters behind the finance module's issue port. The org brings its own account
// at a provider; the provider numbers, signs and obtains the tax authority's code, and Ludy keeps the draft, the state and the
// signed XML it fetched. A credential is sealed in the kernel's channel layer (ADR-0025) and handed to a provider call only by
// the worker; the port takes it as an opaque string and never logs it.
// There is no `cancel` on the port: e-invoice cancellation appears to be gone from the rules (plan einvoice-issue.md section 3,
// rule 7). Each adapter declares static capability data, its hosts and the retry safety of each step; the offline sandbox
// reaches no host.
import { createHash } from 'node:crypto';

export const EINVOICE_PROVIDERS = ['sandbox'] as const;
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
export interface EInvoiceBuyer {
  kind: BuyerKind;
  taxCode: string | null;
  name: string | null;
  address: string | null;
  email: string | null;
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

// ---------------------------------------------------------------------------
// The offline sandbox provider (ADR-0044 point 8)
// ---------------------------------------------------------------------------

// What the next `issue` call does. The default is `ok`.
export type SandboxBehavior =
  // Numbers, signs and answers `issued` at once.
  | 'ok'
  // Accepts and answers `pending`; `status` answers `pending` for `pendingPolls` calls and then `issued`.
  | 'pending'
  // Answers `rejected` and records nothing.
  | 'reject'
  // Records the invoice as issued but the answer never arrives: `issue` throws a `lost_answer` error, and `status` by the key
  // finds the invoice (so a retry that asks first sends nothing twice).
  | 'lose_answer'
  // Answers `issued` after `slowMs` (the injected wait).
  | 'slow';

export interface SandboxControl {
  // Queue behaviors: each `issue`, `adjust` or `replace` takes the next one, then `ok` again.
  script(...behaviors: SandboxBehavior[]): void;
  // The calls `status` answers `pending` for after a `pending` issue.
  pendingPolls: number;
  slowMs: number;
  // Every call the sandbox received, in order (never a credential).
  readonly calls: readonly string[];
}

interface Stored {
  ref: string;
  key: string;
  number: string;
  signedAt: string;
  taxAuthorityCode: string;
  xml: string;
  state: 'issued' | 'pending';
  pollsLeft: number;
}

const SANDBOX_TEMPLATES: readonly EInvoiceTemplate[] = [
  { templateNo: '1', symbol: 'C26TSB', description: 'Hóa đơn giá trị gia tăng (thử nghiệm)' },
  { templateNo: '2', symbol: 'C26TSM', description: 'Hóa đơn bán hàng (thử nghiệm)' },
];

const SANDBOX_SECRET = 'sandbox';

const xmlText = (value: string | null): string =>
  (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// The invoice as the tax authority's data format names its elements (the same ones the intake's parser reads): TTChung,
// NDHDon with the seller, the buyer, the lines and the totals per rate. The sandbox's "signature" is the absence of one: the
// intake reads the file and reports the signature unverified, which is what an offline provider means.
function sandboxXml(request: EInvoiceRequest, number: string, signedAt: string, taxAuthorityCode: string): string {
  const original = request.original;
  const related = original
    ? `<TTHDLQuan><TCHDon>${original.kind === 'replacement' ? '1' : '2'}</TCHDon><KHMSHDCLQuan>${xmlText(original.templateNo)}</KHMSHDCLQuan><KHHDCLQuan>${xmlText(original.symbol)}</KHHDCLQuan><SHDCLQuan>${xmlText(original.number)}</SHDCLQuan><NLHDCLQuan>${xmlText(original.date)}</NLHDCLQuan></TTHDLQuan>`
    : '';
  const lines = request.lines
    .map(
      (line, index) =>
        `<HHDVu><STT>${index + 1}</STT><THHDVu>${xmlText(line.description)}</THHDVu><DVTinh>${xmlText(line.unit)}</DVTinh><SLuong>${xmlText(line.quantity)}</SLuong><DGia>${xmlText(line.unitPrice)}</DGia><ThTien>${xmlText(line.amount)}</ThTien><TSuat>${xmlText(line.vatRate)}</TSuat></HHDVu>`,
    )
    .join('');
  const byRate = new Map<string, { taxable: bigint; vat: bigint }>();
  for (const line of request.lines) {
    const entry = byRate.get(line.vatRate) ?? { taxable: 0n, vat: 0n };
    entry.taxable += toMinor(line.amount);
    entry.vat += toMinor(line.vatAmount);
    byRate.set(line.vatRate, entry);
  }
  const rates = [...byRate.entries()]
    .map(([rate, e]) => `<LTSuat><TSuat>${xmlText(rate)}</TSuat><ThTien>${fromMinor(e.taxable)}</ThTien><TThue>${fromMinor(e.vat)}</TThue></LTSuat>`)
    .join('');
  const buyer = request.buyer;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<HDon><DLHDon><TTChung><THDon>Hóa đơn điện tử (thử nghiệm)</THDon><KHMSHDon>${xmlText(request.templateNo)}</KHMSHDon><KHHDon>${xmlText(request.symbol)}</KHHDon><SHDon>${number}</SHDon><NLap>${xmlText(request.date)}</NLap><DVTTe>${xmlText(request.currency)}</DVTTe>${related}</TTChung>` +
    `<NDHDon><NBan><Ten>${xmlText(request.seller.name)}</Ten><MST>${xmlText(request.seller.taxCode)}</MST></NBan>` +
    `<NMua><Ten>${xmlText(buyer.name)}</Ten><MST>${xmlText(buyer.taxCode)}</MST><DChi>${xmlText(buyer.address)}</DChi><DCTDTu>${xmlText(buyer.email)}</DCTDTu></NMua>` +
    `<DSHHDVu>${lines}</DSHHDVu><TToan><THTTLTSuat>${rates}</THTTLTSuat><TgTCThue>${xmlText(request.subtotal)}</TgTCThue><TgTThue>${xmlText(request.vatAmount)}</TgTThue><TgTTTBSo>${xmlText(request.total)}</TgTTTBSo></TToan></NDHDon></DLHDon>` +
    `<MCCQT>${taxAuthorityCode}</MCCQT></HDon>`
  );
}

// Decimal strings with at most 8 fractional digits as integers of 1e-8, so the per-rate sums of the sandbox's XML are exact.
function toMinor(value: string): bigint {
  const match = /^(-?)(\d{1,16})(?:\.(\d{1,8}))?$/.exec(value);
  if (!match) throw new EInvoiceProviderError('unavailable');
  const whole = BigInt(match[2] ?? '0') * 100_000_000n + BigInt((match[3] ?? '').padEnd(8, '0'));
  return match[1] === '-' ? -whole : whole;
}

function fromMinor(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const whole = abs / 100_000_000n;
  const fraction = (abs % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

export interface SandboxOptions {
  // The wait of the `slow` behavior; the default is a timer, a test passes an instant one.
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function createSandboxEInvoiceProvider(options: SandboxOptions = {}): { provider: EInvoiceProvider; control: SandboxControl } {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const queue: SandboxBehavior[] = [];
  const calls: string[] = [];
  const byKey = new Map<string, Stored>();
  const byRef = new Map<string, Stored>();
  const counters = new Map<string, number>();
  const control: SandboxControl = {
    script: (...behaviors) => {
      queue.push(...behaviors);
    },
    pendingPolls: 2,
    slowMs: 50,
    calls,
  };

  const checkSecret = (secret: string): void => {
    if (secret !== SANDBOX_SECRET) throw new EInvoiceProviderError('credentials');
  };

  const outcome = (stored: Stored): EInvoiceOutcome =>
    stored.state === 'issued'
      ? { state: 'issued', ref: stored.ref, number: stored.number, signedAt: stored.signedAt, taxAuthorityCode: stored.taxAuthorityCode }
      : { state: 'pending', ref: stored.ref };

  // A call being worked on, by key: a second call with the same key while the first waits (the `slow` behavior) is the same invoice, answered with the first's answer.
  const inflight = new Map<string, Promise<EInvoiceOutcome>>();

  async function submit(secret: string, step: 'issue' | 'adjust' | 'replace', request: EInvoiceRequest): Promise<EInvoiceOutcome> {
    checkSecret(secret);
    calls.push(`${step}:${request.key}`);
    // The same key is the same invoice: the provider dedupes on it, as the real ones that have such a field do. A repeat takes no scripted behavior.
    const existing = byKey.get(request.key);
    if (existing) return outcome(existing);
    const running = inflight.get(request.key);
    if (running) return running;
    const run = work(request, queue.shift() ?? 'ok');
    inflight.set(request.key, run);
    try {
      return await run;
    } finally {
      inflight.delete(request.key);
    }
  }

  async function work(request: EInvoiceRequest, behavior: SandboxBehavior): Promise<EInvoiceOutcome> {
    if (!SANDBOX_TEMPLATES.some((t) => t.templateNo === request.templateNo && t.symbol === request.symbol)) return { state: 'rejected', ref: null, code: 'series_unknown' };
    if (behavior === 'reject') return { state: 'rejected', ref: null, code: 'rejected_by_tax_authority' };
    if (behavior === 'slow') await wait(control.slowMs);
    const seriesKey = `${request.templateNo}/${request.symbol}`;
    const next = (counters.get(seriesKey) ?? 0) + 1;
    counters.set(seriesKey, next);
    const number = String(next).padStart(7, '0');
    const signedAt = now().toISOString();
    const hash = createHash('sha256').update(`${request.key}:${number}`).digest('hex').toUpperCase();
    const taxAuthorityCode = `SB${hash.slice(0, 32)}`;
    const ref = `sbx-${hash.slice(0, 12).toLowerCase()}`;
    const stored: Stored = {
      ref,
      key: request.key,
      number,
      signedAt,
      taxAuthorityCode,
      xml: sandboxXml(request, number, signedAt, taxAuthorityCode),
      state: behavior === 'pending' ? 'pending' : 'issued',
      pollsLeft: behavior === 'pending' ? control.pendingPolls : 0,
    };
    byKey.set(request.key, stored);
    byRef.set(ref, stored);
    if (behavior === 'lose_answer') throw new EInvoiceProviderError('lost_answer');
    return outcome(stored);
  }

  const provider: EInvoiceProvider = {
    id: 'sandbox',
    hosts: [],
    capabilities: {
      cancel: false,
      draftCall: false,
      signing: 'provider_hsm',
      batchSize: 1,
      sequentialPerSeries: false,
      retry: { testConnection: 'safe', listTemplates: 'safe', issue: 'idempotent', status: 'safe', files: 'safe', adjust: 'idempotent', replace: 'idempotent' },
    },
    testConnection: async (secret) => {
      calls.push('testConnection');
      return secret === SANDBOX_SECRET ? 'works' : 'wrong_credentials';
    },
    listTemplates: async (secret) => {
      checkSecret(secret);
      calls.push('listTemplates');
      return SANDBOX_TEMPLATES.map((t) => ({ ...t }));
    },
    issue: (secret, request) => submit(secret, 'issue', request),
    status: async (secret, query) => {
      checkSecret(secret);
      calls.push(`status:${query.key}`);
      const stored = byKey.get(query.key) ?? (query.ref ? byRef.get(query.ref) : undefined);
      if (!stored) return { state: 'unknown' };
      if (stored.state === 'pending') {
        if (stored.pollsLeft > 0) stored.pollsLeft -= 1;
        if (stored.pollsLeft === 0) stored.state = 'issued';
      }
      return outcome(stored);
    },
    files: async (secret, ref) => {
      checkSecret(secret);
      calls.push(`files:${ref}`);
      const stored = byRef.get(ref);
      if (!stored || stored.state !== 'issued') throw new EInvoiceProviderError('unavailable');
      return { xml: new TextEncoder().encode(stored.xml), pdf: null };
    },
    adjust: (secret, request) => submit(secret, 'adjust', request),
    replace: (secret, request) => submit(secret, 'replace', request),
  };
  return { provider, control };
}

export const SANDBOX_EINVOICE_SECRET = SANDBOX_SECRET;
