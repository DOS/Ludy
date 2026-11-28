// SPDX-License-Identifier: AGPL-3.0-only
// "Ask the books in plain words" (#5181), a card on the Kế toán Tổng quan: the owner types a question ("Tháng 10 lãi bao nhiêu?") or picks one of the reports below the box. The accounting coworker only chooses which report
// of a fixed list answers the question and for which kind of period; the server resolves the period, reads the report as the member who asks and gives back every figure (finance.askBooks.ask), so the card shows the
// figures, the period and a link to the full report. A question that fits no report, and every state where the coworker could not be asked, show the same fixed list of what can be asked. With AI off the question box is
// hidden and the list of reports below it does the same job; the coworker's one short sentence is shown only when it came back and passed every check. Nothing here writes: the card is a read.
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useLocale, useTranslations } from 'use-intl';
import {
  ASK_BOOKS_ENTRIES,
  ASK_BOOKS_QUESTION_MAX,
  askBooksPickOptions,
  type AskBooksAnswer,
  type AskBooksCard,
  type AskBooksEntry,
  type AskBooksFigureKey,
  type AskBooksRelativeToken,
  type FinanceAskBooksInput,
} from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';

// What a click on a report of the list asks for: the period word a person most likely wants of it (code resolves it, and the card lets them pick another).
const DEFAULT_PERIOD: Record<AskBooksEntry, AskBooksRelativeToken> = {
  profit_loss: 'last_month',
  cash_balance: 'as_of_today',
  receivables_top: 'as_of_today',
  payables_top: 'as_of_today',
  receivables_aging: 'as_of_today',
  payables_aging: 'as_of_today',
  customers_top_sales: 'this_year',
  suppliers_top_purchases: 'this_year',
  vat_position: 'last_month',
  stock_value: 'as_of_today',
};

// 44 px high on every screen: a target a thumb has to hit.
const LINK_CLASS = 'inline-flex min-h-11 items-center text-sm text-link hover:underline';

const localToday = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

function ReportLink({ slug, card, children }: { slug: string; card: AskBooksCard; children: string }) {
  const params = { slug };
  switch (card.entry) {
    case 'profit_loss':
    case 'cash_balance':
      return <Link to="/o/$slug/ledger" params={params} search={{ report: 'statements' as const, period: card.period.value }} className={LINK_CLASS}>{children}</Link>;
    case 'receivables_top':
    case 'payables_top':
      return <Link to="/o/$slug/ledger" params={params} search={{ report: 'parties' as const, period: card.period.value }} className={LINK_CLASS}>{children}</Link>;
    case 'receivables_aging':
      return <Link to="/o/$slug/customers" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'payables_aging':
    case 'suppliers_top_purchases':
      return <Link to="/o/$slug/vendors" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'customers_top_sales':
      return <Link to="/o/$slug/sales-invoices" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'vat_position':
      return <Link to="/o/$slug/vat" params={params} search={{ period: card.period.value }} className={LINK_CLASS}>{children}</Link>;
    case 'stock_value':
      return <Link to="/o/$slug/stock" params={params} className={LINK_CLASS}>{children}</Link>;
  }
}

// The answer under the box: the fixed list when nothing fits, the period picker when the period is not clear, or the card with its figures, its largest parties, what it leaves out and the link to the full report. Every figure
// on it was computed by the server; the coworker's sentence is shown only when it came back and passed every check. Exported so the card can be rendered on its own (the screen test does).
export function AskBooksAnswerView({ slug, answer, onPickPeriod }: { slug: string; answer: AskBooksAnswer; onPickPeriod: (entry: AskBooksEntry, value: string) => void }) {
  const t = useTranslations('financeAskBooks');
  const f = useFormat();
  const periodLabel = (value: string): string => {
    if (/^\d{4}$/.test(value)) return t('period.year', { year: value });
    if (value.includes('-Q')) return t('period.quarter', { quarter: value.slice(6), year: value.slice(0, 4) });
    return t('period.month', { month: String(Number(value.slice(5))), year: value.slice(0, 4) });
  };
  // The periods to change to, with the one on the card always among them (a year or a quarter older than the list goes back would otherwise show as the first option).
  const options = (entry: AskBooksEntry, current: AskBooksCard['period']) => {
    const list = askBooksPickOptions(entry, localToday());
    return list.some((o) => o.value === current.value) ? list : [{ kind: current.kind, value: current.value }, ...list];
  };
  // A total and an advance are named by the entry they belong to (only the entries that have one); every other figure has one name.
  const totalLabel = (entry: AskBooksEntry): string => {
    switch (entry) {
      case 'receivables_top':
        return t('total.receivables_top');
      case 'payables_top':
        return t('total.payables_top');
      case 'customers_top_sales':
        return t('total.customers_top_sales');
      case 'suppliers_top_purchases':
        return t('total.suppliers_top_purchases');
      default:
        return t('figure.overdue');
    }
  };
  const advancesLabel = (entry: AskBooksEntry): string => {
    switch (entry) {
      case 'payables_top':
        return t('advances.payables_top');
      case 'receivables_aging':
        return t('advances.receivables_aging');
      case 'payables_aging':
        return t('advances.payables_aging');
      default:
        return t('advances.receivables_top');
    }
  };
  const topTitle = (entry: AskBooksEntry): string => {
    switch (entry) {
      case 'payables_top':
        return t('top.payables_top');
      case 'receivables_aging':
        return t('top.receivables_aging');
      case 'payables_aging':
        return t('top.payables_aging');
      case 'customers_top_sales':
        return t('top.customers_top_sales');
      case 'suppliers_top_purchases':
        return t('top.suppliers_top_purchases');
      default:
        return t('top.receivables_top');
    }
  };
  const figureLabel = (card: AskBooksCard, key: AskBooksFigureKey): string => (key === 'total' ? totalLabel(card.entry) : key === 'advances' ? advancesLabel(card.entry) : t(`figure.${key}`));
  const pickPeriod = onPickPeriod;
  return (
    <>
      {answer.state === 'none' && (
        <div>
          <p className="text-sm font-medium text-foreground">{t(`none.${answer.ai === 'used' || answer.ai === 'picked' ? 'noMatch' : answer.ai}`)}</p>
          <p className="mt-1 text-xs text-subtle-foreground">{t('none.canAsk')}</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-foreground">
            {ASK_BOOKS_ENTRIES.map((entry) => (
              <li key={entry}>{t(`entry.${entry}`)}</li>
            ))}
          </ul>
        </div>
      )}
      {answer.state === 'pick_period' && answer.pick && (
        <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          <span>{t('period.pick', { report: t(`entry.${answer.pick.entry}`) })}</span>
          <NativeSelect className="w-48 [&_select]:min-h-11" value="" onChange={(e) => answer.pick && e.target.value !== '' && pickPeriod(answer.pick.entry, e.target.value)} data-testid="ask-books-pick-period">
            <NativeSelectOption value="">{t('period.choose')}</NativeSelectOption>
            {answer.pick.options.map((o) => (
              <NativeSelectOption key={`${o.kind}:${o.value}`} value={o.value}>{periodLabel(o.value)}</NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      )}
      {answer.state === 'card' && answer.card && (
        <div data-testid="ask-books-card">
          {answer.lead && (
            <div className="mb-3 rounded-md bg-muted/50 p-3" data-testid="ask-books-lead">
              <p className="text-sm text-foreground">{answer.lead}</p>
              <p className="mt-1 text-xs text-subtle-foreground">{t('lead.note')}</p>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">{`${t(`entry.${answer.card.entry}`)}: ${periodLabel(answer.card.period.value)}`}</h3>
            <label className="flex items-center gap-2 text-xs text-subtle-foreground">
              <span className="whitespace-nowrap">{t('period.change')}</span>
              <NativeSelect className="w-40 [&_select]:min-h-11" value={answer.card.period.value} onChange={(e) => answer.card && pickPeriod(answer.card.entry, e.target.value)} data-testid="ask-books-change-period">
                {options(answer.card.entry, answer.card.period).map((o) => (
                  <NativeSelectOption key={`${o.kind}:${o.value}`} value={o.value}>{periodLabel(o.value)}</NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </div>
          {answer.card.period.partial && <p className="mt-1 text-xs text-subtle-foreground">{t('period.partial')}</p>}
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {answer.card.figures.map((fig) => (
              <div key={fig.key} className="flex items-baseline justify-between gap-3 border-b border-border py-1">
                <dt className="text-sm text-muted-foreground">{figureLabel(answer.card as AskBooksCard, fig.key)}</dt>
                <dd className="text-sm font-medium text-foreground tabular-nums" data-testid={`ask-books-figure-${fig.key}`}>{f.money(fig.amount)}</dd>
              </div>
            ))}
          </dl>
          {answer.card.top.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-muted-foreground">{topTitle(answer.card.entry)}</p>
              <ol className="mt-1">
                {answer.card.top.map((row, index) => (
                  <li key={`${index}:${row.name ?? ''}`} className="flex items-baseline justify-between gap-3 border-b border-border py-1 text-sm">
                    <span className="min-w-0 truncate text-foreground">{row.name ?? t('top.unnamed')}</span>
                    <span className="font-medium text-foreground tabular-nums">{f.money(row.amount)}</span>
                  </li>
                ))}
              </ol>
              {answer.card.partyCount > answer.card.top.length && <p className="mt-1 text-xs text-subtle-foreground">{t('top.more', { count: String(answer.card.partyCount - answer.card.top.length) })}</p>}
            </div>
          )}
          {(answer.card.entry === 'customers_top_sales' || answer.card.entry === 'suppliers_top_purchases') && <p className="mt-2 text-xs text-subtle-foreground">{t('notes.invoiced')}</p>}
          {answer.card.notes.map((note) => (
            <p key={note} className="mt-2 text-xs text-warning">{t(`notes.${note}`)}</p>
          ))}
          <div className="mt-2">
            <ReportLink slug={slug} card={answer.card}>{t(`open.${answer.card.entry}`)}</ReportLink>
          </div>
        </div>
      )}
    </>
  );
}

export function AskBooksPanel({ slug, legalEntityId, ready }: { slug: string; legalEntityId: string | undefined; ready: boolean }) {
  const t = useTranslations('financeAskBooks');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const questionId = useId();
  const [question, setQuestion] = useState('');
  const aiOn = getConfig().aiEnabled === true;
  const ask = useMutation(orpc.financeAskBooks.ask.mutationOptions());
  const entityPart = legalEntityId ? { legalEntityId } : {};

  const send = (input: FinanceAskBooksInput) => ask.mutate(input);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (text === '' || !ready) return;
    send({ question: text, lang, ...entityPart });
  };
  const pickRelative = (entry: AskBooksEntry) => send({ pick: { entry, period: { kind: 'relative', token: DEFAULT_PERIOD[entry] } }, lang, ...entityPart });
  const pickPeriod = (entry: AskBooksEntry, value: string) => send({ pick: { entry, period: { kind: 'period', value } }, lang, ...entityPart });

  const answer: AskBooksAnswer | undefined = ask.data;

  return (
    <section className="mt-6" aria-labelledby="ask-books-title" data-testid="ask-books">
      <Card className="p-4">
        <h2 id="ask-books-title" className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-xs text-subtle-foreground">{aiOn ? t('subtitle') : t('subtitleOff')}</p>
        {aiOn && (
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={submit}>
            <div className="min-w-0 flex-1 basis-64">
              <label htmlFor={questionId} className="text-xs text-subtle-foreground">{t('label')}</label>
              <Input id={questionId} value={question} maxLength={ASK_BOOKS_QUESTION_MAX} placeholder={t('placeholder')} onChange={(e) => setQuestion(e.target.value)} autoComplete="off" data-testid="ask-books-question" />
            </div>
            <Button type="submit" className="min-h-11" disabled={!ready || ask.isPending || question.trim() === ''} data-testid="ask-books-send">
              {ask.isPending ? t('asking') : t('ask')}
            </Button>
          </form>
        )}
        <div className="mt-3">
          <p className="text-xs text-subtle-foreground">{t('listTitle')}</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {ASK_BOOKS_ENTRIES.map((entry) => (
              <li key={entry}>
                <Button type="button" variant="outline" className="min-h-11" disabled={!ready || ask.isPending} onClick={() => pickRelative(entry)} data-testid={`ask-books-entry-${entry}`}>
                  {t(`entry.${entry}`)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
        {ask.isError && (
          <div className="mt-3">
            <ErrorText>{errorMessage(ask.error)}</ErrorText>
          </div>
        )}
        {/* Mounted before the answer comes, so a screen reader announces it when it fills in. */}
        <div className="mt-3" role="status" aria-live="polite" data-testid="ask-books-answer">
          {answer && <AskBooksAnswerView slug={slug} answer={answer} onPickPeriod={pickPeriod} />}
        </div>
      </Card>
    </section>
  );
}
