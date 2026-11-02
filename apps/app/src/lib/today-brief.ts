// SPDX-License-Identifier: AGPL-3.0-only
// Vy's daily brief on Home (issue #2383), the parts that need no screen. The brief is written by the server from the member's
// own list and stored nowhere there; so that Home does not call the model on every visit, this tab keeps the last brief of
// the day for the same list in sessionStorage (gone when the tab closes), keyed by day, language and a fingerprint of the list.
import type { TodayBrief, TodayItem } from '@crove/kernel-contract';

// A short fingerprint of the list: what the brief is written from (kinds, counts, amounts, due times, severities), not its
// titles. The same list gives the same key, so a refresh of an unchanged Home reuses the brief. Two 32-bit hashes of the same
// text, so two lists do not meet by chance.
export function listFingerprint(items: readonly TodayItem[]): string {
  const text = items
    .map((i) => [i.app, i.id, i.kind, i.count ?? 1, i.amount ?? '', i.currency ?? '', i.dueAt ?? '', i.severity ?? ''].join('|'))
    .sort()
    .join('\n');
  let a = 5381;
  let b = 0;
  for (let n = 0; n < text.length; n++) {
    const c = text.charCodeAt(n);
    a = ((a << 5) + a + c) | 0;
    b = (c + (b << 6) + (b << 16) - b) | 0;
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

// The day the brief is for is the Vietnam day the server writes "today" from, not the browser's.
export const briefDay = (now: Date = new Date()): string => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

export const briefStorageKey = (slug: string, day: string, language: string, fingerprint: string) => `ludy:today-brief:${slug}:${day}:${language}:${fingerprint}`;

// The stored brief for a key, or undefined: storage may be absent, full or hold something else, and Home works without it.
export function readStoredBrief(key: string): TodayBrief | undefined {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<TodayBrief>;
    const sentences = value.sentences;
    if ((value.writtenBy !== 'vy' && value.writtenBy !== 'template') || !Array.isArray(sentences) || !sentences.every((s) => typeof s === 'string')) return undefined;
    return { writtenBy: value.writtenBy, sentences, budgetSpent: false, final: true };
  } catch {
    return undefined;
  }
}

// Only a brief that was written and is final is kept: none (no items, the budget spent) and a fallback that a later call may
// improve on are asked again next time.
export function storeBrief(key: string, brief: TodayBrief): void {
  if (brief.writtenBy === null || !brief.final) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(brief));
  } catch {
    // Storage is full or off: the brief is simply asked again.
  }
}
