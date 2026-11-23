// SPDX-License-Identifier: AGPL-3.0-only
// Internal Projects Public Roadmap management panel (#4399, #4400, ADR-0057):
// 1-click board activation, iframe embed snippet, ideas moderation queue, Vy duplicate proposals (human confirms merge),
// Changelog announcement composer (Vy draft + manual authoring, publish), and explicit confirmation for shipped email alerts.
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ROADMAP_ANNOUNCEMENT_BODY_MAX,
  ROADMAP_ANNOUNCEMENT_TITLE_MAX,
  ROADMAP_ITEM_MODERATION_STATUSES,
  ROADMAP_ITEM_STAGES,
  normalizeRoadmapEmbedOrigin,
  type RoadmapAdminItem,
  type RoadmapAnnouncement,
  type RoadmapBoardSummary,
  type RoadmapDedupeResult,
  type RoadmapDedupeSuggestion,
  type RoadmapItemModerationStatus,
  type RoadmapItemStage,
  type RoadmapSignalItemRollup,
} from '@ludy/kernel-contract';
import { useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { RoadmapSignalModal } from './roadmap-signal-modal.tsx';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { SafeRoadmapMarkdown } from './roadmap-markdown.tsx';
import { Empty, ErrorText, ListSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

function refreshRoadmapQueries() {
  void queryClient.invalidateQueries({ queryKey: orpc.projects.roadmap.boards.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.projects.roadmap.boardDetail.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.projects.roadmap.signalList.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.projects.roadmap.signalRollup.key() });
}

export function ExpandedItemSignals({
  boardId,
  roadmapItemId,
  canWrite,
  deletePending,
  onDeleteSignal,
}: {
  boardId: string;
  roadmapItemId: string;
  canWrite: boolean;
  deletePending: boolean;
  onDeleteSignal: (signalId: string) => void;
}) {
  const t = useTranslations('projects.roadmap.admin');
  const f = useFormat();
  const signalListQuery = useQuery({
    ...orpc.projects.roadmap.signalList.queryOptions({
      input: { boardId, roadmapItemId, limit: 200 },
    }),
    enabled: Boolean(boardId && roadmapItemId),
  });
  const itemSignals = signalListQuery.data?.signals ?? [];

  if (signalListQuery.isPending) {
    return <ListSkeleton rows={2} />;
  }
  if (signalListQuery.error) {
    return <ErrorText>{errorMessage(signalListQuery.error)}</ErrorText>;
  }
  if (itemSignals.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">{t('signalEmptyList')}</p>;
  }

  return (
    <ul className="mt-2 space-y-2" data-testid={`roadmap-admin-signals-list-${roadmapItemId}`}>
      {itemSignals.map((sig) => (
        <li
          key={sig.id}
          className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2.5 text-xs md:flex-row md:items-start md:justify-between"
        >
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">
                {sig.sourceType === 'crm.deal'
                  ? t('signalSourceCrmDeal')
                  : sig.sourceType === 'kernel.conversation'
                    ? t('signalSourceConversation')
                    : t('signalSourceMeeting')}
              </Badge>
              {sig.accountLabel && (
                <span className="font-medium text-foreground">{sig.accountLabel}</span>
              )}
              {sig.dealValue && sig.dealCurrency && (
                <Badge variant="secondary" className="tabular-nums">
                  {sig.dealCurrency} {f.money(sig.dealValue, sig.dealCurrency)}
                </Badge>
              )}
              <span className="text-muted-foreground">{f.date(sig.createdAt)}</span>
            </div>
            {sig.quoteExcerpt && (
              <p className="text-muted-foreground">{sig.quoteExcerpt}</p>
            )}
          </div>
          {canWrite && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 shrink-0 text-xs text-destructive"
              disabled={deletePending}
              onClick={() => onDeleteSignal(sig.id)}
              data-testid={`roadmap-admin-delete-signal-${sig.id}`}
            >
              {t('signalUnlinkBtn')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function publicBoardShareUrl(orgSlug: string, boardSlug: string): string {
  const path = `/-/roadmap/${encodeURIComponent(orgSlug)}/${encodeURIComponent(boardSlug)}`;
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path}`;
}

function publicBoardEmbedSnippet(orgSlug: string, boardSlug: string, title = 'Public Roadmap'): string {
  const url = `${publicBoardShareUrl(orgSlug, boardSlug)}?embed=1`;
  const safeTitle = title.replace(/["&<>]/g, '');
  return `<iframe src="${url}" title="${safeTitle || 'Public Roadmap'}" width="100%" height="680" loading="lazy" style="border:0;border-radius:12px"></iframe>`;
}

function copyText(text: string, doneMessage: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
  void navigator.clipboard.writeText(text).then(() => {
    toast(doneMessage, 'success');
  });
}

function parseOriginsText(raw: string): { ok: true; origins: string[] } | { ok: false; bad: string } {
  const tokens = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const origins: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeRoadmapEmbedOrigin(token);
    if (!normalized) return { ok: false, bad: token };
    if (!origins.includes(normalized)) origins.push(normalized);
  }
  return { ok: true, origins };
}

export function ProjectRoadmapPanel({ orgSlug }: { orgSlug: string }) {
  const t = useTranslations('projects.roadmap.admin');
  const tPub = useTranslations('projects.roadmap.public');
  const tc = useTranslations('common');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';

  const boardsQuery = useQuery(orpc.projects.roadmap.boards.queryOptions({ input: {} }));
  const boards = boardsQuery.data?.boards ?? [];
  const projects = boardsQuery.data?.projects ?? [];
  const seats = boardsQuery.data?.seats ?? [];
  const canWrite = boardsQuery.data?.canWrite ?? false;
  const canManageBoard = boardsQuery.data?.canManageBoard ?? false;

  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const effectiveBoardId =
    selectedBoardId && boards.some((b) => b.id === selectedBoardId) ? selectedBoardId : (boards[0]?.id ?? null);

  const detailQuery = useQuery({
    ...orpc.projects.roadmap.boardDetail.queryOptions({ input: { boardId: effectiveBoardId ?? '' } }),
    enabled: Boolean(effectiveBoardId),
  });
  const signalRollupQuery = useQuery({
    ...orpc.projects.roadmap.signalRollup.queryOptions({ input: { boardId: effectiveBoardId ?? '' } }),
    enabled: Boolean(effectiveBoardId),
  });
  const [signalItem, setSignalItem] = useState<RoadmapAdminItem | null>(null);
  const [expandedSignalItemIds, setExpandedSignalItemIds] = useState<string[]>([]);
  const signalDelete = useMutation(
    orpc.projects.roadmap.signalDelete.mutationOptions({
      onSuccess: () => {
        refreshRoadmapQueries();
        toast(t('signalRemovedToast'), 'success');
      },
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  const [modFilter, setModFilter] = useState<'all' | RoadmapItemModerationStatus>('all');
  const [createBoardOpen, setCreateBoardOpen] = useState(false);
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [newBoardSlug, setNewBoardSlug] = useState('');
  const [newBoardDesc, setNewBoardDesc] = useState('');
  const [newBoardProjectId, setNewBoardProjectId] = useState('');

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editSlug, setEditSlug] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editProjectId, setEditProjectId] = useState('');
  const [editAllowSub, setEditAllowSub] = useState(true);
  const [editAllowVote, setEditAllowVote] = useState(true);
  const [editRequireMod, setEditRequireMod] = useState(true);
  const [editOriginsText, setEditOriginsText] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [newItemOpen, setNewItemOpen] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState('');
  const [newItemSummary, setNewItemSummary] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('');
  const [newItemStage, setNewItemStage] = useState<RoadmapItemStage>('planned');

  const [mergeItem, setMergeItem] = useState<RoadmapAdminItem | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState('');

  const [convertItem, setConvertItem] = useState<RoadmapAdminItem | null>(null);
  const [convertProjectId, setConvertProjectId] = useState('');
  const [convertSeatId, setConvertSeatId] = useState('');

  // Vy duplicate suggestions (proposal only, human confirms merge)
  const [dedupeResult, setDedupeResult] = useState<RoadmapDedupeResult | null>(null);
  const [dismissedPairs, setDismissedPairs] = useState<string[]>([]);

  // Changelog announcements composer & alert confirmation
  const [annDialogOpen, setAnnDialogOpen] = useState(false);
  const [editingAnn, setEditingAnn] = useState<RoadmapAnnouncement | null>(null);
  const [annTitle, setAnnTitle] = useState('');
  const [annBodyMd, setAnnBodyMd] = useState('');
  const [annLinkedIds, setAnnLinkedIds] = useState<string[]>([]);
  const [annVyMessage, setAnnVyMessage] = useState<string | null>(null);
  const [confirmNotifyAnn, setConfirmNotifyAnn] = useState<RoadmapAnnouncement | null>(null);

  const boardCreate = useMutation(
    orpc.projects.roadmap.boardCreate.mutationOptions({
      onSuccess: (res) => {
        refreshRoadmapQueries();
        setSelectedBoardId(res.board.id);
        setCreateBoardOpen(false);
        setNewBoardTitle('');
        setNewBoardSlug('');
        setNewBoardDesc('');
        setNewBoardProjectId('');
        toast(t('boardCreated'), 'success');
      },
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  const boardUpdate = useMutation(
    orpc.projects.roadmap.boardUpdate.mutationOptions({
      onSuccess: () => {
        refreshRoadmapQueries();
        setSettingsOpen(false);
        toast(t('boardSaved'), 'success');
      },
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  const itemCreate = useMutation(
    orpc.projects.roadmap.itemCreate.mutationOptions({
      onSuccess: () => {
        refreshRoadmapQueries();
        setNewItemOpen(false);
        setNewItemTitle('');
        setNewItemSummary('');
        setNewItemCategory('');
        toast(t('itemCreated'), 'success');
      },
    }),
  );

  const itemModerate = useMutation(
    orpc.projects.roadmap.itemModerate.mutationOptions({
      onSuccess: refreshRoadmapQueries,
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  const itemMerge = useMutation(
    orpc.projects.roadmap.itemMerge.mutationOptions({
      onSuccess: () => {
        refreshRoadmapQueries();
        setMergeItem(null);
        setMergeTargetId('');
        toast(t('itemMerged'), 'success');
      },
    }),
  );

  const itemConvert = useMutation(
    orpc.projects.roadmap.itemConvertToTask.mutationOptions({
      onSuccess: () => {
        refreshRoadmapQueries();
        setConvertItem(null);
        toast(t('itemConverted'), 'success');
      },
    }),
  );

  const itemSyncStage = useMutation(
    orpc.projects.roadmap.itemSyncStage.mutationOptions({
      onSuccess: refreshRoadmapQueries,
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  const vyAiStatusMessage = (state: string): string => {
    if (state === 'budget') return t('vyStateBudget');
    if (state === 'busy') return t('vyStateBusy');
    if (state === 'refused' || state === 'failed') return t('vyStateRefused');
    return t('vyStateOff');
  };

  const vyDedupe = useMutation({
    mutationFn: (boardId: string) => client.projects.roadmap.dedupeSuggest({ boardId, language: locale }),
    onSuccess: (res) => {
      setDismissedPairs([]);
      setDedupeResult(res);
    },
    onError: (error) => {
      toast(errorMessage(error), 'error');
    },
  });

  const vyChangelogDraft = useMutation({
    mutationFn: (input: { boardId: string; itemIds: string[] }) =>
      client.projects.roadmap.changelogDraft({ boardId: input.boardId, itemIds: input.itemIds, language: locale }),
    onSuccess: (res) => {
      if (res.ai === 'used' && res.title && res.bodyMd) {
        setAnnTitle(res.title);
        setAnnBodyMd(res.bodyMd);
        setAnnVyMessage(null);
      } else {
        setAnnVyMessage(vyAiStatusMessage(res.ai));
      }
    },
    onError: (error) => {
      setAnnVyMessage(errorMessage(error));
    },
  });

  const announcementCreate = useMutation(
    orpc.projects.roadmap.announcementCreate.mutationOptions({
      onSuccess: () => {
        refreshRoadmapQueries();
        setAnnDialogOpen(false);
        toast(t('announcementCreated'), 'success');
      },
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  const announcementUpdate = useMutation(
    orpc.projects.roadmap.announcementUpdate.mutationOptions({
      onSuccess: () => {
        refreshRoadmapQueries();
        setAnnDialogOpen(false);
        toast(t('announcementUpdated'), 'success');
      },
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  const announcementPublish = useMutation(
    orpc.projects.roadmap.announcementPublish.mutationOptions({
      onSuccess: () => {
        refreshRoadmapQueries();
        toast(t('announcementPublished'), 'success');
      },
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  const announcementDelete = useMutation(
    orpc.projects.roadmap.announcementDelete.mutationOptions({
      onSuccess: () => {
        refreshRoadmapQueries();
        toast(t('announcementDeleted'), 'success');
      },
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  const announcementSendNotifications = useMutation(
    orpc.projects.roadmap.announcementSendNotifications.mutationOptions({
      onSuccess: (res) => {
        refreshRoadmapQueries();
        setConfirmNotifyAnn(null);
        if (res.queuedDispatch) {
          toast(t('announcementAlertsQueued', { count: String(res.eligibleCount) }), 'success');
        } else {
          toast(t('announcementAlertsNone'), 'success');
        }
      },
      onError: (error) => {
        toast(errorMessage(error), 'error');
      },
    }),
  );

  if (boardsQuery.isPending) {
    return <ListSkeleton rows={4} />;
  }
  if (boardsQuery.error) {
    return <ErrorText>{errorMessage(boardsQuery.error)}</ErrorText>;
  }

  const activeBoard: RoadmapBoardSummary | null = detailQuery.data?.board ?? boards.find((b) => b.id === effectiveBoardId) ?? null;
  const items = detailQuery.data?.items ?? [];
  const announcements = detailQuery.data?.announcements ?? [];
  const activeSubscriberCount = detailQuery.data?.activeSubscriberCount ?? 0;
  const shippedPublishedItems = items.filter((it) => it.moderationStatus === 'published' && it.stage === 'shipped');
  const itemsById = new Map(items.map((it) => [it.id, it]));
  const visibleDedupeSuggestions: RoadmapDedupeSuggestion[] = (dedupeResult?.suggestions ?? []).filter((s) => {
    const pairKey = `${s.sourceItemId}:${s.targetItemId}`;
    if (dismissedPairs.includes(pairKey)) return false;
    const src = itemsById.get(s.sourceItemId);
    const tgt = itemsById.get(s.targetItemId);
    return src && tgt && src.moderationStatus !== 'merged' && tgt.moderationStatus === 'published';
  });
  const filteredItems = modFilter === 'all' ? items : items.filter((it) => it.moderationStatus === modFilter);
  const mergeTargets = items.filter((it) => it.id !== mergeItem?.id && it.moderationStatus !== 'merged' && it.moderationStatus !== 'archived');
  const rollupByItem = new Map<string, RoadmapSignalItemRollup>(
    (signalRollupQuery.data?.byItem ?? []).map((r) => [r.roadmapItemId, r]),
  );
  const boardSignalRollup = signalRollupQuery.data ?? null;
  const toggleSignalList = (itemId: string) => {
    setExpandedSignalItemIds((prev) => (prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]));
  };

  const openNewAnnouncementDialog = () => {
    setEditingAnn(null);
    setAnnTitle('');
    setAnnBodyMd('');
    setAnnLinkedIds(shippedPublishedItems.slice(0, 5).map((i) => i.id));
    setAnnVyMessage(null);
    setAnnDialogOpen(true);
  };

  const openEditAnnouncementDialog = (ann: RoadmapAnnouncement) => {
    setEditingAnn(ann);
    setAnnTitle(ann.title);
    setAnnBodyMd(ann.bodyMd);
    setAnnLinkedIds(ann.linkedItemIds);
    setAnnVyMessage(null);
    setAnnDialogOpen(true);
  };

  const toggleLinkedShippedItem = (itemId: string, checked: boolean) => {
    setAnnLinkedIds((prev) => {
      if (checked) return prev.includes(itemId) ? prev : [...prev, itemId];
      return prev.filter((id) => id !== itemId);
    });
  };

  const openSettingsForBoard = (board: RoadmapBoardSummary) => {
    setEditTitle(board.title);
    setEditSlug(board.slug);
    setEditDesc(board.description ?? '');
    setEditProjectId(board.projectId ?? '');
    setEditAllowSub(board.allowSubmissions);
    setEditAllowVote(board.allowVoting);
    setEditRequireMod(board.requireModeration);
    setEditOriginsText(board.embedAllowedOrigins.join('\n'));
    setSettingsError(null);
    setSettingsOpen(true);
  };

  const handleQuickEnable = () => {
    if (!canManageBoard) return;
    if (!activeBoard) {
      boardCreate.mutate({
        title: t('defaultBoardTitle'),
        slug: 'roadmap',
        enabled: true,
        allowSubmissions: true,
        allowVoting: true,
        requireModeration: true,
        idempotencyKey: crypto.randomUUID(),
      });
      return;
    }
    boardUpdate.mutate({
      boardId: activeBoard.id,
      enabled: !activeBoard.enabled,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const handleSaveSettings = (e: FormEvent) => {
    e.preventDefault();
    if (!activeBoard) return;
    const parsedOrigins = parseOriginsText(editOriginsText);
    if (!parsedOrigins.ok) {
      setSettingsError(t('invalidOriginError', { origin: parsedOrigins.bad }));
      return;
    }
    setSettingsError(null);
    boardUpdate.mutate({
      boardId: activeBoard.id,
      title: editTitle.trim(),
      slug: editSlug.trim().toLowerCase(),
      description: editDesc.trim() || null,
      projectId: editProjectId || null,
      allowSubmissions: editAllowSub,
      allowVoting: editAllowVote,
      requireModeration: editRequireMod,
      embedAllowedOrigins: parsedOrigins.origins,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  return (
    <div className="space-y-5" data-testid="project-roadmap-admin-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">{t('heading')}</h2>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canManageBoard && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setCreateBoardOpen(true)}
              data-testid="roadmap-admin-new-board-btn"
            >
              {t('newBoardBtn')}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              onClick={handleQuickEnable}
              disabled={boardCreate.isPending || boardUpdate.isPending}
              data-testid="roadmap-admin-toggle-enabled-btn"
            >
              {!activeBoard
                ? t('oneClickActivateBtn')
                : activeBoard.enabled
                  ? t('disableBoardBtn')
                  : t('enableBoardBtn')}
            </Button>
          </div>
        )}
      </div>

      {boards.length === 0 ? (
        <Empty title={t('emptyBoards')} hint={t('emptyBoardsHint')} />
      ) : (
        <>
          {boards.length > 1 && (
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor="roadmap-board-select">{t('selectBoardLabel')}</Label>
              <NativeSelect
                id="roadmap-board-select"
                value={effectiveBoardId ?? ''}
                onChange={(e) => setSelectedBoardId(e.target.value)}
                className="min-h-11 [&_select]:min-h-11"
              >
                {boards.map((b) => (
                  <NativeSelectOption key={b.id} value={b.id}>
                    {b.title} ({b.slug})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}

          {activeBoard && (
            <Card>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle>{activeBoard.title}</CardTitle>
                    <Badge variant={activeBoard.enabled ? 'default' : 'secondary'}>
                      {activeBoard.enabled ? t('statusLive') : t('statusOff')}
                    </Badge>
                    {activeBoard.projectName && <Badge variant="outline">{activeBoard.projectName}</Badge>}
                  </div>
                  <CardDescription>
                    {publicBoardShareUrl(boardsQuery.data?.orgSlug ?? orgSlug, activeBoard.slug)}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() =>
                      copyText(
                        publicBoardShareUrl(boardsQuery.data?.orgSlug ?? orgSlug, activeBoard.slug),
                        t('copiedShareLink'),
                      )
                    }
                    data-testid="roadmap-admin-copy-link-btn"
                  >
                    {t('copyLinkBtn')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() =>
                      copyText(
                        publicBoardEmbedSnippet(boardsQuery.data?.orgSlug ?? orgSlug, activeBoard.slug),
                        t('copiedEmbedSnippet'),
                      )
                    }
                    data-testid="roadmap-admin-copy-embed-btn"
                  >
                    {t('copyEmbedBtn')}
                  </Button>
                  {canManageBoard && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={() => openSettingsForBoard(activeBoard)}
                      data-testid="roadmap-admin-settings-btn"
                    >
                      {t('settingsBtn')}
                    </Button>
                  )}
                  {canWrite && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={vyDedupe.isPending || items.length < 2}
                      onClick={() => vyDedupe.mutate(activeBoard.id)}
                      data-testid="roadmap-admin-vy-dedupe-btn"
                    >
                      {vyDedupe.isPending ? t('vyDedupeBusy') : t('vyDedupeBtn')}
                    </Button>
                  )}
                  {canWrite && (
                    <Button
                      type="button"
                      className="min-h-11"
                      onClick={() => setNewItemOpen(true)}
                      data-testid="roadmap-admin-new-item-btn"
                    >
                      {t('newItemBtn')}
                    </Button>
                  )}
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {dedupeResult && (
                  <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3" data-testid="roadmap-admin-vy-dedupe-box">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{t('vyProposalBadge')}</Badge>
                        <h3 className="text-sm font-semibold text-foreground">{t('vyDedupeTitle')}</h3>
                      </div>
                    </div>
                    {dedupeResult.ai !== 'used' && dedupeResult.ai !== 'empty' ? (
                      <Alert>
                        <AlertDescription>{vyAiStatusMessage(dedupeResult.ai)}</AlertDescription>
                      </Alert>
                    ) : visibleDedupeSuggestions.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t('vyDedupeEmpty')}</p>
                    ) : (
                      <ul className="space-y-2.5">
                        {visibleDedupeSuggestions.map((s) => {
                          const src = itemsById.get(s.sourceItemId);
                          const tgt = itemsById.get(s.targetItemId);
                          if (!src || !tgt) return null;
                          const pairKey = `${s.sourceItemId}:${s.targetItemId}`;
                          return (
                            <li
                              key={pairKey}
                              className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
                              data-testid={`roadmap-vy-dedupe-${s.sourceItemId}`}
                            >
                              <div className="min-w-0 space-y-1">
                                <div className="flex flex-wrap items-center gap-2 text-sm">
                                  <Badge variant="secondary">{t('vyProposalBadge')}</Badge>
                                  <span className="font-medium text-foreground">{src.publicTitle}</span>
                                  <span className="text-muted-foreground">-&gt;</span>
                                  <span className="font-semibold text-foreground">{tgt.publicTitle}</span>
                                </div>
                                <p className="text-xs text-muted-foreground">{s.reason}</p>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 shrink-0">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="min-h-11"
                                  onClick={() => setDismissedPairs((prev) => [...prev, pairKey])}
                                >
                                  {t('vyDismissProposalBtn')}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  className="min-h-11"
                                  disabled={itemMerge.isPending}
                                  onClick={() =>
                                    itemMerge.mutate({
                                      sourceItemId: s.sourceItemId,
                                      targetItemId: s.targetItemId,
                                      idempotencyKey: crypto.randomUUID(),
                                    })
                                  }
                                  data-testid={`roadmap-vy-confirm-merge-${s.sourceItemId}`}
                                >
                                  {t('vyConfirmMergeBtn')}
                                </Button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {(['all', ...ROADMAP_ITEM_MODERATION_STATUSES] as const).map((status) => (
                    <Button
                      key={status}
                      type="button"
                      size="sm"
                      variant={modFilter === status ? 'default' : 'outline'}
                      className="min-h-11"
                      onClick={() => setModFilter(status)}
                    >
                      {t(`moderationFilter.${status}`)}
                    </Button>
                  ))}
                </div>

                {signalRollupQuery.isError && (
                  <Alert
                    variant="destructive"
                    className="flex flex-col gap-2 border-destructive/30 bg-destructive/10 sm:flex-row sm:items-center sm:justify-between"
                    data-testid="roadmap-admin-signal-rollup-error"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-xs font-medium text-destructive">{t('signalRollupError')}</p>
                      <AlertDescription className="text-xs">{errorMessage(signalRollupQuery.error)}</AlertDescription>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 shrink-0"
                      onClick={() => void signalRollupQuery.refetch()}
                      data-testid="roadmap-admin-signal-rollup-retry"
                    >
                      {t('signalRetryBtn')}
                    </Button>
                  </Alert>
                )}

                {detailQuery.isPending ? (
                  <ListSkeleton rows={3} />
                ) : filteredItems.length === 0 ? (
                  <Empty title={t('emptyQueue')} hint={t('emptyQueueHint')} />
                ) : (
                  <div className="space-y-3">
                    {boardSignalRollup && boardSignalRollup.totalSignals > 0 && (
                      <div
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs"
                        data-testid="roadmap-admin-board-signal-rollup"
                      >
                        <span className="font-medium text-foreground">
                          {t('signalsHeading', { count: String(boardSignalRollup.totalSignals) })}
                        </span>
                        <Badge variant="outline" className="tabular-nums">
                          {t('signalAccountsBadge', { count: String(boardSignalRollup.distinctAccountCount) })}
                        </Badge>
                        {boardSignalRollup.valueByCurrency.map((cur) => (
                          <Badge key={cur.currency} variant="secondary" className="tabular-nums">
                            {t('signalCurrencyPill', {
                              currency: cur.currency,
                              amount: f.money(cur.totalAmount, cur.currency),
                              count: String(cur.signalCount),
                            })}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <ul className="space-y-3" data-testid="roadmap-admin-items-list">
                      {filteredItems.map((item) => {
                        const itemRollup = rollupByItem.get(item.id);
                        const isExpanded = expandedSignalItemIds.includes(item.id);
                        return (
                      <li key={item.id} className="rounded-lg border border-border bg-background p-4" data-testid={`roadmap-admin-item-${item.id}`}>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-foreground">{item.publicTitle}</span>
                              <Badge variant={item.moderationStatus === 'published' ? 'default' : 'secondary'}>
                                {t(`moderationStatus.${item.moderationStatus}`)}
                              </Badge>
                              <Badge variant="outline">{tPub(`stages.${item.stage}`)}</Badge>
                              {item.tainted && (
                                <Badge variant="outline" data-testid={`roadmap-admin-tainted-${item.id}`}>
                                  {t('taintedBadge')}
                                </Badge>
                              )}
                              <Badge variant="secondary" className="tabular-nums">
                                {t('votesBadge', { count: String(item.voteCount) })}
                              </Badge>
                              {itemRollup && itemRollup.totalSignals > 0 && (
                                <>
                                  <Badge variant="outline" className="tabular-nums">
                                    {t('signalCountBadge', { count: String(itemRollup.totalSignals) })}
                                  </Badge>
                                  <Badge variant="outline" className="tabular-nums">
                                    {t('signalAccountsBadge', { count: String(itemRollup.distinctAccountCount) })}
                                  </Badge>
                                  {itemRollup.valueByCurrency.map((cur) => (
                                    <Badge
                                      key={cur.currency}
                                      variant="secondary"
                                      className="tabular-nums"
                                      data-testid={`roadmap-admin-item-currency-${item.id}-${cur.currency}`}
                                    >
                                      {t('signalCurrencyPill', {
                                        currency: cur.currency,
                                        amount: f.money(cur.totalAmount, cur.currency),
                                        count: String(cur.signalCount),
                                      })}
                                    </Badge>
                                  ))}
                                </>
                              )}
                            </div>
                            {item.publicSummary && (
                              <p className="text-sm text-muted-foreground">{item.publicSummary}</p>
                            )}
                            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                              {item.submitterDisplayName && <span>{item.submitterDisplayName}</span>}
                              {item.linkedTaskId && (
                                <span>
                                  {t('linkedTaskLabel', {
                                    project: item.linkedProjectName ?? t('projectFallback'),
                                    status: item.linkedTaskStatus ?? '',
                                  })}
                                </span>
                              )}
                              <span>{f.date(item.updatedAt)}</span>
                            </div>
                          </div>

                          {canWrite && item.moderationStatus !== 'merged' && (
                            <div className="flex flex-wrap items-center gap-2">
                              {item.moderationStatus !== 'published' && (
                                <Button
                                  type="button"
                                  size="sm"
                                  className="min-h-11"
                                  onClick={() =>
                                    itemModerate.mutate({
                                      itemId: item.id,
                                      moderationStatus: 'published',
                                      idempotencyKey: crypto.randomUUID(),
                                    })
                                  }
                                  data-testid={`roadmap-admin-publish-${item.id}`}
                                >
                                  {t('publishBtn')}
                                </Button>
                              )}
                              {item.moderationStatus !== 'archived' && (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="min-h-11"
                                    onClick={() => setSignalItem(item)}
                                    data-testid={`roadmap-admin-add-signal-${item.id}`}
                                  >
                                    {t('signalsAddBtn')}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="min-h-11"
                                    onClick={() =>
                                      itemModerate.mutate({
                                        itemId: item.id,
                                        moderationStatus: 'archived',
                                        idempotencyKey: crypto.randomUUID(),
                                      })
                                    }
                                  >
                                    {t('archiveBtn')}
                                  </Button>
                                </>
                              )}
                              <NativeSelect
                                aria-label={t('stageSelectLabel')}
                                value={item.stage}
                                className="min-h-11 [&_select]:min-h-11"
                                onChange={(e) =>
                                  itemModerate.mutate({
                                    itemId: item.id,
                                    stage: e.target.value as RoadmapItemStage,
                                    idempotencyKey: crypto.randomUUID(),
                                  })
                                }
                              >
                                {ROADMAP_ITEM_STAGES.map((s) => (
                                  <NativeSelectOption key={s} value={s}>
                                    {tPub(`stages.${s}`)}
                                  </NativeSelectOption>
                                ))}
                              </NativeSelect>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="min-h-11"
                                onClick={() => {
                                  setMergeItem(item);
                                  setMergeTargetId('');
                                }}
                                data-testid={`roadmap-admin-merge-${item.id}`}
                              >
                                {t('mergeBtn')}
                              </Button>
                              {!item.linkedTaskId ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="min-h-11"
                                  onClick={() => {
                                    setConvertItem(item);
                                    setConvertProjectId(activeBoard.projectId ?? projects[0]?.id ?? '');
                                    setConvertSeatId('');
                                  }}
                                  data-testid={`roadmap-admin-convert-${item.id}`}
                                >
                                  {t('convertBtn')}
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="min-h-11"
                                  onClick={() =>
                                    itemSyncStage.mutate({
                                      itemId: item.id,
                                      idempotencyKey: crypto.randomUUID(),
                                    })
                                  }
                                >
                                  {t('syncStageBtn')}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>

                        {(signalRollupQuery.isError || (itemRollup !== undefined && itemRollup.totalSignals > 0)) && (
                          <div className="mt-3 border-t border-border pt-3">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="min-h-11 px-2 text-xs"
                              onClick={() => toggleSignalList(item.id)}
                              data-testid={`roadmap-admin-toggle-signals-${item.id}`}
                            >
                              {itemRollup !== undefined
                                ? isExpanded
                                  ? t('signalHideList', { count: String(itemRollup.totalSignals) })
                                  : t('signalShowList', { count: String(itemRollup.totalSignals) })
                                : isExpanded
                                  ? t('signalHideListFallback')
                                  : t('signalShowListFallback')}
                            </Button>
                            {isExpanded && (
                              <ExpandedItemSignals
                                boardId={activeBoard.id}
                                roadmapItemId={item.id}
                                canWrite={canWrite}
                                deletePending={signalDelete.isPending}
                                onDeleteSignal={(signalId) =>
                                  signalDelete.mutate({
                                    signalId,
                                    idempotencyKey: crypto.randomUUID(),
                                  })
                                }
                              />
                            )}
                          </div>
                        )}
                      </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {activeBoard && (
            <Card data-testid="roadmap-admin-changelog-card">
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <CardTitle>{t('changelogHeading')}</CardTitle>
                  <CardDescription>{t('changelogSubtitle')}</CardDescription>
                </div>
                {canWrite && (
                  <Button
                    type="button"
                    className="min-h-11 shrink-0"
                    onClick={openNewAnnouncementDialog}
                    data-testid="roadmap-admin-new-announcement-btn"
                  >
                    {t('newAnnouncementBtn')}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {detailQuery.isPending ? (
                  <ListSkeleton rows={2} />
                ) : announcements.length === 0 ? (
                  <Empty title={t('emptyAnnouncements')} hint={t('emptyAnnouncementsHint')} />
                ) : (
                  <ul className="space-y-3" data-testid="roadmap-admin-announcements-list">
                    {announcements.map((ann) => (
                      <li
                        key={ann.id}
                        className="rounded-lg border border-border bg-background p-4 space-y-3"
                        data-testid={`roadmap-admin-ann-${ann.id}`}
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-foreground">{ann.title}</span>
                              <Badge variant={ann.status === 'published' ? 'default' : 'secondary'}>
                                {ann.status === 'published' ? t('announcementPublishedBadge') : t('announcementDraftBadge')}
                              </Badge>
                              {ann.notificationsSentAt && (
                                <Badge variant="outline">{t('announcementNotifiedBadge')}</Badge>
                              )}
                            </div>
                            {ann.publishedAt && (
                              <p className="text-xs text-muted-foreground">{f.date(ann.publishedAt)}</p>
                            )}
                            {ann.linkedItems.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {ann.linkedItems.map((li) => (
                                  <Badge key={li.id} variant="outline">
                                    {li.publicTitle}
                                  </Badge>
                                ))}
                              </div>
                            )}
                            <SafeRoadmapMarkdown markdown={ann.bodyMd} />
                          </div>
                          {(ann.status === 'draft' && (canWrite || canManageBoard) || (ann.status === 'published' && canManageBoard)) && (
                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                              {ann.status === 'draft' && canWrite && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="min-h-11"
                                  onClick={() => openEditAnnouncementDialog(ann)}
                                  data-testid={`roadmap-admin-edit-ann-${ann.id}`}
                                >
                                  {t('editAnnouncementBtn')}
                                </Button>
                              )}
                              {ann.status === 'draft' && canManageBoard && (
                                <Button
                                  type="button"
                                  size="sm"
                                  className="min-h-11"
                                  disabled={announcementPublish.isPending}
                                  onClick={() =>
                                    announcementPublish.mutate({
                                      announcementId: ann.id,
                                      idempotencyKey: crypto.randomUUID(),
                                    })
                                  }
                                  data-testid={`roadmap-admin-publish-ann-${ann.id}`}
                                >
                                  {t('announcementPublishBtn')}
                                </Button>
                              )}
                              {ann.status === 'draft' && canWrite && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="min-h-11"
                                  disabled={announcementDelete.isPending}
                                  onClick={() =>
                                    announcementDelete.mutate({
                                      announcementId: ann.id,
                                      idempotencyKey: crypto.randomUUID(),
                                    })
                                  }
                                  data-testid={`roadmap-admin-delete-ann-${ann.id}`}
                                >
                                  {t('announcementDeleteDraftBtn')}
                                </Button>
                              )}
                              {ann.status === 'published' && canManageBoard && !ann.notificationsSentAt && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  className="min-h-11"
                                  disabled={!activeBoard.enabled || activeSubscriberCount === 0 || announcementSendNotifications.isPending}
                                  onClick={() => setConfirmNotifyAnn(ann)}
                                  data-testid={`roadmap-admin-notify-ann-${ann.id}`}
                                >
                                  {t('announcementSendAlertsBtn', { count: String(activeSubscriberCount) })}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Dialog open={createBoardOpen} onOpenChange={setCreateBoardOpen}>
        <DialogContent closeLabel={tc('close')}>
          <DialogHeader>
            <DialogTitle>{t('newBoardTitle')}</DialogTitle>
            <DialogDescription>{t('newBoardDesc')}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              boardCreate.mutate({
                title: newBoardTitle.trim(),
                ...(newBoardSlug.trim() ? { slug: newBoardSlug.trim().toLowerCase() } : {}),
                description: newBoardDesc.trim() || null,
                projectId: newBoardProjectId || null,
                enabled: true,
                idempotencyKey: crypto.randomUUID(),
              });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="roadmap-new-title">{t('boardTitleLabel')}</Label>
              <Input id="roadmap-new-title" required value={newBoardTitle} onChange={(e) => setNewBoardTitle(e.target.value)} className="min-h-11" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-new-slug">{t('boardSlugLabel')}</Label>
              <Input id="roadmap-new-slug" value={newBoardSlug} onChange={(e) => setNewBoardSlug(e.target.value)} placeholder="roadmap" className="min-h-11" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-new-desc">{t('boardDescLabel')}</Label>
              <Textarea id="roadmap-new-desc" rows={3} value={newBoardDesc} onChange={(e) => setNewBoardDesc(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-new-proj">{t('linkedProjectLabel')}</Label>
              <NativeSelect id="roadmap-new-proj" value={newBoardProjectId} onChange={(e) => setNewBoardProjectId(e.target.value)} className="min-h-11 [&_select]:min-h-11">
                <NativeSelectOption value="">{t('noProjectSelected')}</NativeSelectOption>
                {projects.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {boardCreate.error && <ErrorText>{errorMessage(boardCreate.error)}</ErrorText>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>{tPub('cancel')}</DialogClose>
              <Button type="submit" disabled={boardCreate.isPending} className="min-h-11">
                {t('createBoardSubmit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent closeLabel={tc('close')}>
          <DialogHeader>
            <DialogTitle>{t('settingsTitle')}</DialogTitle>
            <DialogDescription>{t('settingsDesc')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveSettings} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="roadmap-edit-title">{t('boardTitleLabel')}</Label>
              <Input id="roadmap-edit-title" required value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="min-h-11" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-edit-slug">{t('boardSlugLabel')}</Label>
              <Input id="roadmap-edit-slug" required value={editSlug} onChange={(e) => setEditSlug(e.target.value)} className="min-h-11" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-edit-desc">{t('boardDescLabel')}</Label>
              <Textarea id="roadmap-edit-desc" rows={2} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-edit-proj">{t('linkedProjectLabel')}</Label>
              <NativeSelect id="roadmap-edit-proj" value={editProjectId} onChange={(e) => setEditProjectId(e.target.value)} className="min-h-11 [&_select]:min-h-11">
                <NativeSelectOption value="">{t('noProjectSelected')}</NativeSelectOption>
                {projects.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-edit-origins">{t('embedOriginsLabel')}</Label>
              <Textarea
                id="roadmap-edit-origins"
                rows={3}
                value={editOriginsText}
                onChange={(e) => setEditOriginsText(e.target.value)}
                placeholder="https://app.example.com"
              />
            </div>
            <div className="space-y-2">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <Checkbox checked={editAllowSub} onCheckedChange={(v) => setEditAllowSub(v === true)} />
                <span>{t('allowSubmissionsLabel')}</span>
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <Checkbox checked={editAllowVote} onCheckedChange={(v) => setEditAllowVote(v === true)} />
                <span>{t('allowVotingLabel')}</span>
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <Checkbox checked={editRequireMod} onCheckedChange={(v) => setEditRequireMod(v === true)} />
                <span>{t('requireModerationLabel')}</span>
              </label>
            </div>
            {(settingsError || boardUpdate.error) && (
              <ErrorText>{settingsError ?? errorMessage(boardUpdate.error)}</ErrorText>
            )}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>{tPub('cancel')}</DialogClose>
              <Button type="submit" disabled={boardUpdate.isPending} className="min-h-11">
                {t('saveSettingsBtn')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={newItemOpen} onOpenChange={setNewItemOpen}>
        <DialogContent closeLabel={tc('close')}>
          <DialogHeader>
            <DialogTitle>{t('newItemTitle')}</DialogTitle>
            <DialogDescription>{t('newItemDesc')}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!activeBoard) return;
              itemCreate.mutate({
                boardId: activeBoard.id,
                publicTitle: newItemTitle.trim(),
                publicSummary: newItemSummary.trim() || null,
                category: newItemCategory.trim() || null,
                stage: newItemStage,
                moderationStatus: 'published',
                idempotencyKey: crypto.randomUUID(),
              });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="roadmap-item-title">{tPub('ideaTitleLabel')}</Label>
              <Input id="roadmap-item-title" required value={newItemTitle} onChange={(e) => setNewItemTitle(e.target.value)} className="min-h-11" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-item-summary">{tPub('ideaSummaryLabel')}</Label>
              <Textarea id="roadmap-item-summary" rows={3} value={newItemSummary} onChange={(e) => setNewItemSummary(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="roadmap-item-cat">{tPub('ideaCategoryLabel')}</Label>
                <Input id="roadmap-item-cat" value={newItemCategory} onChange={(e) => setNewItemCategory(e.target.value)} className="min-h-11" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="roadmap-item-stage">{t('stageSelectLabel')}</Label>
                <NativeSelect id="roadmap-item-stage" value={newItemStage} onChange={(e) => setNewItemStage(e.target.value as RoadmapItemStage)} className="min-h-11 [&_select]:min-h-11">
                  {ROADMAP_ITEM_STAGES.map((s) => (
                    <NativeSelectOption key={s} value={s}>
                      {tPub(`stages.${s}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
            {itemCreate.error && <ErrorText>{errorMessage(itemCreate.error)}</ErrorText>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>{tPub('cancel')}</DialogClose>
              <Button type="submit" disabled={itemCreate.isPending} className="min-h-11">
                {t('createItemSubmit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mergeItem !== null} onOpenChange={(next) => !next && setMergeItem(null)}>
        <DialogContent closeLabel={tc('close')}>
          <DialogHeader>
            <DialogTitle>{t('mergeTitle')}</DialogTitle>
            <DialogDescription>{t('mergeDesc', { title: mergeItem?.publicTitle ?? '' })}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!mergeItem || !mergeTargetId) return;
              itemMerge.mutate({
                sourceItemId: mergeItem.id,
                targetItemId: mergeTargetId,
                idempotencyKey: crypto.randomUUID(),
              });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="roadmap-merge-target">{t('mergeTargetLabel')}</Label>
              <NativeSelect
                id="roadmap-merge-target"
                value={mergeTargetId}
                onChange={(e) => setMergeTargetId(e.target.value)}
                required
                className="min-h-11 [&_select]:min-h-11"
              >
                <NativeSelectOption value="">{t('selectItemPlaceholder')}</NativeSelectOption>
                {mergeTargets.map((it) => (
                  <NativeSelectOption key={it.id} value={it.id}>
                    {it.publicTitle} ({it.voteCount})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {itemMerge.error && <ErrorText>{errorMessage(itemMerge.error)}</ErrorText>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>{tPub('cancel')}</DialogClose>
              <Button type="submit" disabled={itemMerge.isPending || !mergeTargetId} className="min-h-11">
                {t('confirmMergeBtn')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={convertItem !== null} onOpenChange={(next) => !next && setConvertItem(null)}>
        <DialogContent closeLabel={tc('close')}>
          <DialogHeader>
            <DialogTitle>{t('convertTitle')}</DialogTitle>
            <DialogDescription>{t('convertDesc', { title: convertItem?.publicTitle ?? '' })}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!convertItem || !convertProjectId) return;
              itemConvert.mutate({
                itemId: convertItem.id,
                projectId: convertProjectId,
                assigneePositionId: convertSeatId || null,
                idempotencyKey: crypto.randomUUID(),
              });
            }}
            className="space-y-4"
          >
            <Alert>
              <AlertDescription>{t('convertTaintNotice')}</AlertDescription>
            </Alert>
            <div className="space-y-2">
              <Label htmlFor="roadmap-convert-project">{t('linkedProjectLabel')}</Label>
              <NativeSelect
                id="roadmap-convert-project"
                value={convertProjectId}
                onChange={(e) => setConvertProjectId(e.target.value)}
                required
                className="min-h-11 [&_select]:min-h-11"
              >
                <NativeSelectOption value="">{t('noProjectSelected')}</NativeSelectOption>
                {projects.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-convert-seat">{t('assigneeLabel')}</Label>
              <NativeSelect
                id="roadmap-convert-seat"
                value={convertSeatId}
                onChange={(e) => setConvertSeatId(e.target.value)}
                className="min-h-11 [&_select]:min-h-11"
              >
                <NativeSelectOption value="">{t('unassigned')}</NativeSelectOption>
                {seats.map((s) => (
                  <NativeSelectOption key={s.positionId} value={s.positionId}>
                    {s.title} ({s.holderName})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {itemConvert.error && <ErrorText>{errorMessage(itemConvert.error)}</ErrorText>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>{tPub('cancel')}</DialogClose>
              <Button type="submit" disabled={itemConvert.isPending || !convertProjectId} className="min-h-11">
                {t('confirmConvertBtn')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={annDialogOpen} onOpenChange={setAnnDialogOpen}>
        <DialogContent closeLabel={tc('close')} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingAnn ? t('editAnnouncementBtn') : t('newAnnouncementBtn')}</DialogTitle>
            <DialogDescription>{t('changelogSubtitle')}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!activeBoard) return;
              if (editingAnn) {
                announcementUpdate.mutate({
                  announcementId: editingAnn.id,
                  title: annTitle.trim(),
                  bodyMd: annBodyMd.trim(),
                  linkedItemIds: annLinkedIds,
                  idempotencyKey: crypto.randomUUID(),
                });
                return;
              }
              announcementCreate.mutate({
                boardId: activeBoard.id,
                title: annTitle.trim(),
                bodyMd: annBodyMd.trim(),
                linkedItemIds: annLinkedIds,
                idempotencyKey: crypto.randomUUID(),
              });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label>{t('announcementShippedItemsLabel')}</Label>
              {shippedPublishedItems.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('announcementNoShippedItems')}</p>
              ) : (
                <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border p-2.5">
                  {shippedPublishedItems.map((item) => (
                    <label key={item.id} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
                      <Checkbox
                        checked={annLinkedIds.includes(item.id)}
                        onCheckedChange={(c) => toggleLinkedShippedItem(item.id, c === true)}
                      />
                      <span className="text-foreground">{item.publicTitle}</span>
                    </label>
                  ))}
                </div>
              )}
              {activeBoard && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    disabled={vyChangelogDraft.isPending || annLinkedIds.length === 0}
                    onClick={() => vyChangelogDraft.mutate({ boardId: activeBoard.id, itemIds: annLinkedIds })}
                    data-testid="roadmap-admin-vy-draft-changelog-btn"
                  >
                    {vyChangelogDraft.isPending ? t('vyDraftChangelogBusy') : t('vyDraftChangelogBtn')}
                  </Button>
                  {annLinkedIds.length === 0 && shippedPublishedItems.length > 0 && (
                    <span className="text-xs text-muted-foreground">{t('vyDraftRequiresItems')}</span>
                  )}
                </div>
              )}
              {annVyMessage && (
                <Alert>
                  <AlertDescription>{annVyMessage}</AlertDescription>
                </Alert>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="roadmap-ann-title">{t('announcementTitleLabel')}</Label>
              <Input
                id="roadmap-ann-title"
                required
                maxLength={ROADMAP_ANNOUNCEMENT_TITLE_MAX}
                value={annTitle}
                onChange={(e) => setAnnTitle(e.target.value)}
                placeholder={t('announcementTitlePlaceholder')}
                className="min-h-11"
                data-testid="roadmap-admin-ann-title-input"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="roadmap-ann-body">{t('announcementBodyLabel')}</Label>
              <Textarea
                id="roadmap-ann-body"
                required
                rows={7}
                maxLength={ROADMAP_ANNOUNCEMENT_BODY_MAX}
                value={annBodyMd}
                onChange={(e) => setAnnBodyMd(e.target.value)}
                placeholder={t('announcementBodyPlaceholder')}
                data-testid="roadmap-admin-ann-body-input"
              />
            </div>

            {(announcementCreate.error || announcementUpdate.error) && (
              <ErrorText>{errorMessage(announcementCreate.error ?? announcementUpdate.error)}</ErrorText>
            )}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>{tPub('cancel')}</DialogClose>
              <Button
                type="submit"
                disabled={announcementCreate.isPending || announcementUpdate.isPending}
                className="min-h-11"
                data-testid="roadmap-admin-ann-save-btn"
              >
                {t('announcementSaveDraftBtn')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmNotifyAnn !== null} onOpenChange={(next) => !next && setConfirmNotifyAnn(null)}>
        <DialogContent closeLabel={tc('close')}>
          <DialogHeader>
            <DialogTitle>{t('announcementConfirmNotifyTitle')}</DialogTitle>
            <DialogDescription>
              {t('announcementConfirmNotifyDesc', {
                title: confirmNotifyAnn?.title ?? '',
                count: String(activeSubscriberCount),
              })}
            </DialogDescription>
          </DialogHeader>
          {announcementSendNotifications.error && (
            <ErrorText>{errorMessage(announcementSendNotifications.error)}</ErrorText>
          )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>{tPub('cancel')}</DialogClose>
            <Button
              type="button"
              disabled={!confirmNotifyAnn || announcementSendNotifications.isPending}
              className="min-h-11"
              onClick={() => {
                if (!confirmNotifyAnn) return;
                announcementSendNotifications.mutate({
                  announcementId: confirmNotifyAnn.id,
                  idempotencyKey: crypto.randomUUID(),
                });
              }}
              data-testid="roadmap-admin-confirm-notify-submit"
            >
              {t('announcementConfirmNotifySubmit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {effectiveBoardId && signalItem && (
        <RoadmapSignalModal
          open={Boolean(signalItem)}
          onOpenChange={(next) => {
            if (!next) setSignalItem(null);
          }}
          fixedBoardId={effectiveBoardId}
          fixedItem={{ id: signalItem.id, title: signalItem.publicTitle }}
          onLinked={() => refreshRoadmapQueries()}
        />
      )}
    </div>
  );
}
