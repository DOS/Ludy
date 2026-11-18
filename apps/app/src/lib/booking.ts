// Helpers for the public booking page (issue #1318): the free slots grouped by day and shown in the visitor's own time
// zone, the week the page reads, and the visitor's zone itself.
import { BOOKING_MANAGE_TOKEN, zonedDate, zonedInstant, type BookingPage } from '@crove/kernel-contract';
import type { Locale } from '../i18n/locale.ts';

export type Slot = BookingPage['slots'][number];

/** The visitor's IANA zone, or Vietnam's when the browser does not say. */
export function visitorTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
}

/** Vietnam's zone, the one a customer in Vietnam reads times in and is never told the name of (#3646). */
export const VIETNAM_ZONE = 'Asia/Ho_Chi_Minh';
const VIETNAM_ZONES: readonly string[] = [VIETNAM_ZONE, 'Asia/Saigon'];
export const isVietnamZone = (zone: string): boolean => VIETNAM_ZONES.includes(zone);

/** "GMT+9" or "GMT+5:30": a zone's offset from Greenwich at `at`, as people say it; "GMT" for UTC itself. */
export function zoneOffset(zone: string, at: number): string {
  try {
    const part = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName');
    return part?.value ?? 'GMT';
  } catch {
    return 'GMT';
  }
}

/** "New York" for "America/New_York": the place of a zone, without the region and the underscores of its IANA name. */
export function zonePlace(zone: string): string {
  return (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
}

/**
 * The week `weeks` weeks after today in `timeZone`: from local midnight to local midnight seven days later, so a day is
 * never split between two weeks. What one page read covers.
 */
export function weekRange(now: number, weeks: number, timeZone: string): { from: string; to: string } {
  const start = Date.parse(`${zonedDate(timeZone, now)}T12:00:00Z`) + weeks * 7 * 86_400_000;
  const day = (offset: number) => new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
  return { from: new Date(zonedInstant(timeZone, day(0), 0)).toISOString(), to: new Date(zonedInstant(timeZone, day(7), 0)).toISOString() };
}

/** The slots by day in `timeZone`, days in order, each day's slots in order. */
export function slotsByDay(slots: readonly Slot[], timeZone: string): { date: string; slots: Slot[] }[] {
  const days = new Map<string, Slot[]>();
  for (const s of [...slots].sort((a, b) => a.start.localeCompare(b.start))) {
    const date = zonedDate(timeZone, Date.parse(s.start));
    const list = days.get(date) ?? [];
    list.push(s);
    days.set(date, list);
  }
  return [...days].map(([date, list]) => ({ date, slots: list }));
}

const LOCALE_TAG: Record<Locale, string> = { vi: 'vi-VN', en: 'en-GB' };

/** "09:30" in the zone. */
export function timeIn(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** "Thứ Hai, 02/11/2026" for a calendar date. */
export function dayLabel(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
}

/** The manage token in a link's fragment ("#m=<token>", #1319), or null when there is none or it is malformed. */
export function manageTokenOf(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('m');
  return value && BOOKING_MANAGE_TOKEN.test(value) ? value : null;
}

/**
 * The address of a type's public booking page. With a deal (#3103) the address names it, so the client's booking arrives linked to the deal; the server keeps the
 * link only when it is a deal of the org, and the page shows the client nothing of it.
 */
export const bookingLinkOf = (origin: string, org: string, type: string, dealId?: string) =>
  `${origin}/-/b/${encodeURIComponent(org)}/${encodeURIComponent(type)}${dealId ? `?deal=${encodeURIComponent(dealId)}` : ''}`;

/** The app's own origin, where the public booking page lives; empty where there is no window (a server render in a test). */
export const appOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin);

/** The id of the card in Settings that holds the working hours and the event types: "Cài đặt lịch hẹn" links to it. */
export const BOOKING_SETTINGS_ID = 'booking-settings';
/** The id of the event types card in Settings: "Tạo loại lịch hẹn" links to it. */
export const BOOKING_EVENT_TYPES_ID = 'booking-event-types';
