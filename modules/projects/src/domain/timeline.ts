// SPDX-License-Identifier: AGPL-3.0-only
// Pure deterministic timeline schedule helpers (#2599): date-range validation, dependency conflict detection,
// and longest open dependency chain (critical path) computation. Zero database, runtime, or React dependencies.
import {
  vietnamDate,
  type ProjectTimelineConflict,
  type ProjectTimelineEdge,
  type ProjectTimelineTask,
} from '@ludy/kernel-contract';

type TaskStatus = ProjectTimelineTask['status'];

const DAY_MS = 86_400_000;

export interface TimelineScheduleTask {
  id: string;
  status: TaskStatus;
  startOn: string | null;
  due: string | null;
}

export interface TimelineEdgeRef {
  id: string;
  blockerTaskId: string;
  blockedTaskId: string;
}

export interface CriticalPathResult {
  criticalPathTaskIds: string[];
  criticalPathLength: number;
  criticalPathSpanDays: number;
}

function parseLocalDateParts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y ?? 2000, m ?? 1, d ?? 1];
}

export function daysBetweenLocalDates(later: string, earlier: string): number {
  const [ly, lm, ld] = parseLocalDateParts(later);
  const [ey, em, ed] = parseLocalDateParts(earlier);
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(ey, em - 1, ed)) / DAY_MS);
}

/** Validate that when both `startOn` (YYYY-MM-DD) and `due` (ISO datetime) exist, `startOn <= vietnamDate(due)`. */
export function isValidScheduleRange(startOn: string | null | undefined, due: string | Date | null | undefined): boolean {
  if (startOn === null || startOn === undefined || due === null || due === undefined) {
    return true;
  }
  return startOn <= vietnamDate(due);
}

/** Inclusive day duration of one task bar on the timeline (minimum 1 day). */
export function taskScheduleSpanDays(task: Pick<TimelineScheduleTask, 'startOn' | 'due'>): number {
  if (task.startOn !== null && task.due !== null) {
    const dueDate = vietnamDate(task.due);
    const diff = daysBetweenLocalDates(dueDate, task.startOn) + 1;
    return diff > 1 ? diff : 1;
  }
  return 1;
}

/**
 * Deterministically flag dependency schedule conflicts:
 * when `blocker` has a `due` date strictly after `blocked.startOn` (or after `blocked.due` when `blocked.startOn` is null).
 * Cancelled tasks are ignored.
 */
export function detectTimelineConflicts(
  tasks: readonly Pick<ProjectTimelineTask, 'id' | 'status' | 'startOn' | 'due'>[],
  edges: readonly ProjectTimelineEdge[],
): ProjectTimelineConflict[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const conflicts: ProjectTimelineConflict[] = [];

  for (const edge of edges) {
    const blocker = taskById.get(edge.blockerTaskId);
    const blocked = taskById.get(edge.blockedTaskId);
    if (!blocker || !blocked) continue;
    if (blocker.status === 'cancelled' || blocked.status === 'cancelled') continue;
    if (blocker.due === null) continue;

    const blockerDueDate = vietnamDate(blocker.due);
    let blockedTargetDate: string | null = null;
    let blockedField: 'start_on' | 'due' = 'start_on';

    if (blocked.startOn !== null) {
      blockedTargetDate = blocked.startOn;
      blockedField = 'start_on';
    } else if (blocked.due !== null) {
      blockedTargetDate = vietnamDate(blocked.due);
      blockedField = 'due';
    }

    if (blockedTargetDate === null) continue;

    if (blockerDueDate > blockedTargetDate) {
      conflicts.push({
        dependencyId: edge.id,
        blockerTaskId: blocker.id,
        blockedTaskId: blocked.id,
        blockerDueDate,
        blockedTargetDate,
        blockedField,
      });
    }
  }

  return conflicts;
}

interface ChainCandidate {
  count: number;
  spanDays: number;
  path: string[];
}

function isBetterChain(candidate: ChainCandidate, current: ChainCandidate | null): boolean {
  if (current === null) return true;
  if (candidate.count !== current.count) return candidate.count > current.count;
  if (candidate.spanDays !== current.spanDays) return candidate.spanDays > current.spanDays;
  return candidate.path.join(',') < current.path.join(',');
}

/**
 * Compute the longest open dependency chain across non-done, non-cancelled tasks in the DAG.
 * Ties in chain task count break deterministically by longest total scheduled span (days), then task ID order.
 * Returns empty when no open dependency edges exist.
 */
export function computeCriticalPath(
  tasks: readonly Pick<TimelineScheduleTask, 'id' | 'status' | 'startOn' | 'due'>[],
  edges: readonly Pick<TimelineEdgeRef, 'blockerTaskId' | 'blockedTaskId'>[],
): CriticalPathResult {
  const openById = new Map<string, Pick<TimelineScheduleTask, 'id' | 'status' | 'startOn' | 'due'>>();
  for (const task of tasks) {
    if (task.status !== 'done' && task.status !== 'cancelled') {
      openById.set(task.id, task);
    }
  }

  const nextByBlocker = new Map<string, string[]>();
  const participatingIds = new Set<string>();
  for (const edge of edges) {
    if (edge.blockerTaskId === edge.blockedTaskId) continue;
    if (!openById.has(edge.blockerTaskId) || !openById.has(edge.blockedTaskId)) continue;
    participatingIds.add(edge.blockerTaskId);
    participatingIds.add(edge.blockedTaskId);
    let nexts = nextByBlocker.get(edge.blockerTaskId);
    if (!nexts) {
      nexts = [];
      nextByBlocker.set(edge.blockerTaskId, nexts);
    }
    if (!nexts.includes(edge.blockedTaskId)) {
      nexts.push(edge.blockedTaskId);
    }
  }

  if (participatingIds.size === 0) {
    return { criticalPathTaskIds: [], criticalPathLength: 0, criticalPathSpanDays: 0 };
  }

  for (const nexts of nextByBlocker.values()) {
    nexts.sort();
  }

  const memo = new Map<string, ChainCandidate>();
  const visiting = new Set<string>();

  const bestFrom = (taskId: string): { result: ChainCandidate; cycleSkipped: boolean } => {
    const cached = memo.get(taskId);
    if (cached) return { result: cached, cycleSkipped: false };

    const task = openById.get(taskId)!;
    const ownDays = taskScheduleSpanDays(task);
    visiting.add(taskId);

    let bestChild: ChainCandidate | null = null;
    let cycleSkipped = false;
    for (const nextId of nextByBlocker.get(taskId) ?? []) {
      if (visiting.has(nextId)) {
        cycleSkipped = true;
        continue;
      }
      const child = bestFrom(nextId);
      if (child.cycleSkipped) cycleSkipped = true;
      if (isBetterChain(child.result, bestChild)) {
        bestChild = child.result;
      }
    }

    visiting.delete(taskId);

    const result: ChainCandidate = bestChild
      ? {
          count: 1 + bestChild.count,
          spanDays: ownDays + bestChild.spanDays,
          path: [taskId, ...bestChild.path],
        }
      : {
          count: 1,
          spanDays: ownDays,
          path: [taskId],
        };

    if (!cycleSkipped) {
      memo.set(taskId, result);
    }
    return { result, cycleSkipped };
  };

  let overallBest: ChainCandidate | null = null;
  const sortedIds = [...participatingIds].sort();
  for (const taskId of sortedIds) {
    const { result: candidate } = bestFrom(taskId);
    if (isBetterChain(candidate, overallBest)) {
      overallBest = candidate;
    }
  }

  if (!overallBest || overallBest.count < 2) {
    return { criticalPathTaskIds: [], criticalPathLength: 0, criticalPathSpanDays: 0 };
  }

  return {
    criticalPathTaskIds: overallBest.path,
    criticalPathLength: overallBest.count,
    criticalPathSpanDays: overallBest.spanDays,
  };
}
