// SPDX-License-Identifier: AGPL-3.0-only
// Shared SSRF guard, credential/request validation, ASN.1 DER sanity helpers, and fetch transport wrapper
// for remote CA adapters. Zero secrets are ever placed in thrown errors or URLs.
import { createHash } from 'node:crypto';
import { lookup as nodeDnsLookup } from 'node:dns/promises';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';
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
  let hasUnsafeChar = /[%\\/?#]/.test(trimmed);
  for (let i = 0; !hasUnsafeChar && i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) hasUnsafeChar = true;
  }
  if (
    trimmed.length === 0 ||
    trimmed.length > 128 ||
    trimmed === '.' ||
    trimmed === '..' ||
    hasUnsafeChar
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
    declared = declared * 256 + b;
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
      if (response.status < 400) {
        throw new CaProviderError(options.write ? 'lost_answer' : 'unavailable');
      }
      json = null;
    }
  }

  return { status: response.status, json };
}

const CA_BLOCKED_V4 = (() => {
  const list = new BlockList();
  const ipv4Cidrs: readonly [string, number][] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [net, prefix] of ipv4Cidrs) list.addSubnet(net, prefix, 'ipv4');
  return list;
})();

const CA_BLOCKED_V6 = (() => {
  const list = new BlockList();
  const ipv6Cidrs: readonly [string, number][] = [
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 32],
    ['2001:2::', 48],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ];
  for (const [net, prefix] of ipv6Cidrs) list.addSubnet(net, prefix, 'ipv6');
  return list;
})();

export interface PinnedDnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type PinnedDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly PinnedDnsAddress[]>;

export function isPublicCaIpAddress(rawIp: string): boolean {
  const trimmed = rawIp.trim().toLowerCase();
  if (trimmed === '' || trimmed.includes('%')) return false;
  const unwrapped = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const family = isIP(unwrapped);
  if (family === 4) {
    return !CA_BLOCKED_V4.check(unwrapped, 'ipv4');
  }
  if (family === 6) {
    if (unwrapped.startsWith('::ffff:')) return false;
    return !CA_BLOCKED_V6.check(unwrapped, 'ipv6');
  }
  return false;
}

type FetchRequestInit = NonNullable<Parameters<typeof fetch>[1]>;

function normalizeRequestBody(body: FetchRequestInit['body'] | null | undefined): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new CaProviderError('invalid_request', 'unsupported CA request body type');
}

function toNodeHeaders(headersInit: FetchRequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headersInit) return out;
  const headers = new Headers(headersInit);
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

async function resolveDnsWithSignal(
  resolveDns: PinnedDnsLookup,
  hostname: string,
  signal: AbortSignal | undefined,
): Promise<readonly PinnedDnsAddress[]> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new CaProviderError('timeout');
  }
  const dnsPromise = resolveDns(hostname, { all: true, verbatim: true }).catch(() => {
    throw new CaProviderError('unavailable', 'CA host DNS resolution failed');
  });
  if (!signal) {
    return await dnsPromise;
  }
  return await new Promise<readonly PinnedDnsAddress[]>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new CaProviderError('timeout'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    dnsPromise.then(
      (addresses) => {
        signal.removeEventListener('abort', onAbort);
        resolve(addresses);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export function createPinnedCaFetch(deps?: {
  dnsLookup?: PinnedDnsLookup;
  requestImpl?: typeof https.request;
}): typeof fetch {
  const resolveDns: PinnedDnsLookup =
    deps?.dnsLookup ??
    ((hostname, opts) => nodeDnsLookup(hostname, opts) as Promise<readonly PinnedDnsAddress[]>);
  const requestImpl = deps?.requestImpl ?? https.request;

  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new CaProviderError('unsafe_url', 'CA request URL is invalid');
    }
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      (url.port !== '' && url.port !== '443') ||
      !isSafePublicFqdn(url.hostname)
    ) {
      throw new CaProviderError('unsafe_url', 'CA request URL violates transport security rules');
    }
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? new CaProviderError('timeout');
    }

    const hostname = url.hostname.toLowerCase();
    const resolved = await resolveDnsWithSignal(resolveDns, hostname, init?.signal ?? undefined);
    if (resolved.length === 0) {
      throw new CaProviderError('unavailable', 'CA host DNS resolution returned no addresses');
    }
    for (const entry of resolved) {
      if (!isPublicCaIpAddress(entry.address)) {
        throw new CaProviderError('unsafe_url', 'CA host resolved to a non-public IP address');
      }
    }
    if (init?.signal?.aborted) {
      throw init.signal.reason instanceof Error ? init.signal.reason : new CaProviderError('timeout');
    }
    const pinned = resolved[0]!;
    const requestBody = normalizeRequestBody(init?.body);
    const requestHeaders = toNodeHeaders(init?.headers);
    if (requestBody !== undefined && !Object.keys(requestHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      const byteLen = typeof requestBody === 'string' ? Buffer.byteLength(requestBody, 'utf8') : requestBody.byteLength;
      requestHeaders['content-length'] = String(byteLen);
    }

    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const req = requestImpl(
        {
          protocol: 'https:',
          hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'POST',
          headers: requestHeaders,
          servername: hostname,
          agent: false,
          lookup: (_h, opts, cb) => {
            if (typeof opts === 'object' && opts !== null && opts.all) {
              (cb as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)(
                null,
                [{ address: pinned.address, family: pinned.family }],
              );
              return;
            }
            (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
              null,
              pinned.address,
              pinned.family,
            );
          },
        },
        (res) => {
          const status = res.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            res.destroy();
            req.destroy();
            fail(new CaProviderError('unsafe_url', 'CA HTTP redirects are forbidden'));
            return;
          }
          const remoteAddr = res.socket?.remoteAddress;
          if (remoteAddr && !isPublicCaIpAddress(remoteAddr)) {
            res.destroy();
            req.destroy();
            fail(new CaProviderError('unsafe_url', 'CA connection peer resolved to a non-public IP address'));
            return;
          }

          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) {
              for (const item of v) responseHeaders.append(k, item);
            } else if (typeof v === 'string') {
              responseHeaders.append(k, v);
            }
          }

          const body =
            status === 204 || status === 205 || status === 304
              ? null
              : new ReadableStream<Uint8Array>({
                  start(controller) {
                    res.on('data', (chunk: Uint8Array) => {
                      controller.enqueue(new Uint8Array(chunk));
                    });
                    res.on('end', () => {
                      controller.close();
                    });
                    res.on('error', (err) => {
                      controller.error(err);
                    });
                  },
                  cancel() {
                    res.destroy();
                  },
                });

          settled = true;
          resolve(new Response(body, { status, headers: responseHeaders }));
        },
      );

      req.on('error', (err) => {
        fail(err);
      });

      const signal = init?.signal;
      if (signal) {
        const onAbort = () => {
          const reason = signal.reason instanceof Error ? signal.reason : new CaProviderError('timeout');
          req.destroy(reason);
          fail(reason);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }

      req.end(requestBody);
    });
  };
}

export const defaultPinnedCaFetch: typeof fetch = createPinnedCaFetch();
