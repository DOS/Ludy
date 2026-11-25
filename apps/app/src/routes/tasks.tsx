// Team tasks (ADR-0029, issue #258): work given to positions of the chart, held by members or AI agents. Every member
// reads them; owners, admins and members give work, comment and change status. A task made from untrusted content
// (an email, a run that read one) is marked, so nobody acts on it unchecked.
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { PROJECT_TASK_MAP_LIMIT, type FilterAst, type SavedViewSort } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { meetingsInstalled } from '../components/linked-meetings.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { ProjectDependencies, shouldConfirmBlockedStatusMove, splitTaskDependencies } from '../components/project-dependencies.tsx';
import { TaskChecklistBadge, TaskChecklistSection } from '../components/task-checklist.tsx';
import { EditTaskPanel, NewTaskPanel } from '../components/task-panel.tsx';
import { TaskConversationLink } from '../components/task-conversation-link.tsx';
import { TaskFilterBar } from '../components/task-filter-bar.tsx';
import { TaskTimeTrackingPanel } from '../components/project-time-panel.tsx';
import { TaskRecurrenceControl, formatRecurrenceBadgeLabel } from '../components/task-recurrence-control.tsx';
import { DataTable, Empty, ErrorText, ListSkeleton, PageHeader, PageSkeleton } from '../components/ui.tsx';
import { ViewTabs, type ViewState } from '../components/view-tabs.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { OPEN_TASK_STATUSES, TASK_LIST_LIMIT, TASK_STATUSES, agentPermissions, conversationOf, fromTodo, meetingItemOf, meetingSourceOf, socialPostOf, type TaskFilter, type TaskStatus, type TasksSearch } from '../lib/agents.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { isModuleOff } from '../lib/errors.ts';
import { filterTasksByProject, projectsInstalled, taskProjectMap, taskProjectOptions } from '../lib/projects.ts';
import { myWorkShortcut, stepSelection } from '../lib/my-work.ts';
import { withSearch } from '../lib/search.ts';
import { EMPTY_TASK_FILTER, astToTaskFilter, taskFilterToAst, type TaskFilterState } from '../lib/task-filter.ts';
import { taskTitleText } from '../lib/task-title.ts';
import { useDebounced } from '../lib/use-debounced.ts';

type Chart = Awaited<ReturnType<typeof orpc.chart.get.call>>;

const refresh = () => void queryClient.invalidateQueries();

function statusVariant(status: string): 'success' | 'warning' | 'outline' | 'secondary' {
  if (status === 'done') return 'success';
  if (status === 'waiting' || status === 'in_review') return 'warning';
  if (status === 'cancelled') return 'outline';
  return 'secondary';
}

function positionTitle(chart: Chart | undefined, id: string | null, root: string, unknown: string): string {
  if (id === null) return root;
  return chart?.positions.find((p) => p.id === id)?.title ?? unknown;
}

export function TasksPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('tasks');
  const f = useFormat();
  // The tab and project filter live in the address (#1513, #2593), left out for the defaults.
  const search: TasksSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const filter: TaskFilter = search.filter ?? 'open';
  const setFilter = (next: TaskFilter) =>
    void navigate({
      to: '/o/$slug/tasks',
      params: { slug },
      search: withSearch(search, { filter: next === 'open' ? undefined : next }),
    });
  const [bar, setBar] = useState<TaskFilterState>(EMPTY_TASK_FILTER);
  const [sort, setSort] = useState<SavedViewSort | null>(null);
  const filters: FilterAst = taskFilterToAst(bar);
  const searchTerm = useDebounced(bar.search.trim(), 300);
  const applied: FilterAst = taskFilterToAst({ ...bar, search: searchTerm });
  const viewed = applied.all.length > 0 || sort !== null;
  const applyView = ({ filters: next, sort: nextSort }: ViewState) => {
    setBar(astToTaskFilter(next));
    setSort(nextSort);
  };
  const org = useQuery(orpc.org.get.queryOptions());
  const chart = useQuery(orpc.chart.get.queryOptions());
  const baseInput = filter === 'mine' ? { mine: true } : filter === 'open' ? { status: [...OPEN_TASK_STATUSES] } : {};
  const baseWithoutStatusOverride = filter === 'open' && applied.all.some((c) => c.field === 'status') ? {} : baseInput;
  const input = viewed ? { ...baseWithoutStatusOverride, filters: applied, ...(sort ? { sort } : {}) } : baseInput;
  const tasks = useQuery({
    ...orpc.tasks.list.queryOptions({ input }),
    placeholderData: keepPreviousData,
  });
  const perms = agentPermissions(org.data?.role);
  // The panel over the list: a new task, or one task opened from its row.
  const [panel, setPanel] = useState<{ kind: 'new' } | { kind: 'edit'; id: string } | null>(null);
  useEffect(() => {
    if (search.new !== '1' || !perms.tasks) return;
    setPanel({ kind: 'new' });
    void navigate({
      to: '/o/$slug/tasks',
      params: { slug },
      search: withSearch(search, { new: undefined }),
      replace: true,
    });
  }, [search, perms.tasks, slug, navigate]);

  const hasProjectsModule = projectsInstalled();
  const projectsQuery = useQuery({
    ...orpc.projects.list.queryOptions({ input: {} }),
    enabled: hasProjectsModule,
    retry: (count, error) => !isModuleOff(error) && count < 1,
  });
  const taskIds = useMemo(() => (tasks.data ?? []).slice(0, PROJECT_TASK_MAP_LIMIT).map((task) => task.id), [tasks.data]);
  const taskProjectsQuery = useQuery({
    ...orpc.projects.taskProjects.queryOptions({ input: { taskIds } }),
    enabled: hasProjectsModule && !isModuleOff(projectsQuery.error) && taskIds.length > 0,
    retry: (count, error) => !isModuleOff(error) && count < 1,
  });
  const projectsActive = hasProjectsModule && !isModuleOff(projectsQuery.error) && !isModuleOff(taskProjectsQuery.error);
  const projectsListError = projectsActive ? projectsQuery.error : null;
  const taskProjectsError = projectsActive && taskIds.length > 0 ? taskProjectsQuery.error : null;
  const taskProjectsPending = projectsActive && taskIds.length > 0 && taskProjectsQuery.isPending;
  const projectByTask = useMemo(() => taskProjectMap(taskProjectsQuery.data ?? []), [taskProjectsQuery.data]);
  const projectOptions = useMemo(
    () => (projectsActive ? taskProjectOptions(projectsQuery.data?.projects ?? [], taskProjectsQuery.data ?? []) : []),
    [projectsActive, projectsQuery.data?.projects, taskProjectsQuery.data],
  );
  const projectFilter = projectsActive ? (search.project ?? '') : '';
  const projectFilterUnlisted = projectFilter !== '' && projectFilter !== 'none' && !projectOptions.some((p) => p.id === projectFilter);
  const setProjectFilter = (next: string) =>
    void navigate({
      to: '/o/$slug/tasks',
      params: { slug },
      search: withSearch(search, { project: next === '' ? undefined : (next as TasksSearch['project']) }),
    });
  const waitingProjectFilter = projectFilter !== '' && taskProjectsPending;
  const projectFilterError = projectFilter !== '' ? taskProjectsError : null;
  const visibleTasks = useMemo(
    () => (projectsActive ? filterTasksByProject(tasks.data ?? [], projectByTask, projectFilter) : (tasks.data ?? [])),
    [projectsActive, tasks.data, projectByTask, projectFilter],
  );

  // The keys of My work work here too (DESIGN.md 5.2): N a new task, J and K the next and previous row, E edit the selected one. They do nothing
  // while a field, the filter popover or the panel has the keyboard, and the hint at the foot of the list says so.
  const [selected, setSelected] = useState<string | null>(null);
  const order = useMemo(() => visibleTasks.map((task) => task.id), [visibleTasks]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = panel === null ? myWorkShortcut(event) : null;
      if (!action) return;
      if (action === 'new' && perms.tasks) {
        event.preventDefault();
        setPanel({ kind: 'new' });
      } else if (action === 'next' || action === 'previous') {
        event.preventDefault();
        const id = stepSelection(order, selected, action === 'next' ? 1 : -1);
        setSelected(id);
        if (id) document.querySelector(`[data-task-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (action === 'edit' && perms.tasks && selected && order.includes(selected)) {
        event.preventDefault();
        setPanel({ kind: 'edit', id: selected });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, perms.tasks, order, selected]);

  return (
    <div>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          perms.tasks ? (
            <Button type="button" data-testid="task-add" onClick={() => setPanel({ kind: 'new' })}>
              {t('addTask')}
            </Button>
          ) : undefined
        }
      />
      {panel?.kind === 'new' && perms.tasks && <NewTaskPanel chart={chart.data} onClose={() => setPanel(null)} />}
      {panel?.kind === 'edit' && perms.tasks && <EditTaskPanel taskId={panel.id} chart={chart.data} onClose={() => setPanel(null)} />}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter} onValueChange={(value) => setFilter(value as TaskFilter)}>
          <TabsList>
            <TabsTrigger value="open">{t('filterOpen')}</TabsTrigger>
            <TabsTrigger value="mine">{t('filterMine')}</TabsTrigger>
            <TabsTrigger value="all">{t('filterAll')}</TabsTrigger>
          </TabsList>
        </Tabs>
        {projectsActive && (
          <div className="flex min-w-44 items-center gap-2">
            <Label htmlFor="tasks-project-filter" className="sr-only">
              {t('projectFilter')}
            </Label>
            <NativeSelect
              id="tasks-project-filter"
              aria-label={t('projectFilter')}
              data-testid="tasks-project-filter"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="h-9 w-full text-xs sm:h-8"
            >
              <NativeSelectOption value="">{t('allProjects')}</NativeSelectOption>
              {projectFilterUnlisted && <NativeSelectOption value={projectFilter}>{t('selectedProject')}</NativeSelectOption>}
              {projectOptions.map((project) => (
                <NativeSelectOption key={project.id} value={project.id}>
                  {project.name}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value="none">{t('noProject')}</NativeSelectOption>
            </NativeSelect>
          </div>
        )}
      </div>
      <div className="mb-3 space-y-2">
        <ViewTabs scope="kernel.task" filters={filters} sort={sort} onApply={applyView} />
        <TaskFilterBar
          popover
          idPrefix="tasks-filter"
          bar={bar}
          setBar={setBar}
          sort={sort}
          setSort={setSort}
          positions={(chart.data?.positions ?? []).map((p) => ({ id: p.id, label: p.title }))}
        />
      </div>
      {tasks.isPending || waitingProjectFilter ? (
        <ListSkeleton />
      ) : tasks.error ? (
        <ErrorText>{errorMessage(tasks.error)}</ErrorText>
      ) : projectFilterError ? (
        <ErrorText>{errorMessage(projectFilterError)}</ErrorText>
      ) : tasks.data.length === 0 ? (
        <>
          {projectsListError && (
            <div className="mb-2">
              <ErrorText>{errorMessage(projectsListError)}</ErrorText>
            </div>
          )}
          <Empty title={t('empty')} hint={t(filter === 'mine' ? 'emptyMineHint' : perms.tasks ? 'emptyHint' : 'emptyHintReadOnly')} />
        </>
      ) : visibleTasks.length === 0 ? (
        <>
          {(projectsListError || taskProjectsError) && (
            <div className="mb-2 space-y-1">
              {projectsListError && <ErrorText>{errorMessage(projectsListError)}</ErrorText>}
              {taskProjectsError && <ErrorText>{errorMessage(taskProjectsError)}</ErrorText>}
            </div>
          )}
          {tasks.data.length >= TASK_LIST_LIMIT && <p className="mb-2 text-xs text-muted-foreground">{t('truncated', { count: String(TASK_LIST_LIMIT) })}</p>}
          <Empty title={t('emptyProjectFilter')} hint={t('emptyProjectFilterHint')} />
        </>
      ) : (
        <>
          {(projectsListError || taskProjectsError) && (
            <div className="mb-2 space-y-1">
              {projectsListError && <ErrorText>{errorMessage(projectsListError)}</ErrorText>}
              {taskProjectsError && <ErrorText>{errorMessage(taskProjectsError)}</ErrorText>}
            </div>
          )}
          {tasks.data.length >= TASK_LIST_LIMIT && <p className="mb-2 text-xs text-muted-foreground">{t('truncated', { count: String(TASK_LIST_LIMIT) })}</p>}
          <DataTable
            head={
              projectsActive
                ? [t('colTitle'), t('colProject'), t('colAssignee'), t('colStatus'), t('colCreated'), ...(perms.tasks ? [t('colActions')] : [])]
                : [t('colTitle'), t('colAssignee'), t('colStatus'), t('colCreated'), ...(perms.tasks ? [t('colActions')] : [])]
            }
          >
            {visibleTasks.map((task) => {
              const project = projectsActive ? projectByTask.get(task.id) : undefined;
              return (
                <TableRow key={task.id} data-testid="task-row" data-task-id={task.id} data-selected={selected === task.id ? 'true' : undefined} className={selected === task.id ? 'bg-muted/60' : undefined}>
                  <TableCell>
                    <Link to="/o/$slug/tasks/$id" params={{ slug, id: task.id }} className="font-medium text-link hover:underline">
                      {taskTitleText(task)}
                    </Link>
                    {(task.checklist?.length ?? 0) > 0 && (
                      <TaskChecklistBadge
                        steps={task.checklist ?? []}
                        className="ml-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground"
                      />
                    )}
                    {task.tainted && (
                      <Badge variant="warning" className="ml-2" title={t('taintedHint')}>
                        {t('tainted')}
                      </Badge>
                    )}
                  </TableCell>
                  {projectsActive && (
                    <TableCell data-testid="task-project-cell">
                      {project ? (
                        <Link
                          to="/o/$slug/projects/$id"
                          params={{ slug, id: project.id }}
                          data-testid="task-project-chip"
                          className="inline-flex max-w-44 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          <Badge variant="outline" className="max-w-full hover:bg-muted">
                            <span className="truncate">{project.name}</span>
                          </Badge>
                        </Link>
                      ) : taskProjectsPending || taskProjectsError ? (
                        <span className="text-xs text-subtle-foreground" aria-hidden="true">
                          ...
                        </span>
                      ) : (
                        <span className="text-xs text-subtle-foreground">-</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-sm text-muted-foreground">{positionTitle(chart.data, task.assigneePositionId, t('rootAssignee'), t('unknownPosition'))}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(task.status)}>{t(`status.${task.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">{f.dateTime(task.createdAt)}</TableCell>
                  {perms.tasks && (
                    <TableCell>
                      <Button type="button" variant="ghost" size="sm" aria-label={t('editRow', { title: taskTitleText(task) })} onClick={() => setPanel({ kind: 'edit', id: task.id })}>
                        {t('edit')}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </DataTable>
        </>
      )}
      <p className="mt-4 text-xs text-subtle-foreground" data-testid="tasks-shortcuts">
        {t(perms.tasks ? 'shortcuts' : 'shortcutsReadOnly')}
      </p>
    </div>
  );
}

export function TaskDetailPage() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const t = useTranslations('tasks');
  const ta = useTranslations('agents');
  const tn = useTranslations('notes');
  const tp = useTranslations('projects');
  const f = useFormat();
  const org = useQuery(orpc.org.get.queryOptions());
  const chart = useQuery(orpc.chart.get.queryOptions());
  const detail = useQuery(orpc.tasks.get.queryOptions({ input: { id } }));
  const recurrenceQuery = useQuery({
    ...orpc.projects.getTaskRecurrence.queryOptions({ input: { taskId: id } }),
    enabled: projectsInstalled(),
    retry: false,
  });
  const taskProjectsQuery = useQuery({
    ...orpc.projects.taskProjects.queryOptions({ input: { taskIds: [id] } }),
    enabled: projectsInstalled(),
    retry: false,
  });
  const resolvedProjectId =
    taskProjectsQuery.data?.[0]?.project.id ?? recurrenceQuery.data?.projectId ?? null;
  const depsQuery = useQuery({
    ...orpc.projects.listDependencies.queryOptions({ input: { projectId: resolvedProjectId ?? '', taskId: id } }),
    enabled: projectsInstalled() && resolvedProjectId !== null,
    retry: false,
  });
  const openBlockerCount = useMemo(
    () => splitTaskDependencies(depsQuery.data?.edges ?? [], id).openBlockerCount,
    [depsQuery.data?.edges, id],
  );
  const perms = agentPermissions(org.data?.role);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const editing = editingTaskId === id;
  const [pendingBlockedStatus, setPendingBlockedStatus] = useState<TaskStatus | null>(null);
  const [body, setBody] = useState('');
  const [commentKey, setCommentKey] = useState(() => crypto.randomUUID());
  const comment = useMutation(orpc.tasks.comment.mutationOptions({ onSuccess: refresh }));
  const setStatus = useMutation(orpc.tasks.setStatus.mutationOptions({ onSuccess: refresh }));

  const back = (
    <Link to="/o/$slug/tasks" params={{ slug }} className="text-sm text-link hover:underline">
      {t('back')}
    </Link>
  );
  if (detail.isPending) {
    return (
      <div className="space-y-3">
        {back}
        <PageSkeleton body="list" />
      </div>
    );
  }
  if (detail.error) {
    return (
      <div className="space-y-3">
        {back}
        <ErrorText>{errorMessage(detail.error)}</ErrorText>
      </div>
    );
  }
  const { task, comments, proposal } = detail.data;
  const projectRecurrence = recurrenceQuery.data ?? null;
  const postId = socialPostOf(task.sourceRef);
  const meetingItemId = meetingItemOf(task.sourceRef);
  const directMeetingId = meetingSourceOf(task.sourceRef);
  const conversationId = conversationOf(task.sourceRef);
  const members = org.data?.members ?? [];
  const authorName = (c: (typeof comments)[number]) =>
    c.authorType === 'agent'
      ? t('author.agent')
      : c.authorType === 'user'
        ? (members.find((m) => m.userId === c.authorId)?.displayName ?? members.find((m) => m.userId === c.authorId)?.email ?? t('author.user'))
        : t('author.system');

  return (
    <div className="space-y-6">
      <div>{back}</div>
      <PageHeader
        title={taskTitleText(task)}
        subtitle={positionTitle(chart.data, task.assigneePositionId, t('rootAssignee'), t('unknownPosition'))}
        actions={
          perms.tasks ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={task.checkedOut}
              title={task.checkedOut ? t('checkedOut') : undefined}
              onClick={() => setEditingTaskId(task.id)}
            >
              {t('edit')}
            </Button>
          ) : undefined
        }
      />
      {editing && perms.tasks && <EditTaskPanel key={task.id} taskId={task.id} chart={chart.data} onClose={() => setEditingTaskId(null)} />}
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant(task.status)}>{t(`status.${task.status}`)}</Badge>
          {task.tainted && <Badge variant="warning">{t('tainted')}</Badge>}
          {task.checkedOut && <Badge variant="secondary">{t('checkedOut')}</Badge>}
          {task.due && (
            <Badge variant="outline">
              {t('dueLabel')}: {f.date(task.due)}
            </Badge>
          )}
          <TaskChecklistBadge steps={task.checklist ?? []} />
          {projectRecurrence?.recurrence && (
            <Badge variant="outline" className="gap-1" data-testid="task-recurrence-badge">
              <ProjectIcon name="repeat" className="size-3" />
              <span>{formatRecurrenceBadgeLabel(projectRecurrence.recurrence, tp)}</span>
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">{f.dateTime(task.createdAt)}</span>
        </div>
        {task.tainted && <p className="text-sm text-warning">{t('taintedHint')}</p>}
        <div>
          <p className="text-xs text-subtle-foreground">{t('description')}</p>
          <p className="text-sm whitespace-pre-wrap text-foreground">{task.description ?? t('noDescription')}</p>
        </div>
        <TaskChecklistSection key={task.id} taskId={task.id} checklist={task.checklist ?? []} revision={task.revision} checkedOut={task.checkedOut} readOnly={!perms.tasks || editing} />
        {proposal && (
          <p className="text-sm text-muted-foreground">
            {t('proposal', { title: proposal.title })}{' '}
            <Link to="/o/$slug/inbox/$id" params={{ slug, id: proposal.id }} className="text-link underline">
              {t('openProposal')}
            </Link>
          </p>
        )}
        {/* Handed over from a member's own to-do (#1674), which stays theirs alone. */}
        {fromTodo(task.sourceRef) && <p className="text-sm text-muted-foreground">{t('fromTodo')}</p>}
        {/* A Social post's task (#1193) says only counts: the post page has the rest, and answers 404 to a member who
            may not see the post. */}
        {postId && (
          <p className="text-sm">
            <Link to="/o/$slug/social/$id" params={{ slug, id: postId }} className="text-link underline">
              {t('openPost')}
            </Link>
          </p>
        )}
        {meetingItemId && <MeetingLink itemId={meetingItemId} slug={slug} />}
        {directMeetingId && <DirectMeetingLink meetingId={directMeetingId} slug={slug} />}
        {conversationId && <TaskConversationLink conversationId={conversationId} slug={slug} />}
        {perms.tasks && (
          <label className="block w-56 text-xs">
            <span className="text-subtle-foreground">{t('setStatus')}</span>
            <NativeSelect
              className="mt-1 w-full"
              value={task.status}
              disabled={setStatus.isPending}
              onChange={(e) => {
                const nextStatus = e.target.value as TaskStatus;
                if (shouldConfirmBlockedStatusMove(task.status, nextStatus, openBlockerCount)) {
                  setPendingBlockedStatus(nextStatus);
                  return;
                }
                setStatus.mutate({ id: task.id, status: nextStatus, idempotencyKey: crypto.randomUUID() });
              }}
            >
              {TASK_STATUSES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {t(`status.${s}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        )}
        {setStatus.error && <ErrorText>{errorMessage(setStatus.error)}</ErrorText>}
      </Card>

      {pendingBlockedStatus && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingBlockedStatus(null);
          }}
          title={tp('dependencies.moveBlockedTitle')}
          description={tp('dependencies.moveBlockedDesc', {
            title: task.title,
            count: openBlockerCount,
          })}
          confirm={tp('dependencies.moveBlockedConfirm')}
          onConfirm={() => {
            setStatus.mutate({ id: task.id, status: pendingBlockedStatus, idempotencyKey: crypto.randomUUID() });
            setPendingBlockedStatus(null);
          }}
        />
      )}

      {resolvedProjectId && (
        <>
          <ProjectDependencies
            projectId={resolvedProjectId}
            taskId={task.id}
            canWrite={perms.tasks && !task.checkedOut}
            onChanged={refresh}
          />
          <TaskTimeTrackingPanel
            projectId={resolvedProjectId}
            taskId={task.id}
            taskTitle={task.title}
            canWrite={perms.tasks && !task.checkedOut}
          />
        </>
      )}

      {projectRecurrence && (
        <TaskRecurrenceControl
          projectId={projectRecurrence.projectId}
          taskId={task.id}
          canEdit={perms.tasks && !task.checkedOut}
          view={projectRecurrence}
          onUpdated={refresh}
        />
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">{t('comments')}</h2>
        {comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noComments')}</p>
        ) : (
          <ul className="space-y-2">
            {comments.map((c) => (
              <li key={c.id}>
                <Card className="gap-1 p-3" data-testid="comment">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                    <span className="font-medium text-foreground">{authorName(c)}</span>
                    {c.authorType === 'agent' && <Badge variant="secondary">{ta('aiBadge')}</Badge>}
                    {c.tainted && <Badge variant="warning">{t('tainted')}</Badge>}
                    <span>{f.dateTime(c.createdAt)}</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap text-foreground">{c.body}</p>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {perms.tasks && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!body.trim()) return;
              comment.mutate(
                { id: task.id, body: body.trim(), idempotencyKey: commentKey },
                {
                  onSuccess: () => {
                    setBody('');
                    setCommentKey(crypto.randomUUID());
                  },
                },
              );
            }}
          >
            <Input maxLength={10000} placeholder={t('commentPlaceholder')} aria-label={t('commentPlaceholder')} value={body} onChange={(e) => setBody(e.target.value)} />
            <Button type="submit" disabled={comment.isPending || !body.trim()}>
              {t('send')}
            </Button>
          </form>
        )}
        {comment.error && (
          <div className="mt-2">
            <ErrorText>{errorMessage(comment.error)}</ErrorText>
          </div>
        )}
      </section>
      {notesInstalled() && (
        <RecordNotesPanel
          slug={slug}
          target={{ targetType: 'kernel.task', targetId: task.id }}
          headingId={`notes-task-${task.id}`}
          label={tn('panel.toggleOf', { name: taskTitleText(task) })}
          empty={tn('panel.emptyRecord')}
        />
      )}
    </div>
  );
}

// The meeting a task came from (#2580). Only a reader of the meeting is told where it is; anyone else, and the days after the meeting's text is erased, read
// "the record cannot be opened": the same answer for an unknown item, so the task reveals nothing of the meeting.
function MeetingLink({ itemId, slug }: { itemId: string; slug: string }) {
  const t = useTranslations('tasks');
  const source = useQuery({ ...orpc.meetings.actionItems.source.queryOptions({ input: { itemId } }), retry: false });
  if (source.isPending) return null;
  if (source.error) return <p className="text-sm text-muted-foreground">{t('meetingClosed')}</p>;
  return (
    <p className="text-sm">
      <Link to="/o/$slug/meetings/$id" params={{ slug, id: source.data.meetingId }} className="text-link underline">
        {t('openMeeting')}
      </Link>
    </p>
  );
}

/** Provenance link for tasks proposed directly from a meeting (#2608): opens /meetings/$id only when readable; neutral fallback otherwise. */
export function DirectMeetingLink({ meetingId, slug }: { meetingId: string; slug: string }) {
  const t = useTranslations('tasks');
  const installed = meetingsInstalled();
  const detail = useQuery({ ...orpc.meetings.get.queryOptions({ input: { meetingId } }), enabled: installed, retry: false });
  if (!installed) return <p className="text-sm text-muted-foreground" data-testid="task-provenance-closed">{t('meetingClosed')}</p>;
  if (detail.isPending) return null;
  if (detail.error) return <p className="text-sm text-muted-foreground" data-testid="task-provenance-closed">{t('meetingClosed')}</p>;
  const title = detail.data.title.trim();
  return (
    <p className="text-sm" data-testid="task-provenance-meeting">
      <Link to="/o/$slug/meetings/$id" params={{ slug, id: meetingId }} className="text-link underline">
        {title ? t('openMeetingNamed', { title }) : t('openMeeting')}
      </Link>
    </p>
  );
}
