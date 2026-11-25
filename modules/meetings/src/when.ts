// SPDX-License-Identifier: AGPL-3.0-only
// The calendar day a said "when" means (the summary's items, the spoken cues to Vy): a pure reading by code against the meeting's own day, with no database, no model and no reader of a Vy result.
// It lives apart from summary.ts so a file that only needs the date reading (voice-cue.ts) does not import a file that reads the recorder's Vy results (the member-Vy sinks invariant freezes the importers of those).
import { plainName } from './plain-name.ts';
import { dayAfter } from './retention.ts';

const WEEKDAYS: ReadonlyArray<readonly [string, number]> = [
  ['thu hai', 1],
  ['thu ba', 2],
  ['thu tu', 3],
  ['thu nam', 4],
  ['thu sau', 5],
  ['thu bay', 6],
  ['chu nhat', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
  ['sunday', 0],
];

const validDay = (year: number, month: number, day: number): string | null => {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
};
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/**
 * The calendar day a said "when" means, read by code against the meeting's own day (YYYY-MM-DD, Vietnam time), or null when it does not name one day for
 * sure: a date (2026-11-13, 13/11, 13/11/2026), today, tomorrow, the day after, or a weekday (the next one after the meeting day). A "next week" or a
 * "soon" is null, and a date earlier than the meeting is null: a person decides.
 */
export function parseWhen(text: string, meetingDay: string): string | null {
  const said = plainName(text);
  if (said === '') return null;
  const found = new Set<string>();
  // Whole words only ("thu ba" is not the start of "thu bay"): the text with everything but letters, digits and the date marks turned into single spaces.
  const words = ` ${said.replace(/[^\p{L}\p{N}/-]+/gu, ' ').trim()} `;
  const has = (phrase: string): boolean => words.includes(` ${phrase} `);
  const iso = /(?:^|\D)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(said);
  if (iso) found.add(validDay(Number(iso[1]), Number(iso[2]), Number(iso[3])) ?? 'x');
  const dm = /(?:^|\D)(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/.exec(said);
  if (dm) found.add(validDay(dm[3] ? Number(dm[3]) : Number(meetingDay.slice(0, 4)), Number(dm[2]), Number(dm[1])) ?? 'x');
  if (has('hom nay') || has('today')) found.add(meetingDay);
  if (has('ngay mai') || has('tomorrow')) found.add(dayAfter(new Date(`${meetingDay}T12:00:00Z`), 1));
  if (has('ngay kia')) found.add(dayAfter(new Date(`${meetingDay}T12:00:00Z`), 2));
  for (const [phrase, weekday] of WEEKDAYS) {
    if (!has(phrase)) continue;
    const from = new Date(`${meetingDay}T12:00:00Z`).getUTCDay();
    found.add(dayAfter(new Date(`${meetingDay}T12:00:00Z`), ((weekday - from + 6) % 7) + 1));
  }
  // "next week", "last Friday": a weekday or date with a week named is a different day than the nearest one, so a person decides.
  if (has('tuan') || has('next') || has('last') || has('previous')) return null;
  if (found.size !== 1) return null;
  const day = [...found][0] as string;
  if (day === 'x' || dayNumber(day) < dayNumber(meetingDay)) return null;
  return day;
}
