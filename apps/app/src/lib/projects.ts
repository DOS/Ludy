// SPDX-License-Identifier: AGPL-3.0-only
// Client-side ordering, filtering and view helpers for Projects (issue #2591, ADR-0048, plan §9 P2).
import type {
  FilterAst,
  ProjectBoard,
  ProjectStatus,
  ProjectSummary,
  ProjectTaskCard,
  ProjectTaskProjectEntry,
  ProjectTaskRef,
} from '@crove/kernel-contract';
import type { TaskStatus } from './agents.ts';
import { getConfig } from './auth.ts';

export const projectsInstalled = (): boolean => getConfig().modules.includes('projects');

export const PROJECT_WEEKLY_STATUS_QUERY_PREFIX = ['projects', 'weeklyStatus'] as const;

export function projectWeeklyStatusQueryKey(
  slug: string,
  projectId: string,
  language: 'vi' | 'en',
): readonly ['projects', 'weeklyStatus', string, string, 'vi' | 'en'] {
  return [...PROJECT_WEEKLY_STATUS_QUERY_PREFIX, slug, projectId, language];
}

export const PROJECT_BOARD_COLUMNS = ['todo', 'in_progress', 'waiting', 'in_review', 'done'] as const;
export const PROJECT_STATUSES = ['active', 'on_hold', 'done', 'archived'] as const;
export const PHONE_BREAKPOINT_PX = 768;

export type ProjectViewMode = 'board' | 'list';
export type ProjectStatusFilter = 'open' | ProjectStatus | 'all';

export function defaultProjectView(width: number): ProjectViewMode {
  return width < PHONE_BREAKPOINT_PX ? 'list' : 'board';
}

export function boardColumns(includeCancelled: boolean): readonly TaskStatus[] {
  return includeCancelled ? [...PROJECT_BOARD_COLUMNS, 'cancelled'] : PROJECT_BOARD_COLUMNS;
}

export function compareBoardTasks(
  a: Pick<ProjectTaskCard, 'due' | 'createdAt' | 'id'>,
  b: Pick<ProjectTaskCard, 'due' | 'createdAt' | 'id'>,
): number {
  if (a.due !== b.due) {
    if (a.due === null) return 1;
    if (b.due === null) return -1;
    const diff = Date.parse(a.due) - Date.parse(b.due);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
  }
  const createdDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (createdDiff !== 0 && !Number.isNaN(createdDiff)) return createdDiff;
  return a.id.localeCompare(b.id);
}

export function sortBoardTasks<T extends Pick<ProjectTaskCard, 'due' | 'createdAt' | 'id'>>(tasks: readonly T[]): T[] {
  return [...tasks].sort(compareBoardTasks);
}

export interface TaskPlacement {
  place: 'before' | 'after';
  anchorId: string;
}

export function groupBoardTasks(tasks: readonly ProjectTaskCard[], includeCancelled: boolean): Record<TaskStatus, ProjectTaskCard[]> {
  const columns: Record<TaskStatus, ProjectTaskCard[]> = {
    todo: [],
    in_progress: [],
    waiting: [],
    in_review: [],
    done: [],
    cancelled: [],
  };
  for (const task of tasks) {
    if (task.status === 'cancelled' && !includeCancelled) continue;
    columns[task.status].push(task);
  }
  return columns;
}

export function optimisticReorderTask(
  tasks: readonly ProjectTaskCard[],
  taskId: string,
  placement: TaskPlacement,
): ProjectTaskCard[] {
  if (taskId === placement.anchorId) return [...tasks];
  const moving = tasks.find((t) => t.id === taskId);
  if (!moving) return [...tasks];
  const without = tasks.filter((t) => t.id !== taskId);
  const anchorIndex = without.findIndex((t) => t.id === placement.anchorId);
  if (anchorIndex < 0) return [...tasks];
  const insertAt = placement.place === 'before' ? anchorIndex : anchorIndex + 1;
  without.splice(insertAt, 0, moving);
  return without;
}

export function optimisticMoveTask(
  tasks: readonly ProjectTaskCard[],
  taskId: string,
  nextStatus: TaskStatus,
  placement?: TaskPlacement,
): ProjectTaskCard[] {
  const moved = tasks.map((task) => (task.id === taskId ? { ...task, status: nextStatus } : task));
  return placement ? optimisticReorderTask(moved, taskId, placement) : moved;
}

export function statusFilterIncludesCancelled(ast: FilterAst): boolean {
  return ast.all.some(
    (c) =>
      c.field === 'status' &&
      ((c.op === 'is' && c.value === 'cancelled') ||
        (c.op === 'in' && Array.isArray(c.value) && c.value.includes('cancelled'))),
  );
}

export function isTaskOverdue(task: Pick<ProjectTaskCard, 'due' | 'status'>, nowMs = Date.now()): boolean {
  if (task.due === null || task.status === 'done' || task.status === 'cancelled') return false;
  const dueMs = Date.parse(task.due);
  return !Number.isNaN(dueMs) && dueMs < nowMs;
}

export function projectCompletionPct(openTaskCount: number, doneTaskCount: number): number {
  const total = openTaskCount + doneTaskCount;
  if (total <= 0) return 0;
  return Math.round((doneTaskCount / total) * 100);
}

export function hasUnseatedTeamMembers(board: Pick<ProjectBoard, 'isTeamOrg' | 'viewerHasSeat' | 'members' | 'seats'>): boolean {
  if (!board.isTeamOrg) return false;
  if (!board.viewerHasSeat) return true;
  const seatedUserIds = new Set(
    board.seats.map((seat) => (seat.holder?.type === 'user' ? seat.holder.userId : null)).filter((id): id is string => id !== null),
  );
  return board.members.some((member) => member.role !== 'viewer' && !seatedUserIds.has(member.userId));
}

export function filterProjects<T extends Pick<ProjectSummary, 'name' | 'description' | 'ownerName'>>(
  projects: readonly T[],
  rawQuery: string,
): T[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter(
    (project) =>
      project.name.toLowerCase().includes(q) ||
      (project.description ?? '').toLowerCase().includes(q) ||
      (project.ownerName ?? '').toLowerCase().includes(q),
  );
}

export function projectStatusVariant(status: ProjectStatus): 'brand' | 'warning' | 'success' | 'outline' {
  if (status === 'active') return 'brand';
  if (status === 'on_hold') return 'warning';
  if (status === 'done') return 'success';
  return 'outline';
}

export function taskStatusVariant(status: TaskStatus): 'brand' | 'success' | 'warning' | 'outline' | 'secondary' {
  if (status === 'in_progress') return 'brand';
  if (status === 'done') return 'success';
  if (status === 'waiting' || status === 'in_review') return 'warning';
  if (status === 'cancelled') return 'outline';
  return 'secondary';
}

export function taskProjectMap(entries: readonly ProjectTaskProjectEntry[]): Map<string, ProjectTaskRef> {
  return new Map(entries.map((entry) => [entry.taskId, entry.project]));
}

export function taskProjectOptions(
  projects: readonly Pick<ProjectSummary, 'id' | 'name'>[],
  entries: readonly ProjectTaskProjectEntry[],
): ProjectTaskRef[] {
  const byId = new Map<string, string>();
  for (const p of projects) {
    if (!byId.has(p.id)) byId.set(p.id, p.name);
  }
  for (const entry of entries) {
    if (!byId.has(entry.project.id)) byId.set(entry.project.id, entry.project.name);
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function filterTasksByProject<T extends { id: string }>(
  tasks: readonly T[],
  projectByTask: ReadonlyMap<string, ProjectTaskRef>,
  projectFilter: string,
): T[] {
  if (!projectFilter) return [...tasks];
  if (projectFilter === 'none') return tasks.filter((task) => !projectByTask.has(task.id));
  return tasks.filter((task) => projectByTask.get(task.id)?.id === projectFilter);
}

// Reuse cached board placeholder only within the same project so route transitions show the skeleton immediately (#2610).
export function boardPlaceholderForProject(previous: ProjectBoard | undefined, projectId: string): ProjectBoard | undefined {
  return previous?.project.id === projectId ? previous : undefined;
}

export interface BoardBatchState<TKey> {
  queryKey: TKey;
  pending: number;
  anySucceeded: boolean;
  rollback: ProjectBoard | undefined;
}

export interface BoardBatchEntry<TKey> {
  keyHash: string;
  state: BoardBatchState<TKey>;
}

/** Tracks optimistic rollback snapshots per serialized queryKey across queued board mutations (#2610). */
export function createBoardBatchTracker<TKey>() {
  const batches = new Map<string, BoardBatchState<TKey>>();
  let totalPending = 0;

  return {
    begin(keyHash: string, queryKey: TKey, snapshot: ProjectBoard | undefined): BoardBatchEntry<TKey> {
      let state = batches.get(keyHash);
      if (!state) {
        state = { queryKey, pending: 0, anySucceeded: false, rollback: snapshot };
        batches.set(keyHash, state);
      }
      state.pending += 1;
      totalPending += 1;
      return { keyHash, state };
    },
    markSucceeded(entry: BoardBatchEntry<TKey>): void {
      entry.state.anySucceeded = true;
    },
    // Restore the pre-batch snapshot only when the last pending call on this key failed and nothing in the batch succeeded.
    rollbackOnFailure(entry: BoardBatchEntry<TKey>): ProjectBoard | undefined {
      if (entry.state.pending === 1 && !entry.state.anySucceeded) {
        return entry.state.rollback;
      }
      return undefined;
    },
    finish(entry: BoardBatchEntry<TKey>): { queryDrained: boolean } {
      entry.state.pending -= 1;
      totalPending -= 1;
      if (entry.state.pending <= 0) {
        batches.delete(entry.keyHash);
      }
      return { queryDrained: totalPending <= 0 };
    },
  };
}

export interface BoardOrderClient {
  setTaskStatus: (input: { id: string; status: TaskStatus; idempotencyKey: string }) => Promise<unknown>;
  reorderTask: (input: {
    projectId: string;
    taskId: string;
    place: TaskPlacement['place'];
    anchorId: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
}

/**
 * Runs a cross-column board drop, recording server commitment immediately after `setTaskStatus`
 * so a subsequent `reorderTask` failure does not roll the card back to its old status (#2610).
 */
export async function commitBoardStatusMove(
  orgClient: BoardOrderClient,
  input: { projectId: string; taskId: string; nextStatus: TaskStatus; placement?: TaskPlacement | undefined },
  markCommitted: () => void,
  createKey: () => string = () => crypto.randomUUID(),
): Promise<void> {
  await orgClient.setTaskStatus({ id: input.taskId, status: input.nextStatus, idempotencyKey: createKey() });
  markCommitted();
  if (input.placement) {
    await orgClient.reorderTask({
      projectId: input.projectId,
      taskId: input.taskId,
      place: input.placement.place,
      anchorId: input.placement.anchorId,
      idempotencyKey: createKey(),
    });
  }
}

/** Serializes optimistic board mutations while binding each queued step to the slug that queued it (#2610). */
export function createBoardMutationQueue() {
  let queue: Promise<void> = Promise.resolve();
  const tracker = createBoardBatchTracker<readonly unknown[]>();

  return {
    enqueue(opts: {
      slug: string;
      projectId: string;
      queryKey: readonly unknown[];
      keyHash: string;
      clientForOrg: (slug: string) => BoardOrderClient;
      getBoard: (key: readonly unknown[]) => ProjectBoard | undefined;
      setBoard: (key: readonly unknown[], board: ProjectBoard) => void;
      cancelQueries: (key: readonly unknown[]) => void;
      refreshQueries: () => void;
      isActiveContext: (slug: string, projectId: string) => boolean;
      onStart?: () => void;
      onError: (err: unknown) => void;
      optimisticUpdate: (items: readonly ProjectTaskCard[]) => ProjectTaskCard[];
      mutationFn: (orgClient: BoardOrderClient, markCommitted: () => void) => Promise<void>;
    }): Promise<void> {
      opts.onStart?.();
      const snapshot = opts.getBoard(opts.queryKey);
      const entry = tracker.begin(opts.keyHash, opts.queryKey, snapshot);
      opts.cancelQueries(opts.queryKey);
      if (snapshot) {
        opts.setBoard(opts.queryKey, {
          ...snapshot,
          tasks: opts.optimisticUpdate(snapshot.tasks),
        });
      }
      queue = queue
        .catch(() => undefined)
        .then(async () => {
          const orgClient = opts.clientForOrg(opts.slug);
          try {
            await opts.mutationFn(orgClient, () => tracker.markSucceeded(entry));
            tracker.markSucceeded(entry);
          } catch (err) {
            const rollback = tracker.rollbackOnFailure(entry);
            if (rollback) {
              opts.setBoard(entry.state.queryKey, rollback);
            }
            if (opts.isActiveContext(opts.slug, opts.projectId)) {
              opts.onError(err);
            }
          } finally {
            const { queryDrained } = tracker.finish(entry);
            if (queryDrained) {
              opts.refreshQueries();
            }
          }
        });
      return queue;
    },
  };
}
