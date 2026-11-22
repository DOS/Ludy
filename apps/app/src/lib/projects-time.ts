// SPDX-License-Identifier: AGPL-3.0-only
// Client-side exact decimal money/hours helpers, datetime helpers, and CSV download for project time tracking (#2600).
import { brandFileName } from '../i18n/brand.ts';

const HOURLY_RATE_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;

function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

function groupIntDigits(digits: string, sep: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i]!;
  }
  return out;
}

/** Validate non-negative hourly rate strings up to NUMERIC(18, 2). */
export function isValidHourlyRateInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return true;
  return HOURLY_RATE_PATTERN.test(trimmed);
}

function trimTrailingZeros(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 48) end--;
  return s.slice(0, end);
}

/** Format a decimal string cleanly using pure string grouping so large amounts never suffer JS Number precision loss. */
export function formatDecimalMoney(raw: string, locale: 'vi' | 'en', keepZeroDecimals = false): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return raw;
  const intPart = m[1]!;
  const fracPart = m[2] ?? '';
  const groupSep = locale === 'vi' ? '.' : ',';
  const decSep = locale === 'vi' ? ',' : '.';
  const grouped = groupIntDigits(intPart, groupSep);
  if (keepZeroDecimals && fracPart.length > 0) {
    return `${grouped}${decSep}${fracPart}`;
  }
  const trimmedFrac = trimTrailingZeros(fracPart);
  return trimmedFrac ? `${grouped}${decSep}${trimmedFrac}` : grouped;
}

/** Format decimal hours (2 decimal places -> e.g. '1,5' in Vietnamese, '1.5' in English). */
export function formatDecimalHours(raw: string, locale: 'vi' | 'en'): string {
  return formatDecimalMoney(raw, locale, false);
}

/** Convert integer minutes to formatted hours cleanly using exact BigInt half-up rounding. */
export function formatMinutesAsHours(minutes: number, locale: 'vi' | 'en'): string {
  const scaled = divRoundHalfUp(BigInt(Math.max(0, Math.round(minutes))) * 100n, 60n);
  const whole = scaled / 100n;
  const frac = (scaled % 100n).toString().padStart(2, '0');
  return formatDecimalHours(`${whole}.${frac}`, locale);
}

/** Compute exact BigInt preview for billable amount = ROUND_HALF_UP((durationMinutes * rate) / 60, 2). */
export function previewBillableAmount(
  durationMinutes: number | null,
  hourlyRateRaw: string | null | undefined,
  billable: boolean,
): string | null {
  if (!billable || durationMinutes === null || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    return null;
  }
  const trimmed = (hourlyRateRaw ?? '').trim();
  if (!trimmed || !HOURLY_RATE_PATTERN.test(trimmed)) return null;
  const [intStr = '0', fracStr = ''] = trimmed.split('.');
  const rateCents = BigInt(intStr) * 100n + BigInt((fracStr + '00').slice(0, 2));
  const amountCents = divRoundHalfUp(BigInt(durationMinutes) * rateCents, 60n);
  const whole = amountCents / 100n;
  const frac = (amountCents % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

export function toLocalDateTimeInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localDateTimeInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function currentLocalDateTimeInput(): string {
  return toLocalDateTimeInput(new Date().toISOString());
}

export function saveTimeCsvFile(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = brandFileName(filename);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
