// SPDX-License-Identifier: AGPL-3.0-only
// A sent quote's page (#2694, docs/plan/crm-quotes.md Q2): /-/quote#<token>, opened from a link the seller sent, with no account. It shows one quote in Vietnamese
// with the seller's letterhead, the buyer as they were when the quote was sent, the lines, the totals, the notes and the terms, and prints on A4 (the browser's
// "Save as PDF" is the PDF until the server one of Q3). The token stays after the # and goes to the API in a POST body only. Every text is shown as text.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { vietnamToday, type QuoteDocument } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiUrl } from '../lib/api-base.ts';
import { errorMessage } from '../lib/api.ts';
import { apiErrorFromResponse } from '../lib/errors.ts';
import { usePrintInLight } from '../lib/print.ts';
import { quoteTokenOfHash, subscribeToHash } from '../lib/quote-hash.ts';

async function load(token: string): Promise<QuoteDocument | null> {
  const res = await fetch(apiUrl('/api/quote/view'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json()) as QuoteDocument;
}

// The logo of the letterhead (#2814), asked for apart by the same token in a POST body (never the URL) and shown from an object URL; null when there is none or it cannot be read,
// and the page is the same without it.
async function loadLogo(token: string): Promise<Blob | null> {
  const res = await fetch(apiUrl('/api/quote/logo'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => null);
  if (!res?.ok) return null;
  const blob = await res.blob();
  return blob.type === 'image/png' || blob.type === 'image/jpeg' ? blob : null;
}

function useLogoUrl(token: string | null, wanted: boolean): string | null {
  const logo = useQuery({ queryKey: ['quote-logo', token], queryFn: () => loadLogo(token as string), enabled: token !== null && wanted, retry: false, staleTime: Infinity });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!logo.data) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(logo.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [logo.data]);
  return wanted ? url : null;
}

// A line's quantity without trailing zeros of the six decimals the column keeps.
const plain = (value: string | null): string => (value === null ? '' : value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

export function QuoteDocumentPage() {
  const t = useTranslations('quoteDocument');
  const f = useFormat();
  // The token follows the address: a hash-only change in this tab shows the other quote (the query is keyed by the token).
  const token = useSyncExternalStore(subscribeToHash, quoteTokenOfHash, quoteTokenOfHash);
  const page = useQuery({ queryKey: ['quote-document', token], queryFn: () => load(token as string), enabled: token !== null, retry: false });
  usePrintInLight();
  const doc = page.data;
  const logoUrl = useLogoUrl(token, doc?.hasLogo === true);
  const loading = token !== null && page.isLoading;
  const money = (value: string) => f.money(value, 'VND');
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 print:max-w-none print:p-0" data-testid="quote-document">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Logo />
        {doc && (
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            {t('print')}
          </Button>
        )}
      </div>
      {loading && <Spinner />}
      {token === null || (!loading && !doc && !page.error) ? <p className="rounded-md border border-border p-6 text-sm text-muted-foreground">{t('invalid')}</p> : null}
      {page.error && <ErrorText>{errorMessage(page.error)}</ErrorText>}
      {doc && (
        <article className="space-y-6 text-sm" aria-label={t('title', { number: doc.number })}>
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-0.5">
              {logoUrl && <img src={logoUrl} alt="" className="mb-2 max-h-16 w-auto max-w-48 object-contain" data-testid="quote-logo" />}
              <h1 className="text-lg font-semibold text-foreground">{doc.seller.name}</h1>
              {doc.seller.taxCode && <p className="text-muted-foreground">{t('taxCode', { code: doc.seller.taxCode })}</p>}
              {doc.seller.address && <p className="text-muted-foreground">{doc.seller.address}</p>}
              {doc.seller.phone && <p className="text-muted-foreground">{t('phone', { phone: doc.seller.phone })}</p>}
              {doc.seller.email && <p className="text-muted-foreground">{doc.seller.email}</p>}
            </div>
            <div className="space-y-0.5 text-right">
              <h2 className="text-xl font-semibold uppercase tracking-wide text-foreground">{t('heading')}</h2>
              <p className="tabular-nums text-muted-foreground">{t('number', { number: doc.revision > 1 ? `${doc.number}-R${doc.revision}` : doc.number })}</p>
              <p className="text-muted-foreground">{t('sentOn', { date: f.date(vietnamToday(new Date(doc.sentAt))) })}</p>
              <p className={doc.expired ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                {doc.expired ? t('expired', { date: f.date(doc.validUntil) }) : t('validUntil', { date: f.date(doc.validUntil) })}
              </p>
              {doc.status === 'accepted' && <p className="font-medium text-foreground">{t('accepted')}</p>}
              {doc.status === 'declined' && <p className="font-medium text-foreground">{t('declined')}</p>}
            </div>
          </header>

          <section className="space-y-0.5 rounded-md border border-border p-4 print:break-inside-avoid">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">{t('buyer')}</h3>
            <p className="font-medium text-foreground">{doc.buyer.name}</p>
            {doc.buyer.taxCode && <p className="text-muted-foreground">{t('taxCode', { code: doc.buyer.taxCode })}</p>}
            {doc.buyer.address && <p className="text-muted-foreground">{doc.buyer.address}</p>}
          </section>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left" aria-label={t('lines')}>
              <thead>
                <tr className="border-b-2 border-border text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-2 font-medium">{t('columns.no')}</th>
                  <th className="py-2 pr-2 font-medium">{t('columns.description')}</th>
                  <th className="py-2 pr-2 text-right font-medium">{t('columns.quantity')}</th>
                  <th className="py-2 pr-2 font-medium">{t('columns.unit')}</th>
                  <th className="py-2 pr-2 text-right font-medium">{t('columns.unitPrice')}</th>
                  <th className="py-2 pr-2 text-right font-medium">{t('columns.discount')}</th>
                  <th className="py-2 pr-2 text-right font-medium">{t('columns.vat')}</th>
                  <th className="py-2 text-right font-medium">{t('columns.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((l) =>
                  l.kind === 'text' ? (
                    <tr key={l.lineNo} className="border-b border-border">
                      <td className="py-2 pr-2 align-top tabular-nums">{l.lineNo}</td>
                      <td colSpan={7} className="py-2 italic text-muted-foreground break-words whitespace-pre-line">
                        {l.description}
                      </td>
                    </tr>
                  ) : (
                    <tr key={l.lineNo} className="border-b border-border print:break-inside-avoid">
                      <td className="py-2 pr-2 align-top tabular-nums">{l.lineNo}</td>
                      <td className="py-2 pr-2 align-top break-words">{l.description}</td>
                      <td className="py-2 pr-2 text-right align-top tabular-nums">{plain(l.quantity)}</td>
                      <td className="py-2 pr-2 align-top">{l.unit ?? ''}</td>
                      <td className="py-2 pr-2 text-right align-top tabular-nums">{l.unitPrice === null ? '' : f.decimal(plain(l.unitPrice), 8)}</td>
                      <td className="py-2 pr-2 text-right align-top tabular-nums">{l.discountPercent !== '0' ? `${plain(l.discountPercent)}%` : ''}</td>
                      <td className="py-2 pr-2 text-right align-top tabular-nums">{l.vatRate ?? ''}</td>
                      <td className="py-2 text-right align-top tabular-nums">{money(l.amount)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>

          <dl className="ml-auto grid max-w-xs grid-cols-2 gap-x-4 gap-y-1 tabular-nums print:break-inside-avoid" data-testid="quote-document-totals">
            <dt className="text-muted-foreground">{t('subtotal')}</dt>
            <dd className="text-right">{money(doc.subtotal)}</dd>
            <dt className="text-muted-foreground">{t('vatAmount')}</dt>
            <dd className="text-right">{money(doc.vatAmount)}</dd>
            <dt className="font-semibold text-foreground">{t('total')}</dt>
            <dd className="text-right font-semibold text-foreground">{money(doc.total)}</dd>
          </dl>

          {doc.notes && (
            <section className="space-y-1 print:break-inside-avoid">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">{t('notes')}</h3>
              <p className="break-words whitespace-pre-line">{doc.notes}</p>
            </section>
          )}
          {doc.terms && (
            <section className="space-y-1 print:break-inside-avoid">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">{t('terms')}</h3>
              <p className="break-words whitespace-pre-line">{doc.terms}</p>
            </section>
          )}
          {doc.seller.bankNote && (
            <section className="space-y-1 print:break-inside-avoid">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">{t('bank')}</h3>
              <p className="break-words whitespace-pre-line">{doc.seller.bankNote}</p>
            </section>
          )}
        </article>
      )}
    </main>
  );
}
