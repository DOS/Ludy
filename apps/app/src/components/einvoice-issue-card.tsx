// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of a request to issue a sales e-invoice (ADR-0044 point 3, #2502): the invoice the approval would send to the provider, read from the draft as it stands now,
// and a warning when it is no longer the one the request was made for. Approving issues a legal document that only an adjustment or a replacement corrects, so the card says so.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { CardSkeleton, ErrorText } from './ui.tsx';

export function EInvoiceIssueCard({ id, title, slug }: { id: string; title: string; slug: string }) {
  const t = useTranslations('inboxDetail');
  const f = useFormat();
  const view = useQuery(orpc.einvoice.drafts.issueRequest.queryOptions({ input: { proposalId: id } }));
  const draft = view.data;
  return (
    <Card className="block space-y-3 p-4" data-testid="einvoice-issue">
      <p className="text-sm font-medium text-muted-foreground">{t('issueCard')}</p>
      {view.isLoading ? (
        <CardSkeleton />
      ) : view.error ? (
        <>
          <p className="text-sm text-foreground">{title}</p>
          <ErrorText>{errorMessage(view.error)}</ErrorText>
        </>
      ) : draft ? (
        <div className="space-y-1">
          <p className="text-base font-semibold text-foreground">{f.money(draft.total, draft.currency)}</p>
          <p className="text-sm text-muted-foreground">
            {t('issueBuyer', { name: draft.buyerName ?? t('issueConsumer') })} · {t('issueDate', { date: f.date(draft.date) })} · {t('issueLines', { count: draft.lineCount })}
            {draft.series ? ` · ${t('issueSeries', { series: draft.series })}` : ''}
          </p>
          <p className="text-xs text-subtle-foreground">{t('issueIrreversible')}</p>
        </div>
      ) : null}
      {draft && !draft.current && (
        <Alert data-testid="einvoice-issue-stale">
          <AlertDescription>{t('issueStale')}</AlertDescription>
        </Alert>
      )}
      <Link to="/o/$slug/sales-invoices" params={{ slug }} className="inline-block text-sm text-link hover:underline">
        {t('issueOpenScreen')}
      </Link>
    </Card>
  );
}
