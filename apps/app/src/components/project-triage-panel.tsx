// SPDX-License-Identifier: AGPL-3.0-only
// Projects Triage Inbox workspace panel (#4493, ADR-0058):
// renders inside both a single Project ("Triage" tab) and the cross-project Projects Inbox.
// Supports Accept -> Task, Merge -> Open Task, Snooze (presets + custom), Decline (modal reason),
// Reopen (snoozed/declined), Manual Triage Item creation, and optional Vy AI Triage Assist.
// Core triage controls stay 100% usable when AI is off, paused, or over budget; OKLCH tokens only.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import {
  PROJECT_TRIAGE_DECLINE_REASON_MAX,
  PROJECT_TRIAGE_DESCRIPTION_MAX,
  PROJECT_TRIAGE_PRIORITIES,
  PROJECT_TRIAGE_TITLE_MAX,
  type ProjectTriageAiState,
  type ProjectTriageAssistProposal,
  type ProjectTriageCursor,
  type ProjectTriageItem,
  type ProjectTriagePriority,
  type ProjectTriageProjectOption,
  type ProjectTriageSourceType,
  type ProjectTriageStatus,
} from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Tabs, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { Textarea } from '@ludy/ui/components/textarea';
import { DateInput } from './date-input.tsx';
import { seatOptionLabel } from './project-task-dialog.tsx';
import { Empty, ErrorText, ListSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { taskDueFromDay } from '../lib/agents.ts';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import { toast } from '../lib/toast.ts';

type StatusTab = 'pending' | 'snoozed' | 'resolved';

const STATUS_TAB_VALUES: Record<StatusTab, ProjectTriageStatus[]> = {
  pending: ['pending'],
  snoozed: ['snoozed'],
  resolved: ['accepted', 'merged', 'declined'],
};

function sourceTypeKey(sourceType: ProjectTriageSourceType): 'roadmap_item' | 'kernel_conversation' | 'meetings_meeting' | 'manual' {
  switch (sourceType) {
    case 'roadmap.item':
      return 'roadmap_item';
    case 'kernel.conversation':
      return 'kernel_conversation';
    case 'meetings.meeting':
      return 'meetings_meeting';
    default:
      return 'manual';
  }
}

function priorityBadgeVariant(priority: ProjectTriagePriority): 'destructive' | 'default' | 'secondary' | 'outline' {
  switch (priority) {
    case 'urgent':
      return 'destructive';
    case 'high':
      return 'default';
    case 'medium':
      return 'secondary';
    default:
      return 'outline';
  }
}

function invalidateTriageQueries(): void {
  void queryClient.invalidateQueries({ queryKey: orpc.projects.triage.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.projects.board.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.projects.listCycles.key() });
}

function tomorrowMorningIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function addHoursIso(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function mergeTriagePages(
  baseItems: ReadonlyArray<ProjectTriageItem>,
  loadedMore: { scopeKey: string; items: ReadonlyArray<ProjectTriageItem> } | null,
  scopeKey: string,
): ProjectTriageItem[] {
  if (!loadedMore || loadedMore.scopeKey !== scopeKey) return [...baseItems];
  const seen = new Set(baseItems.map((item) => item.id));
  return [...baseItems, ...loadedMore.items.filter((item) => !seen.has(item.id))];
}

export function ProjectTriagePanel({
  orgSlug,
  projectId,
}: {
  orgSlug: string;
  projectId?: string | undefined;
}) {
  const t = useTranslations('projects.triage');
  const tt = useTranslations('tasks');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';

  const [statusTab, setStatusTab] = useState<StatusTab>('pending');
  const [projectFilterId, setProjectFilterId] = useState<string>('all');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  // Accept form state synced when switching selected item
  const [acceptTitle, setAcceptTitle] = useState('');
  const [acceptDescription, setAcceptDescription] = useState('');
  const [acceptPriority, setAcceptPriority] = useState<ProjectTriagePriority>('none');
  const [acceptSeatId, setAcceptSeatId] = useState('');
  const [acceptColumnId, setAcceptColumnId] = useState('');
  const [acceptCycleId, setAcceptCycleId] = useState('');
  const [acceptDueDay, setAcceptDueDay] = useState('');

  // Merge, Snooze, Decline modals/controls
  const [mergeTargetTaskId, setMergeTargetTaskId] = useState('');
  const [snoozeCustomLocal, setSnoozeCustomLocal] = useState(() => toDatetimeLocalValue(tomorrowMorningIso()));
  const [declineDialogOpen, setDeclineDialogOpen] = useState(false);
  const [declineTargetId, setDeclineTargetId] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState('');

  // Manual create item dialog + draft-scoped idempotency key for safe retries
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState(projectId ?? '');
  const [createTitle, setCreateTitle] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createPriority, setCreatePriority] = useState<ProjectTriagePriority>('medium');
  const createIdempotencyKeyRef = useRef<string>(crypto.randomUUID());

  // Server-side filter & cursor pagination state
  const activeProjectId = projectId ?? (projectFilterId !== 'all' ? projectFilterId : undefined);
  const scopeKey = `${activeProjectId ?? 'all'}:${statusTab}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const [loadedMore, setLoadedMore] = useState<{
    scopeKey: string;
    items: ProjectTriageItem[];
    nextCursor: ProjectTriageCursor | null;
  } | null>(null);
  const [knownWorkspaceProjects, setKnownWorkspaceProjects] = useState<ProjectTriageProjectOption[]>([]);

  // Vy AI assist proposal cache per itemId
  const [assistState, setAssistState] = useState<{
    itemId: string;
    ai: ProjectTriageAiState;
    proposal: ProjectTriageAssistProposal | null;
  } | null>(null);

  const listQuery = useQuery(
    orpc.projects.triage.list.queryOptions({
      input: {
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
        statuses: STATUS_TAB_VALUES[statusTab],
        limit: 100,
      },
    }),
  );

  // Preserve full workspace project list when filtered to one project on the server.
  const fallbackWorkspaceProjectsQuery = useQuery({
    ...orpc.projects.triage.list.queryOptions({
      input: {
        statuses: STATUS_TAB_VALUES[statusTab],
        limit: 1,
      },
    }),
    enabled: Boolean(!projectId && activeProjectId && knownWorkspaceProjects.length === 0),
  });

  const data = listQuery.data;
  useEffect(() => {
    if (!projectId && !activeProjectId && data?.projects) {
      setKnownWorkspaceProjects(data.projects);
    }
  }, [projectId, activeProjectId, data?.projects]);

  const counts = data?.counts ?? {
    pending: 0,
    snoozed: 0,
    accepted: 0,
    merged: 0,
    declined: 0,
    snoozeElapsed: 0,
  };
  const projects = useMemo(() => {
    if (projectId) return data?.projects ?? [];
    if (!activeProjectId) return data?.projects ?? [];
    if (knownWorkspaceProjects.length > 0) return knownWorkspaceProjects;
    return fallbackWorkspaceProjectsQuery.data?.projects ?? data?.projects ?? [];
  }, [projectId, activeProjectId, data?.projects, knownWorkspaceProjects, fallbackWorkspaceProjectsQuery.data?.projects]);
  const writableProjects = useMemo(() => projects.filter((p) => p.canWrite), [projects]);

  const filteredItems = useMemo(
    () => mergeTriagePages(data?.items ?? [], loadedMore, scopeKey),
    [data?.items, loadedMore, scopeKey],
  );
  const activeNextCursor = loadedMore?.scopeKey === scopeKey ? loadedMore.nextCursor : (data?.nextCursor ?? null);

  const selectedItem: ProjectTriageItem | null = useMemo(() => {
    if (filteredItems.length === 0) return null;
    if (selectedItemId) {
      const hit = filteredItems.find((i) => i.id === selectedItemId);
      if (hit) return hit;
    }
    return filteredItems[0] ?? null;
  }, [filteredItems, selectedItemId]);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedItem?.id ?? null;

  const activeProjectOption = useMemo(
    () => (selectedItem ? projects.find((p) => p.id === selectedItem.projectId) ?? null : null),
    [projects, selectedItem],
  );
  const canWriteSelected = activeProjectOption?.canWrite ?? false;

  // Cross-project mode: fetch open tasks scoped specifically to selectedItem.projectId so the merge picker is never truncated by a workspace-wide 150-task cap.
  const selectedProjectTasksQuery = useQuery({
    ...orpc.projects.triage.list.queryOptions({
      input: {
        projectId: selectedItem?.projectId,
        statuses: ['pending'],
        limit: 1,
      },
    }),
    enabled: Boolean(
      !projectId &&
        selectedItem?.projectId &&
        (selectedItem.status === 'pending' || selectedItem.status === 'snoozed'),
    ),
  });

  const projectSeats = useMemo(() => {
    if (!selectedItem || !data?.seats) return [];
    return data.seats.filter((s) => s.projectIds.includes(selectedItem.projectId));
  }, [data?.seats, selectedItem]);

  const projectColumns = useMemo(() => {
    if (!selectedItem || !data?.columns) return [];
    return data.columns.filter((c) => c.projectId === selectedItem.projectId);
  }, [data?.columns, selectedItem]);

  const projectCycles = useMemo(() => {
    if (!selectedItem || !data?.cycles) return [];
    return data.cycles.filter((c) => c.projectId === selectedItem.projectId);
  }, [data?.cycles, selectedItem]);

  const projectOpenTasks = useMemo(() => {
    if (!selectedItem) return [];
    if (!projectId && selectedProjectTasksQuery.data?.openTasks) {
      return selectedProjectTasksQuery.data.openTasks.filter((task) => task.projectId === selectedItem.projectId);
    }
    if (!data?.openTasks) return [];
    return data.openTasks.filter((task) => task.projectId === selectedItem.projectId);
  }, [projectId, selectedItem, selectedProjectTasksQuery.data?.openTasks, data?.openTasks]);

  useEffect(() => {
    if (projectOpenTasks.length === 0) {
      if (mergeTargetTaskId !== '') setMergeTargetTaskId('');
      return;
    }
    if (!projectOpenTasks.some((task) => task.id === mergeTargetTaskId)) {
      setMergeTargetTaskId(projectOpenTasks[0]?.id ?? '');
    }
  }, [projectOpenTasks, mergeTargetTaskId]);

  useEffect(() => {
    createIdempotencyKeyRef.current = crypto.randomUUID();
  }, [createProjectId, createTitle, createDescription, createPriority]);

  useEffect(() => {
    if (!selectedItem) return;
    setAcceptTitle(selectedItem.title);
    setAcceptDescription(selectedItem.description ?? '');
    setAcceptPriority(selectedItem.priority);
    setAcceptSeatId('');
    const defaultTodoCol = projectColumns.find((c) => c.taskStatus === 'todo') ?? projectColumns[0];
    setAcceptColumnId(defaultTodoCol?.id ?? '');
    setAcceptCycleId('');
    setAcceptDueDay('');
    setMergeTargetTaskId(projectOpenTasks[0]?.id ?? '');
    setDeclineReason('');
  }, [selectedItem?.id]);

  useEffect(() => {
    if (projectId) {
      setCreateProjectId(projectId);
    } else if (writableProjects.length === 0) {
      setCreateProjectId('');
    } else if (!writableProjects.some((p) => p.id === createProjectId)) {
      setCreateProjectId(writableProjects[0]?.id ?? '');
    }
  }, [projectId, writableProjects, createProjectId]);

  const createMutation = useMutation(
    orpc.projects.triage.create.mutationOptions({
      onSuccess: (res) => {
        createIdempotencyKeyRef.current = crypto.randomUUID();
        setCreateDialogOpen(false);
        setCreateTitle('');
        setCreateDescription('');
        setLoadedMore(null);
        setStatusTab('pending');
        setSelectedItemId(res.item.id);
        invalidateTriageQueries();
        toast(t('toast.created'), 'success');
      },
    }),
  );

  const acceptMutation = useMutation(
    orpc.projects.triage.accept.mutationOptions({
      onSuccess: () => {
        setLoadedMore(null);
        invalidateTriageQueries();
        toast(t('toast.accepted'), 'success');
      },
    }),
  );

  const mergeMutation = useMutation(
    orpc.projects.triage.merge.mutationOptions({
      onSuccess: () => {
        setLoadedMore(null);
        invalidateTriageQueries();
        toast(t('toast.merged'), 'success');
      },
    }),
  );

  const snoozeMutation = useMutation(
    orpc.projects.triage.snooze.mutationOptions({
      onSuccess: () => {
        setLoadedMore(null);
        invalidateTriageQueries();
        toast(t('toast.snoozed'), 'success');
      },
    }),
  );

  const declineMutation = useMutation(
    orpc.projects.triage.decline.mutationOptions({
      onSuccess: () => {
        setDeclineDialogOpen(false);
        setDeclineTargetId(null);
        setDeclineReason('');
        setLoadedMore(null);
        invalidateTriageQueries();
        toast(t('toast.declined'), 'success');
      },
    }),
  );

  const reopenMutation = useMutation(
    orpc.projects.triage.reopen.mutationOptions({
      onSuccess: (res) => {
        setLoadedMore(null);
        setStatusTab('pending');
        setSelectedItemId(res.item.id);
        invalidateTriageQueries();
        toast(t('toast.reopened'), 'success');
      },
    }),
  );

  const loadMoreMutation = useMutation({
    mutationFn: (vars: {
      cursor: ProjectTriageCursor;
      capturedScope: string;
      capturedProjectId?: string;
      capturedStatuses: ProjectTriageStatus[];
    }) =>
      client.projects.triage.list({
        ...(vars.capturedProjectId ? { projectId: vars.capturedProjectId } : {}),
        statuses: vars.capturedStatuses,
        cursor: vars.cursor,
        limit: 100,
      }),
    onSuccess: (res, vars) => {
      if (scopeKeyRef.current !== vars.capturedScope) return;
      setLoadedMore((prev) => {
        const existing = prev?.scopeKey === vars.capturedScope ? prev.items : [];
        const seen = new Set(existing.map((i) => i.id));
        return {
          scopeKey: vars.capturedScope,
          items: [...existing, ...res.items.filter((i) => !seen.has(i.id))],
          nextCursor: res.nextCursor,
        };
      });
    },
  });

  const assistMutation = useMutation({
    mutationFn: (itemId: string) => client.projects.triage.assist({ itemId, language: locale }),
    onSuccess: (res, itemId) => {
      if (selectedIdRef.current !== itemId) return;
      setAssistState({ itemId, ai: res.ai, proposal: res.proposal });
    },
  });

  const currentAssist = selectedItem && assistState?.itemId === selectedItem.id ? assistState : null;
  const anyMutationError =
    acceptMutation.error ??
    mergeMutation.error ??
    snoozeMutation.error ??
    declineMutation.error ??
    reopenMutation.error ??
    loadMoreMutation.error ??
    assistMutation.error;

  const submitManualCreate = (e: FormEvent) => {
    e.preventDefault();
    if (!createProjectId || createTitle.trim() === '') return;
    createMutation.mutate({
      projectId: createProjectId,
      sourceType: 'manual',
      sourceId: null,
      priority: createPriority,
      title: createTitle.trim().slice(0, PROJECT_TRIAGE_TITLE_MAX),
      description: createDescription.trim()
        ? createDescription.trim().slice(0, PROJECT_TRIAGE_DESCRIPTION_MAX)
        : null,
      tainted: false,
      idempotencyKey: createIdempotencyKeyRef.current,
    });
  };

  const submitAccept = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedItem || acceptTitle.trim() === '') return;
    const dueIso = acceptDueDay ? taskDueFromDay(acceptDueDay, browserTimeZone()) : null;
    acceptMutation.mutate({
      itemId: selectedItem.id,
      title: acceptTitle.trim().slice(0, PROJECT_TRIAGE_TITLE_MAX),
      description: acceptDescription.trim()
        ? acceptDescription.trim().slice(0, PROJECT_TRIAGE_DESCRIPTION_MAX)
        : null,
      priority: acceptPriority,
      assigneePositionId: acceptSeatId || null,
      columnId: acceptColumnId || null,
      cycleId: acceptCycleId || null,
      due: dueIso,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const applyProposalToForm = (proposal: ProjectTriageAssistProposal) => {
    setAcceptPriority(proposal.recommendedPriority);
    if (
      proposal.suggestedAssigneePositionId &&
      projectSeats.some((s) => s.id === proposal.suggestedAssigneePositionId)
    ) {
      setAcceptSeatId(proposal.suggestedAssigneePositionId);
    }
    if (
      proposal.suggestedCycleId &&
      projectCycles.some((c) => c.id === proposal.suggestedCycleId)
    ) {
      setAcceptCycleId(proposal.suggestedCycleId);
    }
    if (
      proposal.duplicateTaskId &&
      projectOpenTasks.some((task) => task.id === proposal.duplicateTaskId)
    ) {
      setMergeTargetTaskId(proposal.duplicateTaskId);
    }
    toast(t('ai.appliedToast'), 'success');
  };

  const isPendingOrSnoozed = selectedItem?.status === 'pending' || selectedItem?.status === 'snoozed';
  const canReopen = selectedItem?.status === 'snoozed' || selectedItem?.status === 'declined';
  const aiStatus = data?.aiStatus;

  return (
    <div className="space-y-4" data-testid="project-triage-panel">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <Tabs
          value={statusTab}
          onValueChange={(next) => {
            setStatusTab(next as StatusTab);
            setLoadedMore(null);
            setMobileDetailOpen(false);
          }}
          className="w-full min-w-0 sm:w-auto"
        >
          <TabsList
            aria-label={t('tabsLabel')}
            className="flex h-auto w-full max-w-full flex-wrap justify-start gap-1 group-data-horizontal/tabs:h-auto sm:w-fit"
          >
            <TabsTrigger
              value="pending"
              className="h-auto min-h-11 flex-none gap-2 px-3 sm:min-h-9"
              data-testid="triage-tab-pending"
            >
              <span>{t('tabs.pending')}</span>
              <Badge variant={statusTab === 'pending' ? 'secondary' : 'outline'}>{counts.pending}</Badge>
            </TabsTrigger>
            <TabsTrigger
              value="snoozed"
              className="h-auto min-h-11 flex-none gap-2 px-3 sm:min-h-9"
              data-testid="triage-tab-snoozed"
            >
              <span>{t('tabs.snoozed')}</span>
              <Badge variant={counts.snoozeElapsed > 0 ? 'destructive' : 'outline'}>
                {counts.snoozed}
                {counts.snoozeElapsed > 0 ? ` (${counts.snoozeElapsed})` : ''}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="resolved"
              className="h-auto min-h-11 flex-none gap-2 px-3 sm:min-h-9"
              data-testid="triage-tab-resolved"
            >
              <span>{t('tabs.resolved')}</span>
              <Badge variant="outline">{counts.accepted + counts.merged + counts.declined}</Badge>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2">
          {!projectId && projects.length > 1 && (
            <NativeSelect
              aria-label={t('projectFilterLabel')}
              value={projectFilterId}
              onChange={(e) => {
                setProjectFilterId(e.target.value);
                setLoadedMore(null);
                setMobileDetailOpen(false);
              }}
              className="min-h-11 [&_select]:min-h-11"
              data-testid="triage-project-filter"
            >
              <NativeSelectOption value="all">{t('allProjects')}</NativeSelectOption>
              {projects.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {writableProjects.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                createIdempotencyKeyRef.current = crypto.randomUUID();
                setCreateDialogOpen(true);
              }}
              data-testid="triage-new-manual-btn"
            >
              {t('newManualItem')}
            </Button>
          )}
        </div>
      </div>

      {listQuery.error && <ErrorText>{errorMessage(listQuery.error)}</ErrorText>}

      {listQuery.isLoading ? (
        <ListSkeleton rows={4} />
      ) : filteredItems.length === 0 ? (
        <Empty title={t(`empty.${statusTab}.title`)} hint={t(`empty.${statusTab}.body`)} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,360px)_1fr]">
          {/* List column: hidden on mobile while viewing detail */}
          <div
            className={`space-y-2 ${mobileDetailOpen && selectedItem ? 'hidden md:block' : 'block'}`}
            data-testid="triage-list"
          >
            {filteredItems.map((item) => {
              const isSelected = selectedItem?.id === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedItemId(item.id);
                    setMobileDetailOpen(true);
                  }}
                  className={`min-h-11 w-full rounded-xl border p-3 text-left transition-colors ${
                    isSelected
                      ? 'border-primary bg-muted/60'
                      : 'border-border bg-card hover:bg-muted/40'
                  }`}
                  data-testid={`triage-item-row-${item.id}`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={priorityBadgeVariant(item.priority)}>
                      {t(`priorities.${item.priority}`)}
                    </Badge>
                    <Badge variant="outline">{t(`sources.${sourceTypeKey(item.sourceType)}`)}</Badge>
                    {item.tainted && (
                      <Badge variant="secondary" data-testid={`triage-tainted-${item.id}`}>
                        {t('taintedBadge')}
                      </Badge>
                    )}
                    {item.snoozeElapsed && (
                      <Badge variant="destructive" data-testid={`triage-snooze-elapsed-${item.id}`}>
                        {t('snoozeElapsedBadge')}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-sm font-medium text-foreground">{item.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {!projectId && <span>{item.projectName}</span>}
                    <span>{t(`statuses.${item.status}`)}</span>
                    <span>{f.dateTime(item.createdAt)}</span>
                  </div>
                </button>
              );
            })}
            {activeNextCursor !== null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 w-full"
                loading={loadMoreMutation.isPending}
                onClick={() =>
                  loadMoreMutation.mutate({
                    cursor: activeNextCursor,
                    capturedScope: scopeKey,
                    ...(activeProjectId ? { capturedProjectId: activeProjectId } : {}),
                    capturedStatuses: STATUS_TAB_VALUES[statusTab],
                  })
                }
                data-testid="triage-load-more-btn"
              >
                {t('loadMore')}
              </Button>
            )}
          </div>

          {/* Detail / triage action pane */}
          {selectedItem && (
            <Card
              className={`${mobileDetailOpen ? 'block' : 'hidden md:block'}`}
              data-testid="triage-detail-pane"
            >
              <CardHeader className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="min-h-11 md:hidden"
                    onClick={() => setMobileDetailOpen(false)}
                    data-testid="triage-mobile-back"
                  >
                    {t('common.back')}
                  </Button>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={priorityBadgeVariant(selectedItem.priority)}>
                      {t(`priorities.${selectedItem.priority}`)}
                    </Badge>
                    <Badge variant="outline">{t(`sources.${sourceTypeKey(selectedItem.sourceType)}`)}</Badge>
                    <Badge variant="outline">{t(`statuses.${selectedItem.status}`)}</Badge>
                    {selectedItem.tainted && (
                      <Badge variant="secondary" data-testid="triage-detail-tainted">
                        {t('taintedBadge')}
                      </Badge>
                    )}
                    {selectedItem.snoozeElapsed && (
                      <Badge variant="destructive">{t('snoozeElapsedBadge')}</Badge>
                    )}
                  </div>
                </div>
                <CardTitle className="text-lg">{selectedItem.title}</CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{selectedItem.projectName}</span>
                  {selectedItem.sourceLabel && <span>{selectedItem.sourceLabel}</span>}
                  {selectedItem.createdByName && <span>{t('createdBy', { name: selectedItem.createdByName })}</span>}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-5">
                {selectedItem.tainted && (
                  <Alert data-testid="triage-tainted-notice">
                    <AlertDescription>{t('taintedNotice')}</AlertDescription>
                  </Alert>
                )}

                {selectedItem.description && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm whitespace-pre-wrap text-foreground">
                    {selectedItem.description}
                  </div>
                )}

                {selectedItem.sourceType === 'kernel.conversation' && selectedItem.sourceId && (
                  <p className="text-xs text-muted-foreground">
                    <Link
                      to="/o/$slug/inbox"
                      params={{ slug: orgSlug }}
                      className="inline-flex min-h-11 items-center underline hover:text-foreground"
                    >
                      {t('sourceLinks.conversation')}
                    </Link>
                  </p>
                )}
                {selectedItem.sourceType === 'meetings.meeting' && selectedItem.sourceId && (
                  <p className="text-xs text-muted-foreground">
                    <Link
                      to="/o/$slug/meetings/$id"
                      params={{ slug: orgSlug, id: selectedItem.sourceId }}
                      className="inline-flex min-h-11 items-center underline hover:text-foreground"
                    >
                      {t('sourceLinks.meeting')}
                    </Link>
                  </p>
                )}

                {selectedItem.status === 'accepted' && selectedItem.acceptedTaskId && (
                  <Alert data-testid="triage-accepted-link-box">
                    <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                      <span>{t('resolved.acceptedText')}</span>
                      <Link
                        to="/o/$slug/tasks/$id"
                        params={{ slug: orgSlug, id: selectedItem.acceptedTaskId }}
                        className={`${buttonVariants({ size: 'sm', variant: 'outline' })} min-h-11`}
                      >
                        {t('resolved.openTask')}
                      </Link>
                    </AlertDescription>
                  </Alert>
                )}

                {selectedItem.status === 'merged' && selectedItem.mergedIntoTaskId && (
                  <Alert data-testid="triage-merged-link-box">
                    <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                      <span>{t('resolved.mergedText')}</span>
                      <Link
                        to="/o/$slug/tasks/$id"
                        params={{ slug: orgSlug, id: selectedItem.mergedIntoTaskId }}
                        className={`${buttonVariants({ size: 'sm', variant: 'outline' })} min-h-11`}
                      >
                        {t('resolved.openTask')}
                      </Link>
                    </AlertDescription>
                  </Alert>
                )}

                {selectedItem.status === 'declined' && (
                  <Alert data-testid="triage-declined-box">
                    <AlertDescription>
                      {selectedItem.declineReason
                        ? t('resolved.declinedWithReason', { reason: selectedItem.declineReason })
                        : t('resolved.declinedNoReason')}
                    </AlertDescription>
                  </Alert>
                )}

                {selectedItem.status === 'snoozed' && selectedItem.snoozedUntil && (
                  <Alert data-testid="triage-snoozed-box">
                    <AlertDescription>
                      {t('resolved.snoozedUntil', { date: f.dateTime(selectedItem.snoozedUntil) })}
                    </AlertDescription>
                  </Alert>
                )}

                {anyMutationError && <ErrorText>{errorMessage(anyMutationError)}</ErrorText>}

                {/* Vy AI Triage Assist */}
                {isPendingOrSnoozed && canWriteSelected && (
                  <div
                    className="space-y-3 rounded-xl border border-border bg-muted/20 p-3"
                    data-testid="triage-vy-assist-box"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" data-testid="triage-ai-badge">
                          {t('ai.badge')}
                        </Badge>
                        <span className="text-sm font-medium text-foreground">{t('ai.heading')}</span>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-11"
                        disabled={!aiStatus?.available}
                        loading={assistMutation.isPending}
                        onClick={() => assistMutation.mutate(selectedItem.id)}
                        data-testid="triage-vy-assist-btn"
                      >
                        {t('ai.askBtn')}
                      </Button>
                    </div>

                    {aiStatus && !aiStatus.available && (
                      <p className="text-xs text-muted-foreground" data-testid="triage-ai-unavailable">
                        {aiStatus.reason === 'budget'
                          ? t('ai.unavailableBudget')
                          : aiStatus.reason === 'paused'
                            ? t('ai.unavailablePaused')
                            : t('ai.unavailableOff')}
                      </p>
                    )}

                    {currentAssist && currentAssist.ai !== 'used' && (
                      <p className="text-xs text-muted-foreground" data-testid="triage-ai-state-note">
                        {t(`ai.states.${currentAssist.ai}`)}
                      </p>
                    )}

                    {currentAssist?.ai === 'used' && currentAssist.proposal && (
                      <div className="space-y-2 rounded-lg border border-border bg-background p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>
                            {t('ai.recommendedPriority')}:{' '}
                            <strong>{t(`priorities.${currentAssist.proposal.recommendedPriority}`)}</strong>
                          </span>
                          {currentAssist.proposal.suggestedAssigneeLabel && (
                            <span>
                              · {t('ai.suggestedAssignee')}:{' '}
                              <strong>{currentAssist.proposal.suggestedAssigneeLabel}</strong>
                            </span>
                          )}
                          {currentAssist.proposal.suggestedCycleLabel && (
                            <span>
                              · {t('ai.suggestedCycle')}:{' '}
                              <strong>{currentAssist.proposal.suggestedCycleLabel}</strong>
                            </span>
                          )}
                        </div>
                        {currentAssist.proposal.duplicateTaskTitle && (
                          <p className="text-xs text-muted-foreground">
                            {t('ai.possibleDuplicate', { title: currentAssist.proposal.duplicateTaskTitle })}
                          </p>
                        )}
                        {currentAssist.proposal.reason && (
                          <p className="text-xs text-muted-foreground">{currentAssist.proposal.reason}</p>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="min-h-11"
                          onClick={() => applyProposalToForm(currentAssist.proposal!)}
                          data-testid="triage-ai-apply-btn"
                        >
                          {t('ai.applyBtn')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {/* Accept into Task form */}
                {isPendingOrSnoozed && canWriteSelected && (
                  <form onSubmit={submitAccept} className="space-y-3 rounded-xl border border-border p-3">
                    <h3 className="text-sm font-semibold text-foreground">{t('accept.heading')}</h3>
                    <div className="space-y-1.5">
                      <Label htmlFor={`triage-accept-title-${selectedItem.id}`}>{t('fields.titleLabel')}</Label>
                      <Input
                        id={`triage-accept-title-${selectedItem.id}`}
                        required
                        maxLength={PROJECT_TRIAGE_TITLE_MAX}
                        value={acceptTitle}
                        onChange={(e) => setAcceptTitle(e.target.value)}
                        className="min-h-11"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`triage-accept-desc-${selectedItem.id}`}>{t('fields.descriptionLabel')}</Label>
                      <Textarea
                        id={`triage-accept-desc-${selectedItem.id}`}
                        rows={2}
                        maxLength={PROJECT_TRIAGE_DESCRIPTION_MAX}
                        value={acceptDescription}
                        onChange={(e) => setAcceptDescription(e.target.value)}
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`triage-accept-priority-${selectedItem.id}`}>{t('fields.priorityLabel')}</Label>
                        <NativeSelect
                          id={`triage-accept-priority-${selectedItem.id}`}
                          value={acceptPriority}
                          onChange={(e) => setAcceptPriority(e.target.value as ProjectTriagePriority)}
                          className="min-h-11 [&_select]:min-h-11"
                        >
                          {PROJECT_TRIAGE_PRIORITIES.map((p) => (
                            <NativeSelectOption key={p} value={p}>
                              {t(`priorities.${p}`)}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`triage-accept-seat-${selectedItem.id}`}>{t('fields.assigneeLabel')}</Label>
                        <NativeSelect
                          id={`triage-accept-seat-${selectedItem.id}`}
                          value={acceptSeatId}
                          onChange={(e) => setAcceptSeatId(e.target.value)}
                          className="min-h-11 [&_select]:min-h-11"
                        >
                          <NativeSelectOption value="">{t('fields.unassigned')}</NativeSelectOption>
                          {projectSeats.map((s) => (
                            <NativeSelectOption key={s.id} value={s.id}>
                              {seatOptionLabel(s, t('common.aiSuffix'), t('common.openSeatSuffix'))}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`triage-accept-col-${selectedItem.id}`}>{t('fields.columnLabel')}</Label>
                        <NativeSelect
                          id={`triage-accept-col-${selectedItem.id}`}
                          value={acceptColumnId}
                          onChange={(e) => setAcceptColumnId(e.target.value)}
                          className="min-h-11 [&_select]:min-h-11"
                        >
                          {projectColumns.length === 0 ? (
                            <NativeSelectOption value="">{t('fields.defaultColumn')}</NativeSelectOption>
                          ) : (
                            projectColumns.map((col) => (
                              <NativeSelectOption key={col.id} value={col.id}>
                                {col.name}
                              </NativeSelectOption>
                            ))
                          )}
                        </NativeSelect>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`triage-accept-cycle-${selectedItem.id}`}>{t('fields.cycleLabel')}</Label>
                        <NativeSelect
                          id={`triage-accept-cycle-${selectedItem.id}`}
                          value={acceptCycleId}
                          onChange={(e) => setAcceptCycleId(e.target.value)}
                          className="min-h-11 [&_select]:min-h-11"
                        >
                          <NativeSelectOption value="">{t('fields.backlog')}</NativeSelectOption>
                          {projectCycles.map((cy) => (
                            <NativeSelectOption key={cy.id} value={cy.id}>
                              #{cy.number} {cy.name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                    </div>
                    <label className="block space-y-1.5 text-sm font-medium text-foreground">
                      <span>{tt('dueLabel')}</span>
                      <DateInput
                        value={acceptDueDay}
                        onChange={setAcceptDueDay}
                        aria-label={tt('dueLabel')}
                        className="mt-1"
                        inputClassName="min-h-11"
                      />
                    </label>
                    <Button
                      type="submit"
                      className="min-h-11"
                      loading={acceptMutation.isPending}
                      disabled={acceptTitle.trim() === ''}
                      data-testid="triage-accept-submit"
                    >
                      {t('accept.submit')}
                    </Button>
                  </form>
                )}

                {/* Merge + Snooze + Decline + Reopen action rows */}
                {isPendingOrSnoozed && canWriteSelected && (
                  <div className="space-y-3">
                    {projectOpenTasks.length > 0 && (
                      <div className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-end">
                        <div className="flex-1 space-y-1.5">
                          <Label htmlFor={`triage-merge-task-${selectedItem.id}`}>{t('merge.label')}</Label>
                          <NativeSelect
                            id={`triage-merge-task-${selectedItem.id}`}
                            value={mergeTargetTaskId}
                            onChange={(e) => setMergeTargetTaskId(e.target.value)}
                            className="min-h-11 [&_select]:min-h-11"
                          >
                            {projectOpenTasks.map((task) => (
                              <NativeSelectOption key={task.id} value={task.id}>
                                {task.title}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          loading={mergeMutation.isPending}
                          disabled={!mergeTargetTaskId}
                          onClick={() =>
                            mergeMutation.mutate({
                              itemId: selectedItem.id,
                              targetTaskId: mergeTargetTaskId,
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                          data-testid="triage-merge-submit"
                        >
                          {t('merge.submit')}
                        </Button>
                      </div>
                    )}

                    <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
                      <span className="text-sm font-medium text-foreground">{t('snooze.heading')}</span>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          loading={snoozeMutation.isPending}
                          onClick={() =>
                            snoozeMutation.mutate({
                              itemId: selectedItem.id,
                              snoozedUntil: addHoursIso(1),
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                          data-testid="triage-snooze-1h"
                        >
                          {t('snooze.oneHour')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          loading={snoozeMutation.isPending}
                          onClick={() =>
                            snoozeMutation.mutate({
                              itemId: selectedItem.id,
                              snoozedUntil: tomorrowMorningIso(),
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                          data-testid="triage-snooze-tomorrow"
                        >
                          {t('snooze.tomorrow')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          loading={snoozeMutation.isPending}
                          onClick={() =>
                            snoozeMutation.mutate({
                              itemId: selectedItem.id,
                              snoozedUntil: addHoursIso(24 * 7),
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                          data-testid="triage-snooze-week"
                        >
                          {t('snooze.nextWeek')}
                        </Button>
                        <Input
                          type="datetime-local"
                          aria-label={t('snooze.customLabel')}
                          value={snoozeCustomLocal}
                          onChange={(e) => setSnoozeCustomLocal(e.target.value)}
                          className="min-h-11 w-auto"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          loading={snoozeMutation.isPending}
                          disabled={!snoozeCustomLocal}
                          onClick={() => {
                            const parsed = new Date(snoozeCustomLocal);
                            if (Number.isNaN(parsed.getTime())) return;
                            snoozeMutation.mutate({
                              itemId: selectedItem.id,
                              snoozedUntil: parsed.toISOString(),
                              idempotencyKey: crypto.randomUUID(),
                            });
                          }}
                          data-testid="triage-snooze-custom-btn"
                        >
                          {t('snooze.customSubmit')}
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 text-destructive"
                        onClick={() => {
                          setDeclineTargetId(selectedItem.id);
                          setDeclineDialogOpen(true);
                        }}
                        data-testid="triage-decline-open-btn"
                      >
                        {t('decline.openBtn')}
                      </Button>
                      {canReopen && (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          loading={reopenMutation.isPending}
                          onClick={() =>
                            reopenMutation.mutate({
                              itemId: selectedItem.id,
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                          data-testid="triage-reopen-btn"
                        >
                          {t('reopen.btn')}
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {selectedItem.status === 'declined' && canReopen && canWriteSelected && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    loading={reopenMutation.isPending}
                    onClick={() =>
                      reopenMutation.mutate({
                        itemId: selectedItem.id,
                        idempotencyKey: crypto.randomUUID(),
                      })
                    }
                    data-testid="triage-reopen-btn"
                  >
                    {t('reopen.btn')}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Decline Modal */}
      <Dialog
        open={declineDialogOpen}
        onOpenChange={(next) => {
          setDeclineDialogOpen(next);
          if (!next) setDeclineTargetId(null);
        }}
      >
        <DialogContent className="max-w-md" closeLabel={t('common.cancel')} data-testid="triage-decline-dialog">
          <DialogHeader>
            <DialogTitle>{t('decline.title')}</DialogTitle>
            <DialogDescription>{t('decline.subtitle')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="triage-decline-reason">{t('decline.reasonLabel')}</Label>
            <Textarea
              id="triage-decline-reason"
              rows={3}
              maxLength={PROJECT_TRIAGE_DECLINE_REASON_MAX}
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder={t('decline.reasonPlaceholder')}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className="min-h-11" />}>
              {t('common.cancel')}
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              loading={declineMutation.isPending}
              disabled={!declineTargetId}
              onClick={() => {
                if (!declineTargetId) {
                  setDeclineDialogOpen(false);
                  return;
                }
                declineMutation.mutate({
                  itemId: declineTargetId,
                  declineReason: declineReason.trim() || null,
                  idempotencyKey: crypto.randomUUID(),
                });
              }}
              data-testid="triage-decline-confirm-btn"
            >
              {t('decline.confirmBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual Create Modal */}
      <Dialog
        open={createDialogOpen}
        onOpenChange={(next) => {
          if (next) createIdempotencyKeyRef.current = crypto.randomUUID();
          setCreateDialogOpen(next);
        }}
      >
        <DialogContent className="max-w-lg" closeLabel={t('common.cancel')} data-testid="triage-create-dialog">
          <DialogHeader>
            <DialogTitle>{t('createDialog.title')}</DialogTitle>
            <DialogDescription>{t('createDialog.subtitle')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitManualCreate} className="space-y-4">
            {!projectId && (
              <div className="space-y-1.5">
                <Label htmlFor="triage-create-project">{t('sendDialog.projectLabel')}</Label>
                <NativeSelect
                  id="triage-create-project"
                  value={createProjectId}
                  onChange={(e) => setCreateProjectId(e.target.value)}
                  className="min-h-11 [&_select]:min-h-11"
                >
                  {writableProjects.map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="triage-create-title">{t('fields.titleLabel')}</Label>
              <Input
                id="triage-create-title"
                required
                maxLength={PROJECT_TRIAGE_TITLE_MAX}
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                placeholder={t('fields.titlePlaceholder')}
                className="min-h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="triage-create-priority">{t('fields.priorityLabel')}</Label>
              <NativeSelect
                id="triage-create-priority"
                value={createPriority}
                onChange={(e) => setCreatePriority(e.target.value as ProjectTriagePriority)}
                className="min-h-11 [&_select]:min-h-11"
              >
                {PROJECT_TRIAGE_PRIORITIES.map((p) => (
                  <NativeSelectOption key={p} value={p}>
                    {t(`priorities.${p}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="triage-create-desc">{t('fields.descriptionLabel')}</Label>
              <Textarea
                id="triage-create-desc"
                rows={3}
                maxLength={PROJECT_TRIAGE_DESCRIPTION_MAX}
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder={t('fields.descriptionPlaceholder')}
              />
            </div>
            {createMutation.error && <ErrorText>{errorMessage(createMutation.error)}</ErrorText>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" className="min-h-11" />}>
                {t('common.cancel')}
              </DialogClose>
              <Button
                type="submit"
                className="min-h-11"
                loading={createMutation.isPending}
                disabled={!createProjectId || createTitle.trim() === ''}
                data-testid="triage-create-submit"
              >
                {t('createDialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
