// SPDX-License-Identifier: AGPL-3.0-only
// The received invoices that can be asked for payment (#3113 S4b, #3701), for owners and admins, above the approved payments of the vendors page. Code decides what is listed
// (finance.supplier_payment.payable: purchases that are not voided and have no payment or request yet); each row names the supplier, the invoice and the amount, never a bank number. "Ask to pay" sends
// the ordinary request for approval (finance.supplier_payment.record, through inbox.request): the server builds it from the invoice and the supplier's one active account, and a person approves in
// the Inbox. A supplier with no account, or several, shows what to do first instead of a button; an account changed in the last 30 days is shown on the row. Ludy moves no money. No AI is involved here:
// the screen works with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { SupplierPayable } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { isServerRefusal } from '../lib/errors.ts';

// What a request changes: the list of invoices to pay, the payments, the Inbox. A server refusal changes nothing; a lost response may have made the request, so that case reconciles.
const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.supplierPayment.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.inbox.list.key() }),
  ]);

function Row({ item, onAsked }: { item: SupplierPayable; onAsked: (id: string, proposalId: string) => void }) {
  const t = useTranslations('vendors.payable');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  // One key per request, renewed once it succeeds: a retry returns the same proposal, but a new request after the approver rejected the first one must not replay it.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const ask = useMutation({
    mutationFn: () => client.inbox.request({ command: 'finance.supplier_payment.record', idempotencyKey, input: { purchaseDocumentId: item.purchaseDocumentId } }),
    onSuccess: (data) => {
      setIdempotencyKey(crypto.randomUUID());
      onAsked(item.purchaseDocumentId, data.proposalId);
    },
    // A refusal that says the invoice's state moved (409: asked by someone else, paid, no account any more) is a reason to reload the list; any other server refusal changes nothing.
    onSettled: (_data, error) => {
      if (!isServerRefusal(error) || (error as { status?: number }).status === 409) void refresh();
    },
  });
  return (
    <li className="py-3 text-sm" data-testid="supplier-payable-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{item.partyName}</span>
        <span className="text-muted-foreground">{t('invoice', { number: item.invoiceNumber, date: f.date(item.invoiceDate) })}</span>
        <span className="ml-auto font-medium tabular-nums">{f.money(item.amount, item.currency)}</span>
      </div>
      {item.accountChangedOn !== null && (
        <p className="mt-1 text-xs text-destructive" data-testid="supplier-payable-changed">
          <Badge variant="secondary">!</Badge> {t('changed', { date: f.date(item.accountChangedOn) })}
        </p>
      )}
      {item.account === 'none' && <p className="mt-1 text-xs text-muted-foreground">{t('noAccount')}</p>}
      {item.account === 'many' && <p className="mt-1 text-xs text-muted-foreground">{t('manyAccounts')}</p>}
      {item.account === 'ready' && !open && (
        <div className="mt-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={t('askOf', { name: item.partyName, number: item.invoiceNumber })} data-testid="supplier-payable-open">
            {t('ask')}
          </Button>
        </div>
      )}
      {item.account === 'ready' && open && (
        <form
          className="mt-2 space-y-2"
          data-testid="supplier-payable-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ask.isPending) ask.mutate();
          }}
        >
          <p className="text-foreground">{t('confirm')}</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={ask.isPending} data-testid="supplier-payable-send">
              {t('send')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {ask.error && (
        <p className="mt-2 text-destructive" role="alert" data-testid="supplier-payable-refusal">
          {errorMessage(ask.error)}
        </p>
      )}
    </li>
  );
}

export function SupplierPayablePanel({ slug }: { slug: string }) {
  const t = useTranslations('vendors.payable');
  const list = useQuery(orpc.supplierPayment.payable.queryOptions({ input: {} }));
  // A request that was made stays shown (with the link to it) after the refreshed list no longer has its invoice.
  const [asked, setAsked] = useState<Record<string, { item: SupplierPayable; proposalId: string }>>({});
  const items = list.data?.items ?? [];
  const f = useFormat();
  const rows = items.filter((i) => !asked[i.purchaseDocumentId]);
  const requests = Object.values(asked);
  if (rows.length === 0 && requests.length === 0) return null;
  return (
    <section className="mb-6 rounded-md border border-border p-4 print:hidden" aria-label={t('title')} data-testid="supplier-payable">
      <h2 className="mb-1 text-sm font-semibold">{t('title')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('hint')}</p>
      <ul className="divide-y">
        {requests.map(({ item, proposalId }) => (
          <li key={item.purchaseDocumentId} className="py-3 text-sm" data-testid="supplier-payable-asked">
            <span className="font-medium text-foreground">{item.partyName}</span>{' '}
            <span className="text-muted-foreground">{t('invoice', { number: item.invoiceNumber, date: f.date(item.invoiceDate) })}</span>
            <p className="mt-1 text-foreground">
              {t('asked')}{' '}
              <Link to="/o/$slug/inbox/$id" params={{ slug, id: proposalId }} className="text-link underline">
                {t('openProposal')}
              </Link>
            </p>
          </li>
        ))}
        {rows.map((item) => (
          <Row key={item.purchaseDocumentId} item={item} onAsked={(id, proposalId) => setAsked((prev) => ({ ...prev, [id]: { item, proposalId } }))} />
        ))}
      </ul>
      {list.data?.more && <p className="mt-2 text-xs text-muted-foreground">{t('more', { count: String(items.length) })}</p>}
    </section>
  );
}
