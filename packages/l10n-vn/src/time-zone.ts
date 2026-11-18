// SPDX-License-Identifier: AGPL-3.0-only
// Pure IANA time zone wall-clock and offset helpers shared across @crove/l10n-vn modules.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const tzFormatters = new Map<string, Intl.DateTimeFormat>();

function getTzFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = tzFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    tzFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function assertValidTimeZone(timeZone: string): void {
  if (timeZone.length === 0 || timeZone.length > 64) {
    throw new RangeError(`Invalid timeZone: ${timeZone}`);
  }
  try {
    getTzFormatter(timeZone);
  } catch {
    throw new RangeError(`Invalid timeZone: ${timeZone}`);
  }
}

export function wallClockAt(timeZone: string, atMs: number): WallClock {
  const parts = Object.fromEntries(getTzFormatter(timeZone).formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  const rawHour = Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function zoneOffsetMs(timeZone: string, atMs: number): number {
  const w = wallClockAt(timeZone, atMs);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

export function zonedDateString(timeZone: string, atMs: number): string {
  const w = wallClockAt(timeZone, atMs);
  return `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

export function nextUtcDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Resolves the UTC epoch milliseconds at which `timeZone`'s wall clock reads `date` (`YYYY-MM-DD`)
 * at `minute` minutes after midnight. Handles DST gaps and repeated hours deterministically.
 */
export function zonedInstant(timeZone: string, date: string, minute: number): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d) + minute * MINUTE_MS;
  const before = zoneOffsetMs(timeZone, wall - DAY_MS);
  const after = zoneOffsetMs(timeZone, wall + DAY_MS);
  const reads = (at: number) => at + zoneOffsetMs(timeZone, at) === wall;
  const candidates = [wall - before, wall - after].filter(reads).sort((a, b) => a - b);
  return candidates[0] ?? wall - before;
}

/** Formats an epoch instant as an ISO-8601 datetime string with explicit `±HH:MM` offset in `timeZone`. */
export function formatZonedIsoOffset(timeZone: string, atMs: number): string {
  const w = wallClockAt(timeZone, atMs);
  const offsetMin = Math.round(zoneOffsetMs(timeZone, atMs) / MINUTE_MS);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, '0');
  const offM = String(absMin % 60).padStart(2, '0');
  return `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}T${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}:${String(w.second).padStart(2, '0')}${sign}${offH}:${offM}`;
}
