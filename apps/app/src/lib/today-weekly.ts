// SPDX-License-Identifier: AGPL-3.0-only
// "Tuần này" on Home (#3257, Vy plan C5), the parts that need no screen. The server computes the figures and writes the sentences and stores nothing. The answer is kept in the app's query cache only,
// which is emptied when the session ends or changes (sign-out, another sign-in): it holds balances and a person's own task count, so it is never written to the browser's storage, where the next person to sign in
// in the same tab would find it. Within a session the same day and language ask the model once.
import { weeklyShownByDefault } from '@ludy/kernel-contract';
import { briefDay } from './today-brief.ts';

/** Whether the card shows without being asked: Monday to Wednesday, by the Vietnam day the server counts the week from. */
export const weeklyAutoShown = (now: Date = new Date()): boolean => weeklyShownByDefault(briefDay(now));

export const weeklyCacheKey = (slug: string, day: string, language: string) => `${slug}:${day}:${language}`;
