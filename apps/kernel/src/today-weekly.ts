// SPDX-License-Identifier: AGPL-3.0-only
// Vy's "Tuần này" answer (#3257, Vy plan C5): the figures of the last 7 days (kernel.today_weekly.figures, computed in the member's own context) and the sentences over them. The
// figures are the card's own numbers; the sentences are Vy's, checked against them sentence by sentence (packages/agent weekly.ts), or the template built from the same figures.
// Nothing is stored.
import { templateWeekly, weeklyEmpty, AiBudgetExhaustedError, type WeeklyFacts, type WeeklyResult } from '@ludy/agent';
import type { TodayWeekly, WeeklyFigures } from '@ludy/kernel-contract';
import { type DraftTicket } from './ai-draft-limit.ts';

/** What the sentences are written from: the figures and the language, nothing else. */
export function weeklyFactsOf(figures: WeeklyFigures, language: 'vi' | 'en'): WeeklyFacts {
  return { language, deals: figures.deals, money: figures.money, tasks: figures.tasks };
}

// Vy's status of a member's week. No figure at all (the member can open none of what it reads): nothing to say, and nobody is asked. No model, or the per-member AI rate limit (`take` says
// no): the plain template. The AI budget spent, or the AI switched off by a kill switch (the meter refuses the call): the template, and `budgetSpent`. Any other failure is the caller's. `take` is the member's draft-budget ticket,
// released when the call is over.
export async function weeklyAnswer(
  figures: WeeklyFigures,
  language: 'vi' | 'en',
  write: ((facts: WeeklyFacts) => Promise<WeeklyResult>) | undefined,
  take: () => DraftTicket,
): Promise<TodayWeekly> {
  const facts = weeklyFactsOf(figures, language);
  if (weeklyEmpty(facts)) return { figures, writtenBy: null, sentences: [], budgetSpent: false, final: true };
  const plain: TodayWeekly = { figures, writtenBy: 'template', sentences: templateWeekly(facts), budgetSpent: false, final: true };
  // No model: this is the status. Asking too often: the template for now, not kept, so the next ask can reach the model.
  if (!write) return plain;
  const ticket = take();
  if (!ticket.allowed) return { ...plain, final: false };
  try {
    const result = await write(facts);
    return { figures, writtenBy: result.writtenBy, sentences: result.sentences, budgetSpent: false, final: result.final };
  } catch (error: unknown) {
    // The call is refused (the org's, the module's or the agent's budget is spent, or a kill switch is on): the template costs nothing, so it shows, and `budgetSpent` says why Vy did not write.
    if (error instanceof AiBudgetExhaustedError) return { ...plain, budgetSpent: true, final: false };
    throw error;
  } finally {
    ticket.release();
  }
}
