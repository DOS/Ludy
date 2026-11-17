// SPDX-License-Identifier: AGPL-3.0-only
// The MISA meInvoice adapter (#2503, ADR-0044): one adapter behind the e-invoice port, built from MISA's own developer document only (developer.misa.vn, the meInvoice
// API; every field, code and limit below is from that document, and the tests replay answers shaped by it: nothing here calls MISA). It is OFF: a deployment that names
// `misa` in EINVOICE_PROVIDERS is refused until the issues in MISA_GATES are done and written in the issue (misaBlockers).
//
// What it does: a token from the app credentials plus the seller's tax code, user and password; the connection test (the account must hold a remote signing certificate);
// the templates and series; issue with Ludy's key as the provider's RefID and the provider's HSM signing (SignType 2 only); status by RefID; the signed XML and the PDF;
// adjustment and replacement with the original named. It never calls the USB-token or local-signing endpoints (the document's /publishing/token and the local signing tool):
// a seller whose certificate lives on a USB token has no certificate in the account's remote list, and the connection test answers `signing_needs_person`.
//
// The credential is the opaque secret of the port (the JSON of the fields the org typed, sealed at the edge); it is read here and never logged, stored or returned. The
// token is held in memory only, per credential. Amounts are the decimal strings the caller computed, written into the request as exact numbers, never through a JS number.
import { createHash } from 'node:crypto';
import { fromMinor, toMinor } from './decimal.ts';
import { MISA_BUYER_IDENTITY_FIELDS } from './buyer-identity.ts';
import { ADJUST_REPLACE_REASON_CODES, isReasonCode, type ReasonCode } from './reason-codes.ts';
import {
  EInvoiceProviderError,
  type ConnectionState,
  type EInvoiceFiles,
  type EInvoiceOriginal,
  type EInvoiceOutcome,
  type EInvoiceProvider,
  type EInvoiceRequest,
  type EInvoiceStatusAnswer,
  type EInvoiceTemplate,
  type RejectCode,
} from './port.ts';

export const MISA_BASE_URL = 'https://developer.misa.vn/apis/itg/meinvoice';
export const MISA_HOSTS = ['developer.misa.vn'] as const;

// The limits of the document, as data: invoices per publishing request, lines per invoice, and sequential requests per series.
export const MISA_LIMITS = { batchSize: 30, maxLinesPerInvoice: 400 } as const;

// What the owner must have done before `misa` may be named: the issues stay refused until they are done and written in the issue (issue #2503). Each entry is turned off by
// adding its number to MISA_GATES_DONE in a PR that links the issue comment that says it is done; nothing else enables the adapter.
export const MISA_GATES = [
  { issue: 2506, what: 'a person who can read the primary text checked the plan against Decree 254/2026 and Circular 91/2026' },
  { issue: 2507, what: 'the owner finished the MISA registration and click-through acceptance for the production app' },
] as const;
export const MISA_GATES_DONE: readonly number[] = [];

export function misaBlockers(done: readonly number[] = MISA_GATES_DONE): readonly { issue: number; what: string }[] {
  return MISA_GATES.filter((gate) => !done.includes(gate.issue));
}

// One call to MISA, as the transport carries it. The transport is bound to MISA_HOSTS and https (the kernel's guarded egress); it rejects with an EInvoiceProviderError:
// `unreachable` when nothing was sent, `timeout` or `lost_answer` when the request may have reached MISA.
export interface MisaRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string | null;
}
export interface MisaResponse {
  status: number;
  body: string;
}
export type MisaTransport = (request: MisaRequest) => Promise<MisaResponse>;

export interface MisaOptions {
  transport: MisaTransport;
  now?: () => Date;
  // The codes an adjustment or a replacement may carry; the default is the data file's list (reason-codes.ts). A test passes its own.
  reasonCodes?: readonly ReasonCode[];
}

// The fields the org types to connect, in the order the form shows them. ClientID and ClientSecret are the app's (issued by MISA to the owner's developer app).
export const MISA_CONNECT_FIELDS = ['clientId', 'clientSecret', 'taxCode', 'username', 'password'] as const;

interface Credentials {
  clientId: string;
  clientSecret: string;
  taxCode: string;
  username: string;
  password: string;
}

function parseCredentials(secret: string): Credentials {
  let raw: unknown;
  try {
    raw = JSON.parse(secret);
  } catch {
    throw new EInvoiceProviderError('credentials');
  }
  if (typeof raw !== 'object' || raw === null) throw new EInvoiceProviderError('credentials');
  const out: Record<string, string> = {};
  for (const name of MISA_CONNECT_FIELDS) {
    const value = (raw as Record<string, unknown>)[name];
    if (typeof value !== 'string' || value.trim() === '') throw new EInvoiceProviderError('credentials');
    out[name] = value.trim();
  }
  return out as unknown as Credentials;
}

// ---------------------------------------------------------------------------
// The answer, read
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

// The document writes the envelope's names in both casings (Success / success), so a field is read without regard to case.
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
function pick(obj: unknown, name: string): unknown {
  if (!isObj(obj)) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(obj)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

// A list the document gives either as an array or as a JSON string of one (publishInvoiceResult is the second).
function listOf(value: unknown): Obj[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.filter(isObj) : [];
}

interface Envelope {
  httpStatus: number;
  success: boolean;
  code: string | null;
  data: unknown;
  custom: unknown;
  publish: unknown;
}

function readEnvelope(response: MisaResponse): Envelope | null {
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    return null;
  }
  if (!isObj(json)) return null;
  return { httpStatus: response.status, success: pick(json, 'success') === true, code: text(pick(json, 'errorCode')), data: pick(json, 'data'), custom: pick(json, 'customData'), publish: pick(json, 'publishInvoiceResult') };
}

const TOKEN_REFUSED = new Set(['UnAuthorize', 'TokenExpiredCode', 'InvalidTokenCode']);

// How an error code of the publishing steps ends an invoice (the document's table): the data is wrong, the series is not the account's, or MISA refuses. A code the
// document does not list is null: it is not read as a refusal, the caller asks for the key first.
const REFUSED = new Set([
  'ExistsInvoiceNextYear', 'InActiveAppID', 'DeclarationNotExist', 'InvalidDeclaration', 'ExistDeclarationNotReceive', 'InvoiceTemplateNotValidInDeclaration', 'CallSignServiceFail',
  'SignSoftDream78Exception', 'SignEsignHSMError', 'APINotSupportTypeInvoice', 'CertRevocation', 'InvalidCertByRegistration', 'HasRegistrationStopUseCert', 'SigningTimeNotInRegistration',
  'InvalidSignature', 'SignatureEmpty', 'X509SubjectName', 'X509Certificate', 'InvoiceCannotReplace', 'InvoiceCannotAdjust', 'InvoiceCannotReplaceByStatusNew', 'HasAdjustmentInvoice', 'TaxReductionDateInValid',
]);
function rejectionFor(code: string): RejectCode | null {
  if (code === 'TemplateNotExist' || code === 'InvoiceTemplateNotExist') return 'series_unknown';
  const data = ['InvalidInvoiceData', 'InvalidTaxCode', 'InvalidInvoiceDate', 'InvalidInvNo', 'InvalidXMLData', 'InvalidXMLContainEmoji', 'TaxRateInfo_VATRateName', 'BuyerTaxCode_TaxCodeInvalid', 'XMLTooLong', 'InvoiceQuantityTooLarge'];
  if (data.includes(code) || code.startsWith('InvoiceDetail_') || code.startsWith('RequireError_') || code.startsWith('StockInTaxCode_')) return 'invalid_data';
  if (REFUSED.has(code) || code.startsWith('LicenseInfo_')) return 'provider_refused';
  return null;
}

// The document's own retry list ("Các trường hợp gặp mã lỗi cần retry"): parallel requests on one series, or a gap in the numbers.
const RETRY = new Set(['InvoiceDuplicated', 'InvoiceNumberNotCotinuous']);
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// The request, written
// ---------------------------------------------------------------------------

// An exact number in the JSON text: a decimal string checked here, written without quotes and never through a JS number.
class Num {
  readonly text: string;
  constructor(value: string) {
    this.text = value;
  }
}
const DECIMAL = /^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/;
const num = (value: string): Num => new Num(value);

function json(value: unknown): string {
  if (value instanceof Num) return value.text;
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`;
  if (isObj(value)) return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${json(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

const fractionDigits = (value: string): number => value.split('.')[1]?.length ?? 0;
const SERIES = /^[1-9][CK]\d{2}[TM][A-Z]{2}$/;
const SYMBOL = /^[CK]\d{2}[TM][A-Z]{2}$/;

// The document's names for a rate: KCT, KKKNT, 0%, 5%, 8%, 10% and KHAC:x% for any other. Null when the rate is not one of those shapes.
function rateName(raw: string): string | null {
  const value = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (value === 'KCT' || value === 'KKKNT') return value;
  const other = /^KHAC:(\d{1,2}(?:\.\d{1,2})?)%$/.exec(value);
  if (other?.[1]) return `KHAC:${other[1]}%`;
  const match = /^(\d{1,2}(?:\.\d{1,2})?)%?$/.exec(value);
  if (!match || match[1] === undefined) return null;
  const rate = String(Number(match[1]));
  return ['0', '5', '8', '10'].includes(rate) ? `${rate}%` : `KHAC:${match[1]}%`;
}

type Refusal = 'invalid_data' | 'series_unknown';

// The invoice as MISA's InvoiceData, or why it is refused before anything is sent: a currency other than VND (the document's exchange-rate fields are not built), too many
// lines, a series that is not MISA's shape, an amount that is not an exact decimal, a rate the document has no name for.
function invoiceData(request: EInvoiceRequest, series: string, original: EInvoiceOriginal | null, kind: 'adjustment' | 'replacement' | null, reasonCodes: readonly ReasonCode[]): Obj | Refusal {
  if (request.currency !== 'VND') return 'invalid_data';
  // An adjustment or a replacement carries a reason code of the list (#3571); without one, or with an unknown one, nothing is sent.
  if (original && kind && !isReasonCode(original.reasonCode, reasonCodes)) return 'invalid_data';
  // A buyer's identity (#3678) goes in the field the data file names for its kind; with no name yet it is refused rather than dropped.
  const identityField = request.buyer.identity ? MISA_BUYER_IDENTITY_FIELDS[request.buyer.identity.kind] : null;
  if (request.buyer.identity && identityField === null) return 'invalid_data';
  if (request.lines.length === 0 || request.lines.length > MISA_LIMITS.maxLinesPerInvoice) return 'invalid_data';
  if (!/^[1-9]$/.test(request.templateNo) || !SYMBOL.test(request.symbol) || !SERIES.test(series)) return 'series_unknown';
  if (![request.subtotal, request.vatAmount, request.total].every((v) => DECIMAL.test(v))) return 'invalid_data';
  const byRate = new Map<string, { taxable: bigint; vat: bigint }>();
  const details: Obj[] = [];
  let quantityDigits = 0;
  let priceDigits = 0;
  let amountDigits = 0;
  for (const [index, line] of request.lines.entries()) {
    const rate = rateName(line.vatRate);
    if (rate === null || ![line.quantity, line.unitPrice, line.amount, line.vatAmount].every((v) => DECIMAL.test(v)) || line.description.trim() === '') return 'invalid_data';
    quantityDigits = Math.max(quantityDigits, fractionDigits(line.quantity));
    priceDigits = Math.max(priceDigits, fractionDigits(line.unitPrice));
    amountDigits = Math.max(amountDigits, fractionDigits(line.amount), fractionDigits(line.vatAmount));
    const entry = byRate.get(rate) ?? { taxable: 0n, vat: 0n };
    entry.taxable += toMinor(line.amount);
    entry.vat += toMinor(line.vatAmount);
    byRate.set(rate, entry);
    details.push({
      ItemType: 1,
      SortOrder: index + 1,
      LineNumber: index + 1,
      ItemName: line.description,
      UnitName: line.unit ?? undefined,
      Quantity: num(line.quantity),
      UnitPrice: num(line.unitPrice),
      AmountOC: num(line.amount),
      Amount: num(line.amount),
      DiscountRate: num('0'),
      DiscountAmountOC: num('0'),
      DiscountAmount: num('0'),
      AmountWithoutVATOC: num(line.amount),
      AmountWithoutVAT: num(line.amount),
      VATRateName: rate,
      VATAmountOC: num(line.vatAmount),
      VATAmount: num(line.vatAmount),
    });
  }
  const buyer = request.buyer;
  const data: Obj = {
    RefID: request.key,
    InvSeries: series,
    InvTemplateNo: request.templateNo,
    InvDate: request.date,
    CurrencyCode: 'VND',
    ExchangeRate: num('1'),
    PaymentMethodName: 'TM/CK',
    IsInvoiceSummary: false,
    // Ludy sends no message of its own accord: a person approves what is sent to a buyer.
    IsSendEmail: false,
    BuyerLegalName: buyer.kind === 'business' ? (buyer.name ?? undefined) : undefined,
    BuyerFullName: buyer.kind === 'business' ? undefined : (buyer.name ?? undefined),
    BuyerTaxCode: buyer.taxCode ?? undefined,
    BuyerAddress: buyer.address ?? undefined,
    BuyerEmail: buyer.email ?? undefined,
    ...(buyer.identity && identityField ? { [identityField]: buyer.identity.value } : {}),
    TotalSaleAmountOC: num(request.subtotal),
    TotalSaleAmount: num(request.subtotal),
    TotalDiscountAmountOC: num('0'),
    TotalDiscountAmount: num('0'),
    TotalAmountWithoutVATOC: num(request.subtotal),
    TotalAmountWithoutVAT: num(request.subtotal),
    TotalVATAmountOC: num(request.vatAmount),
    TotalVATAmount: num(request.vatAmount),
    TotalAmountOC: num(request.total),
    TotalAmount: num(request.total),
    OriginalInvoiceDetail: details,
    TaxRateInfo: [...byRate.entries()].map(([rate, sum]) => ({ VATRateName: rate, AmountWithoutVATOC: num(fromMinor(sum.taxable)), VATAmountOC: num(fromMinor(sum.vat)) })),
    // Digits are the ones the figures carry, so MISA rounds nothing the caller computed.
    OptionUserDefined: {
      MainCurrency: 'VND',
      QuantityDecimalDigits: String(quantityDigits),
      UnitPriceOCDecimalDigits: String(priceDigits),
      UnitPriceDecimalDigits: String(priceDigits),
      AmountOCDecimalDigits: String(amountDigits),
      AmountDecimalDigits: String(amountDigits),
      CoefficientDecimalDigits: '0',
      ExchangRateDecimalDigits: '0',
    },
  };
  if (original && kind) {
    // 1 replaces, 2 adjusts; the original is named by the number part and the symbol part of its series (1C24MAA is template 1, series C24MAA), its number and its date.
    data.ReferenceType = kind === 'replacement' ? 1 : 2;
    data.OrgInvoiceType = 1;
    data.OrgInvTemplateNo = original.templateNo;
    data.OrgInvSeries = original.symbol;
    data.OrgInvNo = original.number;
    data.OrgInvDate = original.date;
    // The reason, from Appendix XVII (shown in the XML as <LDDCTThe>), required from 2026-12-15. MISA's notice puts it in the OriginalInvoice object; the adapter sends it with the original's other fields.
    data.AdjustReplaceReasonCode = original.reasonCode;
  }
  return data;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const TOKEN_HOURS = 6;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const tag = (xml: string, name: string): string | null => {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]+)</${name}>`).exec(xml);
  return match?.[1]?.trim() || null;
};

export function createMisaEInvoiceProvider(options: MisaOptions): EInvoiceProvider {
  const now = options.now ?? (() => new Date());
  const reasonCodes = options.reasonCodes ?? ADJUST_REPLACE_REASON_CODES.codes;
  // The token of a credential, in memory only (valid about 14 days at MISA; held for a few hours so a restart and a rotation cost nothing).
  const tokens = new Map<string, { token: string; at: number }>();
  // Requests are sequential per series (the document's rule): one publishing at a time for a credential and a series.
  const queues = new Map<string, Promise<unknown>>();

  async function send(write: boolean, request: MisaRequest): Promise<MisaResponse> {
    try {
      return await options.transport(request);
    } catch (error) {
      if (error instanceof EInvoiceProviderError) throw error;
      throw new EInvoiceProviderError(write ? 'lost_answer' : 'unreachable');
    }
  }

  const baseHeaders = (creds: Credentials): Record<string, string> => ({ ClientID: creds.clientId, 'Content-Type': 'application/json' });

  // The token login. `refused` and `two_step` are answers about the account, not failures of the call.
  async function login(creds: Credentials): Promise<{ kind: 'token'; token: string } | { kind: 'refused' | 'two_step' | 'app_off' }> {
    const response = await send(false, {
      method: 'POST',
      url: `${MISA_BASE_URL}/invoice/token`,
      headers: { ...baseHeaders(creds), ClientSecret: creds.clientSecret },
      body: json({ taxcode: creds.taxCode, username: creds.username, password: creds.password }),
    });
    if (response.status === 429 || response.status >= 500) throw new EInvoiceProviderError('unavailable');
    const envelope = readEnvelope(response);
    if (!envelope) throw new EInvoiceProviderError('unavailable');
    if (envelope.code === 'InActiveAppID') return { kind: 'app_off' };
    if (!envelope.success) return { kind: 'refused' };
    const token = text(envelope.data);
    if (token) return { kind: 'token', token };
    // The document gives the second step (a one-time code a person types) the user's id from this answer's CustomData: an answer without a token that carries one is that step.
    return pick(envelope.custom, 'id') !== undefined ? { kind: 'two_step' } : { kind: 'refused' };
  }

  async function tokenFor(secretKey: string, creds: Credentials, fresh: boolean): Promise<string> {
    const held = tokens.get(secretKey);
    if (!fresh && held && now().getTime() - held.at < TOKEN_HOURS * 3_600_000) return held.token;
    tokens.delete(secretKey);
    const result = await login(creds);
    // Two-step accounts and refused logins cannot be served by a server alone.
    if (result.kind !== 'token') throw new EInvoiceProviderError('credentials');
    if (tokens.size >= 100) tokens.delete(tokens.keys().next().value as string);
    tokens.set(secretKey, { token: result.token, at: now().getTime() });
    return result.token;
  }

  // An authorised call. A token the answer refuses is replaced once (a refusal comes before anything is processed, so sending again is safe); rate limits and server errors are
  // `unavailable` for a read and, for a write, `lost_answer` only when the answer was not read at all (a 429 is the gateway's refusal, so nothing was processed).
  async function call(secret: string, write: boolean, request: { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: unknown }): Promise<Envelope> {
    const creds = parseCredentials(secret);
    const key = digest(secret);
    const query = request.query ? `?${new URLSearchParams(request.query).toString()}` : '';
    for (let attempt = 0; ; attempt += 1) {
      const token = await tokenFor(key, creds, attempt > 0);
      const response = await send(write, {
        method: request.method,
        url: `${MISA_BASE_URL}${request.path}${query}`,
        headers: { ...baseHeaders(creds), Authorization: `Bearer ${token}` },
        body: request.body === undefined ? null : json(request.body),
      });
      if (response.status === 429) throw new EInvoiceProviderError('unavailable');
      const envelope = readEnvelope(response);
      if (response.status === 401 || (envelope?.code && TOKEN_REFUSED.has(envelope.code))) {
        tokens.delete(key);
        if (attempt === 0) continue;
        throw new EInvoiceProviderError('credentials');
      }
      if (!envelope) throw new EInvoiceProviderError(write ? 'lost_answer' : 'unavailable');
      if (response.status >= 500) throw new EInvoiceProviderError(write ? 'lost_answer' : 'unavailable');
      return envelope;
    }
  }

  // The signed XML of an invoice, by MISA's lookup code (the transaction id): the document's Download with Xml gives the XML itself, not base64 (a base64 body is read too).
  async function xmlOf(secret: string, ref: string): Promise<string> {
    const envelope = await call(secret, false, { method: 'POST', path: '/invoice/Download', query: { downloadDataType: 'Xml', invoiceWithCode: 'true', invoiceCalcu: 'false' }, body: [ref] });
    if (!envelope.success) throw new EInvoiceProviderError('unavailable');
    const item = listOf(envelope.data).find((i) => pick(i, 'transactionID') === ref) ?? listOf(envelope.data)[0];
    const raw = text(pick(item, 'data') ?? pick(item, 'fileData'));
    if (!raw || text(pick(item, 'errorCode'))) throw new EInvoiceProviderError('unavailable');
    const body = raw.replace(/^﻿/, '');
    const decoded = body.startsWith('<') ? body : Buffer.from(body, 'base64').toString('utf8').replace(/^﻿/, '');
    if (!decoded.startsWith('<')) throw new EInvoiceProviderError('unavailable');
    return decoded;
  }

  // What the status of an invoice means, read with its signed XML: the number and the symbol come from the XML (the status answer carries neither in the document), and the
  // tax authority's step is read by the kind of the invoice, since the document numbers a coded and a not-coded invoice's steps differently.
  async function statusOf(secret: string, item: Obj, fallbackRef: string | null): Promise<EInvoiceStatusAnswer> {
    const ref = text(pick(item, 'transactionID')) ?? fallbackRef;
    if (!ref) return { state: 'unknown' };
    const published = Number(pick(item, 'publishStatus') ?? pick(item, 'statusCode'));
    if (published === 0) return { state: 'pending', ref };
    if (published === -1) return { state: 'rejected', ref, code: 'provider_refused' };
    if (published !== 1) throw new EInvoiceProviderError('unavailable');
    const xml = await xmlOf(secret, ref);
    const number = text(pick(item, 'invNo')) ?? tag(xml, 'SHDon');
    const symbol = tag(xml, 'KHHDon');
    if (!number || !symbol) throw new EInvoiceProviderError('unavailable');
    const coded = symbol.startsWith('C');
    const taxStep = Number(pick(item, 'sendTaxStatus'));
    if (taxStep === 3) return { state: 'rejected', ref, code: 'rejected_by_tax_authority' };
    const code = text(pick(item, 'invoiceCode')) ?? tag(xml, 'MCCQT');
    // A coded invoice waits for the code (steps 0 and 1: waiting, sending failed and tried again); the others are done once signed.
    if (coded && (taxStep === 0 || taxStep === 1 || !code)) return { state: 'pending', ref };
    return { state: 'issued', ref, number, signedAt: now().toISOString(), taxAuthorityCode: coded ? code : null };
  }

  async function statusByKey(secret: string, key: string, ref: string | null): Promise<EInvoiceStatusAnswer> {
    for (const lookup of [{ type: '2', value: key }, ...(ref ? [{ type: '1', value: ref }] : [])]) {
      const envelope = await call(secret, false, { method: 'POST', path: '/invoice/status', query: { inputType: lookup.type, invoiceWithCode: 'true', invoiceCalcu: 'false' }, body: [lookup.value] });
      if (envelope.code === 'InvalidTransactionID') continue;
      if (!envelope.success) throw new EInvoiceProviderError('unavailable');
      const items = listOf(envelope.data);
      const item = items.find((i) => pick(i, 'refID') === lookup.value || pick(i, 'transactionID') === lookup.value) ?? (items.length === 1 ? items[0] : undefined);
      if (item) return statusOf(secret, item, lookup.type === '1' ? lookup.value : null);
    }
    return { state: 'unknown' };
  }

  // Publishing: one invoice per request, serial per series. A duplicate of the key is answered by asking for it; the document's two retry codes are sent again only after the
  // key was asked for and found nowhere.
  async function publish(secret: string, request: EInvoiceRequest, kind: 'adjustment' | 'replacement' | null): Promise<EInvoiceOutcome> {
    const series = `${request.templateNo}${request.symbol}`;
    const data = invoiceData(request, series, request.original ?? null, kind, reasonCodes);
    if (typeof data === 'string') return { state: 'rejected', ref: null, code: data };
    // Per process: one publishing at a time for a seller's tax code and a series.
    const lane = `${parseCredentials(secret).taxCode}:${series}`;
    const previous = queues.get(lane) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => attempt());
    queues.set(lane, run);
    try {
      return await run;
    } finally {
      if (queues.get(lane) === run) queues.delete(lane);
    }

    async function attempt(): Promise<EInvoiceOutcome> {
      for (let tries = 1; ; tries += 1) {
        // After a first try the invoice may exist: any failure here or in the question is a lost answer, never a certain one.
        const envelope = await call(secret, true, { method: 'POST', path: '/invoice/publishing', body: { SignType: 2, InvoiceData: [data] } }).catch((error: unknown) => {
          if (tries > 1 && error instanceof EInvoiceProviderError && error.kind === 'credentials') throw new EInvoiceProviderError('lost_answer');
          throw error;
        });
        const result = listOf(envelope.publish).find((i) => pick(i, 'refID') === request.key) ?? listOf(envelope.publish)[0];
        // The document's order: success, then the envelope's code, then the code of the invoice's own result (empty is success).
        const code = envelope.code ?? text(pick(result, 'errorCode'));
        if (envelope.success && !code && result) {
          const ref = text(pick(result, 'transactionID'));
          const number = text(pick(result, 'invNo'));
          if (!ref) throw new EInvoiceProviderError('lost_answer');
          const taxCode = text(pick(result, 'invCode'));
          const coded = request.symbol.startsWith('C');
          if (!number || (coded && !taxCode)) return { state: 'pending', ref };
          return { state: 'issued', ref, number, signedAt: now().toISOString(), taxAuthorityCode: coded ? taxCode : null };
        }
        if (!code) throw new EInvoiceProviderError('lost_answer');
        const refusal = rejectionFor(code);
        if (refusal === null) {
          // Retry codes, duplicates, uncertain answers and codes the document does not list: the invoice may exist, so the key is asked for first.
          const known = await statusByKey(secret, request.key, null).catch(() => {
            throw new EInvoiceProviderError('lost_answer');
          });
          if (known.state !== 'unknown') return known;
          if (!RETRY.has(code) || tries >= MAX_ATTEMPTS) throw new EInvoiceProviderError('lost_answer');
          continue;
        }
        return { state: 'rejected', ref: null, code: refusal };
      }
    }
  }

  return {
    id: 'misa',
    hosts: [...MISA_HOSTS],
    connectFields: [...MISA_CONNECT_FIELDS],
    capabilities: {
      cancel: false,
      draftCall: false,
      // SignType 2 only: MISA's HSM or remote certificate. The USB-token and local-tool endpoints are never called.
      signing: 'provider_hsm',
      batchSize: MISA_LIMITS.batchSize,
      maxLinesPerInvoice: MISA_LIMITS.maxLinesPerInvoice,
      sequentialPerSeries: true,
      // A repeated publishing is answered with an error, not with the invoice, so a retry asks for the key first.
      retry: { testConnection: 'safe', listTemplates: 'safe', issue: 'reconcile_only', status: 'safe', files: 'safe', adjust: 'reconcile_only', replace: 'reconcile_only' },
    },

    testConnection: async (secret): Promise<ConnectionState> => {
      let creds: Credentials;
      try {
        creds = parseCredentials(secret);
      } catch {
        return 'wrong_credentials';
      }
      try {
        const result = await login(creds);
        if (result.kind !== 'token') return result.kind === 'refused' ? 'wrong_credentials' : result.kind === 'app_off' ? 'api_not_enabled' : 'signing_needs_person';
        tokens.set(digest(secret), { token: result.token, at: now().getTime() });
        // An account with no remote certificate (HSM or MISA eSign) cannot issue with SignType 2: its certificate is on a USB token, which a server cannot use.
        const certificates = await call(secret, false, { method: 'GET', path: '/invoice/get-certificates' });
        if (!certificates.success) return 'unreachable';
        return listOf(certificates.data).length > 0 ? 'works' : 'signing_needs_person';
      } catch (error) {
        if (error instanceof EInvoiceProviderError && error.kind === 'credentials') return 'wrong_credentials';
        return 'unreachable';
      }
    },

    listTemplates: async (secret): Promise<EInvoiceTemplate[]> => {
      // The year in Vietnam (UTC+7), where the series changes.
      const year = String(new Date(now().getTime() + 7 * 3_600_000).getUTCFullYear());
      const envelope = await call(secret, false, { method: 'GET', path: '/invoice/templates', query: { invoiceWithCode: 'true', ticket: 'false', year, haveTempOld: 'false' } });
      if (!envelope.success) throw new EInvoiceProviderError('unavailable');
      const out: EInvoiceTemplate[] = [];
      for (const item of listOf(envelope.data)) {
        const series = text(pick(item, 'invSeries'));
        // Normal coded invoices only (the query asks for the coded ones and the check repeats it): the series MISA lists (1C26TYY) split into the template number and the
        // six-character symbol; not-coded, cash-register, petrol and inactive ones are left out.
        if (!series || !SERIES.test(series) || series[1] !== 'C' || series[4] !== 'T' || pick(item, 'inactive') === true || pick(item, 'isPetrol') === true) continue;
        out.push({ templateNo: series.slice(0, 1), symbol: series.slice(1), description: text(pick(item, 'templateName')) ?? series });
      }
      return out;
    },

    issue: (secret, request) => publish(secret, request, null),
    adjust: (secret, request) => publish(secret, request, 'adjustment'),
    replace: (secret, request) => publish(secret, request, 'replacement'),

    status: (secret, query) => statusByKey(secret, query.key, query.ref),

    files: async (secret, ref): Promise<EInvoiceFiles> => {
      const xml = await xmlOf(secret, ref);
      let pdf: Uint8Array | null = null;
      try {
        const envelope = await call(secret, false, { method: 'POST', path: '/invoice/Download', query: { downloadDataType: 'Pdf', invoiceWithCode: 'true', invoiceCalcu: 'false' }, body: [ref] });
        const item = envelope.success ? listOf(envelope.data)[0] : undefined;
        const raw = text(pick(item, 'data') ?? pick(item, 'fileData'));
        const bytes = raw ? Buffer.from(raw, 'base64') : null;
        // A display copy: a body that is not a PDF is no copy, never a reason to lose the signed XML.
        if (bytes && bytes.subarray(0, 5).toString('latin1') === '%PDF-') pdf = new Uint8Array(bytes);
      } catch {
        pdf = null;
      }
      return { xml: new TextEncoder().encode(xml), pdf };
    },
  };
}
