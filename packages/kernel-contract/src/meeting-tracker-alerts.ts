// SPDX-License-Identifier: AGPL-3.0-only
// Alerts when a tracked keyword comes up in a new meeting (#4873, builds on the keyword trackers of #4818). A member opts in (off by default); when a recorder publishes the minutes of a meeting
// the member reads, the worker counts the org's tracked words in the published transcript lines, inside the database (no text leaves it), and writes one notice per meeting that lists the words that came up and how often. The notice holds term
// ids and counts only: no word, no title, no text of the transcript (the app writes the words from the live term list when it shows the notice, so a deleted term disappears and no competitor's name is copied
// into a row a purge would have to chase). No model call.
//
// This file holds the shapes and the names both sides use. No database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The notice's kind, the outbox event that carries the publish, and the mail template and source.
export const TRACKER_ALERT_KIND = 'meetings.tracker_alert';
export const TRACKER_ALERT_EVENT = 'meetings.tracker.alert';
export const TRACKER_ALERT_MAIL_TEMPLATE = 'meetings.tracker_alert';
export const TRACKER_ALERT_MAIL_SOURCE = 'meetings.tracker_alert';
// The most words one notice lists (the busiest first); the mail says only how many came up.
export const TRACKER_ALERT_TERMS_MAX = 5;

// A member's own switch.
export const zTrackerAlertGet = z.strictObject({});
// `language`: the language of the member's mail, taken from the app they turn it on in (stored on their own row, as the morning notice does).
export const zTrackerAlertSet = z.strictObject({ on: z.boolean(), language: z.enum(['vi', 'en']).default('vi') });
export type TrackerAlertSetInput = z.input<typeof zTrackerAlertSet>;
export const zTrackerAlertState = z.strictObject({ on: z.boolean() });
export type TrackerAlertState = z.infer<typeof zTrackerAlertState>;

// The outbox event: the meeting's id, never a word. Who is told, and in which language, is decided by the worker's dispatch when it runs, not copied here.
export const zTrackerAlertEvent = z.strictObject({ meetingId: zId });
export type TrackerAlertEvent = z.infer<typeof zTrackerAlertEvent>;
// The worker's dispatch is told the event's id only and reads the event itself.
export const zTrackerAlertDispatch = z.strictObject({ eventId: zId });

// What the notice keeps in its `detail` (a notification's detail is strings only): one string, `terms`, of at most TRACKER_ALERT_TERMS_MAX pairs `<term id>:<count>` joined by commas, the busiest first. No word,
// no text. The reader below is strict: a value that is not exactly that shape is dropped, never shown.
export interface TrackerAlertTerm {
  termId: string;
  count: number;
}
export function encodeTrackerAlertTerms(terms: readonly TrackerAlertTerm[]): { terms: string } {
  return { terms: terms.slice(0, TRACKER_ALERT_TERMS_MAX).map((t) => `${t.termId}:${Math.max(1, Math.min(100_000, Math.floor(t.count)))}`).join(',') };
}
const PAIR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9][0-9]{0,5})$/;
export function parseTrackerAlertTerms(detail: { terms?: unknown } | null | undefined): TrackerAlertTerm[] {
  const raw = detail?.terms;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 400) return [];
  const out: TrackerAlertTerm[] = [];
  for (const pair of raw.split(',').slice(0, TRACKER_ALERT_TERMS_MAX)) {
    const m = PAIR.exec(pair);
    if (!m) return [];
    out.push({ termId: m[1] as string, count: Number(m[2]) });
  }
  return out;
}

// The mail's merge data: the org's name, the app path that opens the meeting, the language and how many words came up. No other key can be stored.
export const zTrackerAlertMail = z.strictObject({
  lang: z.enum(['vi', 'en']),
  org: z.string().trim().min(1).max(200),
  words: z.number().int().min(1).max(TRACKER_ALERT_TERMS_MAX),
  path: z.string().regex(/^\/o\/[a-z0-9][a-z0-9-]{0,62}\/meetings\/[0-9a-f-]{36}$/),
});
export type TrackerAlertMail = z.infer<typeof zTrackerAlertMail>;
