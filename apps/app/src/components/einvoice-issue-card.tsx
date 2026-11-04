// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of a request to issue a sales e-invoice (ADR-0044 point 3, #2502): the invoice the approval would send to the provider, read from the draft as it stands now,
// and a warning when it is no longer the one the request was made for. Approving issues a legal document that only an adjustment or a replacement corrects, so the card says so.
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { EInvoiceIssueView } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage } from '../lib/api.ts';
import { CardSkeleton, ErrorText } from './ui.tsx';

// The query is the route's, which also holds the approve button until the invoice has loaded: an approval is never given for an invoice that was not shown.
export function EInvoiceIssueCard({ view, title, slug, pending }: { view: UseQueryResult<EInvoiceIssueView>; title: string; slug: string; pending: boolean }) {
  const t = useTranslations('inboxDetail');
  const f = useFormat();
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
        <div className="space-y-2">
          <p className="text-base font-semibold text-foreground">{f.money(draft.total, draft.currency)}</p>
          <p className="text-sm text-muted-foreground">
            {t('issueBuyer', { name: draft.buyerName ?? t('issueConsumer') })}
            {draft.buyerTaxCode ? ` · ${t('issueBuyerTaxCode', { code: draft.buyerTaxCode })}` : ''} · {t('issueDate', { date: f.date(draft.date) })} · {t('issueLines', { count: draft.lineCount })}
            {draft.series ? ` · ${t('issueSeries', { series: draft.series })}` : ''}
          </p>
          <ul className="divide-y divide-border text-sm" data-testid="einvoice-issue-lines">
            {draft.lines.map((line) => (
              <li key={line.lineNo} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-1.5">
                <span className="min-w-0 break-words text-foreground">{line.description}</span>
                <span className="tabular-nums text-muted-foreground">
                  {t('issueLineDetail', { quantity: line.quantity, unit: line.unit ?? '', price: f.money(line.unitPrice, draft.currency), rate: line.vatRate })} · {f.money(line.amount, draft.currency)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm tabular-nums text-muted-foreground" data-testid="einvoice-issue-totals">
            {t('issueTotals', { subtotal: f.money(draft.subtotal, draft.currency), vat: f.money(draft.vatAmount, draft.currency), total: f.money(draft.total, draft.currency) })}
          </p>
          <p className="text-xs text-subtle-foreground">{t('issueIrreversible')}</p>
        </div>
      ) : null}
      {/* Only a request still waiting can be refused for a change: an approved, rejected or expired one has no approval left to refuse. */}
      {pending && draft && !draft.current && (
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
