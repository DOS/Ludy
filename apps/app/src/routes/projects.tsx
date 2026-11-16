// SPDX-License-Identifier: AGPL-3.0-only
// Projects list and board/list screens (/o/$slug/projects and /o/$slug/projects/$id, issue #2591, ADR-0048).
import { hashKey, useMutation, useQuery } from '@tanstack/react-query';
import type { FilterAst, ProjectBoard, ProjectStatus, ProjectSummary, ProjectTaskCard, SavedViewSort } from '@crove/kernel-contract';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { ProjectIcon } from '@crove/ui/components/project-icon';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { ProjectBoardView, type BoardColumnStatus } from '../components/project-board.tsx';
import { ProjectWeeklyStatus } from '../components/project-weekly-status.tsx';
import {
  AttachTaskDialog,
  CreateProjectDialog,
  EditProjectTaskDialog,
  ProjectSettingsDialog,
  refreshProjectQueries,
  seatOptionLabel,
} from '../components/project-task-dialog.tsx';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { TaskFilterBar } from '../components/task-filter-bar.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader, PageSkeleton } from '../components/ui.tsx';
import { ViewTabs, type ViewState } from '../components/view-tabs.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import {
  PROJECT_STATUSES,
  boardPlaceholderForProject,
  createBoardBatchTracker,
  defaultProjectView,
  filterProjects,
  hasUnseatedTeamMembers,
  optimisticMoveTask,
  optimisticReorderTask,
  projectCompletionPct,
  projectStatusVariant,
  statusFilterIncludesCancelled,
  type ProjectStatusFilter,
  type ProjectViewMode,
  type TaskPlacement,
} from '../lib/projects.ts';
import { EMPTY_TASK_FILTER, astToTaskFilter, taskFilterToAst, type TaskFilterState } from '../lib/task-filter.ts';
import { useDebounced } from '../lib/use-debounced.ts';

function statusFilterParam(filter: ProjectStatusFilter): ProjectStatus[] | undefined {
  if (filter === 'all') return undefined;
  if (filter === 'open') return ['active', 'on_hold', 'done'];
  return [filter];
}

function ProjectCardItem({ slug, project }: { slug: string; project: ProjectSummary }) {
  const t = useTranslations('projects');
  const f = useFormat();
  const pct = projectCompletionPct(project.openTaskCount, project.doneTaskCount);
  const total = project.openTaskCount + project.doneTaskCount;

  return (
    <li className="min-w-0">
      <Link
        to="/o/$slug/projects/$id"
        params={{ slug, id: project.id }}
        data-testid="project-card"
        data-project-id={project.id}
        className="block h-full rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Card className="flex h-full flex-col justify-between gap-3 p-4 transition-colors hover:bg-muted/35">
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <h2 className="min-w-0 break-words text-base font-semibold tracking-tight text-foreground">{project.name}</h2>
              <Badge variant={projectStatusVariant(project.status)} className="shrink-0">
                {t(`status.${project.status}`)}
              </Badge>
            </div>
            {project.description && (
              <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{project.description}</p>
            )}
          </div>

          <div className="space-y-2.5 pt-1">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
                <span>
                  {t('card.openTasks', { count: String(project.openTaskCount) })} · {t('card.doneTasks', { count: String(project.doneTaskCount) })}
                </span>
                {total > 0 && <span className="font-medium text-foreground">{pct}%</span>}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div
                  className={`h-full rounded-full transition-all ${pct === 100 && total > 0 ? 'bg-success' : 'bg-primary'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <ProjectIcon name="user" className="size-3.5" />
                <span className="truncate">
                  {project.ownerName ? t('card.owner', { name: project.ownerName }) : t('card.noOwner')}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-2 tabular-nums">
                {project.memberCount > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <ProjectIcon name="users" className="size-3.5" />
                    {t('card.membersCount', { count: String(project.memberCount) })}
                  </span>
                )}
                <span>{f.date(project.updatedAt)}</span>
              </span>
            </div>
          </div>
        </Card>
      </Link>
    </li>
  );
}

export function ProjectsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const t = useTranslations('projects');
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>('open');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const statuses = statusFilterParam(statusFilter);
  const query = useQuery(orpc.projects.list.queryOptions({ input: statuses ? { status: statuses } : {} }));

  const canWrite = query.data?.canWrite ?? false;
  const projects = filterProjects(query.data?.projects ?? [], search);
  const filterTabs: readonly ProjectStatusFilter[] = ['open', ...PROJECT_STATUSES, 'all'];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canWrite ? (
            <Button onClick={() => setCreateOpen(true)} data-testid="new-project-button">
              <ProjectIcon name="plus" />
              {t('newProject')}
            </Button>
          ) : undefined
        }
      />

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(projectId) => {
          void navigate({ to: '/o/$slug/projects/$id', params: { slug, id: projectId } });
        }}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={statusFilter}
          onValueChange={(next) => setStatusFilter(next as ProjectStatusFilter)}
          className="min-w-0 overflow-x-auto"
        >
          <TabsList aria-label={t('filters.label')}>
            {filterTabs.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {t(`filters.${tab}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="w-full sm:w-72">
          <Input
            type="search"
            aria-label={t('searchLabel')}
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {query.isPending ? (
        <ListSkeleton />
      ) : query.error ? (
        <ErrorText>{errorMessage(query.error)}</ErrorText>
      ) : projects.length === 0 ? (
        <Empty
          title={search.trim() || statusFilter !== 'open' ? t('emptyFiltered') : t('empty')}
          hint={search.trim() || statusFilter !== 'open' ? t('emptyFilteredHint') : t('emptyHint')}
          action={
            canWrite && !search.trim() ? (
              <Button onClick={() => setCreateOpen(true)}>
                <ProjectIcon name="plus" />
                {t('newProject')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {query.data?.truncated && (
            <p className="text-xs text-muted-foreground">{t('truncated', { count: String(projects.length) })}</p>
          )}
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="projects-list">
            {projects.map((project) => (
              <ProjectCardItem key={project.id} slug={slug} project={project} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function countOtherProjectMembers(
  members: ReadonlyArray<{ userId: string; onProject: boolean }>,
  currentUserId: string | null,
): number | undefined {
  return currentUserId ? members.filter((m) => m.onProject && m.userId !== currentUserId).length : undefined;
}

export function ProjectDetailPage() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const t = useTranslations('projects');
  const tn = useTranslations('notes');

  const userPickedView = useRef(false);
  const [view, setView] = useState<ProjectViewMode>(() =>
    typeof window === 'undefined' ? 'board' : defaultProjectView(window.innerWidth),
  );
  const [positionId, setPositionId] = useState<string>('');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ProjectTaskCard | null>(null);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [bar, setBar] = useState<TaskFilterState>(EMPTY_TASK_FILTER);
  const [sort, setSort] = useState<SavedViewSort | null>(null);
  const filters: FilterAst = taskFilterToAst(bar);
  const searchTerm = useDebounced(bar.search.trim(), 300);
  const applied: FilterAst = taskFilterToAst({ ...bar, search: searchTerm });
  const applyView = ({ filters: next, sort: nextSort }: ViewState) => {
    setBar(astToTaskFilter(next));
    setSort(nextSort);
  };
  const reorderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const batchTrackerRef = useRef(createBoardBatchTracker<readonly unknown[]>());
  const activeProjectIdRef = useRef(id);
  activeProjectIdRef.current = id;

  useEffect(() => {
    setMoveError(null);
    setEditingTask(null);
  }, [id]);

  useEffect(() => {
    const onResize = () => {
      if (!userPickedView.current) {
        setView(defaultProjectView(window.innerWidth));
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const effectiveIncludeCancelled = includeCancelled || statusFilterIncludesCancelled(applied);
  const boardInput = {
    projectId: id,
    ...(positionId ? { positionId } : {}),
    ...(includeCancelled ? { includeCancelled: true } : {}),
    ...(applied.all.length > 0 ? { filters: applied } : {}),
    ...(sort ? { sort } : {}),
  };
  const boardQueryOptions = orpc.projects.board.queryOptions({ input: boardInput });
  const boardQuery = useQuery({
    ...boardQueryOptions,
    placeholderData: (previous) => boardPlaceholderForProject(previous, id),
    // Task checkout releases are not pushed over SSE yet; poll only while an agent holds a lease.
    refetchInterval: (query) => (query.state.data?.tasks.some((item) => item.checkedOut) ? 5_000 : false),
  });
  const me = useQuery(orpc.me.get.queryOptions());

  const enqueueBoardMutation = (
    optimisticUpdate: (items: readonly ProjectTaskCard[]) => ProjectTaskCard[],
    mutationFn: () => Promise<unknown>,
  ) => {
    setMoveError(null);
    const capturedProjectId = id;
    const queryKey = boardQueryOptions.queryKey;
    const keyHash = hashKey(queryKey);
    const tracker = batchTrackerRef.current;
    const snapshot = queryClient.getQueryData<ProjectBoard>(queryKey);
    const entry = tracker.begin(keyHash, queryKey, snapshot);
    void queryClient.cancelQueries({ queryKey });
    if (snapshot) {
      queryClient.setQueryData<ProjectBoard>(queryKey, {
        ...snapshot,
        tasks: optimisticUpdate(snapshot.tasks),
      });
    }
    reorderQueueRef.current = reorderQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await mutationFn();
          tracker.markSucceeded(entry);
        } catch (err) {
          const rollback = tracker.rollbackOnFailure(entry);
          if (rollback) {
            queryClient.setQueryData<ProjectBoard>(entry.state.queryKey, rollback);
          }
          if (activeProjectIdRef.current === capturedProjectId) {
            setMoveError(err);
          }
        } finally {
          const { queryDrained } = tracker.finish(entry);
          if (queryDrained) {
            refreshProjectQueries();
          }
        }
      });
  };

  const createTask = useMutation(
    orpc.projects.createTask.mutationOptions({
      onSuccess: refreshProjectQueries,
    }),
  );

  const removeTask = useMutation(
    orpc.projects.removeTask.mutationOptions({
      onSuccess: refreshProjectQueries,
    }),
  );

  const handleViewChange = (next: ProjectViewMode) => {
    userPickedView.current = true;
    setView(next);
  };

  if (!boardQuery.data) {
    if (boardQuery.error) return <ErrorText>{errorMessage(boardQuery.error)}</ErrorText>;
    return <PageSkeleton />;
  }

  const board = boardQuery.data;
  const { project, seats, members, tasks, hiddenByEntityCount } = board;
  const currentUserId = me.data?.userId ?? null;
  const otherMemberCount = countOtherProjectMembers(members, currentUserId);
  const openCount = tasks.filter((item) => item.status !== 'done' && item.status !== 'cancelled').length;
  const doneCount = tasks.filter((item) => item.status === 'done').length;
  const pct = projectCompletionPct(openCount, doneCount);
  const showSeatHint = hasUnseatedTeamMembers(board);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Link
          to="/o/$slug/projects"
          params={{ slug }}
          className="inline-flex min-h-8 items-center gap-1.5 rounded px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ProjectIcon name="back" className="size-3.5" />
          <span>{t('backToList')}</span>
        </Link>

        <PageHeader
          title={project.name}
          subtitle={project.description ?? undefined}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {project.canWrite && (
                <Button variant="outline" onClick={() => setAttachOpen(true)} data-testid="attach-task-button">
                  <ProjectIcon name="link" />
                  {t('detail.addExisting')}
                </Button>
              )}
              <Button variant="outline" onClick={() => setSettingsOpen(true)} data-testid="project-settings-button">
                <NavIcon name="settings" />
                {t('detail.settingsTeam')}
              </Button>
            </div>
          }
        />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <Badge variant={projectStatusVariant(project.status)}>{t(`status.${project.status}`)}</Badge>
          <span className="inline-flex items-center gap-1">
            <ProjectIcon name="user" className="size-3.5" />
            <span>{project.ownerName ? t('card.owner', { name: project.ownerName }) : t('card.noOwner')}</span>
          </span>
          <span className="tabular-nums">
            {t('detail.progressLabel', {
              done: String(doneCount),
              total: String(openCount + doneCount),
              pct: String(pct),
            })}
          </span>
        </div>
      </div>

      <ProjectWeeklyStatus
        key={project.id}
        slug={slug}
        projectId={project.id}
        projectStatus={project.status}
        canManage={project.canManage}
        otherMemberCount={otherMemberCount}
      />

      {project.status === 'archived' && (
        <Alert className="border-border bg-muted/40">
          <ProjectIcon name="archive" className="text-muted-foreground" />
          <AlertDescription className="text-xs text-foreground">{t('detail.archivedBanner')}</AlertDescription>
        </Alert>
      )}

      {hiddenByEntityCount > 0 && (
        <Alert className="border-warning/30 bg-warning/10" data-testid="hidden-entity-banner">
          <NavIcon name="info" className="text-warning" />
          <AlertDescription className="text-xs text-foreground">
            {t('detail.hiddenEntitiesBanner', { count: String(hiddenByEntityCount) })}
          </AlertDescription>
        </Alert>
      )}

      {showSeatHint && (
        <Alert className="border-border bg-muted/35" data-testid="seat-hint-banner">
          <ProjectIcon name="users" className="text-muted-foreground" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
            <span>{t('detail.seatHint')}</span>
            <Link
              to="/o/$slug/agents"
              params={{ slug }}
              className="rounded font-medium text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('detail.openOrgChart')}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <Tabs value={view} onValueChange={(next) => handleViewChange(next as ProjectViewMode)}>
          <TabsList aria-label={t('detail.viewSwitchLabel')}>
            <TabsTrigger value="board" data-testid="view-toggle-board" className="gap-1.5">
              <ProjectIcon name="board" className="size-3.5" />
              <span>{t('detail.viewBoard')}</span>
            </TabsTrigger>
            <TabsTrigger value="list" data-testid="view-toggle-list" className="gap-1.5">
              <ProjectIcon name="list" className="size-3.5" />
              <span>{t('detail.viewList')}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-44 items-center gap-2">
            <Label htmlFor="project-seat-filter" className="sr-only">
              {t('detail.positionFilter')}
            </Label>
            <NativeSelect
              id="project-seat-filter"
              aria-label={t('detail.positionFilter')}
              value={positionId}
              onChange={(e) => setPositionId(e.target.value)}
              className="h-9 w-full text-xs sm:h-8"
            >
              <NativeSelectOption value="">{t('detail.allPositions')}</NativeSelectOption>
              <NativeSelectOption value="root">{t('detail.rootPosition')}</NativeSelectOption>
              {seats.map((seat) => (
                <NativeSelectOption key={seat.id} value={seat.id}>
                  {seatOptionLabel(seat, t('modals.aiSeatSuffix'), t('modals.openSeatSuffix'))}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-xs text-foreground sm:min-h-8">
            <Checkbox
              checked={includeCancelled}
              onCheckedChange={(checked) => setIncludeCancelled(checked === true)}
            />
            <span>{t('detail.includeCancelled')}</span>
          </label>
        </div>
      </div>

      {board.truncated && (
        <p className="text-xs text-muted-foreground">{t('detail.truncated', { count: String(tasks.length) })}</p>
      )}

      <div className="space-y-2">
        <ViewTabs scope="kernel.task" filters={filters} sort={sort} onApply={applyView} />
        <TaskFilterBar
          idPrefix="project-tasks-filter"
          bar={bar}
          setBar={setBar}
          sort={sort}
          setSort={setSort}
          positions={seats.map((seat) => ({
            id: seat.id,
            label: seatOptionLabel(seat, t('modals.aiSeatSuffix'), t('modals.openSeatSuffix')),
          }))}
        />
      </div>

      {boardQuery.error && <ErrorText>{errorMessage(boardQuery.error)}</ErrorText>}
      {moveError !== null && <ErrorText>{errorMessage(moveError)}</ErrorText>}
      {createTask.error && <ErrorText>{errorMessage(createTask.error)}</ErrorText>}
      {removeTask.error && <ErrorText>{errorMessage(removeTask.error)}</ErrorText>}

      <ProjectBoardView
        slug={slug}
        view={view}
        tasks={tasks}
        seats={seats}
        canEdit={project.canWrite}
        includeCancelled={effectiveIncludeCancelled}
        creatingTask={createTask.isPending}
        customSortActive={sort !== null}
        onMoveStatus={(taskId, nextStatus, placement) => {
          enqueueBoardMutation(
            (items) => optimisticMoveTask(items, taskId, nextStatus, placement),
            async () => {
              await orpc.tasks.setStatus.call({ id: taskId, status: nextStatus, idempotencyKey: crypto.randomUUID() });
              if (placement) {
                await orpc.projects.reorderTask.call({
                  projectId: project.id,
                  taskId,
                  place: placement.place,
                  anchorId: placement.anchorId,
                  idempotencyKey: crypto.randomUUID(),
                });
              }
            },
          );
        }}
        onReorderTask={(taskId: string, placement: TaskPlacement) => {
          enqueueBoardMutation(
            (items) => optimisticReorderTask(items, taskId, placement),
            () =>
              orpc.projects.reorderTask.call({
                projectId: project.id,
                taskId,
                place: placement.place,
                anchorId: placement.anchorId,
                idempotencyKey: crypto.randomUUID(),
              }),
          );
        }}
        onCreateTask={(input: { title: string; assigneePositionId: string | null; due?: string; status: BoardColumnStatus }, done) => {
          createTask.mutate(
            {
              projectId: project.id,
              title: input.title,
              assigneePositionId: input.assigneePositionId,
              ...(input.due ? { due: input.due } : {}),
              status: input.status,
              idempotencyKey: crypto.randomUUID(),
            },
            { onSuccess: done },
          );
        }}
        onEditTask={setEditingTask}
        onRemoveTask={(taskId) => {
          removeTask.mutate({
            projectId: project.id,
            taskId,
            idempotencyKey: crypto.randomUUID(),
          });
        }}
      />

      {notesInstalled() && (
        <RecordNotesPanel
          slug={slug}
          target={{ targetType: 'projects.project', targetId: project.id }}
          headingId={`notes-project-${project.id}`}
          label={tn('panel.toggleOf', { name: project.name })}
          empty={tn('panel.emptyRecord')}
        />
      )}

      <AttachTaskDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        projectId={project.id}
        disabled={!project.canWrite}
      />
      <EditProjectTaskDialog
        slug={slug}
        task={editingTask}
        seats={seats}
        open={editingTask !== null}
        onOpenChange={(next) => {
          if (!next) setEditingTask(null);
        }}
      />
      <ProjectSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        project={project}
        members={members}
      />
    </div>
  );
}
