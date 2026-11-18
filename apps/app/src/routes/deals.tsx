// SPDX-License-Identifier: AGPL-3.0-only
// The deals screen (#2225, #2226, docs/plan/crm.md steps K1 and K2): the org's deals as the pipeline board (a column per
// stage, cards dragged between them) or as a list with party, stage, amount and expected close. A member adds, edits,
// moves and deletes deals; owners and admins edit the stages; a viewer reads. The board is the default on a wide screen,
// the list on a phone. Amounts are decimal strings and are shown as the reader's language groups them.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { DEAL_LOST_REASON_MAX, type Deal, type DealCursor, type FilterAst, type PipelineStage, type SavedViewSort } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { DealBookings } from '../components/booking-deal.tsx';
import { LinkedMeetings, meetingsInstalled } from '../components/linked-meetings.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { DealBoard, DealsEmpty } from '../components/deal-board.tsx';
import { DealFilterBar } from '../components/deal-filter-bar.tsx';
import { DealForm, DealPartyDuplicate, refreshDeals, type Member } from '../components/deal-form.tsx';
import { DealQuotes } from '../components/deal-quotes.tsx';
import { DealNextSteps, useNextStepCount } from '../components/deal-next-steps.tsx';
import { SALES_PROCESS_ID } from '../components/sales-process-card.tsx';
import { DataTable, Empty, ErrorText, Field, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { ViewTabs, type ViewState } from '../components/view-tabs.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { EMPTY_DEAL_FILTER, astToDealFilter, dealFilterToAst, type DealFilterState } from '../lib/deal-filter.ts';
import { isEmptyBoard, readDealView, showAllClosed, withDealView, type DealView } from '../lib/deal-board.ts';
import { formatMoney } from '../lib/format.ts';
import { useDebounced } from '../lib/use-debounced.ts';

const refresh = refreshDeals;
const SCOPE = 'crm.deal';
// The search waits for a pause in typing, so one request goes out per word and not per key.
const SEARCH_PAUSE_MS = 300;

function DealRow({ deal, stages, members, canEdit, canDelete, columns }: { deal: Deal; stages: readonly PipelineStage[]; members: readonly Member[]; canEdit: boolean; canDelete: boolean; columns: number }) {
  const t = useTranslations('deals');
  const { locale } = useLocaleSetting();
  const [editing, setEditing] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [meetingsOpen, setMeetingsOpen] = useState(false);
  const [bookingsOpen, setBookingsOpen] = useState(false);
  // A move into a lost stage asks for an optional reason first.
  const [losing, setLosing] = useState<PipelineStage | null>(null);
  const [reason, setReason] = useState('');
  const move = useMutation(
    orpc.crm.deals.move.mutationOptions({
      onSuccess: () => {
        setLosing(null);
        setReason('');
        void refresh();
      },
    }),
  );
  const remove = useMutation(orpc.crm.deals.delete.mutationOptions({ onSuccess: () => void refresh() }));
  const owner = members.find((m) => m.userId === deal.ownerUserId);
  const overdue = deal.stageKind === 'open' && deal.expectedClose !== null && deal.expectedClose < new Date().toISOString().slice(0, 10);
  const pick = (stageId: string) => {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage || stage.id === deal.stageId) return;
    if (stage.kind === 'lost') setLosing(stage);
    else move.mutate({ dealId: deal.id, version: deal.version, stageId: stage.id });
  };
  return (
    <>
      <TableRow data-testid="deal-row">
        <TableCell className="px-4 text-sm">
          <p className="font-medium text-foreground">
            {deal.title}
            {deal.followUp && (
              <>
                {' '}
                <Badge variant="warning" data-testid="follow-up-badge">
                  {t('followUp')}
                </Badge>
              </>
            )}
          </p>
          {deal.lostReason && <p className="text-xs text-muted-foreground">{t('lostReason', { reason: deal.lostReason })}</p>}
          <Button size="sm" variant="ghost" className="-ml-2 mt-1" onClick={() => setQuoting((q) => !q)} aria-expanded={quoting} data-testid="deal-quotes-toggle">
            {t('quotes')}
          </Button>
          {meetingsInstalled() && (
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => setMeetingsOpen((o) => !o)} aria-expanded={meetingsOpen} data-testid="deal-meetings-toggle">
              {t('meetings')}
            </Button>
          )}
          {/* The deal's bookings and "Đặt lịch" (#3103); a viewer reads no booking, so has no button. */}
          {canEdit && (
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => setBookingsOpen((o) => !o)} aria-expanded={bookingsOpen} data-testid="deal-bookings-toggle">
              {t('bookings')}
            </Button>
          )}
        </TableCell>
        <TableCell className="px-4 text-sm">
          {deal.partyName}
          <DealPartyDuplicate deal={deal} canEdit={canEdit} />
        </TableCell>
        <TableCell className="px-4 text-sm">
          {canEdit ? (
            <NativeSelect size="sm" aria-label={t('stageOf', { title: deal.title })} value={deal.stageId} disabled={move.isPending} onChange={(e) => pick(e.target.value)}>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Badge variant="outline">{stages.find((s) => s.id === deal.stageId)?.name ?? ''}</Badge>
          )}
        </TableCell>
        <TableCell className="px-4 text-right text-sm tabular-nums">{formatMoney(deal.amount, locale, deal.currency)}</TableCell>
        <TableCell className={`px-4 text-sm ${overdue ? 'text-destructive' : ''}`}>{deal.expectedClose ?? ''}</TableCell>
        <TableCell className="px-4 text-sm">{owner ? (owner.displayName ?? owner.email) : ''}</TableCell>
        {canEdit && (
          <TableCell className="px-4">
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
                {t('edit')}
              </Button>
              {canDelete && (
                <ConfirmDialog
                  render={
                    <Button size="sm" variant="outline">
                      {t('delete')}
                    </Button>
                  }
                  title={t('deleteTitle')}
                  description={t('deleteDescription', { title: deal.title })}
                  confirm={t('deleteYes')}
                  destructive
                  onConfirm={() => remove.mutate({ dealId: deal.id })}
                >
                  {t('delete')}
                </ConfirmDialog>
              )}
            </div>
          </TableCell>
        )}
      </TableRow>
      {(losing || move.error || remove.error) && (
        <TableRow>
          <TableCell colSpan={columns} className="px-4 py-3">
            {losing && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  move.mutate({ dealId: deal.id, version: deal.version, stageId: losing.id, lostReason: reason.trim() || null });
                }}
              >
                <Field label={t('lostReasonLabel')} className="min-w-64">
                  {(c) => <Input {...c} maxLength={DEAL_LOST_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />}
                </Field>
                <Button type="submit" size="sm" loading={move.isPending}>
                  {t('markLost')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setLosing(null)}>
                  {t('form.cancel')}
                </Button>
              </form>
            )}
            {(move.error || remove.error) && <ErrorText>{errorMessage(move.error ?? remove.error)}</ErrorText>}
          </TableCell>
        </TableRow>
      )}
      {meetingsOpen && (
        <TableRow>
          <TableCell colSpan={columns} className="px-4 py-3">
            <LinkedMeetings kind="deal" targetId={deal.id} />
          </TableCell>
        </TableRow>
      )}
      {bookingsOpen && (
        <TableRow>
          <TableCell colSpan={columns} className="px-4 py-3">
            <DealBookings deal={deal} canEdit={canEdit} />
          </TableCell>
        </TableRow>
      )}
      {quoting && (
        <TableRow>
          <TableCell colSpan={columns} className="px-4 py-3">
            <DealQuotes deal={deal} canEdit={canEdit} onClose={() => setQuoting(false)} />
          </TableCell>
        </TableRow>
      )}
      {editing && (
        <TableRow>
          <TableCell colSpan={columns} className="px-4 py-3">
            <DealForm key={deal.version} deal={deal} members={members} onDone={() => setEditing(false)} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

type View = DealView;
// The board is the default where there is room for columns; on a phone the list is. The view in use is in the address (`?tab=`), so a reload keeps it, and the Home list links to `?tab=next`.
const wideScreen = (): boolean => {
  try {
    return window.matchMedia('(min-width: 640px)').matches;
  } catch {
    return true;
  }
};

export function DealsPage() {
  const t = useTranslations('deals');
  const org = useQuery(orpc.org.get.queryOptions());
  const role = org.data?.role;
  const canEdit = role === 'owner' || role === 'admin' || role === 'member';
  const members = org.data?.members ?? [];
  const canManage = role === 'owner' || role === 'admin';
  const [adding, setAdding] = useState(false);
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [view, setViewState] = useState<View>(() => {
    try {
      return readDealView(window.location.search) ?? (wideScreen() ? 'board' : 'list');
    } catch {
      return 'board';
    }
  });
  const setView = (next: View) => {
    setViewState(next);
    try {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${withDealView(window.location.search, next)}${window.location.hash}`);
    } catch {
      // No address to write: the view is kept in this page only.
    }
  };
  const nextCount = useNextStepCount();
  const stages = useQuery(orpc.crm.pipeline.stages.queryOptions({ input: {} }));
  // The first member to open the screen in an org with no pipeline gets the default stages.
  const setup = useMutation(orpc.crm.pipeline.setup.mutationOptions({ onSuccess: (data) => {
        queryClient.setQueryData(orpc.crm.pipeline.stages.queryKey({ input: {} }), data);
        refreshDeals();
      },
    }));
  const { mutate: setupStages } = setup;
  const needsSetup = canEdit && stages.data?.length === 0;
  useEffect(() => {
    if (needsSetup) setupStages({});
  }, [needsSetup, setupStages]);
  // The screen's filter and sort: what the bar shows, and what a picked view sets (the tabs above the bar). The board and
  // the list read the same filter, so one view shows the same deals as cards and as rows; the sort is the list's.
  const [bar, setBar] = useState<DealFilterState>(EMPTY_DEAL_FILTER);
  const [sort, setSort] = useState<SavedViewSort | null>(null);
  const filters: FilterAst = dealFilterToAst(bar);
  const filtered = filters.all.length > 0;
  // The search waits for a pause in typing; the rest of the bar applies at once.
  const searchTerm = useDebounced(bar.search.trim(), SEARCH_PAUSE_MS);
  const applied: FilterAst = dealFilterToAst({ ...bar, search: searchTerm });
  const viewed = applied.all.length > 0 || sort !== null;
  const applyView = ({ filters: next, sort: nextSort }: ViewState) => {
    setBar(astToDealFilter(next));
    setSort(nextSort);
  };
  const deals = useInfiniteQuery({
    ...orpc.crm.deals.list.infiniteOptions({
      // With a filter or a sort the list pages by the last deal and its sort value; without, the newest-first cursor of before.
      input: (cursor: DealCursor | undefined) =>
        viewed ? { filters: applied, ...(sort ? { sort } : {}), ...(cursor ? { after: { id: cursor.id, value: cursor.value ?? null } } : {}) } : cursor ? { cursor } : {},
      initialPageParam: undefined as DealCursor | undefined,
      getNextPageParam: (page) => page.next ?? undefined,
      placeholderData: keepPreviousData,
    }),
  });
  const rows = deals.data?.pages.flatMap((p) => p.items) ?? [];
  // An org with no deal sees one action, the empty state's: the header's "Thêm cơ hội" waits until there is a deal (#3647). The board's answer is the one DealBoard reads.
  const plainBoard = useQuery({ ...orpc.crm.deals.board.queryOptions({ input: {} }), enabled: view === 'board' });
  const noDeals = view === 'board' ? !filtered && !plainBoard.error && isEmptyBoard(plainBoard.data) : view === 'list' && !filtered && !deals.isPending && !stages.isPending && !deals.error && !stages.error && rows.length === 0;
  const head = [t('columns.title'), t('columns.party'), t('columns.stage'), t('columns.amount'), t('columns.expectedClose'), t('columns.owner'), ...(canEdit ? [''] : [])];
  const stageList = stages.data ?? [];

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Tabs value={view} onValueChange={(v) => setView(v as View)}>
              <TabsList aria-label={t('view.label')}>
                <TabsTrigger value="board">{t('view.board')}</TabsTrigger>
                <TabsTrigger value="list">{t('view.list')}</TabsTrigger>
                <TabsTrigger value="next" data-testid="next-steps-tab">
                  {nextCount > 0 ? t('view.nextCount', { count: String(nextCount) }) : t('view.next')}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {canEdit && !noDeals && (
              <Button onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
                {t('add')}
              </Button>
            )}
          </div>
        }
      />
      {adding && (
        <div className="mb-4">
          <DealForm deal={null} members={members} onDone={() => setAdding(false)} />
        </div>
      )}
      {view === 'next' ? (
        <DealNextSteps canEdit={canEdit} />
      ) : (
        <>
      {!noDeals && <ViewTabs scope={SCOPE} filters={filters} sort={sort} onApply={applyView} />}
      {!noDeals && (
        <DealFilterBar
          bar={bar}
          setBar={setBar}
          sort={sort}
          setSort={setSort}
          stages={stageList}
          members={members}
          view={view === 'board' ? 'board' : 'list'}
          extra={
            canManage ? (
              <Link to="/o/$slug/settings" params={{ slug }} hash={SALES_PROCESS_ID} className={buttonVariants({ variant: 'link', size: 'sm' })}>
                {t('editStages')}
              </Link>
            ) : undefined
          }
        />
      )}
      {view === 'board' ? (
        <DealBoard
          members={members}
          canEdit={canEdit}
          onAdd={() => setAdding(true)}
          filters={applied.all.length > 0 ? applied : undefined}
          onShowAll={(kind) => {
            setBar(showAllClosed(kind));
            setSort(null);
            setView('list');
          }}
        />
      ) : deals.isPending || stages.isPending ? (
        <TableSkeleton columns={6} />
      ) : (deals.error || stages.error) && rows.length === 0 ? (
        <ErrorText>{errorMessage(deals.error ?? stages.error)}</ErrorText>
      ) : rows.length === 0 ? (
        filtered ? <Empty title={t('filters.noMatch')} /> : <DealsEmpty title={t('empty')} hint={canEdit ? t('emptyHint') : undefined} canEdit={canEdit} onAdd={() => setAdding(true)} />
      ) : (
        <>
          <DataTable head={head} numeric={[3]}>
            {rows.map((d) => (
              <DealRow key={d.id} deal={d} stages={stageList} members={members} canEdit={canEdit} canDelete={d.canDelete} columns={head.length} />
            ))}
          </DataTable>
          {deals.hasNextPage && (
            <div className="mt-3">
              <Button variant="outline" size="sm" disabled={deals.isFetchingNextPage} onClick={() => void deals.fetchNextPage()}>
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
        </>
      )}
    </>
  );
}
