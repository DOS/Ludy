// SPDX-License-Identifier: AGPL-3.0-only
// The month-close checklist card on the Kế toán screen: for the chosen legal entity and a month (the month before today by default), what is still open before the books of the
// month can be locked. Every item and every count comes from the books (finance.month_close) and has fixed text and a link to the screen where a person does it; the card shows all
// of them and does nothing itself. The finance coworker's short note, and the order it puts the open items in, are read from the same items by the model and hidden when there is no
// model, the AI budget is spent or its answer was refused, so the checklist never waits for it and looks the same with AI off, only in the fixed order and without the note.
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useLocale, useTranslations } from 'use-intl';
import type { MonthCloseItem, MonthCloseKey } from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { cn } from '@ludy/ui/lib/utils';
import { CardSkeleton, ErrorText } from './ui.tsx';
import { useChosenEntity } from './entity-switcher.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { COUNTED_ITEMS, closeMonths, defaultCloseMonth, orderItems } from '../lib/month-close.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';

// 44 px high on every screen: a link of the checklist is a target a thumb has to hit.
const LINK_CLASS = 'inline-flex min-h-11 items-center text-sm text-link hover:underline';

// The screen where a person does the item.
function ItemLink({ item, month, slug, children }: { item: MonthCloseItem; month: string; slug: string; children: ReactNode }) {
  const params = { slug };
  switch (item.key) {
    case 'proposals':
      return <Link to="/o/$slug/inbox" params={params} search={{ status: 'pending' }} className={LINK_CLASS}>{children}</Link>;
    case 'invoices':
      return <Link to="/o/$slug/portal-invoices" params={params} search={item.period ? { period: item.period, ...(item.direction === 'sale' ? { direction: 'sale' as const } : {}) } : {}} className={LINK_CLASS}>{children}</Link>;
    case 'bank':
      return <Link to="/o/$slug/bank" params={params} search={{ month }} className={LINK_CLASS}>{children}</Link>;
    case 'marketplace':
      return <Link to="/o/$slug/marketplace" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'stock':
      return <Link to="/o/$slug/stock" params={params} className={LINK_CLASS}>{children}</Link>;
    case 'vat':
      return <Link to="/o/$slug/vat" params={params} search={item.period ? { period: item.period } : {}} className={LINK_CLASS}>{children}</Link>;
    case 'lock':
      return <Link to="/o/$slug/ledger" params={params} className={LINK_CLASS}>{children}</Link>;
  }
}

function Row({ item, month, slug }: { item: MonthCloseItem; month: string; slug: string }) {
  const t = useTranslations('financeOverview.monthClose');
  const open = item.count > 0;
  const counted = COUNTED_ITEMS.includes(item.key);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-1 first:border-t-0" data-testid={`month-close-item-${item.key}`} data-open={open ? 'true' : 'false'}>
      <span className={cn('inline-flex min-h-11 min-w-16 items-center justify-center rounded-md px-2 text-xs font-medium', open ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success')}>
        {counted && open ? <span className="font-mono text-sm tabular-nums" data-testid={`month-close-count-${item.key}`}>{item.count}</span> : open ? t('status.open') : t('status.done')}
      </span>
      <span className="min-w-0 flex-1 text-sm text-foreground">{open ? t(`items.${item.key}.open`, { count: item.count }) : t(`items.${item.key}.done`)}</span>
      {open && (
        <ItemLink item={item} month={month} slug={slug}>
          {t(`items.${item.key}.link`)}
        </ItemLink>
      )}
    </li>
  );
}

// The coworker's note and order: nothing at all unless it came back used, so with AI off the card has no gap and no notice. `open` names the open items on screen: the note is
// asked again whenever that set changes, so it never sits beside items it was not written from (the server keeps a note by the open items, so asking again costs no model call either).
function useNote(input: { month: string; legalEntityId?: string }, ready: boolean, open: string) {
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const base = orpc.financeMonthClose.explain.queryOptions({ input: { ...input, lang } });
  const note = useQuery({ ...base, queryKey: [...base.queryKey, open], enabled: ready, staleTime: Infinity, retry: false });
  return note.data?.ai === 'used' && note.data.text ? { text: note.data.text, order: note.data.order as MonthCloseKey[] } : null;
}

export function MonthCloseCard({ slug, today = new Date() }: { slug: string; today?: Date }) {
  const t = useTranslations('financeOverview.monthClose');
  const entity = useChosenEntity();
  const [month, setMonth] = useState(() => defaultCloseMonth(today));
  const input = { month, ...(entity.legalEntityId ? { legalEntityId: entity.legalEntityId } : {}) };
  const live = useStreamLive();
  const checklist = useQuery({ ...orpc.financeMonthClose.get.queryOptions({ input }), enabled: entity.ready, refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
  const data = checklist.data;
  // The note is written from which items are open, so it is asked again only when that set changes: a poll that finds the same items keeps it, and the order does not jump.
  const note = useNote(input, entity.ready && data !== undefined, data ? data.items.filter((item) => item.count > 0).map((item) => item.key).join(',') : '');
  const items = data ? orderItems(data.items, note?.order ?? []) : [];
  const openCount = items.filter((item) => item.count > 0).length;
  return (
    <section className="mt-6" aria-labelledby="month-close-title" data-testid="month-close">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="month-close-title" className="text-sm font-semibold text-foreground">{t('title')}</h2>
            <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
          </div>
          <label className="flex items-center gap-2 text-xs text-subtle-foreground">
            <span className="whitespace-nowrap">{t('month.label')}</span>
            <NativeSelect className="w-40 [&_select]:min-h-11" value={month} onChange={(e) => setMonth(e.target.value)} data-testid="month-close-month">
              {closeMonths(today).map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {t('month.option', { month: String(Number(m.slice(5))), year: m.slice(0, 4) })}
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
          <div className="mt-3 rounded-md bg-muted/50 p-3" data-testid="month-close-note">
            <p className="text-xs font-medium text-muted-foreground">{t('note.title')}</p>
            <p className="mt-1 text-sm text-foreground">{note.text}</p>
            <p className="mt-2 text-xs text-subtle-foreground">{t('note.hint')}</p>
          </div>
        )}
        {/* Mounted before the answer comes, so a screen reader announces the summary when it fills in. */}
        <p className="mt-3 text-xs text-subtle-foreground" role="status">
          {data ? (openCount === 0 ? t('allDone') : t('summary', { open: String(openCount), total: String(items.length) })) : ''}
        </p>
        {data && (
          <ul className="mt-1">
            {items.map((item) => (
              <Row key={item.key} item={item} month={month} slug={slug} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
