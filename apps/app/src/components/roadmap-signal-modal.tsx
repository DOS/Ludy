// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import type { DealCursor, RoadmapSignalMatchResult, RoadmapSignalSourceType } from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { useFormat } from '../i18n/provider.tsx';
import { installedModules } from '../lib/org-modules.ts';
import { toast } from '../lib/toast.ts';

export interface RoadmapSignalSourcePrefill {
  sourceType: RoadmapSignalSourceType;
  sourceId: string;
  sourceLabel?: string;
  accountLabel?: string | null;
  quoteExcerpt?: string | null;
  dealValue?: string | null;
  dealCurrency?: string | null;
}

export interface RoadmapSignalModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fixedBoardId?: string;
  fixedItem?: { id: string; title: string };
  prefillSource?: RoadmapSignalSourcePrefill;
  onLinked?: (result: { boardId: string; roadmapItemId: string; alreadyLinked: boolean }) => void;
}

function sourceTypeOptions(modules: readonly string[]): RoadmapSignalSourceType[] {
  const opts: RoadmapSignalSourceType[] = [];
  if (modules.includes('crm')) opts.push('crm.deal');
  opts.push('kernel.conversation');
  if (modules.includes('meetings')) opts.push('meetings.meeting');
  return opts;
}

export function buildRoadmapSignalCreatePayload(args: {
  idempotencyKey: string;
  boardId: string;
  roadmapItemId: string;
  sourceType: RoadmapSignalSourceType;
  sourceId: string;
  accountLabel: string;
  prefillAccountLabel: string;
  quoteExcerpt: string;
  dealValue: string;
  dealCurrency: string;
}) {
  const trimmedAccount = args.accountLabel.trim();
  const omitUnchangedCrmAccount =
    args.sourceType === 'crm.deal' &&
    args.prefillAccountLabel !== '' &&
    trimmedAccount === args.prefillAccountLabel;
  const trimmedQuote = args.quoteExcerpt.trim();
  const trimmedVal = args.dealValue.trim();
  const trimmedCur = args.dealCurrency.trim().toUpperCase();

  return {
    idempotencyKey: args.idempotencyKey,
    boardId: args.boardId,
    roadmapItemId: args.roadmapItemId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    ...(omitUnchangedCrmAccount ? {} : { accountLabel: trimmedAccount ? trimmedAccount : null }),
    quoteExcerpt: trimmedQuote ? trimmedQuote : null,
    dealValue: trimmedVal ? trimmedVal : null,
    dealCurrency: trimmedVal ? trimmedCur || 'VND' : null,
  };
}

export function buildRoadmapSignalAttempt(args: {
  boardId: string;
  roadmapItemId: string;
  sourceType: RoadmapSignalSourceType;
  sourceId: string;
  accountLabel: string;
  prefillAccountLabel: string;
  quoteExcerpt: string;
  dealValue: string;
  dealCurrency: string;
  previousAttempt: { sig: string; key: string } | null;
  mintKey?: () => string;
}): {
  attempt: { sig: string; key: string };
  payload: ReturnType<typeof buildRoadmapSignalCreatePayload>;
} {
  const { idempotencyKey: _placeholder, ...payloadFields } = buildRoadmapSignalCreatePayload({
    idempotencyKey: '',
    boardId: args.boardId,
    roadmapItemId: args.roadmapItemId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    accountLabel: args.accountLabel,
    prefillAccountLabel: args.prefillAccountLabel,
    quoteExcerpt: args.quoteExcerpt,
    dealValue: args.dealValue,
    dealCurrency: args.dealCurrency,
  });
  const signalSig = JSON.stringify(payloadFields);
  const attempt =
    args.previousAttempt?.sig === signalSig
      ? args.previousAttempt
      : { sig: signalSig, key: (args.mintKey ?? (() => crypto.randomUUID()))() };

  return {
    attempt,
    payload: {
      ...payloadFields,
      idempotencyKey: attempt.key,
    },
  };
}

export function RoadmapSignalModal({
  open,
  onOpenChange,
  fixedBoardId,
  fixedItem,
  prefillSource,
  onLinked,
}: RoadmapSignalModalProps) {
  const t = useTranslations('projects.roadmap.admin');
  const locale = useLocale();
  const fmt = useFormat();
  const modulesKey = installedModules().join(',');
  const language: 'vi' | 'en' = locale.startsWith('vi') ? 'vi' : 'en';

  const isFromItem = Boolean(fixedBoardId && fixedItem);
  const availableSources = useMemo(
    () => sourceTypeOptions(modulesKey ? modulesKey.split(',') : []),
    [modulesKey],
  );
  const wasOpenRef = useRef(false);

  const [selectedBoardId, setSelectedBoardId] = useState(fixedBoardId ?? '');
  const [selectedItemId, setSelectedItemId] = useState(fixedItem?.id ?? '');
  const [itemSearch, setItemSearch] = useState('');
  const [creatingNewItem, setCreatingNewItem] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState('');
  const [newItemSummary, setNewItemSummary] = useState('');

  const [sourceType, setSourceType] = useState<RoadmapSignalSourceType>(
    prefillSource?.sourceType ?? availableSources[0] ?? 'kernel.conversation',
  );
  const [selectedSourceId, setSelectedSourceId] = useState(prefillSource?.sourceId ?? '');
  const [sourceSearch, setSourceSearch] = useState('');

  const [accountLabel, setAccountLabel] = useState(prefillSource?.accountLabel ?? '');
  const [quoteExcerpt, setQuoteExcerpt] = useState(prefillSource?.quoteExcerpt ?? '');
  const [dealValue, setDealValue] = useState(prefillSource?.dealValue ?? '');
  const [dealCurrency, setDealCurrency] = useState(prefillSource?.dealCurrency ?? 'VND');

  const [vyMatch, setVyMatch] = useState<RoadmapSignalMatchResult | null>(null);
  const [vyError, setVyError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createdItemRef = useRef<{ sig: string; itemId: string } | null>(null);
  const itemAttemptKeyRef = useRef<{ sig: string; key: string } | null>(null);
  const signalAttemptKeyRef = useRef<{ sig: string; key: string } | null>(null);
  const prefillAccountRef = useRef<string>(
    prefillSource?.sourceType === 'crm.deal' ? (prefillSource.accountLabel ?? '').trim() : '',
  );
  const openSessionRef = useRef(0);

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        openSessionRef.current += 1;
      }
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    openSessionRef.current += 1;
    createdItemRef.current = null;
    itemAttemptKeyRef.current = null;
    signalAttemptKeyRef.current = null;
    setSubmitError(null);
    setVyMatch(null);
    setVyError(null);
    setCreatingNewItem(false);
    setNewItemTitle('');
    setNewItemSummary('');
    setItemSearch('');
    setSourceSearch('');
    if (fixedBoardId) setSelectedBoardId(fixedBoardId);
    if (fixedItem) setSelectedItemId(fixedItem.id);
    if (prefillSource) {
      setSourceType(prefillSource.sourceType);
      setSelectedSourceId(prefillSource.sourceId);
      setAccountLabel(prefillSource.accountLabel ?? '');
      prefillAccountRef.current =
        prefillSource.sourceType === 'crm.deal' ? (prefillSource.accountLabel ?? '').trim() : '';
      setQuoteExcerpt(prefillSource.quoteExcerpt ?? '');
      setDealValue(prefillSource.dealValue ?? '');
      setDealCurrency(prefillSource.dealCurrency ?? 'VND');
    } else {
      setSourceType(availableSources[0] ?? 'kernel.conversation');
      setSelectedSourceId('');
      setAccountLabel('');
      prefillAccountRef.current = '';
      setQuoteExcerpt('');
      setDealValue('');
      setDealCurrency('VND');
    }
  }, [
    open,
    fixedBoardId,
    fixedItem,
    prefillSource,
    availableSources,
  ]);

  const boardsQuery = useQuery({
    ...orpc.projects.roadmap.boards.queryOptions({ input: {} }),
    enabled: open && !fixedBoardId,
  });

  useEffect(() => {
    if (fixedBoardId) return;
    const boards = boardsQuery.data?.boards ?? [];
    if (boards.length > 0 && !boards.some((b) => b.id === selectedBoardId)) {
      const preferred = boards.find((b) => b.enabled) ?? boards[0];
      if (preferred) setSelectedBoardId(preferred.id);
    }
  }, [fixedBoardId, boardsQuery.data, selectedBoardId]);

  const activeBoardId = fixedBoardId ?? selectedBoardId;
  const activeBoardIdRef = useRef(activeBoardId);
  activeBoardIdRef.current = activeBoardId;

  const boardDetailQuery = useQuery({
    ...orpc.projects.roadmap.boardDetail.queryOptions({ input: { boardId: activeBoardId } }),
    enabled: open && !isFromItem && Boolean(activeBoardId),
  });

  const eligibleItems = useMemo(() => {
    const items = boardDetailQuery.data?.items ?? [];
    return items.filter((item) => item.moderationStatus !== 'merged' && item.moderationStatus !== 'archived');
  }, [boardDetailQuery.data]);

  const filteredItems = useMemo(() => {
    const needle = itemSearch.trim().toLowerCase();
    if (!needle) return eligibleItems;
    return eligibleItems.filter(
      (item) =>
        item.publicTitle.toLowerCase().includes(needle) ||
        (item.publicSummary ?? '').toLowerCase().includes(needle),
    );
  }, [eligibleItems, itemSearch]);

  useEffect(() => {
    if (isFromItem) return;
    if (eligibleItems.length > 0 && !eligibleItems.some((item) => item.id === selectedItemId)) {
      const first = eligibleItems[0];
      if (first) setSelectedItemId(first.id);
    } else if (eligibleItems.length === 0) {
      setSelectedItemId('');
    }
  }, [isFromItem, eligibleItems, selectedItemId]);

  const dealsListQuery = useInfiniteQuery({
    ...orpc.crm.deals.list.infiniteOptions({
      input: (cursor: DealCursor | undefined) => ({ limit: 50, ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined as DealCursor | undefined,
      getNextPageParam: (last) => last.next ?? undefined,
    }),
    enabled: open && isFromItem && sourceType === 'crm.deal' && modulesKey.split(',').includes('crm'),
  });

  const conversationsListQuery = useQuery({
    ...orpc.conversations.list.queryOptions({ input: {} }),
    enabled: open && isFromItem && sourceType === 'kernel.conversation',
  });

  const meetingsListQuery = useQuery({
    ...orpc.meetings.list.queryOptions({ input: { limit: 200 } }),
    enabled: open && isFromItem && sourceType === 'meetings.meeting' && modulesKey.split(',').includes('meetings'),
  });

  const activeSourceQuery =
    sourceType === 'crm.deal'
      ? dealsListQuery
      : sourceType === 'kernel.conversation'
        ? conversationsListQuery
        : meetingsListQuery;

  const sourceOptions = useMemo(() => {
    const needle = sourceSearch.trim().toLowerCase();
    if (sourceType === 'crm.deal') {
      const items = (dealsListQuery.data?.pages ?? []).flatMap((page) => page.items);
      return items
        .filter((d) => !needle || d.title.toLowerCase().includes(needle) || (d.partyName ?? '').toLowerCase().includes(needle))
        .map((d) => ({
          id: d.id,
          label: [d.title, d.partyName, d.amount && d.currency ? fmt.money(d.amount, d.currency) : null]
            .filter(Boolean)
            .join(' · '),
          account: d.partyName ?? '',
          amount: d.amount ?? '',
          currency: d.currency ?? 'VND',
        }));
    }
    if (sourceType === 'kernel.conversation') {
      const convs = conversationsListQuery.data?.conversations ?? [];
      return convs
        .filter((c) => {
          const text = [c.contact?.partyName, c.channel.displayName, c.preview].filter(Boolean).join(' ').toLowerCase();
          return !needle || text.includes(needle);
        })
        .map((c) => ({
          id: c.id,
          label: [c.contact?.partyName ?? c.channel.displayName, c.preview].filter(Boolean).join(' · '),
          account: c.contact?.partyName ?? '',
          amount: '',
          currency: 'VND',
        }));
    }
    const meetings = meetingsListQuery.data ?? [];
    return meetings
      .filter((m) => !needle || m.title.toLowerCase().includes(needle))
      .map((m) => ({
        id: m.id,
        label: m.title,
        account: '',
        amount: '',
        currency: 'VND',
      }));
  }, [sourceType, sourceSearch, dealsListQuery.data, conversationsListQuery.data, meetingsListQuery.data, fmt]);

  function handleSelectPickedSource(id: string) {
    const changed = id !== selectedSourceId;
    setSelectedSourceId(id);
    if (changed) {
      setQuoteExcerpt('');
    }
    const chosen = sourceOptions.find((o) => o.id === id);
    if (!chosen) {
      prefillAccountRef.current = '';
      setAccountLabel('');
      setDealValue('');
      setDealCurrency('VND');
      return;
    }
    prefillAccountRef.current = sourceType === 'crm.deal' ? chosen.account.trim() : '';
    setAccountLabel(chosen.account);
    setDealValue(chosen.amount);
    setDealCurrency(chosen.currency || 'VND');
  }

  const vyMatchMutation = useMutation({
    mutationFn: async (boardId: string) => {
      if (!boardId || !prefillSource) {
        throw new Error('Board or source is missing');
      }
      const res = await orpc.projects.roadmap.signalMatchSuggest.call({
        boardId,
        sourceType: prefillSource.sourceType,
        sourceId: prefillSource.sourceId,
        language,
      });
      return { boardId, res };
    },
    onSuccess: ({ boardId, res }) => {
      if (boardId !== activeBoardIdRef.current) return;
      setVyError(null);
      setVyMatch(res);
    },
    onError: (err, boardId) => {
      if (boardId !== activeBoardIdRef.current) return;
      setVyError(errorMessage(err));
    },
  });

  const linkMutation = useMutation({
    mutationFn: async (sessionId: number) => {
      const prefillAccountLabel = prefillAccountRef.current;
      const boardId = activeBoardId;
      if (!boardId) throw new Error('Select a roadmap board');
      let targetItemId = fixedItem?.id ?? selectedItemId;

      if (!isFromItem && creatingNewItem) {
        const trimmedTitle = newItemTitle.trim();
        const trimmedSummary = newItemSummary.trim();
        const itemSig = JSON.stringify([boardId, trimmedTitle, trimmedSummary]);
        if (createdItemRef.current?.sig === itemSig) {
          targetItemId = createdItemRef.current.itemId;
        } else {
          if (itemAttemptKeyRef.current?.sig !== itemSig) {
            itemAttemptKeyRef.current = { sig: itemSig, key: crypto.randomUUID() };
          }
          const created = await orpc.projects.roadmap.itemCreate.call({
            idempotencyKey: itemAttemptKeyRef.current.key,
            boardId,
            publicTitle: trimmedTitle,
            publicSummary: trimmedSummary ? trimmedSummary : null,
            category: null,
          });
          createdItemRef.current = { sig: itemSig, itemId: created.item.id };
          targetItemId = created.item.id;
        }
      }

      if (!targetItemId) throw new Error('Select a roadmap item');
      const finalSourceType = prefillSource?.sourceType ?? sourceType;
      const finalSourceId = prefillSource?.sourceId ?? selectedSourceId;
      if (!finalSourceId) throw new Error('Select a source record');

      const { attempt, payload } = buildRoadmapSignalAttempt({
        boardId,
        roadmapItemId: targetItemId,
        sourceType: finalSourceType,
        sourceId: finalSourceId,
        accountLabel,
        prefillAccountLabel,
        quoteExcerpt,
        dealValue,
        dealCurrency,
        previousAttempt: signalAttemptKeyRef.current,
      });
      signalAttemptKeyRef.current = attempt;

      const res = await orpc.projects.roadmap.signalCreate.call(payload);
      return { sessionId, boardId, roadmapItemId: targetItemId, alreadyLinked: res.alreadyLinked };
    },
    onSuccess: async ({ sessionId, ...res }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.projects.roadmap.signalList.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.projects.roadmap.signalRollup.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.projects.roadmap.boardDetail.key() }),
      ]);
      toast(res.alreadyLinked ? t('signalAlreadyLinkedToast') : t('signalLinkedToast'), 'success');
      if (sessionId !== openSessionRef.current) return;
      createdItemRef.current = null;
      itemAttemptKeyRef.current = null;
      signalAttemptKeyRef.current = null;
      setSubmitError(null);
      onOpenChange(false);
      onLinked?.(res);
    },
    onError: (err, sessionId) => {
      if (sessionId !== openSessionRef.current) return;
      setSubmitError(errorMessage(err));
    },
  });

  const boards = boardsQuery.data?.boards ?? [];
  const itemTitlesById = useMemo(
    () => new Map(eligibleItems.map((i) => [i.id, i.publicTitle])),
    [eligibleItems],
  );
  const selectedItemVisible = useMemo(
    () => filteredItems.some((item) => item.id === selectedItemId),
    [filteredItems, selectedItemId],
  );

  const canSubmit =
    Boolean(activeBoardId) &&
    (isFromItem
      ? Boolean(fixedItem?.id && selectedSourceId)
      : creatingNewItem
        ? newItemTitle.trim().length > 0
        : selectedItemVisible);

  const vyBannerText = useMemo(() => {
    if (!vyMatch) return null;
    if (vyMatch.ai === 'off' || vyMatch.ai === 'paused') return t('vyStateOff');
    if (vyMatch.ai === 'budget') return t('vyStateBudget');
    if (vyMatch.ai === 'busy') return t('vyStateBusy');
    if (vyMatch.ai === 'refused' || vyMatch.ai === 'failed') return t('vyStateRefused');
    if (vyMatch.suggestions.length === 0 && !vyMatch.newIdeaDraft) return t('signalVyEmpty');
    return null;
  }, [vyMatch, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto"
        closeLabel={t('signalCancelBtn')}
      >
        <DialogHeader>
          <DialogTitle>
            {isFromItem
              ? t('signalModalFromItemTitle', { title: fixedItem?.title ?? '' })
              : t('signalModalFromSourceTitle')}
          </DialogTitle>
          <DialogDescription>
            {isFromItem ? t('signalModalFromItemDesc') : t('signalModalFromSourceDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t('signalInternalOnlyNotice')}
          </p>

          {!fixedBoardId && boardsQuery.isError ? (
            <Alert
              variant="destructive"
              className="flex flex-col gap-2 border-destructive/30 bg-destructive/10 sm:flex-row sm:items-center sm:justify-between"
              data-testid="roadmap-signal-boards-error"
            >
              <AlertDescription className="text-xs">{t('signalBoardsLoadError')}</AlertDescription>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 shrink-0"
                data-testid="roadmap-signal-boards-retry"
                onClick={() => {
                  void boardsQuery.refetch();
                }}
              >
                {t('signalRetryBtn')}
              </Button>
            </Alert>
          ) : !fixedBoardId && !boardsQuery.isPending && boards.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground">
              {t('signalBoardEmpty')}
            </p>
          ) : (
            <>
              {!isFromItem && (
                <div className="space-y-3">
                  {boards.length > 1 && (
                    <div className="space-y-1.5">
                      <Label htmlFor="roadmap-signal-board">{t('signalBoardLabel')}</Label>
                      <NativeSelect
                        id="roadmap-signal-board"
                        className="w-full min-h-11 [&_select]:min-h-11"
                        value={activeBoardId}
                        onChange={(e) => {
                          setSelectedBoardId(e.target.value);
                          setVyMatch(null);
                        }}
                      >
                        {boards.map((b) => (
                          <NativeSelectOption key={b.id} value={b.id}>
                            {b.title}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  )}

                  {prefillSource && activeBoardId && (
                    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium text-foreground">{t('signalVyTitle')}</span>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11 px-3"
                          disabled={vyMatchMutation.isPending}
                          onClick={() => vyMatchMutation.mutate(activeBoardId)}
                        >
                          {vyMatchMutation.isPending ? t('signalVyBusy') : t('signalVyBtn')}
                        </Button>
                      </div>

                      {vyError && <p className="text-xs text-destructive">{vyError}</p>}
                      {vyBannerText && <p className="text-xs text-muted-foreground">{vyBannerText}</p>}

                      {vyMatch && vyMatch.suggestions.length > 0 && (
                        <ul className="space-y-2">
                          {vyMatch.suggestions.map((s) => (
                            <li
                              key={s.roadmapItemId}
                              className="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5 md:flex-row md:items-center md:justify-between"
                            >
                              <div className="min-w-0 space-y-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm font-medium text-foreground">
                                    {itemTitlesById.get(s.roadmapItemId) ?? s.roadmapItemId}
                                  </span>
                                  <Badge variant="secondary">{s.confidence}</Badge>
                                </div>
                                <p className="text-xs text-muted-foreground">{s.reason}</p>
                              </div>
                              <Button
                                type="button"
                                variant={selectedItemId === s.roadmapItemId && !creatingNewItem ? 'default' : 'outline'}
                                className="min-h-11 shrink-0 px-3"
                                onClick={() => {
                                  setCreatingNewItem(false);
                                  setSelectedItemId(s.roadmapItemId);
                                }}
                              >
                                {t('signalVyPickBtn')}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {vyMatch?.newIdeaDraft && (
                        <div className="space-y-2 rounded-md border border-border bg-card p-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-medium text-foreground">{t('signalVyDraftLabel')}</span>
                              <Badge variant="outline">{t('taintedBadge')}</Badge>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11 px-3"
                              onClick={() => {
                                setCreatingNewItem(true);
                                setNewItemTitle(vyMatch.newIdeaDraft?.suggestedTitle ?? '');
                                setNewItemSummary(vyMatch.newIdeaDraft?.suggestedSummary ?? '');
                              }}
                            >
                              {t('signalVyUseDraftBtn')}
                            </Button>
                          </div>
                          <p className="text-sm font-medium text-foreground">{vyMatch.newIdeaDraft.suggestedTitle}</p>
                          {vyMatch.newIdeaDraft.suggestedSummary && (
                            <p className="text-xs text-muted-foreground">{vyMatch.newIdeaDraft.suggestedSummary}</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {!creatingNewItem ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label htmlFor="roadmap-signal-item-select">{t('signalItemLabel')}</Label>
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-11 px-3 text-xs"
                          onClick={() => setCreatingNewItem(true)}
                        >
                          {t('signalCreateItemBtn')}
                        </Button>
                      </div>
                      <Input
                        type="search"
                        aria-label={t('signalSearchItemsPlaceholder')}
                        className="min-h-11"
                        placeholder={t('signalSearchItemsPlaceholder')}
                        value={itemSearch}
                        onChange={(e) => setItemSearch(e.target.value)}
                      />
                      <NativeSelect
                        id="roadmap-signal-item-select"
                        className="w-full min-h-11 [&_select]:min-h-11"
                        value={selectedItemId}
                        onChange={(e) => setSelectedItemId(e.target.value)}
                      >
                        <NativeSelectOption value="">{t('selectItemPlaceholder')}</NativeSelectOption>
                        {filteredItems.map((item) => (
                          <NativeSelectOption key={item.id} value={item.id}>
                            {item.publicTitle} ({item.voteCount})
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  ) : (
                    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{t('signalCreateItemBtn')}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-11 px-3 text-xs"
                          onClick={() => setCreatingNewItem(false)}
                        >
                          {t('signalCancelBtn')}
                        </Button>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="roadmap-signal-new-item-title">{t('signalCreateItemTitleLabel')}</Label>
                        <Input
                          id="roadmap-signal-new-item-title"
                          className="min-h-11"
                          value={newItemTitle}
                          maxLength={200}
                          onChange={(e) => setNewItemTitle(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="roadmap-signal-new-item-summary">{t('signalCreateItemSummaryLabel')}</Label>
                        <Textarea
                          id="roadmap-signal-new-item-summary"
                          rows={2}
                          value={newItemSummary}
                          maxLength={4000}
                          onChange={(e) => setNewItemSummary(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {isFromItem && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="roadmap-signal-source-type">{t('signalSourceTypeLabel')}</Label>
                    <NativeSelect
                      id="roadmap-signal-source-type"
                      className="w-full min-h-11 [&_select]:min-h-11"
                      value={sourceType}
                      onChange={(e) => {
                        setSourceType(e.target.value as RoadmapSignalSourceType);
                        setSelectedSourceId('');
                        setSourceSearch('');
                        prefillAccountRef.current = '';
                        setAccountLabel('');
                        setQuoteExcerpt('');
                        setDealValue('');
                        setDealCurrency('VND');
                      }}
                    >
                      {availableSources.map((st) => (
                        <NativeSelectOption key={st} value={st}>
                          {st === 'crm.deal'
                            ? t('signalSourceCrmDeal')
                            : st === 'kernel.conversation'
                              ? t('signalSourceConversation')
                              : t('signalSourceMeeting')}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="roadmap-signal-source-search">{t('signalSourceSearchPlaceholder')}</Label>
                    <Input
                      id="roadmap-signal-source-search"
                      type="search"
                      className="min-h-11"
                      placeholder={t('signalSourceSearchPlaceholder')}
                      value={sourceSearch}
                      onChange={(e) => setSourceSearch(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5 md:col-span-2">
                    <Label htmlFor="roadmap-signal-source-select">{t('signalSourcePickerLabel')}</Label>
                    <NativeSelect
                      id="roadmap-signal-source-select"
                      className="w-full min-h-11 [&_select]:min-h-11"
                      value={selectedSourceId}
                      onChange={(e) => handleSelectPickedSource(e.target.value)}
                    >
                      <NativeSelectOption value="">{t('signalSourcePickerLabel')}</NativeSelectOption>
                      {sourceOptions.map((opt) => (
                        <NativeSelectOption key={opt.id} value={opt.id}>
                          {opt.label || opt.id}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    {activeSourceQuery.isError && sourceOptions.length === 0 ? (
                      <Alert
                        variant="destructive"
                        className="flex flex-col gap-2 border-destructive/30 bg-destructive/10 sm:flex-row sm:items-center sm:justify-between"
                        data-testid="roadmap-signal-sources-error"
                      >
                        <AlertDescription className="text-xs">{t('signalSourcesLoadError')}</AlertDescription>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 shrink-0"
                          data-testid="roadmap-signal-sources-retry"
                          onClick={() => {
                            void activeSourceQuery.refetch();
                          }}
                        >
                          {t('signalRetryBtn')}
                        </Button>
                      </Alert>
                    ) : (
                      activeSourceQuery.isSuccess &&
                      sourceOptions.length === 0 && (
                        <p className="text-xs text-muted-foreground" data-testid="roadmap-signal-sources-empty">
                          {t('signalSourcesEmpty')}
                        </p>
                      )
                    )}
                    {sourceType === 'crm.deal' && dealsListQuery.hasNextPage && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11"
                        disabled={dealsListQuery.isFetchingNextPage}
                        onClick={() => void dealsListQuery.fetchNextPage()}
                        data-testid="roadmap-signal-load-more-deals"
                      >
                        {t('signalLoadMoreDeals')}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="roadmap-signal-account">{t('signalAccountLabel')}</Label>
                  <Input
                    id="roadmap-signal-account"
                    className="min-h-11"
                    placeholder={t('signalAccountPlaceholder')}
                    maxLength={160}
                    value={accountLabel}
                    onChange={(e) => setAccountLabel(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="roadmap-signal-value">{t('signalDealValueLabel')}</Label>
                  <Input
                    id="roadmap-signal-value"
                    className="min-h-11"
                    inputMode="decimal"
                    placeholder="15000000"
                    value={dealValue}
                    onChange={(e) => setDealValue(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="roadmap-signal-currency">{t('signalDealCurrencyLabel')}</Label>
                  <Input
                    id="roadmap-signal-currency"
                    className="min-h-11 uppercase"
                    maxLength={3}
                    placeholder="VND"
                    value={dealCurrency}
                    onChange={(e) => setDealCurrency(e.target.value.toUpperCase())}
                  />
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="roadmap-signal-quote">{t('signalQuoteLabel')}</Label>
                  <Textarea
                    id="roadmap-signal-quote"
                    rows={3}
                    placeholder={t('signalQuotePlaceholder')}
                    maxLength={1000}
                    value={quoteExcerpt}
                    onChange={(e) => setQuoteExcerpt(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          {submitError && <p className="text-sm text-destructive">{submitError}</p>}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full md:w-auto"
            onClick={() => onOpenChange(false)}
          >
            {t('signalCancelBtn')}
          </Button>
          {boards.length > 0 || fixedBoardId ? (
            <Button
              type="button"
              className="min-h-11 w-full md:w-auto"
              disabled={!canSubmit || linkMutation.isPending}
              onClick={() => linkMutation.mutate(openSessionRef.current)}
            >
              {creatingNewItem ? t('signalCreateItemSubmit') : t('signalSubmitBtn')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
