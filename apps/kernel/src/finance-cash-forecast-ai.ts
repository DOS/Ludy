// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's note on the 30/60/90-day cash forecast, on the API side (#4391). finance.cash_forecast runs in the member's own transaction and gives the figures code computed; the model
// call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The model is told the figures and dates and nothing else (no name of a
// customer, supplier, bank or document), and its text is refused when it states a number or date the facts do not hold, a link, advice about money or a promise (packages/agent cash-forecast.ts), so what it
// writes can never state a fact the books do not hold.
//
// The note is read, never written: nothing here stores a text or changes the books, and it is not a command. When there is no model, the AI budget is spent, the member's calls are too frequent, the call
// fails or its text is refused, the answer names the state (`ai`) with no words and the screen shows the figures alone (the lowest balance is in the forecast itself, so it is shown either way). An answer is
// kept for a while by its facts, so reopening the screen does not pay for the same note twice. A failure is named, never quoted: neither the figures nor the model's answer is logged.
import { AiBudgetExhaustedError, cashForecastFactsText, cashForecastQuiet, type CashForecastFacts, type InboxReader } from '@ludy/agent';
import type { CashForecast, CashForecastExplanation } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface CashForecastAi {
  reader: Pick<InboxReader, 'cashForecastSentence'> | null;
  budget: DraftBudget;
  // Notes by org, language and facts, with the time they were written.
  kept: Map<string, { text: string; at: number }>;
}

export const CASH_FORECAST_KEEP_MS = 30 * 60 * 1000;
export const CASH_FORECAST_KEEP_MAX = 200;

export function cashForecastAi(reader: CashForecastAi['reader'], budget: DraftBudget): CashForecastAi {
  return { reader, budget, kept: new Map() };
}

// What the note is written from: the opening cash and its day, the low point, the three checkpoints, the largest items up to the low day and what is left out. The same figures the screen shows.
export function cashForecastFacts(forecast: CashForecast, language: 'vi' | 'en'): CashForecastFacts {
  return {
    language,
    asOf: forecast.asOf,
    openingCash: forecast.openingCash,
    low: { date: forecast.low.date, balance: forecast.low.balance },
    checkpoints: forecast.checkpoints.map((c) => ({ days: c.days, date: c.date, balance: c.balance, receipts: c.receipts, payments: c.payments })),
    topItems: forecast.topItems.map((i) => ({ kind: i.kind, date: i.date, amount: i.amount })),
    overdueReceiptsNotCounted: forecast.overdueReceiptsNotCounted,
    unlinkedReceivablesNotCounted: forecast.unlinkedReceivablesNotCounted,
    notIncluded: forecast.notIncluded,
    truncated: forecast.truncated,
  };
}

export async function explainCashForecast(
  ai: CashForecastAi,
  orgId: string,
  userId: string,
  forecast: CashForecast,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<CashForecastExplanation> {
  const answer = (state: CashForecastExplanation['ai'], text: string | null = null): CashForecastExplanation => ({ ai: state, text });
  if (!ai.reader) return answer('off');
  const facts = cashForecastFacts(forecast, language);
  if (forecast.empty || cashForecastQuiet(facts)) return answer('quiet');
  const key = `${orgId}\n${forecast.legalEntityId}\n${language}\n${cashForecastFactsText(facts)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < CASH_FORECAST_KEEP_MS) return answer('used', hit.text);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.cashForecastSentence(facts);
    if (result.kind === 'none') {
      console.error(`[finance-cash-forecast-ai] note refused: ${result.code}`);
      return answer('failed');
    }
    if (ai.kept.size >= CASH_FORECAST_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text: result.text, at: now() });
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-cash-forecast-ai] note failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
