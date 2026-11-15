// SPDX-License-Identifier: AGPL-3.0-only
// "Tuần này" on Home (#3257, Vy plan C5), the parts that need no screen. The server computes the figures and writes the sentences and stores nothing; so that Home does not call
// the model on every visit, this tab keeps the last answer of the day in sessionStorage (gone when the tab closes), keyed by organization, day and language.
import { zTodayWeekly, weeklyShownByDefault, type TodayWeekly } from '@crove/kernel-contract';
import { briefDay } from './today-brief.ts';

/** Whether the card shows without being asked: Monday to Wednesday, by the Vietnam day the server counts the week from. */
export const weeklyAutoShown = (now: Date = new Date()): boolean => weeklyShownByDefault(briefDay(now));

export const weeklyStorageKey = (slug: string, day: string, language: string) => `ludy:today-weekly:${slug}:${day}:${language}`;

// The stored answer for a key, or undefined: storage may be absent, full or hold something else, and Home works without it.
export function readStoredWeekly(key: string): TodayWeekly | undefined {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = zTodayWeekly.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// Only an answer that was written and is final is kept: none (the budget spent, no figure) and a fallback a later call may improve on are asked again next time.
export function storeWeekly(key: string, weekly: TodayWeekly): void {
  if (weekly.writtenBy === null || !weekly.final) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(weekly));
  } catch {
    // Storage is full or off: the answer is simply asked again.
  }
}
