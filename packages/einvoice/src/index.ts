// SPDX-License-Identifier: AGPL-3.0-only
// The e-invoice port (port.ts) and its adapters: the offline sandbox here, MISA meInvoice in misa.ts (off until its gates are written, ADR-0044 point 7).
import { createHash } from 'node:crypto';
import { EInvoiceProviderError, type EInvoiceOutcome, type EInvoiceProvider, type EInvoiceRequest, type EInvoiceTemplate } from './port.ts';
import { fromMinor, toMinor } from './decimal.ts';
import { ADJUST_REPLACE_REASON_CODES, isReasonCode, type ReasonCode } from './reason-codes.ts';

export * from './port.ts';
export {
  MISA_BASE_URL,
  MISA_CONNECT_FIELDS,
  MISA_GATES,
  MISA_GATES_DONE,
  MISA_HOSTS,
  MISA_LIMITS,
  createMisaEInvoiceProvider,
  misaBlockers,
  type MisaOptions,
  type MisaRequest,
  type MisaResponse,
  type MisaTransport,
} from './misa.ts';
export * from './reason-codes.ts';

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
    ? `<TTHDLQuan><TCHDon>${original.kind === 'replacement' ? '1' : '2'}</TCHDon><KHMSHDCLQuan>${xmlText(original.templateNo)}</KHMSHDCLQuan><KHHDCLQuan>${xmlText(original.symbol)}</KHHDCLQuan><SHDCLQuan>${xmlText(original.number)}</SHDCLQuan><NLHDCLQuan>${xmlText(original.date)}</NLHDCLQuan><LDDCTThe>${xmlText(original.reasonCode)}</LDDCTThe></TTHDLQuan>`
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
    `<NMua><Ten>${xmlText(buyer.name)}</Ten><MST>${xmlText(buyer.taxCode)}</MST><DChi>${xmlText(buyer.address)}</DChi><DCTDTu>${xmlText(buyer.email)}</DCTDTu>${buyer.identity ? `<DDanh Loai="${buyer.identity.kind}"${buyer.identity.nationality ? ` QTich="${xmlText(buyer.identity.nationality)}"` : ''}>${xmlText(buyer.identity.value)}</DDanh>` : ''}</NMua>` +
    `<DSHHDVu>${lines}</DSHHDVu><TToan><THTTLTSuat>${rates}</THTTLTSuat><TgTCThue>${xmlText(request.subtotal)}</TgTCThue><TgTThue>${xmlText(request.vatAmount)}</TgTThue><TgTTTBSo>${xmlText(request.total)}</TgTTTBSo></TToan></NDHDon></DLHDon>` +
    `<MCCQT>${taxAuthorityCode}</MCCQT></HDon>`
  );
}

export interface SandboxOptions {
  // The codes an adjustment or a replacement may carry; the default is the data file's list (reason-codes.ts). A test passes its own.
  reasonCodes?: readonly ReasonCode[];
  // The wait of the `slow` behavior; the default is a timer, a test passes an instant one.
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function createSandboxEInvoiceProvider(options: SandboxOptions = {}): { provider: EInvoiceProvider; control: SandboxControl } {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const reasonCodes = options.reasonCodes ?? ADJUST_REPLACE_REASON_CODES.codes;
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
    // An adjustment or a replacement without a reason code of the list, or with an unknown one, is refused before anything is recorded (as the MISA adapter refuses it before any call).
    if (step !== 'issue' && !isReasonCode(request.original?.reasonCode, reasonCodes)) return { state: 'rejected', ref: null, code: 'invalid_data' };
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
    connectFields: [],
    capabilities: {
      cancel: false,
      draftCall: false,
      signing: 'provider_hsm',
      batchSize: 1,
      maxLinesPerInvoice: null,
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
