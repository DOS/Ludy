// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" (issue #2383): what needs the member today across the apps, on top of Home. One list from
// kernel.today, grouped by kind with flags first; each row links to the screen where the item is acted on. Nothing is
// approved or sent from here: batch approval stays in the owning app's screen.
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type MouseEvent } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { CONTACT_ATTENTION_HOME_MAX, todayCoworkerKey, todayCount, type TodayCoworkers, type TodayItem, type TodaySeverity } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import { CoworkerAttribution, ProposalSurface } from './proposal-surface.tsx';
import { TodayBrief } from './today-brief.tsx';
import { Empty, ErrorText, ListSkeleton, PeekSheet } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { useListPeekNav } from '../lib/list-peek-nav.ts';
import { installedModules } from '../lib/org-modules.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { QUEUE_ROWS, TODAY_ICON, groupToday, limitGroups, proposalChips, queueRows, todayPath, todayTotal } from '../lib/today.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

const SEVERITY_VARIANT: Record<TodaySeverity, 'destructive' | 'warning' | 'outline'> = { block: 'destructive', warn: 'warning', info: 'outline' };

// An item's title is a message key of the catalog (`today.items.<key>`) with its parameters, which each line adds with
// its read. A key this app does not know shows the kind's general sentence, so a new read never leaves a blank row.
function useTitle() {
  const t = useTranslations('today');
  const items = useTranslations('today.items');
  return (item: TodayItem): string => {
    const params = item.title.params ?? {};
    // The keys are runtime strings from the lines, so they are looked up in the catalog directly, not through its types.
    // A key that is not a message (missing, or a group of messages) or a message the parameters do not fit gets the
    // kind's sentence, so one line's mistake never blanks Home.
    const translate = items as unknown as { raw: (key: string) => unknown; (key: string, values: Record<string, string | number>): string };
    try {
      if (typeof translate.raw(item.title.key) === 'string') {
        const text = translate(item.title.key, params);
        if (!text.endsWith(item.title.key)) return text;
      }
    } catch {
      // Not a message of the catalog.
    }
    return t(`fallback.${item.kind}`);
  };
}

// The coworker's name goes first in the row's small print: who raised it (Ly for finance, Dy for CRM and conversations, Uy for Social and Ads,
// Vy for the rest), by the name the org gave it now. A person still approves; the name only says who is asking (#3265).
function todayItemId(item: TodayItem): string {
  return `${item.app}:${item.id}`;
}

function TodayRow({
  item,
  slug,
  coworkers,
  selected,
  dueAsEvent = false,
  onInspect,
  onRowClick,
}: {
  item: TodayItem;
  slug: string;
  coworkers: TodayCoworkers;
  selected: boolean;
  dueAsEvent?: boolean;
  onInspect: (id: string) => void;
  onRowClick: (id: string, event: MouseEvent<HTMLElement>) => void;
}) {
  const t = useTranslations('today');
  const f = useFormat();
  const router = useRouter();
  const title = useTitle();
  const itemKey = todayItemId(item);
  const itemTitle = title(item);
  const path = todayPath(slug, item.href);
  const isEventTimestamp = dueAsEvent && !item.id.includes(':invoice_overdue:');
  // A plain click moves inside the app without a reload; a new tab, a copied link and the keyboard use the real href.
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.history.push(path);
  };
  return (
    <li>
      <div
        data-peek-row={itemKey}
        data-selected={selected ? 'true' : undefined}
        onClick={(event) => onRowClick(itemKey, event)}
        className={cn(
          'flex cursor-pointer items-center gap-2 pr-3 transition-colors',
          selected ? 'bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]' : 'hover:bg-muted/50',
        )}
      >
        <a
          href={path}
          onClick={go}
          className={cn('flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-sm focus-visible:bg-muted/50 focus-visible:outline-none', PHONE_TARGET)}
        >
          <NavIcon name={TODAY_ICON[item.kind]} className="text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-foreground">{itemTitle}</span>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground">
              <span data-testid="today-coworker">{t('from', { name: coworkers[todayCoworkerKey(item.app)] })}</span>
              {item.severity && <Badge variant={SEVERITY_VARIANT[item.severity]}>{t(`severity.${item.severity}`)}</Badge>}
              {item.count !== undefined && <span className="tabular-nums">{t('count', { count: item.count })}</span>}
              {item.amount !== undefined && <span className="font-mono tabular-nums">{f.money(item.amount, item.currency)}</span>}
              {item.dueAt !== undefined && (
                <span className="tabular-nums">
                  {isEventTimestamp
                    ? t('contactAttention.when', { when: f.dateTime(item.dueAt) })
                    : t('due', { when: item.kind === 'message' ? f.dateTime(item.dueAt) : f.date(item.dueAt) })}
                </span>
              )}
            </span>
          </span>
          {/* The whole row is the link; on a phone the word would only squeeze the title. */}
          <span className="hidden shrink-0 text-xs text-link sm:inline">{t('open')}</span>
        </a>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className={PHONE_TARGET}
          data-peek-trigger={itemKey}
          data-testid="today-peek-btn"
          aria-label={t('peek.inspectItem', { title: itemTitle })}
          onClick={() => onInspect(itemKey)}
        >
          {t('peek.inspect')}
        </Button>
      </div>
    </li>
  );
}

export function TodayList({ slug }: { slug: string }) {
  const t = useTranslations('today');
  const common = useTranslations('common');
  const f = useFormat();
  const router = useRouter();
  const title = useTitle();
  const live = useStreamLive();
  const crmInstalled = installedModules().includes('crm');
  const today = useQuery({ ...orpc.today.list.queryOptions(), refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
  const contactAttention = useQuery({
    ...orpc.today.contactAttention.queryOptions(),
    enabled: crmInstalled,
    refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS),
  });
  const [all, setAll] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const items = today.data?.items ?? [];
  const attentionItems = crmInstalled ? (contactAttention.data ?? []).slice(0, CONTACT_ATTENTION_HOME_MAX) : [];
  // One count per thing (#3591): a flag about proposals already listed is a chip on them, not a row, and the number beside the title is the
  // same one the summary says.
  const allGroups = groupToday(queueRows(items));
  const rows = allGroups.reduce((n, g) => n + g.items.length, 0);
  const groups = all ? allGroups : limitGroups(allGroups, QUEUE_ROWS);
  const chips = proposalChips(items);
  const total = todayCount(items) + todayCount(attentionItems);
  const visibleItems = [...groups.flatMap((group) => group.items), ...attentionItems];
  const peek = useListPeekNav({
    items: visibleItems,
    getId: todayItemId,
    containerRef: listRef,
    enabled: Boolean(today.data && visibleItems.length > 0),
    resetKey: slug,
  });
  const activeItem = peek.activeItem;

  if (today.isError) {
    return (
      <section aria-labelledby="overview-today">
        <h2 id="overview-today" className="flex items-baseline gap-2 text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
        <div className="mt-3">
          <ErrorText>{errorMessage(today.error)}</ErrorText>
        </div>
      </section>
    );
  }

  if (today.isPending || !today.data) {
    return (
      <section aria-labelledby="overview-today">
        <h2 id="overview-today" className="flex items-baseline gap-2 text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
        <div className="mt-3">
          <ListSkeleton rows={2} />
        </div>
      </section>
    );
  }

  if (groups.length === 0 && attentionItems.length === 0) {
    return (
      <section aria-labelledby="overview-today">
        <h2 id="overview-today" className="flex items-baseline gap-2 text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
        <div className="mt-3">
          {/* Nothing waits: a new owner is pointed to the quick guide (#3596), where the accounting app is on. */}
          <Empty
            compact
            title={t('empty')}
            hint={t('emptyHint')}
            action={
              installedModules().includes('finance') ? (
                <Link to="/o/$slug/guide" params={{ slug }} className="text-sm text-link hover:underline">
                  {t('guideLink')}
                </Link>
              ) : undefined
            }
          />
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="overview-today">
      <Card className="block overflow-hidden p-0" data-testid="today-hero-card">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 id="overview-today" className="flex items-baseline gap-2 text-base font-semibold text-foreground">
              {t('title')}
              {total > 0 && (
                <span className="font-mono text-sm font-normal tabular-nums text-subtle-foreground" data-testid="today-total">
                  {total}
                </span>
              )}
            </h2>
            <p className="text-xs text-subtle-foreground">{t('subtitle')}</p>
          </div>
        </div>
        {/* TodayBrief integrated inside the same hero card without double card chrome or spacing (#4644). */}
        <div
          data-testid="today-brief-host"
          className={cn(
            'border-b bg-muted/20 empty:hidden',
            '[&>[data-testid="today-brief"]]:rounded-none [&>[data-testid="today-brief"]]:border-0 [&>[data-testid="today-brief"]]:px-4 [&>[data-testid="today-brief"]]:py-2.5 [&>[data-testid="today-brief"]]:ring-0 [&>[data-testid="today-brief"]]:shadow-none',
            '[&_[data-slot="card"]]:rounded-none [&_[data-slot="card"]]:border-0 [&_[data-slot="card"]]:bg-transparent [&_[data-slot="card"]]:px-4 [&_[data-slot="card"]]:py-2.5 [&_[data-slot="card"]]:ring-0 [&_[data-slot="card"]]:shadow-none',
            '[&>[aria-busy="true"]]:h-12 [&>[aria-busy="true"]]:rounded-none [&>[aria-busy="true"]]:border-0',
          )}
        >
          <TodayBrief slug={slug} items={items} name={today.data.coworkers.gm} />
        </div>
        <div ref={listRef} className="divide-y">
          {groups.map((group) => (
            <div key={group.kind}>
              <div className="flex flex-wrap items-center gap-2 bg-muted/30 px-4 py-2">
                <h3 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
                  {t(`kinds.${group.kind}`)}
                  <span className="font-mono text-xs font-normal tabular-nums text-subtle-foreground">{todayTotal(allGroups.find((g) => g.kind === group.kind)?.items ?? group.items)}</span>
                </h3>
                {/* Beside the heading, not in it, so the heading's name stays the kind and its count. */}
                {group.kind === 'proposal' &&
                  chips.map((chip) => (
                    <Badge key={chip.severity} variant={SEVERITY_VARIANT[chip.severity]} data-testid="today-chip">
                      {t(`chip.${chip.severity}`, { count: chip.count })}
                    </Badge>
                  ))}
              </div>
              <ul className="divide-y">
                {group.items.map((item) => (
                  <TodayRow
                    key={todayItemId(item)}
                    item={item}
                    slug={slug}
                    coworkers={today.data.coworkers}
                    selected={peek.selectedId === todayItemId(item)}
                    onInspect={peek.openPeek}
                    onRowClick={peek.onRowClick}
                  />
                ))}
              </ul>
            </div>
          ))}
          {attentionItems.length > 0 && (
            <section data-testid="today-contact-attention" aria-labelledby="today-contact-attention-heading">
              <div className="flex flex-wrap items-center gap-2 bg-muted/30 px-4 py-2">
                <h3 id="today-contact-attention-heading" className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
                  {t('contactAttention.title')}
                  <span className="font-mono text-xs font-normal tabular-nums text-subtle-foreground">{attentionItems.length}</span>
                </h3>
              </div>
              <ul className="divide-y">
                {attentionItems.map((item) => (
                  <TodayRow
                    key={todayItemId(item)}
                    item={item}
                    slug={slug}
                    coworkers={today.data.coworkers}
                    selected={peek.selectedId === todayItemId(item)}
                    dueAsEvent
                    onInspect={peek.openPeek}
                    onRowClick={peek.onRowClick}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
        {rows > QUEUE_ROWS && (
          <div className="border-t px-4 py-2.5">
            <Button type="button" variant="outline" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="today-toggle">
              {all ? t('showLess') : t('showAll', { count: rows })}
            </Button>
          </div>
        )}
      </Card>

      {activeItem && today.data ? (
        <PeekSheet
          open={peek.open}
          onClose={peek.closePeek}
          peekId={peek.peekId}
          data-testid="today-peek-sheet"
          title={title(activeItem)}
          description={t('from', { name: today.data.coworkers[todayCoworkerKey(activeItem.app)] })}
          badges={
            <>
              <Badge variant="outline">{t(`kinds.${activeItem.kind}`)}</Badge>
              {activeItem.severity ? (
                <Badge variant={SEVERITY_VARIANT[activeItem.severity]}>{t(`severity.${activeItem.severity}`)}</Badge>
              ) : null}
            </>
          }
          positionLabel={common('peek.position', { index: String(peek.activeIndex + 1), total: String(peek.total) })}
          canPrevious={peek.canPrevious}
          canNext={peek.canNext}
          onPrevious={() => peek.step(-1)}
          onNext={() => peek.step(1)}
          actions={
            <a
              href={todayPath(slug, activeItem.href)}
              onClick={(event) => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                  return;
                }
                event.preventDefault();
                const targetPath = todayPath(slug, activeItem.href);
                peek.closePeek();
                router.history.push(targetPath);
              }}
              className={buttonVariants({ size: 'sm', variant: 'default' })}
              data-testid="today-peek-open-link"
            >
              {t('open')}
            </a>
          }
        >
          <div className="space-y-4">
            <ProposalSurface proposed={activeItem.kind === 'proposal'} className="p-3">
              <CoworkerAttribution
                coworker={todayCoworkerKey(activeItem.app)}
                name={today.data.coworkers[todayCoworkerKey(activeItem.app)]}
              />
            </ProposalSurface>

            <dl className="grid gap-2 rounded-lg border border-border bg-card p-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-subtle-foreground">{t('peek.kind')}</dt>
                <dd className="font-medium text-foreground">{t(`kinds.${activeItem.kind}`)}</dd>
              </div>
              {activeItem.severity ? (
                <div>
                  <dt className="text-subtle-foreground">{t('peek.severity')}</dt>
                  <dd className="font-medium text-foreground">{t(`severity.${activeItem.severity}`)}</dd>
                </div>
              ) : null}
              {activeItem.count !== undefined ? (
                <div>
                  <dt className="text-subtle-foreground">{t('peek.count')}</dt>
                  <dd className="font-mono tabular-nums text-foreground">{t('count', { count: activeItem.count })}</dd>
                </div>
              ) : null}
              {activeItem.amount !== undefined ? (
                <div>
                  <dt className="text-subtle-foreground">{t('peek.amount')}</dt>
                  <dd className="font-mono tabular-nums text-foreground">
                    {f.money(activeItem.amount, activeItem.currency)}
                  </dd>
                </div>
              ) : null}
              {activeItem.dueAt !== undefined ? (
                <div>
                  <dt className="text-subtle-foreground">
                    {t(activeItem.id.startsWith('signal:contact-attention:') && !activeItem.id.includes(':invoice_overdue:') ? 'peek.when' : 'peek.due')}
                  </dt>
                  <dd className="tabular-nums text-muted-foreground">
                    {activeItem.kind === 'message' || (activeItem.id.startsWith('signal:contact-attention:') && !activeItem.id.includes(':invoice_overdue:'))
                      ? f.dateTime(activeItem.dueAt)
                      : f.date(activeItem.dueAt)}
                  </dd>
                </div>
              ) : null}
              <div className="sm:col-span-2">
                <dt className="text-subtle-foreground">{t('peek.destination')}</dt>
                <dd className="font-mono break-all text-muted-foreground">{todayPath(slug, activeItem.href)}</dd>
              </div>
            </dl>

            <p className="text-xs text-subtle-foreground">{t('peek.humanHint')}</p>
          </div>
        </PeekSheet>
      ) : null}
    </section>
  );
}
