// SPDX-License-Identifier: AGPL-3.0-only
// Pure formatting, UUID idempotency keys, currency helpers, and safe web hand-off URL builders for mobile approvals.

import { normalizeServerUrl, serverAllowed, type ServerPolicy } from '../../config.ts';

export type Locale = 'vi' | 'en';

export interface RandomBytesPort {
  randomBytes(length: number): Uint8Array;
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;
const RAW_MONEY_IN_TITLE_RE = /\b(\d+(?:\.\d+)?)\s+([A-Z]{3})\b/;

function groupThousands(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Formats a decimal string money amount without converting through JS `number`.
 * When `currency` is omitted (`null`), formats the decimal value without inventing a currency symbol.
 */
export function formatMoney(
  raw: string | null | undefined,
  currency?: string | null,
  locale: Locale = 'vi',
): string {
  if (raw === null || raw === undefined) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) return trimmed;

  const isZero = isZeroMoney(trimmed);
  const sign = match[1] && !isZero ? '-' : '';
  const rawInt = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
  let frac = (match[3] ?? '').replace(/0+$/, '');

  const normalizedCurrency = currency ? currency.trim().toUpperCase() : '';
  // Preserve up to 10 fractional digits so small rates (e.g. 0.00005) and 8-decimal contract amounts never truncate to zero.
  if (frac.length > 10) frac = frac.slice(0, 10).replace(/0+$/, '');
  if (normalizedCurrency && normalizedCurrency !== 'VND' && frac.length === 1) {
    frac = `${frac}0`;
  }

  const thousandsSep = locale === 'vi' ? '.' : ',';
  const decimalSep = locale === 'vi' ? ',' : '.';
  const intFormatted = groupThousands(rawInt, thousandsSep);
  const numberPart = frac ? `${sign}${intFormatted}${decimalSep}${frac}` : `${sign}${intFormatted}`;

  if (!normalizedCurrency) return numberPart;
  if (normalizedCurrency === 'VND') return `${numberPart} ₫`;
  return `${numberPart} ${normalizedCurrency}`;
}

/**
 * Per zPurchaseProposal: when `invoice.foreign` is set, booked invoice totals and line amounts are stored in VND.
 */
export function bookedInvoiceCurrency(invoice: { currency: string; foreign?: unknown }): string {
  return invoice.foreign ? 'VND' : invoice.currency;
}

export function isZeroMoney(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) return false;
  const intPart = match[2] ?? '';
  const fracPart = match[3] ?? '';
  for (let i = 0; i < intPart.length; i++) {
    if (intPart[i] !== '0') return false;
  }
  for (let i = 0; i < fracPart.length; i++) {
    if (fracPart[i] !== '0') return false;
  }
  return true;
}

export function isPositiveMoney(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const trimmed = raw.trim();
  const match = DECIMAL_RE.exec(trimmed);
  if (!match || match[1]) return false;
  return !isZeroMoney(trimmed);
}

/**
 * Fallback display extraction when `inbox.list` omits `total` on `finance.supplier_payment`.
 */
export function parseMoneyHintFromTitle(title: string): { amount: string; currency: string } | null {
  const match = RAW_MONEY_IN_TITLE_RE.exec(title);
  if (!match?.[1] || !match[2]) return null;
  return { amount: match[1], currency: match[2] };
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/**
 * Builds an RFC 4122 v4 UUID string from a 16-byte CSPRNG buffer for command `idempotencyKey`.
 */
export function createIdempotencyKey(crypto: RandomBytesPort): string {
  const bytes = Uint8Array.from(crypto.randomBytes(16));
  if (bytes.length < 16) {
    throw new Error('Expected at least 16 random bytes for idempotency key');
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += hexByte(bytes[i] ?? 0);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDateShort(value: string | null | undefined, locale: Locale = 'vi'): string {
  if (!value) return '';
  const trimmed = value.trim();
  const ymd = YMD_RE.exec(trimmed);
  if (ymd?.[1] && ymd[2] && ymd[3]) {
    return locale === 'vi' ? `${ymd[3]}/${ymd[2]}/${ymd[1]}` : `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  const dd = pad2(parsed.getDate());
  const mm = pad2(parsed.getMonth() + 1);
  const yyyy = parsed.getFullYear();
  return locale === 'vi' ? `${dd}/${mm}/${yyyy}` : `${yyyy}-${mm}-${dd}`;
}

export function formatDateTimeShort(value: string | number | null | undefined, locale: Locale = 'vi'): string {
  if (value === null || value === undefined || value === '') return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const hh = pad2(parsed.getHours());
  const min = pad2(parsed.getMinutes());
  const dd = pad2(parsed.getDate());
  const mm = pad2(parsed.getMonth() + 1);
  const yyyy = parsed.getFullYear();
  return locale === 'vi' ? `${hh}:${min} ${dd}/${mm}/${yyyy}` : `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function hasUnsafeSegmentChars(segment: string): boolean {
  if (segment === '.' || segment === '..') return true;
  if (/%2e/i.test(segment) || /%2f/i.test(segment) || /%5c/i.test(segment)) return true;
  try {
    const decoded = decodeURIComponent(segment);
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return true;
  } catch {
    return true;
  }
  return false;
}

export function isValidOrgSlug(orgSlug: string | null | undefined): orgSlug is string {
  if (!orgSlug) return false;
  if (orgSlug === '.' || orgSlug === '..') return false;
  if (/[/\\\s]|\p{C}/u.test(orgSlug)) return false;
  if (hasUnsafeSegmentChars(orgSlug)) return false;
  return true;
}

export function isSafeRelativeWebPath(path: string): boolean {
  if (!path || path[0] !== '/') return false;
  if (path.startsWith('//') || path.includes('\\')) return false;
  if (/[\s\p{C}]/u.test(path)) return false;

  const qIdx = path.indexOf('?');
  const hIdx = path.indexOf('#');
  const cutIdx = qIdx === -1 ? hIdx : hIdx === -1 ? qIdx : Math.min(qIdx, hIdx);
  const rawPathname = cutIdx === -1 ? path : path.slice(0, cutIdx);

  const segments = rawPathname.split('/');
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i] ?? '';
    if (hasUnsafeSegmentChars(seg)) return false;
  }
  return true;
}

/**
 * Builds a validated `https:` (or local dev `http:`) web hand-off URL strictly scoped to the active org.
 */
export function buildWebUrl(
  serverUrl: string,
  orgSlug: string | null,
  relativePath: string,
  policy?: ServerPolicy,
): string | null {
  const origin = normalizeServerUrl(serverUrl);
  if (!origin) return null;
  if (policy && !serverAllowed(policy, origin)) return null;
  if (!isSafeRelativeWebPath(relativePath)) return null;

  if (relativePath === '/' && !orgSlug) {
    try {
      const rootParsed = new URL('/', origin);
      if (rootParsed.origin !== origin || rootParsed.username !== '' || rootParsed.password !== '') return null;
      if (rootParsed.pathname !== '/') return null;
      return rootParsed.toString();
    } catch {
      return null;
    }
  }

  if (!isValidOrgSlug(orgSlug)) return null;

  const encodedSlug = encodeURIComponent(orgSlug);
  const orgPrefix = `/o/${encodedSlug}`;

  const qIdx = relativePath.indexOf('?');
  const hIdx = relativePath.indexOf('#');
  const cutIdx = qIdx === -1 ? hIdx : hIdx === -1 ? qIdx : Math.min(qIdx, hIdx);
  const rawPathname = cutIdx === -1 ? relativePath : relativePath.slice(0, cutIdx);

  let candidate: string;
  if (rawPathname === '/o' || rawPathname.startsWith('/o/')) {
    if (rawPathname !== orgPrefix && !rawPathname.startsWith(`${orgPrefix}/`)) {
      // Allow unencoded slug matching as well before URL verification.
      const unencodedPrefix = `/o/${orgSlug}`;
      if (rawPathname !== unencodedPrefix && !rawPathname.startsWith(`${unencodedPrefix}/`)) {
        return null;
      }
    }
    candidate = `${origin}${relativePath}`;
  } else {
    candidate = `${origin}${orgPrefix}${relativePath}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.pathname !== orgPrefix && !parsed.pathname.startsWith(`${orgPrefix}/`)) return null;

  return parsed.toString();
}

const EXTERNAL_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validates that an external web hand-off URL uses `https:` (or local dev `http:`) with no embedded credentials,
 * strictly matching a non-empty `allowedOrigin`.
 */
export function isSafeExternalWebUrl(rawUrl: string, allowedOrigin: string): boolean {
  if (!allowedOrigin || !allowedOrigin.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const local = EXTERNAL_LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.origin !== allowedOrigin) return false;
  return true;
}
