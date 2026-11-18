// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of a request to open the way to spend (ADR-0043 point 1, issue #2294): what changes if it is approved, in one
// sentence of the reader's language, built from the change the server read from the proposal (ads.proposal.change). It posts
// nothing to the books, so there is no entry and no checks to show; a request the server cannot read shows its title alone.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { adsChangeText } from '../lib/ads-change.ts';
import { orpc } from '../lib/api.ts';
import { AdsPlanPreview, useAdsPlanView } from './ads-plan-preview.tsx';
import { CardSkeleton } from './ui.tsx';

export function AdsProposalCard({ id, title, slug }: { id: string; title: string; slug: string }) {
  const t = useTranslations('inboxDetail');
  const root = useTranslations();
  const f = useFormat();
  const view = useQuery(orpc.ads.proposal.queryOptions({ input: { id } }));
  const change = view.data?.change ?? null;
  const plan = useAdsPlanView(change);
  // The server says when this deployment has no launch writer: the card then never promises a launch (#3675).
  const noLauncher = change?.change === 'campaign_launch' && view.data?.canLaunch === false;
  const text = change ? adsChangeText(change, root, (amount, currency) => f.money(amount, currency), (day) => f.date(day), view.data?.canLaunch ?? null) : null;
  return (
    <Card className="block space-y-3 p-4" data-testid="ads-change">
      <p className="text-sm font-medium text-muted-foreground">{t('adsChange')}</p>
      {view.isLoading ? (
        <CardSkeleton />
      ) : text ? (
        <div className="space-y-3">
          {plan && (
            // What the approver signs comes first and is the loudest line: the most the plan can spend.
            <div data-testid="ads-plan-amount">
              <p className="text-sm text-muted-foreground">{root('ads.change.plan.maxSpend')}</p>
              <p className="text-2xl font-bold text-foreground">{plan.amount}</p>
              <p className="text-sm text-muted-foreground">{plan.spend}</p>
            </div>
          )}
          <div className="space-y-1">
            <p className="break-words text-base font-semibold text-foreground">{text.title}</p>
            <p className="text-sm text-muted-foreground">{text.detail}</p>
          </div>
          {noLauncher && (
            <p role="note" data-testid="ads-no-launcher" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm font-medium text-foreground">
              {t('adsNoLauncher')}
            </p>
          )}
          {plan && <AdsPlanPreview plan={plan} />}
        </div>
      ) : (
        <p className="text-sm text-foreground">{title}</p>
      )}
      <Link to="/o/$slug/ads" params={{ slug }} className="inline-block text-sm text-link hover:underline">
        {t('adsOpenScreen')}
      </Link>
    </Card>
  );
}
