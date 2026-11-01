// SPDX-License-Identifier: AGPL-3.0-only
// The deals screen (#2225, #2226, docs/plan/crm.md steps K1 and K2): the org's deals as the pipeline board (a column per
// stage, cards dragged between them) or as a list with party, stage, amount and expected close. A member adds, edits,
// moves and deletes deals; owners and admins edit the stages; a viewer reads. The board is the default on a wide screen,
// the list on a phone. Amounts are decimal strings and are shown as the reader's language groups them.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { DEAL_LOST_REASON_MAX, type Deal, type DealCursor, type PipelineStage } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { DealBoard } from '../components/deal-board.tsx';
import { DealForm, refreshDeals, type Member } from '../components/deal-form.tsx';
import { PipelineSettings } from '../components/pipeline-settings.tsx';
import { DataTable, Empty, ErrorText, Field, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';

const refresh = refreshDeals;

function DealRow({ deal, stages, members, canEdit, canDelete, columns }: { deal: Deal; stages: readonly PipelineStage[]; members: readonly Member[]; canEdit: boolean; canDelete: boolean; columns: number }) {
  const t = useTranslations('deals');
  const { locale } = useLocaleSetting();
  const [editing, setEditing] = useState(false);
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
          <p className="font-medium text-foreground">{deal.title}</p>
          {deal.lostReason && <p className="text-xs text-muted-foreground">{t('lostReason', { reason: deal.lostReason })}</p>}
        </TableCell>
        <TableCell className="px-4 text-sm">{deal.partyName}</TableCell>
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

type View = 'board' | 'list';
// The board is the default where there is room for columns; on a phone the list is.
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
  const [settings, setSettings] = useState(false);
  const [view, setView] = useState<View>(wideScreen() ? 'board' : 'list');
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
  const deals = useInfiniteQuery({
    ...orpc.crm.deals.list.infiniteOptions({
      input: (cursor: DealCursor | undefined) => (cursor ? { cursor } : {}),
      initialPageParam: undefined as DealCursor | undefined,
      getNextPageParam: (page) => page.next ?? undefined,
      placeholderData: keepPreviousData,
    }),
  });
  const rows = deals.data?.pages.flatMap((p) => p.items) ?? [];
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
              </TabsList>
            </Tabs>
            {canManage && (
              <Button variant="outline" onClick={() => setSettings((s) => !s)} aria-expanded={settings}>
                {t('view.settings')}
              </Button>
            )}
            {canEdit && (
              <Button onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
                {t('add')}
              </Button>
            )}
          </div>
        }
      />
      {settings && canManage && (
        <div className="mb-4">
          <PipelineSettings />
        </div>
      )}
      {adding && (
        <div className="mb-4">
          <DealForm deal={null} members={members} onDone={() => setAdding(false)} />
        </div>
      )}
      {view === 'board' ? (
        <DealBoard members={members} canEdit={canEdit} />
      ) : deals.isPending || stages.isPending ? (
        <TableSkeleton columns={6} />
      ) : (deals.error || stages.error) && rows.length === 0 ? (
        <ErrorText>{errorMessage(deals.error ?? stages.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={t('empty')} hint={canEdit ? t('emptyHint') : undefined} />
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
  );
}
