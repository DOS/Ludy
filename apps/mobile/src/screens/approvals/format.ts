// SPDX-License-Identifier: AGPL-3.0-only
// Pure formatting, UUID idempotency keys, and safe web hand-off URL helpers for mobile approvals.

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
 */
export function formatMoney(
  raw: string | null | undefined,
  currency: string | null | undefined = 'VND',
  locale: Locale = 'vi',
): string {
  if (raw === null || raw === undefined) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) return trimmed;

  const sign = match[1] ? '-' : '';
  const rawInt = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
  let frac = (match[3] ?? '').replace(/0+$/, '');

  const normalizedCurrency = (currency ?? 'VND').trim().toUpperCase() || 'VND';
  if (frac.length > 4) frac = frac.slice(0, 4).replace(/0+$/, '');
  if (normalizedCurrency !== 'VND' && frac.length === 1) {
    frac = `${frac}0`;
  }

  const thousandsSep = locale === 'vi' ? '.' : ',';
  const decimalSep = locale === 'vi' ? ',' : '.';
  const intFormatted = groupThousands(rawInt, thousandsSep);
  const numberPart = frac ? `${sign}${intFormatted}${decimalSep}${frac}` : `${sign}${intFormatted}`;

  if (normalizedCurrency === 'VND') return `${numberPart} ₫`;
  return `${numberPart} ${normalizedCurrency}`;
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

export function isSafeRelativeWebPath(path: string): boolean {
  if (!path || path[0] !== '/') return false;
  if (path.startsWith('//') || path.includes('\\')) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Builds a validated `https:` (or local dev `http:`) web hand-off URL scoped to the active org.
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

  if (relativePath === '/' && !orgSlug) return `${origin}/`;
  if (!orgSlug) return null;

  if (relativePath.startsWith('/o/')) {
    return `${origin}${relativePath}`;
  }
  return `${origin}/o/${encodeURIComponent(orgSlug)}${relativePath}`;
}

const EXTERNAL_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validates that an external web hand-off URL uses `https:` (or local dev `http:`) with no embedded credentials,
 * optionally pinned to the active server's origin.
 */
export function isSafeExternalWebUrl(rawUrl: string, allowedOrigin?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const local = EXTERNAL_LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (allowedOrigin && parsed.origin !== allowedOrigin) return false;
  return true;
}
