// SPDX-License-Identifier: AGPL-3.0-only
// Shared SSRF guard, credential/request validation, ASN.1 DER sanity helpers, and fetch transport wrapper
// for remote CA adapters. Zero secrets are ever placed in thrown errors or URLs.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  CaProviderError,
  type CaFetchCmsQuery,
  type CaInitiateRequest,
  type CaPollQuery,
} from './port.ts';

export const DEFAULT_CA_TIMEOUT_MS = 15_000;
const MAX_CA_RESPONSE_BYTES = 2 * 1024 * 1024;
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const USB_TOKEN_MODE_TOKENS = [
  'usb',
  'token',
  'pkcs11',
  'client_pc',
  'local_pc',
  'local_sign',
  'smartcard',
  'hard_token',
  'plugin',
] as const;

const FORBIDDEN_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.arpa',
  '.localdomain',
  '.home',
  '.lan',
] as const;

const FORBIDDEN_EXACT_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function setBoundedMap<K, V>(map: Map<K, V>, maxEntries: number, key: K, value: V): void {
  if (map.size >= maxEntries && !map.has(key)) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

export function isUsbTokenMode(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === '' || normalized === 'remote_ca' || normalized === 'provider_hsm' || normalized === 'remote' || normalized === 'cloud_ca' || normalized === 'remote_signing') {
    return false;
  }
  return USB_TOKEN_MODE_TOKENS.some((token) => normalized.includes(token));
}

function assertRemoteSigningAllowed(signingMode: unknown): void {
  if (signingMode === undefined || signingMode === null) return;
  if (typeof signingMode === 'string') {
    const normalized = signingMode.trim().toLowerCase();
    if (normalized === 'remote_ca' || normalized === 'provider_hsm') return;
    if (isUsbTokenMode(normalized)) {
      throw new CaProviderError('usb_token_unsupported', 'client-PC USB/token signing mode is not supported on server workers');
    }
    throw new CaProviderError('usb_token_unsupported', 'unsupported signing mode; only remote_ca or provider_hsm is permitted');
  }
  throw new CaProviderError('usb_token_unsupported', 'client-PC USB/token signing mode is not supported on server workers');
}

export function assertSafeHostAllowlist(hosts: readonly string[]): readonly string[] {
  if (hosts.length === 0) {
    throw new CaProviderError('unsafe_url', 'CA host allowlist cannot be empty');
  }
  const normalized: string[] = [];
  for (const rawHost of hosts) {
    const host = rawHost.trim().toLowerCase();
    if (!isSafePublicFqdn(host)) {
      throw new CaProviderError('unsafe_url', 'allowlist contains an unsafe or private host');
    }
    normalized.push(host);
  }
  return normalized;
}

export function isSafePublicFqdn(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return false;
  if (host.endsWith('.') || host.startsWith('.')) return false;
  if (host.includes('[') || host.includes(']') || host.includes('@') || host.includes(':')) return false;
  const unwrapped = host;
  if (isIP(unwrapped) !== 0) return false;
  if (FORBIDDEN_EXACT_HOSTS.has(unwrapped)) return false;
  if (FORBIDDEN_HOST_SUFFIXES.some((suffix) => unwrapped.endsWith(suffix))) return false;
  if (!unwrapped.includes('.')) return false;
  const labels = unwrapped.split('.');
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return false;
  }
  // Real public DNS TLDs are alphabetic or punycode (`xn--...`), blocking numeric/hex/octal IPv4 lookalikes.
  const tld = labels[labels.length - 1] ?? '';
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return false;
  return true;
}

export function assertSafeCaBaseUrl(rawUrl: string, allowedHosts: readonly string[]): string {
  const safeAllowlist = assertSafeHostAllowlist(allowedHosts);
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new CaProviderError('unsafe_url', 'CA base URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new CaProviderError('unsafe_url', 'CA base URL must use https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new CaProviderError('unsafe_url', 'CA base URL must not contain credentials');
  }
  if (url.port !== '' && url.port !== '443') {
    throw new CaProviderError('unsafe_url', 'CA base URL must use default HTTPS port 443');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new CaProviderError('unsafe_url', 'CA base URL must not contain query or fragment');
  }
  const host = url.hostname.toLowerCase();
  if (!isSafePublicFqdn(host) || !safeAllowlist.includes(host)) {
    throw new CaProviderError('unsafe_url', 'CA base URL host is not in the provider allowlist');
  }
  const cleanPath = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${cleanPath}`;
}

export function assertSafeCaRequestUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  const safeAllowlist = assertSafeHostAllowlist(allowedHosts);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CaProviderError('unsafe_url', 'CA request URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) {
    throw new CaProviderError('unsafe_url', 'CA request URL violates transport security rules');
  }
  const host = url.hostname.toLowerCase();
  if (!isSafePublicFqdn(host) || !safeAllowlist.includes(host)) {
    throw new CaProviderError('unsafe_url', 'CA request host is not allowlisted');
  }
  return url;
}

export function validateInitiateRequest(request: CaInitiateRequest): {
  idempotencyKey: string;
  digestSha256: string;
  certRef: string;
  documentName?: string;
  signerReason?: string;
} {
  assertRemoteSigningAllowed(request.signingMode);
  const idempotencyKey = normalizeSafeIdentifier(request.idempotencyKey, 'idempotencyKey');
  const digestSha256 = request.digestSha256.trim().toLowerCase();
  if (!SHA256_HEX_RE.test(digestSha256)) {
    throw new CaProviderError('invalid_request', 'digestSha256 must be a 64-character hex SHA-256 digest');
  }
  const certRef = request.certRef.trim();
  if (certRef.length === 0 || certRef.length > 256) {
    throw new CaProviderError('invalid_request', 'certRef must be 1..256 characters');
  }
  return {
    idempotencyKey,
    digestSha256,
    certRef,
    ...(request.documentName !== undefined && request.documentName.trim() !== ''
      ? { documentName: request.documentName.trim().slice(0, 200) }
      : {}),
    ...(request.signerReason !== undefined && request.signerReason.trim() !== ''
      ? { signerReason: request.signerReason.trim().slice(0, 300) }
      : {}),
  };
}

function normalizeSafeIdentifier(raw: string, fieldName: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 128 ||
    trimmed === '.' ||
    trimmed === '..' ||
    /[\\/?#]/.test(trimmed)
  ) {
    throw new CaProviderError('invalid_request', `${fieldName} must be a safe 1..128 character identifier`);
  }
  return trimmed;
}

export function normalizeExternalTxId(externalTxId: string): string {
  return normalizeSafeIdentifier(externalTxId, 'externalTxId');
}

export function normalizePollQuery(query: CaPollQuery | string): {
  externalTxId: string | null;
  idempotencyKey: string | null;
} {
  if (typeof query === 'string') {
    return { externalTxId: normalizeExternalTxId(query), idempotencyKey: null };
  }
  const externalTxId =
    typeof query.externalTxId === 'string' && query.externalTxId.trim() !== ''
      ? normalizeExternalTxId(query.externalTxId)
      : null;
  const idempotencyKey =
    typeof query.idempotencyKey === 'string' && query.idempotencyKey.trim() !== ''
      ? normalizeSafeIdentifier(query.idempotencyKey, 'idempotencyKey')
      : null;
  if (externalTxId === null && idempotencyKey === null) {
    throw new CaProviderError('invalid_request', 'pollStatus requires externalTxId or idempotencyKey');
  }
  return { externalTxId, idempotencyKey };
}

export function normalizeFetchCmsQuery(query: CaFetchCmsQuery | string): {
  externalTxId: string;
  certRef?: string;
  signedAttrsDer?: Uint8Array;
} {
  if (typeof query === 'string') {
    return { externalTxId: normalizeExternalTxId(query) };
  }
  const externalTxId = normalizeExternalTxId(query.externalTxId);
  const certRef =
    typeof query.certRef === 'string' && query.certRef.trim() !== ''
      ? query.certRef.trim().slice(0, 256)
      : undefined;
  let signedAttrsDer: Uint8Array | undefined;
  if (query.signedAttrsDer !== undefined) {
    if (query.signedAttrsDer.byteLength < 4 || query.signedAttrsDer[0] !== 0xa0) {
      throw new CaProviderError('invalid_request', 'signedAttrsDer must be a valid [0] IMPLICIT SignedAttributes DER TLV');
    }
    signedAttrsDer = query.signedAttrsDer;
  }
  return {
    externalTxId,
    ...(certRef !== undefined ? { certRef } : {}),
    ...(signedAttrsDer !== undefined ? { signedAttrsDer } : {}),
  };
}

export function hasUsbTokenCredentialFields(obj: Record<string, unknown>): boolean {
  for (const key of ['signingMode', 'signing_mode', 'signMode', 'sign_mode', 'tokenType', 'token_type', 'mode']) {
    if (obj[key] !== undefined && isUsbTokenMode(obj[key])) return true;
  }
  return (
    obj.usbToken === true ||
    obj.usb_token === true ||
    (typeof obj.usbTokenSerial === 'string' && obj.usbTokenSerial.trim() !== '') ||
    (typeof obj.usb_token_serial === 'string' && obj.usb_token_serial.trim() !== '') ||
    (typeof obj.tokenSerial === 'string' && obj.tokenSerial.trim() !== '') ||
    (typeof obj.token_serial === 'string' && obj.token_serial.trim() !== '')
  );
}

export function parseCredentialObject(secret: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(secret);
  } catch {
    throw new CaProviderError('credentials');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CaProviderError('credentials');
  }
  const obj = raw as Record<string, unknown>;
  if (hasUsbTokenCredentialFields(obj)) {
    throw new CaProviderError('usb_token_unsupported', 'client-PC USB/token signing mode is not supported on server workers');
  }
  return obj;
}

export function requireCredentialField(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CaProviderError('credentials');
  }
  return value.trim();
}

export function optionalCredentialField(obj: Record<string, unknown>, field: string): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CaProviderError('credentials');
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pickCaseInsensitive(obj: unknown, name: string): unknown {
  if (!isRecord(obj)) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function decodeBase64Bytes(value: unknown): Uint8Array | null {
  const text = readText(value);
  if (!text) return null;
  const compact = text.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !STRICT_BASE64_RE.test(compact)) {
    return null;
  }
  return new Uint8Array(Buffer.from(compact, 'base64'));
}

export function decodeDerSequenceBase64(value: unknown): Uint8Array | null {
  const bytes = decodeBase64Bytes(value);
  if (!bytes || !isValidDerSequence(bytes)) return null;
  return bytes;
}

export function isValidDerSequence(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 2 || bytes[0] !== 0x30) return false;
  const lenByte = bytes[1];
  if (lenByte === undefined) return false;
  if (lenByte < 0x80) {
    return bytes.byteLength === 2 + lenByte;
  }
  const octets = lenByte & 0x7f;
  if (octets === 0 || octets > 4 || bytes.byteLength < 2 + octets) return false;
  // Minimal canonical DER length encoding forbids leading zero length octets.
  if (bytes[2] === 0x00) return false;
  let declared = 0;
  for (let i = 0; i < octets; i += 1) {
    const b = bytes[2 + i];
    if (b === undefined) return false;
    declared = (declared << 8) | b;
  }
  if (declared < 0x80) return false;
  return bytes.byteLength === 2 + octets + declared;
}

interface CaHttpResponse {
  status: number;
  json: unknown;
}

async function readResponseTextBounded(response: Response, write: boolean): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_CA_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new CaProviderError(write ? 'lost_answer' : 'unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_CA_RESPONSE_BYTES) {
      throw new CaProviderError(write ? 'lost_answer' : 'unavailable');
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CA_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CaProviderError(write ? 'lost_answer' : 'unavailable');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export async function postCaJson(options: {
  fetchImpl: typeof fetch;
  url: string;
  allowedHosts: readonly string[];
  headers: Readonly<Record<string, string>>;
  body: unknown;
  method?: 'GET' | 'POST';
  write: boolean;
  timeoutMs: number;
}): Promise<CaHttpResponse> {
  const checkedUrl = assertSafeCaRequestUrl(options.url, options.allowedHosts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CaProviderError('timeout')), options.timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await options.fetchImpl(checkedUrl.toString(), {
      method: options.method ?? 'POST',
      headers: options.headers,
      ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.body) }),
      redirect: 'error',
      signal: controller.signal,
    });
    text = await readResponseTextBounded(response, options.write);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CaProviderError(options.write ? 'lost_answer' : 'timeout');
    }
    if (error instanceof CaProviderError) throw error;
    throw new CaProviderError(options.write ? 'lost_answer' : 'unreachable');
  } finally {
    clearTimeout(timer);
  }

  let json: unknown = null;
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      throw new CaProviderError(options.write ? 'lost_answer' : 'unavailable');
    }
  }

  return { status: response.status, json };
}
