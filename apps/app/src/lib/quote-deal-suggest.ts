// SPDX-License-Identifier: AGPL-3.0-only
// What the sales coworker offers on a deal once its quote was sent or accepted (#3420, docs/plan/crm-quotes.md section 2, ADR-0050 decision 1): move the deal to "Báo giá"
// after a send, to the won stage after an acceptance, and set the deal's amount to the quote total. Computed on read from the deal, the pipeline and the deal's quotes; nothing
// is stored, no model is called, and a person confirms each offer with a click (the existing `crm.deal.move` and `crm.deal.update`). Amounts are decimal strings compared through
// @crove/l10n-vn, never JS numbers.
import { zDealAmount, type Deal, type PipelineStage, type QuoteSummary } from '@crove/kernel-contract';
import { money } from '@crove/l10n-vn';
import { foldWord } from './search-fold.ts';

// The default pipeline's third stage; an org that renamed or removed it gets no offer to move a deal to it.
export const QUOTED_STAGE_NAME = 'Báo giá';

export interface MoveOffer {
  // `quoted` after a send, `won` after an acceptance.
  to: 'quoted' | 'won';
  stage: PipelineStage;
  quoteId: string;
}

export interface AmountOffer {
  quoteId: string;
  total: string;
}

export interface DealOffers {
  move: MoveOffer | null;
  amount: AmountOffer | null;
}

const NONE: DealOffers = { move: null, amount: null };

// The words of a stage name as the search folds them: marks and case do not matter, and neither does the spacing.
const foldName = (name: string): string => foldWord(name).replace(/\s+/g, ' ').trim();

// The newest of the quotes by the time it was last touched (an accepted quote's decision is its last change; a sent quote's send is).
const newest = (quotes: readonly QuoteSummary[]): QuoteSummary | null =>
  quotes.reduce<QuoteSummary | null>((best, q) => (best === null || q.updatedAt > best.updatedAt ? q : best), null);

export function sameAmount(a: string, b: string): boolean {
  try {
    return money(a).equals(money(b));
  } catch {
    // Not a decimal amount: never the same, and `amountOffer` also refuses to offer it.
    return false;
  }
}

// The offers for one deal. An accepted quote speaks before a sent one (the customer's yes is the later fact). A closed deal (won or lost) gets none: nothing here reopens a deal
// or rewrites a closed one's amount. A sent quote that has lapsed offers nothing (its price is no longer on the table); an accepted one still does.
export function suggestDealOffers(input: { deal: Deal; stages: readonly PipelineStage[]; quotes: readonly QuoteSummary[] }): DealOffers {
  const { deal, stages, quotes } = input;
  if (deal.stageKind !== 'open') return NONE;
  const own = quotes.filter((q) => q.dealId === deal.id);
  const accepted = newest(own.filter((q) => q.status === 'accepted'));
  const sent = newest(own.filter((q) => q.status === 'sent' && !q.expired));
  const quote = accepted ?? sent;
  if (quote === null) return NONE;

  let move: MoveOffer | null = null;
  if (accepted !== null) {
    // The org's won stage (found by kind); with several, the first in the pipeline.
    const won = [...stages].filter((s) => s.kind === 'won').sort((a, b) => a.position - b.position)[0];
    if (won !== undefined) move = { to: 'won', stage: won, quoteId: accepted.id };
  } else {
    const wanted = foldName(QUOTED_STAGE_NAME);
    const quoted = stages.find((s) => s.kind === 'open' && foldName(s.name) === wanted);
    const current = stages.find((s) => s.id === deal.stageId);
    // Only a deal that sits before that stage is offered the move; one already there or past it (or in a stage this read does not know) is not.
    if (quoted !== undefined && current !== undefined && current.position < quoted.position) move = { to: 'quoted', stage: quoted, quoteId: quote.id };
  }

  // The amount: the deal's, when it differs from the quote total. A total the deal's amount cannot hold (more than two decimals) is not offered, the server would refuse it.
  const amount = zDealAmount.safeParse(quote.total).success && !sameAmount(deal.amount, quote.total) ? { quoteId: quote.id, total: quote.total } : null;
  return { move, amount };
}
