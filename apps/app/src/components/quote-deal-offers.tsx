// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's offers on a deal once its quote was sent or accepted (#3420, docs/plan/crm-quotes.md section 2, ADR-0050 decision 1): move the deal to "Báo giá" after a send,
// to the won stage after an acceptance, and set the deal's amount to the quote total. The rule is plain code on the deal, the pipeline and the deal's quotes (no model, no AI
// budget, the core works with AI off); each offer is its own click on the existing `crm.deals.move` or `crm.deals.update`, can be dismissed, and nothing moves or changes by itself.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { Deal, QuoteSummary } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { refreshDeals } from './deal-form.tsx';
import { quoteLabel, refreshQuoteQueries } from './quote-send.tsx';
import { ErrorText } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';
import { suggestDealOffers } from '../lib/quote-deal-suggest.ts';

// A move or an edit changes the deal everywhere it shows, and a refusal (someone changed it first, the stage is gone) reads everything again.
const refreshAll = () => {
  refreshDeals();
  refreshQuoteQueries();
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.get.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.pipeline.key() });
};

export function QuoteDealOffers({ dealId, quotes, canEdit }: { dealId: string; quotes: readonly QuoteSummary[]; canEdit: boolean }) {
  const t = useTranslations('quotes.dealOffer');
  const { locale } = useLocaleSetting();
  const id = useId();
  // The deal is read fresh (the row or card that opened this tab holds the deal as it was then), so each click carries the version the person is looking at.
  const deal = useQuery({ ...orpc.crm.deals.get.queryOptions({ input: { dealId } }), enabled: canEdit, refetchOnMount: 'always' as const });
  const stages = useQuery({ ...orpc.crm.pipeline.stages.queryOptions({ input: {} }), enabled: canEdit });
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  // What the last clicks did, said once: the offer itself is gone by then.
  const [done, setDone] = useState<{ stage?: string; amount?: string }>({});
  const move = useMutation(orpc.crm.deals.move.mutationOptions({ onSuccess: refreshAll, onError: refreshAll }));
  const update = useMutation(orpc.crm.deals.update.mutationOptions({ onSuccess: refreshAll, onError: refreshAll }));
  const offers = useMemo(() => (deal.data && stages.data ? suggestDealOffers({ deal: deal.data, stages: stages.data, quotes }) : null), [deal.data, stages.data, quotes]);
  const label = (quoteId: string): string => {
    const q = quotes.find((x) => x.id === quoteId);
    return q ? quoteLabel(q) : '';
  };
  const dismiss = (key: string) => setDismissed((current) => new Set(current).add(key));

  // Viewers see no buttons, and the offers wait for both reads.
  if (!canEdit || !deal.data) return null;
  const current: Deal = deal.data;
  const moveKey = offers?.move ? `move:${offers.move.stage.id}` : '';
  const amountKey = offers?.amount ? `amount:${offers.amount.quoteId}:${offers.amount.total}` : '';
  const showMove = offers?.move && !dismissed.has(moveKey) ? offers.move : null;
  const showAmount = offers?.amount && !dismissed.has(amountKey) ? offers.amount : null;
  const error = move.error ?? update.error;

  return (
    <>
      {(done.stage || done.amount) && (
        <div role="status" className="space-y-0.5 text-sm text-foreground" data-testid="quote-deal-offer-done">
          {done.stage && <p>{t('moved', { stage: done.stage })}</p>}
          {done.amount && <p>{t('amountSet', { amount: formatMoney(done.amount, locale, 'VND') })}</p>}
        </div>
      )}
      {(showMove || showAmount) && (
        <div role="group" aria-label={t('title')} className="space-y-2 rounded-lg border border-dashed border-proposal/60 p-3" data-testid="quote-deal-offers">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-foreground">{t('title')}</h4>
            <Badge variant="outline">{t('badge')}</Badge>
          </div>
          {showMove && (
            <div className="flex flex-wrap items-center justify-between gap-2" data-testid="quote-deal-offer-move">
              <p id={`${id}-move`} className="min-w-0 text-sm text-foreground">
                {showMove.to === 'won' ? t('wonReason', { number: label(showMove.quoteId) }) : t('quotedReason', { number: label(showMove.quoteId) })}
              </p>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={move.isPending}
                  disabled={update.isPending || deal.isFetching}
                  aria-describedby={`${id}-move`}
                  onClick={() => {
                    update.reset();
                    move.mutate({ dealId: current.id, version: current.version, stageId: showMove.stage.id }, { onSuccess: () => setDone((d) => ({ ...d, stage: showMove.stage.name })) });
                  }}
                >
                  {t('moveTo', { stage: showMove.stage.name })}
                </Button>
                <Button type="button" size="sm" variant="ghost" aria-describedby={`${id}-move`} onClick={() => dismiss(moveKey)}>
                  {t('dismiss')}
                </Button>
              </div>
            </div>
          )}
          {showAmount && (
            <div className="flex flex-wrap items-center justify-between gap-2" data-testid="quote-deal-offer-amount">
              <p id={`${id}-amount`} className="min-w-0 text-sm text-foreground">
                {t('amountReason', { number: label(showAmount.quoteId), amount: formatMoney(current.amount, locale, 'VND'), total: formatMoney(showAmount.total, locale, 'VND') })}
              </p>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={update.isPending}
                  disabled={move.isPending || deal.isFetching}
                  aria-describedby={`${id}-amount`}
                  onClick={() => {
                    move.reset();
                    update.mutate(
                      {
                        dealId: current.id,
                        version: current.version,
                        partyId: current.partyId,
                        title: current.title,
                        amount: showAmount.total,
                        expectedClose: current.expectedClose,
                        ownerUserId: current.ownerUserId,
                      },
                      { onSuccess: (saved) => setDone((d) => ({ ...d, amount: saved.amount })) },
                    );
                  }}
                >
                  {t('setAmount')}
                </Button>
                <Button type="button" size="sm" variant="ghost" aria-describedby={`${id}-amount`} onClick={() => dismiss(amountKey)}>
                  {t('dismiss')}
                </Button>
              </div>
            </div>
          )}
          {error && <ErrorText>{errorMessage(error)}</ErrorText>}
        </div>
      )}
    </>
  );
}
