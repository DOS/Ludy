// SPDX-License-Identifier: AGPL-3.0-only
// The quotes of a deal and the quote editor (#2693, docs/plan/crm-quotes.md step Q1). "Tạo báo giá" makes a draft for the deal's customer in one click;
// the editor adds lines (typed, copied from an earlier quote to the customer, or started from the price the customer paid last time), shows the totals
// the way the server computes them, and saves. Nothing here sends a quote: sending is a later step, and a person always does it. The core works with AI
// off; the sales coworker's suggested lines come in a later step and will be applied by a person line by line.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { QUOTE_DESCRIPTION_MAX, QUOTE_LINES_MAX, QUOTE_TEXT_MAX, QUOTE_UNIT_MAX, zQuoteLineInput, type Deal, type Quote, type QuoteHint, type QuoteLineInput, type QuoteLinkCreated, type QuoteStatus, type QuoteSummary } from '@crove/kernel-contract';
import { computeLineTotals, sumLineTotals } from '@crove/l10n-vn';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { NewLink, QuoteLinks, QuoteSendPanel, QuoteSettingsForm, quoteLabel, refreshQuoteQueries } from './quote-send.tsx';
import { ErrorText, Field } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatDate, formatMoney } from '../lib/format.ts';

const refreshQuotes = refreshQuoteQueries;

// The rates a line may carry (the set of @crove/l10n-vn's line rule); the server checks them again.
const VAT_RATES = ['0%', '5%', '8%', '10%', 'KCT', 'KKKNT'] as const;

interface LineDraft {
  key: number;
  kind: 'item' | 'text';
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  vatRate: string;
  stockItemId: string | null;
}

let nextKey = 1;
const blank = (kind: 'item' | 'text', vatRate: string): LineDraft => ({ key: nextKey++, kind, description: '', unit: '', quantity: '1', unitPrice: '', discount: '', vatRate, stockItemId: null });
const decimal = (value: string): string => value.trim().replace(',', '.');

function fromQuote(quote: Quote): LineDraft[] {
  return quote.lines.map((l) => ({
    key: nextKey++,
    kind: l.kind,
    description: l.description,
    unit: l.unit ?? '',
    quantity: l.quantity ?? '1',
    unitPrice: l.unitPrice ?? '',
    discount: l.discountPercent === '0' ? '' : l.discountPercent,
    vatRate: l.vatRate ?? '10%',
    stockItemId: l.stockItemId,
  }));
}

function toInput(line: LineDraft): QuoteLineInput {
  if (line.kind === 'text') return { kind: 'text', description: line.description.trim() };
  return {
    kind: 'item',
    description: line.description.trim(),
    unit: line.unit.trim() || null,
    quantity: decimal(line.quantity),
    unitPrice: decimal(line.unitPrice),
    ...(line.discount.trim() ? { discountPercent: decimal(line.discount) } : {}),
    vatRate: line.vatRate,
    stockItemId: line.stockItemId,
  };
}

const statusVariant = (status: QuoteStatus, expired: boolean): 'outline' | 'warning' | 'success' | 'destructive' | 'secondary' =>
  expired ? 'warning' : status === 'accepted' ? 'success' : status === 'declined' ? 'destructive' : status === 'draft' ? 'outline' : 'secondary';

function QuoteEditor({ quote, canEdit, onClose }: { quote: Quote; canEdit: boolean; onClose: () => void }) {
  const t = useTranslations('quotes');
  const { locale } = useLocaleSetting();
  const readOnly = quote.status !== 'draft';
  const defaults = useQuery(orpc.crm.quotes.defaults.queryOptions({ input: { partyId: quote.partyId } }));
  const earlier = useQuery({ ...orpc.crm.quotes.list.queryOptions({ input: { partyId: quote.partyId, limit: 20 } }), enabled: !readOnly });
  const [validUntil, setValidUntil] = useState(quote.validUntil);
  const [notes, setNotes] = useState(quote.notes ?? '');
  const [terms, setTerms] = useState(quote.terms ?? '');
  const [lines, setLines] = useState<LineDraft[]>(() => fromQuote(quote));
  const [invalid, setInvalid] = useState<number | null>(null);
  const [sent, setSent] = useState<{ link: QuoteLinkCreated | null; mailed: string | null } | null>(null);
  // What the form held when it opened: a send is of what was saved, so it waits while the form differs.
  const [opened] = useState(() => JSON.stringify([quote.validUntil, (quote.notes ?? '').trim(), (quote.terms ?? '').trim(), fromQuote(quote).map(toInput)]));
  const vat = defaults.data?.defaultVat ?? '10%';
  const hints: readonly QuoteHint[] = defaults.data?.hints ?? [];
  const save = useMutation(
    orpc.crm.quotes.save.mutationOptions({
      // The editor stays open, keyed by the quote's version, so it reopens on the saved quote and the send panel can follow.
      onSuccess: refreshQuotes,
      // A refused save (someone saved first) reads the quote again; the editor is keyed by the quote's version.
      onError: refreshQuotes,
    }),
  );
  const copy = useMutation({
    mutationFn: (quoteId: string) => queryClient.fetchQuery(orpc.crm.quotes.get.queryOptions({ input: { quoteId } })),
    onSuccess: (source) => setLines((current) => [...current, ...fromQuote(source)].slice(0, QUOTE_LINES_MAX)),
  });

  const patch = (key: number, change: Partial<LineDraft>) => setLines((current) => current.map((l) => (l.key === key ? { ...l, ...change } : l)));
  const move = (index: number, by: -1 | 1) =>
    setLines((current) => {
      const next = [...current];
      const target = index + by;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target] as LineDraft, next[index] as LineDraft];
      return next;
    });
  // Picking a description the customer was quoted before offers that price, unit and rate; a person edits them.
  const describe = (line: LineDraft, description: string) => {
    const hint = hints.find((h) => h.description.toLowerCase() === description.trim().toLowerCase());
    patch(line.key, hint && !line.unitPrice ? { description, unit: line.unit || (hint.unit ?? ''), unitPrice: hint.unitPrice, vatRate: hint.vatRate } : { description });
  };

  // The totals as the server will compute them (the same rule), shown while typing.
  const computed = lines.map((l) => (l.kind === 'text' ? { amount: '0', vatAmount: '0' } : computeLineTotals({ quantity: decimal(l.quantity), unitPrice: decimal(l.unitPrice), discountPercent: decimal(l.discount) || '0', vatRate: l.vatRate })));
  const totals = sumLineTotals(computed);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const bad = lines.findIndex((l) => !zQuoteLineInput.safeParse(toInput(l)).success);
    setInvalid(bad < 0 ? null : bad + 1);
    if (bad >= 0) return;
    save.mutate({ quoteId: quote.id, version: quote.version, validUntil, notes: notes.trim() || null, terms: terms.trim() || null, lines: lines.map(toInput) });
  };
  const dirty = JSON.stringify([validUntil, notes.trim(), terms.trim(), lines.map(toInput)]) !== opened;
  const others = (earlier.data?.items ?? []).filter((q) => q.id !== quote.id && q.lineCount > 0);
  const money = (value: string) => formatMoney(value, locale, 'VND');

  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-lg border border-border p-4" aria-label={t('editor.title')} data-testid="quote-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">{quote.number ? t('editor.titleNumbered', { number: quote.number }) : t('editor.title')}</h3>
        <Badge variant={statusVariant(quote.status, quote.expired)}>{quote.expired ? t('status.expired') : t(`status.${quote.status}`)}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t('editor.for', { party: quote.partyName, deal: quote.dealTitle })}</p>
      {readOnly && <p className="text-sm text-muted-foreground">{t('editor.readOnly')}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('editor.validUntil')}>{(c) => <Input {...c} type="date" required disabled={readOnly} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />}</Field>
        {!readOnly && others.length > 0 && (
          <Field label={t('editor.copyFrom')}>
            {(c) => (
              <NativeSelect {...c} className="w-full" value="" disabled={copy.isPending || lines.length >= QUOTE_LINES_MAX} onChange={(e) => e.target.value && copy.mutate(e.target.value)}>
                <option value="">{t('editor.copyPick')}</option>
                {others.map((q) => (
                  <option key={q.id} value={q.id}>
                    {t('editor.copyOption', { date: formatDate(q.createdAt.slice(0, 10), locale), count: String(q.lineCount), total: money(q.total) })}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
      </div>

      <datalist id="quote-hints">
        {hints.map((h) => (
          <option key={h.description} value={h.description} />
        ))}
      </datalist>
      <ol className="space-y-3" aria-label={t('editor.lines')}>
        {lines.map((line, i) => (
          <li key={line.key} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-6" data-testid="quote-line">
            <Field label={t('editor.description', { n: String(i + 1) })} className="sm:col-span-6">
              {(c) => (
                <Input {...c} list={line.kind === 'item' ? 'quote-hints' : undefined} maxLength={QUOTE_DESCRIPTION_MAX} disabled={readOnly} value={line.description} onChange={(e) => describe(line, e.target.value)} />
              )}
            </Field>
            {line.kind === 'item' && (
              <>
                <Field label={t('editor.quantity')} className="sm:col-span-1">
                  {(c) => <Input {...c} inputMode="decimal" disabled={readOnly} value={line.quantity} onChange={(e) => patch(line.key, { quantity: e.target.value })} />}
                </Field>
                <Field label={t('editor.unit')} className="sm:col-span-1">
                  {(c) => <Input {...c} maxLength={QUOTE_UNIT_MAX} disabled={readOnly} value={line.unit} onChange={(e) => patch(line.key, { unit: e.target.value })} />}
                </Field>
                <Field label={t('editor.unitPrice')} className="sm:col-span-2">
                  {(c) => <Input {...c} inputMode="decimal" disabled={readOnly} value={line.unitPrice} onChange={(e) => patch(line.key, { unitPrice: e.target.value })} />}
                </Field>
                <Field label={t('editor.discount')} className="sm:col-span-1">
                  {(c) => <Input {...c} inputMode="decimal" disabled={readOnly} value={line.discount} onChange={(e) => patch(line.key, { discount: e.target.value })} />}
                </Field>
                <Field label={t('editor.vat')} className="sm:col-span-1">
                  {(c) => (
                    <NativeSelect {...c} className="w-full" disabled={readOnly} value={line.vatRate} onChange={(e) => patch(line.key, { vatRate: e.target.value })}>
                      {(VAT_RATES as readonly string[]).includes(line.vatRate) ? null : <option value={line.vatRate}>{line.vatRate}</option>}
                      {VAT_RATES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              </>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-6">
              <span className="text-sm tabular-nums text-muted-foreground">{line.kind === 'item' ? t('editor.lineAmount', { amount: money(computed[i]?.amount ?? '0') }) : t('editor.textLine')}</span>
              {!readOnly && (
                <div className="flex gap-1">
                  <Button type="button" size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('editor.moveUp', { n: String(i + 1) })}>
                    {t('editor.up')}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={i === lines.length - 1} onClick={() => move(i, 1)} aria-label={t('editor.moveDown', { n: String(i + 1) })}>
                    {t('editor.down')}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))} aria-label={t('editor.remove', { n: String(i + 1) })}>
                    {t('editor.removeLine')}
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {lines.length === 0 && <p className="text-sm text-muted-foreground">{t('editor.noLines')}</p>}
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={lines.length >= QUOTE_LINES_MAX} onClick={() => setLines((current) => [...current, blank('item', vat)])}>
            {t('editor.addItem')}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={lines.length >= QUOTE_LINES_MAX} onClick={() => setLines((current) => [...current, blank('text', vat)])}>
            {t('editor.addText')}
          </Button>
        </div>
      )}

      <dl className="ml-auto grid max-w-xs grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums" data-testid="quote-totals">
        <dt className="text-muted-foreground">{t('editor.subtotal')}</dt>
        <dd className="text-right">{money(totals.subtotal)}</dd>
        <dt className="text-muted-foreground">{t('editor.vatAmount')}</dt>
        <dd className="text-right">{money(totals.vatAmount)}</dd>
        <dt className="font-medium">{t('editor.total')}</dt>
        <dd className="text-right font-medium">{money(totals.total)}</dd>
      </dl>

      <Field label={t('editor.notes')}>{(c) => <Textarea {...c} rows={2} maxLength={QUOTE_TEXT_MAX} disabled={readOnly} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
      <Field label={t('editor.terms')}>{(c) => <Textarea {...c} rows={3} maxLength={QUOTE_TEXT_MAX} disabled={readOnly} value={terms} onChange={(e) => setTerms(e.target.value)} />}</Field>

      {readOnly && quote.buyer && (
        <p className="text-sm text-muted-foreground" data-testid="quote-buyer">
          {t('editor.buyer', { name: quote.buyer.name })}
        </p>
      )}
      {sent?.link && <NewLink quote={quote} link={sent.link} />}
      {sent?.mailed !== undefined && sent.mailed !== null && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm text-foreground" data-testid="quote-mailed">
          {sent.mailed ? t('send.mailedTo', { to: sent.mailed }) : t('send.mailed')}
        </p>
      )}
      {!readOnly && canEdit && !sent && <QuoteSendPanel quote={quote} dirty={dirty} onSent={(done) => setSent({ link: done.link, mailed: done.mailed })} />}
      {readOnly && <QuoteLinks quote={quote} canEdit={canEdit} />}
      {invalid !== null && <ErrorText>{t('editor.lineInvalid', { n: String(invalid) })}</ErrorText>}
      {(save.error || copy.error) && <ErrorText>{errorMessage(save.error ?? copy.error)}</ErrorText>}
      <div className="flex flex-wrap gap-2">
        {!readOnly && (
          <Button type="submit" loading={save.isPending}>
            {t('editor.save')}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onClose}>
          {readOnly ? t('editor.close') : t('editor.cancel')}
        </Button>
      </div>
    </form>
  );
}

function QuoteRow({ quote, canEdit, onOpen }: { quote: QuoteSummary; canEdit: boolean; onOpen: () => void }) {
  const t = useTranslations('quotes');
  const { locale } = useLocaleSetting();
  const remove = useMutation(orpc.crm.quotes.deleteDraft.mutationOptions({ onSuccess: refreshQuotes }));
  const revise = useMutation(orpc.crm.quotes.revise.mutationOptions({ onSuccess: refreshQuotes }));
  const label = quote.number ? quoteLabel(quote) : t('draftLabel');
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm" data-testid="quote-row">
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium text-foreground">
          {label} <Badge variant={statusVariant(quote.status, quote.expired)}>{quote.expired ? t('status.expired') : t(`status.${quote.status}`)}</Badge>
        </p>
        {quote.firstViewedAt && (
          <p className="text-xs text-muted-foreground" data-testid="quote-viewed">
            {t('row.viewed', { time: formatDate(quote.firstViewedAt.slice(0, 10), locale) })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('row.meta', { date: formatDate(quote.validUntil, locale), count: String(quote.lineCount), total: formatMoney(quote.total, locale, 'VND') })}</p>
        {(remove.error || revise.error) && <ErrorText>{errorMessage(remove.error ?? revise.error)}</ErrorText>}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" onClick={onOpen}>
          {quote.status === 'draft' && canEdit ? t('row.edit') : t('row.view')}
        </Button>
        {canEdit && quote.status === 'draft' && (
          <ConfirmDialog
            render={
              <Button size="sm" variant="outline">
                {t('row.delete')}
              </Button>
            }
            title={t('row.deleteTitle')}
            description={t('row.deleteDescription')}
            confirm={t('row.deleteYes')}
            destructive
            onConfirm={() => remove.mutate({ quoteId: quote.id })}
          >
            {t('row.delete')}
          </ConfirmDialog>
        )}
        {canEdit && (quote.status === 'sent' || quote.status === 'declined') && (
          <Button size="sm" variant="outline" loading={revise.isPending} onClick={() => revise.mutate({ quoteId: quote.id })}>
            {t('row.revise')}
          </Button>
        )}
      </div>
    </li>
  );
}

// The deal's quotes tab: its quotes newest first, "Tạo báo giá" for those who write, and the editor of the one opened.
export function DealQuotes({ deal, canEdit, onClose }: { deal: Deal; canEdit: boolean; onClose?: () => void }) {
  const t = useTranslations('quotes');
  const quotes = useQuery(orpc.crm.quotes.byDeal.queryOptions({ input: { dealId: deal.id } }));
  const [openId, setOpenId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const org = useQuery(orpc.org.get.queryOptions());
  const canManage = org.data?.role === 'owner' || org.data?.role === 'admin';
  const opened = useQuery({ ...orpc.crm.quotes.get.queryOptions({ input: { quoteId: openId ?? '' } }), enabled: openId !== null });
  const create = useMutation(
    orpc.crm.quotes.save.mutationOptions({
      onSuccess: (quote) => {
        refreshQuotes();
        setOpenId(quote.id);
      },
    }),
  );
  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t('title', { deal: deal.title })} data-testid="deal-quotes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">{t('title', { deal: deal.title })}</h3>
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setSettings((v) => !v)} aria-expanded={settings}>
              {t('settings.open')}
            </Button>
          )}
          {canEdit && (
            <Button size="sm" loading={create.isPending} onClick={() => create.mutate({ dealId: deal.id, lines: [] })}>
              {t('create')}
            </Button>
          )}
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('editor.close')}
            </Button>
          )}
        </div>
      </div>
      {settings && canManage && <QuoteSettingsForm onDone={() => setSettings(false)} />}
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      {quotes.error ? (
        <ErrorText>{errorMessage(quotes.error)}</ErrorText>
      ) : quotes.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{canEdit ? t('emptyHint') : t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {quotes.data?.map((q) => (
            <QuoteRow key={q.id} quote={q} canEdit={canEdit} onOpen={() => setOpenId(q.id)} />
          ))}
        </ul>
      )}
      {openId !== null && opened.error && <ErrorText>{errorMessage(opened.error)}</ErrorText>}
      {openId !== null && opened.data && <QuoteEditor key={`${opened.data.id}:${opened.data.version}`} quote={opened.data} canEdit={canEdit} onClose={() => setOpenId(null)} />}
    </section>
  );
}
