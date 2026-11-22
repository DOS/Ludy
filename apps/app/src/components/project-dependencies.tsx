// SPDX-License-Identifier: AGPL-3.0-only
// Project task dependencies editor & list (issue #2601, isolated from crove_kernel.task.parent_task_id).
import type { ProjectDependencyEdge } from '@ludy/kernel-contract';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

export type DependencyDirection = 'blocked_by' | 'blocking';

export interface ProjectDependencyTaskOption {
  id: string;
  title: string;
  status: string;
}

export function isOpenDependencyStatus(status: string): boolean {
  return status !== 'done' && status !== 'cancelled';
}

export function shouldConfirmBlockedStatusMove(
  currentStatus: string,
  nextStatus: string,
  openBlockerCount: number,
): boolean {
  return (nextStatus === 'in_progress' || nextStatus === 'done') && currentStatus !== nextStatus && openBlockerCount > 0;
}

export function splitTaskDependencies(edges: readonly ProjectDependencyEdge[], taskId: string): {
  blockedBy: ProjectDependencyEdge[];
  blocking: ProjectDependencyEdge[];
  openBlockerCount: number;
} {
  const blockedBy: ProjectDependencyEdge[] = [];
  const blocking: ProjectDependencyEdge[] = [];
  let openBlockerCount = 0;

  for (const edge of edges) {
    if (edge.blockedTaskId === taskId) {
      blockedBy.push(edge);
      if (isOpenDependencyStatus(edge.blocker.status)) {
        openBlockerCount++;
      }
    } else if (edge.blockerTaskId === taskId) {
      blocking.push(edge);
    }
  }

  return { blockedBy, blocking, openBlockerCount };
}

export function availableDependencyCandidates(
  projectTasks: readonly ProjectDependencyTaskOption[],
  edges: readonly ProjectDependencyEdge[],
  taskId: string,
  direction: DependencyDirection,
): ProjectDependencyTaskOption[] {
  const blockedBySet = new Set<string>();
  const blockingSet = new Set<string>();
  for (const edge of edges) {
    if (edge.blockedTaskId === taskId) blockedBySet.add(edge.blockerTaskId);
    if (edge.blockerTaskId === taskId) blockingSet.add(edge.blockedTaskId);
  }
  return projectTasks.filter((candidate) => {
    if (candidate.id === taskId) return false;
    return direction === 'blocked_by' ? !blockedBySet.has(candidate.id) : !blockingSet.has(candidate.id);
  });
}

export function ProjectDependenciesPanel({
  taskId,
  edges,
  projectTasks,
  canWrite,
  loading = false,
  busy = false,
  error = null,
  onAdd,
  onRemove,
}: {
  taskId: string;
  edges: readonly ProjectDependencyEdge[];
  projectTasks: readonly ProjectDependencyTaskOption[];
  canWrite: boolean;
  loading?: boolean;
  busy?: boolean;
  error?: unknown;
  onAdd: (direction: DependencyDirection, otherTaskId: string) => void;
  onRemove: (dependencyId: string) => void;
}) {
  const t = useTranslations('projects.dependencies');
  const directionId = useId();
  const pickerId = useId();

  const [direction, setDirection] = useState<DependencyDirection>('blocked_by');
  const [selectedTaskId, setSelectedTaskId] = useState('');

  const { blockedBy, blocking } = useMemo(() => splitTaskDependencies(edges, taskId), [edges, taskId]);
  const candidates = useMemo(
    () => availableDependencyCandidates(projectTasks, edges, taskId, direction),
    [projectTasks, edges, taskId, direction],
  );
  const effectiveSelectedId = candidates.some((c) => c.id === selectedTaskId) ? selectedTaskId : '';

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canWrite || busy || !effectiveSelectedId) return;
    onAdd(direction, effectiveSelectedId);
    setSelectedTaskId('');
  };

  return (
    <section
      aria-label={t('title')}
      className="space-y-3 rounded-lg border border-border bg-muted/20 p-3"
      data-testid="project-dependencies-section"
    >
      <div className="space-y-0.5">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <ProjectIcon name="link" className="size-4 text-muted-foreground" />
          <span>{t('title')}</span>
        </h3>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">...</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5" data-testid="project-dependencies-blocked-by">
            <p className="text-xs font-medium text-muted-foreground">{t('blockedByLabel')}</p>
            {blockedBy.length === 0 ? (
              <p className="text-xs text-subtle-foreground">{t('noneBlockedBy')}</p>
            ) : (
              <ul className="space-y-1.5">
                {blockedBy.map((edge) => {
                  const open = isOpenDependencyStatus(edge.blocker.status);
                  return (
                    <li
                      key={edge.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs"
                      data-testid="dependency-blocked-by-item"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="truncate font-medium text-foreground">{edge.blocker.title}</p>
                        <Badge variant={open ? 'warning' : 'success'} className="h-5 px-1.5 text-[11px]">
                          {t(open ? 'openBadge' : 'resolvedBadge')}
                        </Badge>
                      </div>
                      {canWrite && (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => onRemove(edge.id)}
                          aria-label={t('removeBtn', { title: edge.blocker.title })}
                          className="min-h-11 min-w-11 shrink-0"
                          data-testid="remove-dependency-btn"
                        >
                          <ProjectIcon name="remove" className="size-4" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="space-y-1.5" data-testid="project-dependencies-blocking">
            <p className="text-xs font-medium text-muted-foreground">{t('blockingLabel')}</p>
            {blocking.length === 0 ? (
              <p className="text-xs text-subtle-foreground">{t('noneBlocking')}</p>
            ) : (
              <ul className="space-y-1.5">
                {blocking.map((edge) => {
                  const open = isOpenDependencyStatus(edge.blocked.status);
                  return (
                    <li
                      key={edge.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs"
                      data-testid="dependency-blocking-item"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="truncate font-medium text-foreground">{edge.blocked.title}</p>
                        <Badge variant={open ? 'secondary' : 'success'} className="h-5 px-1.5 text-[11px]">
                          {t(open ? 'openBadge' : 'resolvedBadge')}
                        </Badge>
                      </div>
                      {canWrite && (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => onRemove(edge.id)}
                          aria-label={t('removeBtn', { title: edge.blocked.title })}
                          className="min-h-11 min-w-11 shrink-0"
                          data-testid="remove-dependency-btn"
                        >
                          <ProjectIcon name="remove" className="size-4" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {canWrite && (
        <form onSubmit={handleSubmit} className="space-y-2 border-t border-border pt-2.5">
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('noCandidates')}</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-end">
              <div className="space-y-1">
                <Label htmlFor={directionId} className="text-xs">
                  {t('addDirectionLabel')}
                </Label>
                <NativeSelect
                  id={directionId}
                  value={direction}
                  disabled={busy}
                  onChange={(e) => {
                    setDirection(e.target.value as DependencyDirection);
                    setSelectedTaskId('');
                  }}
                  className="w-full [&_select]:min-h-11 [&_select]:text-xs"
                  data-testid="dependency-direction-select"
                >
                  <NativeSelectOption value="blocked_by">{t('addDirectionBlockedBy')}</NativeSelectOption>
                  <NativeSelectOption value="blocking">{t('addDirectionBlocking')}</NativeSelectOption>
                </NativeSelect>
              </div>

              <div className="space-y-1">
                <Label htmlFor={pickerId} className="text-xs">
                  {t('pickTaskLabel')}
                </Label>
                <NativeSelect
                  id={pickerId}
                  value={effectiveSelectedId}
                  disabled={busy}
                  onChange={(e) => setSelectedTaskId(e.target.value)}
                  className="w-full [&_select]:min-h-11 [&_select]:text-xs"
                  data-testid="dependency-task-select"
                >
                  <NativeSelectOption value="">{t('pickTaskPlaceholder')}</NativeSelectOption>
                  {candidates.map((candidate) => (
                    <NativeSelectOption key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>

              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={busy || !effectiveSelectedId}
                loading={busy}
                className="min-h-11"
                data-testid="add-dependency-btn"
              >
                {busy ? t('adding') : t('addBtn')}
              </Button>
            </div>
          )}
        </form>
      )}

      {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}
    </section>
  );
}

export function ProjectDependencies({
  projectId,
  taskId,
  canWrite,
  projectTasks,
  onChanged,
}: {
  projectId: string;
  taskId: string;
  canWrite: boolean;
  projectTasks?: readonly ProjectDependencyTaskOption[] | undefined;
  onChanged?: (() => void) | undefined;
}) {
  const addAttemptRef = useRef<{ sig: string; key: string } | null>(null);
  const removeAttemptRef = useRef<{ sig: string; key: string } | null>(null);

  const depsQuery = useQuery({
    ...orpc.projects.listDependencies.queryOptions({ input: { projectId, taskId } }),
    retry: false,
  });

  const boardQuery = useQuery({
    ...orpc.projects.board.queryOptions({ input: { projectId } }),
    enabled: canWrite && projectTasks === undefined,
    retry: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.projects.key() });
    onChanged?.();
  };

  const addMutation = useMutation(
    orpc.projects.addDependency.mutationOptions({
      onSuccess: () => {
        addAttemptRef.current = null;
        invalidate();
      },
    }),
  );

  const removeMutation = useMutation(
    orpc.projects.removeDependency.mutationOptions({
      onSuccess: () => {
        removeAttemptRef.current = null;
        invalidate();
      },
    }),
  );

  const tasks = projectTasks ?? boardQuery.data?.tasks ?? [];

  return (
    <ProjectDependenciesPanel
      taskId={taskId}
      edges={depsQuery.data?.edges ?? []}
      projectTasks={tasks}
      canWrite={canWrite}
      loading={depsQuery.isPending}
      busy={addMutation.isPending || removeMutation.isPending}
      error={depsQuery.error ?? addMutation.error ?? removeMutation.error}
      onAdd={(direction, otherTaskId) => {
        removeMutation.reset();
        const sig = `${direction}:${otherTaskId}`;
        const key = addAttemptRef.current?.sig === sig ? addAttemptRef.current.key : crypto.randomUUID();
        addAttemptRef.current = { sig, key };
        addMutation.mutate({
          projectId,
          blockerTaskId: direction === 'blocked_by' ? otherTaskId : taskId,
          blockedTaskId: direction === 'blocked_by' ? taskId : otherTaskId,
          idempotencyKey: key,
        });
      }}
      onRemove={(dependencyId) => {
        addMutation.reset();
        const key = removeAttemptRef.current?.sig === dependencyId ? removeAttemptRef.current.key : crypto.randomUUID();
        removeAttemptRef.current = { sig: dependencyId, key };
        removeMutation.mutate({
          projectId,
          dependencyId,
          idempotencyKey: key,
        });
      }}
    />
  );
}
