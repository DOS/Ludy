// SPDX-License-Identifier: AGPL-3.0-only
// The year-end checklist card on the Kế toán screen (#5283): for the chosen legal entity and a year (the current one from October, else the one before), what is still open before the year can be
// closed and its returns filed. Every state comes from the books (finance.year_end) and has fixed text and a link to the screen where a person does it; every due date comes from the tax calendar and is
// shown here by code, never by the model. The card shows all the items and does nothing itself. The finance coworker's short note, and the order it puts the items to do now in, are read from the same
// items by the model and hidden when there is no model, the AI budget is spent or its answer was refused, so the checklist never waits for it and looks the same with AI off, only in the fixed order
// and without the note.
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useLocale, useTranslations } from 'use-intl';
import type { YearEndItem, YearEndKey } from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { cn } from '@ludy/ui/lib/utils';
import { CardSkeleton, ErrorText } from './ui.tsx';
import { useChosenEntity } from './entity-switcher.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { COUNTED_ITEMS, closeYears, defaultCloseYear, isReady, orderYearEndItems } from '../lib/year-end.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';

// 44 px high on every screen: a link of the checklist is a target a thumb has to hit.
const LINK_CLASS = 'inline-flex min-h-11 items-center text-sm text-link hover:underline';

// The screen where a person does the item: the Overview marks a return as filed from its list of what is due.
function ItemLink({ item, slug, children }: { item: YearEndItem; slug: string; children: ReactNode }) {
  const params = { slug };
  switch (item.key) {
    case 'balances':
    case 'closing_entry':
    case 'months_locked':
      return <Link to="/o/$slug/ledger" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'depreciation':
      return <Link to="/o/$slug/fixed-assets" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'stock_count':
      return <Link to="/o/$slug/stock" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'statements':
    case 'cit':
    case 'pit':
      return <Link to="/o/$slug/overview" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'household_return':
      return <Link to="/o/$slug/household" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'einvoice_series':
      return <Link to="/o/$slug/settings/connections" params={params} className={LINK_CLASS}>{children}</Link>;
  }
}

// The items that have a legal due date, and so a line naming its legal basis.
const DUE_BASIS = ['statements', 'cit', 'pit', 'household_return'] as const;
type BasisKey = (typeof DUE_BASIS)[number];
const basisOf = (key: YearEndKey): BasisKey | null => (DUE_BASIS as readonly string[]).includes(key) ? (key as BasisKey) : null;

function Row({ item, slug }: { item: YearEndItem; slug: string }) {
  const t = useTranslations('financeOverview.yearEnd');
  const f = useFormat();
  const ready = isReady(item);
  const counted = COUNTED_ITEMS.includes(item.key);
  const status = item.state === 'done' ? 'done' : item.state === 'na' ? 'na' : item.waiting ? 'waiting' : 'open';
  // An open item that waits for the year to end has its own wording.
  const text = item.state === 'done' ? t(`items.${item.key}.done`) : item.state === 'na' ? t(`items.${item.key}.na`) : item.waiting ? t(`items.${item.key}.waiting`) : t(`items.${item.key}.open`, { count: item.count });
  const basis = item.due !== null && item.state === 'open' ? basisOf(item.key) : null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-1 first:border-t-0" data-testid={`year-end-item-${item.key}`} data-state={status}>
      <span
        className={cn(
          'inline-flex min-h-11 min-w-20 items-center justify-center rounded-md px-2 text-center text-xs font-medium',
          status === 'open' ? 'bg-warning/15 text-warning' : status === 'done' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
        )}
      >
        {counted && ready && item.count > 0 ? <span className="font-mono text-sm tabular-nums" data-testid={`year-end-count-${item.key}`}>{item.count}</span> : t(`status.${status}`)}
      </span>
      <span className="min-w-0 flex-1 text-sm text-foreground">
        {text}
        {basis && item.due && (
          <span className="mt-0.5 block text-xs text-subtle-foreground" data-testid={`year-end-due-${item.key}`}>
            <span className="font-medium tabular-nums text-foreground">{t('due.label', { date: f.date(item.due) })}</span> {t(`basis.${basis}`)}
          </span>
        )}
      </span>
      {item.state === 'open' && (
        <ItemLink item={item} slug={slug}>
          {t(`items.${item.key}.link`)}
        </ItemLink>
      )}
    </li>
  );
}

// The coworker's note and order: nothing at all unless it came back used, so with AI off the card has no gap and no notice. `open` names the items to do now on screen: the note is asked again whenever
// that set changes, so it never sits beside items it was not written from (the server keeps a note by those items, so asking again costs no model call either).
function useNote(input: { year: number; legalEntityId?: string }, ready: boolean, open: string) {
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const base = orpc.financeYearEnd.explain.queryOptions({ input: { ...input, lang } });
  const note = useQuery({ ...base, queryKey: [...base.queryKey, open], enabled: ready, staleTime: Infinity, retry: false });
  return note.data?.ai === 'used' && note.data.text ? { text: note.data.text, order: note.data.order as YearEndKey[] } : null;
}

export function YearEndCard({ slug, today = new Date() }: { slug: string; today?: Date }) {
  const t = useTranslations('financeOverview.yearEnd');
  const entity = useChosenEntity();
  const [year, setYear] = useState(() => defaultCloseYear(today));
  const input = { year, ...(entity.legalEntityId ? { legalEntityId: entity.legalEntityId } : {}) };
  const live = useStreamLive();
  const checklist = useQuery({ ...orpc.financeYearEnd.get.queryOptions({ input }), enabled: entity.ready, refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
  const data = checklist.data;
  // The note is written from which items can be done now, so it is asked again only when that set changes: a poll that finds the same items keeps it, and the order does not jump.
  const note = useNote(input, entity.ready && data !== undefined, data ? data.items.filter(isReady).map((item) => item.key).join(',') : '');
  const items = data ? orderYearEndItems(data.items, note?.order ?? []) : [];
  const applicable = items.filter((item) => item.state !== 'na');
  const openCount = applicable.filter((item) => item.state === 'open').length;
  return (
    <section className="mt-6" aria-labelledby="year-end-title" data-testid="year-end">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="year-end-title" className="text-sm font-semibold text-foreground">{t('title')}</h2>
            <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
          </div>
          <label className="flex items-center gap-2 text-xs text-subtle-foreground">
            <span className="whitespace-nowrap">{t('year.label')}</span>
            <NativeSelect className="w-40 [&_select]:min-h-11" value={String(year)} onChange={(e) => setYear(Number(e.target.value))} data-testid="year-end-year">
              {closeYears(today).map((y) => (
                <NativeSelectOption key={y} value={String(y)}>
                  {t('year.option', { year: String(y) })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        </div>
        {checklist.isError && (
          <ErrorText>
            {errorMessage(checklist.error)}{' '}
            <button type="button" className="inline-flex min-h-11 items-center underline" onClick={() => void checklist.refetch()}>
              {t('retry')}
            </button>
          </ErrorText>
        )}
        {!data && !checklist.isError && (
          <div aria-busy="true" className="mt-3">
            <CardSkeleton />
          </div>
        )}
        {data && note && (
          <div className="mt-3 rounded-md bg-muted/50 p-3" data-testid="year-end-note">
            <p className="text-xs font-medium text-muted-foreground">{t('note.title')}</p>
            <p className="mt-1 text-sm text-foreground">{note.text}</p>
            <p className="mt-2 text-xs text-subtle-foreground">{t('note.hint')}</p>
          </div>
        )}
        {/* Mounted before the answer comes, so a screen reader announces the summary when it fills in. */}
        <p className="mt-3 text-xs text-subtle-foreground" role="status">
          {data ? (openCount === 0 ? t('allDone') : t('summary', { open: String(openCount), total: String(applicable.length) })) : ''}
        </p>
        {data && !data.over && <p className="text-xs text-subtle-foreground" data-testid="year-end-waiting-note">{t('waitingNote')}</p>}
        {data && (
          <ul className="mt-1">
            {items.map((item) => (
              <Row key={item.key} item={item} slug={slug} />
            ))}
          </ul>
        )}
        {data && items.some((item) => item.due !== null && item.state === 'open') && <p className="mt-2 text-xs text-subtle-foreground" data-testid="year-end-due-hint">{t('due.hint')}</p>}
      </Card>
    </section>
  );
}
