// SPDX-License-Identifier: AGPL-3.0-only
// The figures of Vy's daily brief (#2383): the member's Home list (kernel.today) reduced to counts, the sum of the waiting
// proposals' amounts per currency and the nearest due dates. Nothing of an item's title, id or link goes further: the brief
// is told numbers and dates only (packages/agent/src/today.ts).
import { Decimal } from '@crove/l10n-vn';
import { VIETNAM_TIME_ZONE, todayCurrency, type TodayBrief, type TodayItem } from '@crove/kernel-contract';
import { type DraftTicket } from './ai-draft-limit.ts';
import { AiBudgetExhaustedError, templateBrief, type BriefFacts, type BriefResult } from '@crove/agent';

const DUE_DATES_MAX = 3;
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: VIETNAM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

// A due time as its calendar day in Vietnam time (YYYY-MM-DD).
export function vietnamDay(iso: string): string {
  return dayFormat.format(new Date(iso));
}

export function briefFactsOf(items: readonly TodayItem[], language: 'vi' | 'en', today: string): BriefFacts {
  const sum = (pick: (item: TodayItem) => boolean) => items.filter(pick).reduce((n, item) => n + (item.count ?? 1), 0);
  const amounts = new Map<string, InstanceType<typeof Decimal>>();
  for (const item of items) {
    if (item.kind !== 'proposal' || item.amount === undefined) continue;
    const currency = todayCurrency(item);
    amounts.set(currency, (amounts.get(currency) ?? new Decimal(0)).plus(item.amount));
  }
  const dueDates = [...new Set(items.filter((item) => item.dueAt !== undefined).map((item) => vietnamDay(item.dueAt as string)))].sort().slice(0, DUE_DATES_MAX);
  return {
    language,
    today,
    dueDates,
    flags: sum((i) => i.kind === 'flag'),
    blocking: sum((i) => i.kind === 'flag' && i.severity === 'block'),
    proposals: sum((i) => i.kind === 'proposal'),
    messages: sum((i) => i.kind === 'message'),
    deadlines: sum((i) => i.kind === 'deadline'),
    proposalAmounts: [...amounts].map(([currency, amount]) => ({ currency, amount: amount.toFixed() })),
  };
}

// Vy's brief of a member's list. No items: nothing to say. No model, or the per-member AI rate limit (`take` says no): the
// plain template. The month's AI budget spent: no brief and `budgetSpent`, so Home shows the list alone. Any other failure is
// the caller's. `take` is the member's draft-budget ticket, released when the call is over.
export async function briefAnswer(
  items: readonly TodayItem[],
  language: 'vi' | 'en',
  today: string,
  write: ((facts: BriefFacts) => Promise<BriefResult>) | undefined,
  take: () => DraftTicket,
): Promise<TodayBrief> {
  if (items.length === 0) return { writtenBy: null, sentences: [], budgetSpent: false, final: true };
  const facts = briefFactsOf(items, language, today);
  const plain: TodayBrief = { writtenBy: 'template', sentences: templateBrief(facts), budgetSpent: false, final: true };
  // No model: this is the brief. Asking too often: the template for now, not kept, so the next ask can reach the model.
  if (!write) return plain;
  const ticket = take();
  if (!ticket.allowed) return { ...plain, final: false };
  try {
    const result = await write(facts);
    return { writtenBy: result.writtenBy, sentences: result.sentences, budgetSpent: false, final: result.final };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return { writtenBy: null, sentences: [], budgetSpent: true, final: false };
    throw error;
  } finally {
    ticket.release();
  }
}
