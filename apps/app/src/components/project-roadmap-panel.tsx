// SPDX-License-Identifier: AGPL-3.0-only
// Internal Projects Public Roadmap management panel (#4399, ADR-0057):
// 1-click board activation, public/iframe embed snippet copy, and ideas moderation queue (Pending / Published / Merged / Archived + Convert to Task).
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ROADMAP_ITEM_MODERATION_STATUSES,
  ROADMAP_ITEM_STAGES,
  normalizeRoadmapEmbedOrigin,
  type RoadmapAdminItem,
  type RoadmapBoardSummary,
  type RoadmapItemModerationStatus,
  type RoadmapItemStage,
} from '@ludy/kernel-contract';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
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
import { Empty, ErrorText, ListSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

function refreshRoadmapQueries() {
  void queryClient.invalidateQueries({ queryKey: orpc.projects.roadmap.boards.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.projects.roadmap.boardDetail.key() });
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

  if (boardsQuery.isPending) {
    return <ListSkeleton rows={4} />;
  }
  if (boardsQuery.error) {
    return <ErrorText>{errorMessage(boardsQuery.error)}</ErrorText>;
  }

  const activeBoard: RoadmapBoardSummary | null = detailQuery.data?.board ?? boards.find((b) => b.id === effectiveBoardId) ?? null;
  const items = detailQuery.data?.items ?? [];
  const filteredItems = modFilter === 'all' ? items : items.filter((it) => it.moderationStatus === modFilter);
  const mergeTargets = items.filter((it) => it.id !== mergeItem?.id && it.moderationStatus !== 'merged' && it.moderationStatus !== 'archived');

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

                {detailQuery.isPending ? (
                  <ListSkeleton rows={3} />
                ) : filteredItems.length === 0 ? (
                  <Empty title={t('emptyQueue')} hint={t('emptyQueueHint')} />
                ) : (
                  <ul className="space-y-3" data-testid="roadmap-admin-items-list">
                    {filteredItems.map((item) => (
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
    </div>
  );
}
