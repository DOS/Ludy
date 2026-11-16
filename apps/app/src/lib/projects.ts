// SPDX-License-Identifier: AGPL-3.0-only
// Client-side ordering, filtering and view helpers for Projects (issue #2591, ADR-0048, plan §9 P2).
import type {
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

export function groupBoardTasks(tasks: readonly ProjectTaskCard[], includeCancelled: boolean): Record<TaskStatus, ProjectTaskCard[]> {
  const columns: Record<TaskStatus, ProjectTaskCard[]> = {
    todo: [],
    in_progress: [],
    waiting: [],
    in_review: [],
    done: [],
    cancelled: [],
  };
  for (const task of sortBoardTasks(tasks)) {
    if (task.status === 'cancelled' && !includeCancelled) continue;
    columns[task.status].push(task);
  }
  return columns;
}

export function optimisticMoveTask(tasks: readonly ProjectTaskCard[], taskId: string, nextStatus: TaskStatus): ProjectTaskCard[] {
  return sortBoardTasks(tasks.map((task) => (task.id === taskId ? { ...task, status: nextStatus } : task)));
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
