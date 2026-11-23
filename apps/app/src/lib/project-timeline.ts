// SPDX-License-Identifier: AGPL-3.0-only

import {
  VIETNAM_TIME_ZONE,
  isCalendarDate,
  todoDueInstant,
  vietnamDate,
  type ProjectTimelineConflict,
  type ProjectTimelineCycle,
  type ProjectTimelineEdge,
  type ProjectTimelineTask,
} from '@ludy/kernel-contract';

export type TimelineZoom = 'week' | 'month';

export const TIMELINE_ROW_HEIGHT_PX = 52;
export const TIMELINE_MAX_WINDOW_DAYS = 366;
export const TIMELINE_DAY_WIDTH_PX: Record<TimelineZoom, number> = {
  week: 44,
  month: 18,
};

const MS_PER_DAY = 86_400_000;

function parseUtcDayMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function formatUtcDay(ms: number): string {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addLocalDateDays(dateStr: string, deltaDays: number): string {
  if (!isCalendarDate(dateStr)) return dateStr;
  return formatUtcDay(parseUtcDayMs(dateStr) + deltaDays * MS_PER_DAY);
}

export function timelineDaysBetween(start: string, end: string): number {
  return Math.round((parseUtcDayMs(end) - parseUtcDayMs(start)) / MS_PER_DAY);
}

export function taskDueDayVietnam(due: string | null | undefined): string | null {
  if (!due) return null;
  const formatted = vietnamDate(due);
  return isCalendarDate(formatted) ? formatted : null;
}

export function taskDueIsoFromVietnamDay(day: string): string {
  return todoDueInstant(day, '23:59', VIETNAM_TIME_ZONE).toISOString();
}

export interface TaskScheduleSpan {
  start: string;
  end: string;
  hasExplicitStart: boolean;
  hasExplicitDue: boolean;
}

export function taskScheduleSpan(task: Pick<ProjectTimelineTask, 'startOn' | 'due'>): TaskScheduleSpan | null {
  const start = task.startOn && isCalendarDate(task.startOn) ? task.startOn : null;
  const end = taskDueDayVietnam(task.due);
  if (!start && !end) return null;
  if (start && end) {
    return {
      start,
      end: start <= end ? end : start,
      hasExplicitStart: true,
      hasExplicitDue: true,
    };
  }
  if (start) {
    return { start, end: start, hasExplicitStart: true, hasExplicitDue: false };
  }
  return { start: end!, end: end!, hasExplicitStart: false, hasExplicitDue: true };
}

export type TimelineShiftMode = 'move' | 'resize-start' | 'resize-end';

export function shiftTaskSchedule(
  task: Pick<ProjectTimelineTask, 'startOn' | 'due'>,
  mode: TimelineShiftMode,
  deltaDays: number,
): { startOn: string | null; due: string | null } {
  const startOn = task.startOn && isCalendarDate(task.startOn) ? task.startOn : null;
  const dueDay = taskDueDayVietnam(task.due);
  if (deltaDays === 0 || (!startOn && !dueDay)) {
    return { startOn, due: dueDay ? (task.due ?? taskDueIsoFromVietnamDay(dueDay)) : null };
  }

  if (mode === 'move') {
    const nextStartOn = startOn ? addLocalDateDays(startOn, deltaDays) : null;
    const nextDueDay = dueDay ? addLocalDateDays(dueDay, deltaDays) : null;
    return {
      startOn: nextStartOn,
      due: nextDueDay ? taskDueIsoFromVietnamDay(nextDueDay) : null,
    };
  }

  if (mode === 'resize-start') {
    const anchor = startOn ?? dueDay!;
    let nextStart = addLocalDateDays(anchor, deltaDays);
    if (dueDay && nextStart > dueDay) {
      nextStart = dueDay;
    }
    return {
      startOn: nextStart,
      due: dueDay ? (task.due ?? taskDueIsoFromVietnamDay(dueDay)) : null,
    };
  }

  // resize-end
  const anchor = dueDay ?? startOn!;
  let nextEnd = addLocalDateDays(anchor, deltaDays);
  if (startOn && nextEnd < startOn) {
    nextEnd = startOn;
  }
  return {
    startOn,
    due: taskDueIsoFromVietnamDay(nextEnd),
  };
}

export function timelineBarKeyDelta(key: string, shiftKey: boolean): number | null {
  const step = shiftKey ? 7 : 1;
  if (key === 'ArrowLeft') return -step;
  if (key === 'ArrowRight') return step;
  return null;
}

export function defaultQuickScheduleDates(today: string): { startOn: string; due: string } {
  return {
    startOn: today,
    due: taskDueIsoFromVietnamDay(today),
  };
}

export interface TimelineWindow {
  start: string;
  end: string;
  totalDays: number;
  dayWidthPx: number;
  totalWidthPx: number;
  todayOffsetPx: number;
}

export interface TimelineHeaderBucket {
  key: string;
  label: string;
  leftPx: number;
  widthPx: number;
}

export function computeTimelineWindow(
  tasks: readonly ProjectTimelineTask[],
  cycles: readonly ProjectTimelineCycle[],
  today: string,
  zoom: TimelineZoom,
): TimelineWindow {
  let minDate = today;
  let maxDate = today;

  for (const task of tasks) {
    const span = taskScheduleSpan(task);
    if (!span) continue;
    if (span.start < minDate) minDate = span.start;
    if (span.end > maxDate) maxDate = span.end;
  }

  for (const cycle of cycles) {
    if (isCalendarDate(cycle.startsOn) && cycle.startsOn < minDate) minDate = cycle.startsOn;
    if (isCalendarDate(cycle.endsOn) && cycle.endsOn > maxDate) maxDate = cycle.endsOn;
  }

  const leadPad = zoom === 'week' ? 3 : 7;
  const tailPad = zoom === 'week' ? 7 : 14;
  const minDays = zoom === 'week' ? 21 : 45;
  const maxSpan = TIMELINE_MAX_WINDOW_DAYS;

  let start = addLocalDateDays(minDate, -leadPad);
  let end = addLocalDateDays(maxDate, tailPad);
  let totalDays = timelineDaysBetween(start, end) + 1;
  if (totalDays > maxSpan) {
    const half = Math.floor(maxSpan / 2);
    const minWindowStart = addLocalDateDays(today, -half);
    if (start < minWindowStart) start = minWindowStart;
    end = addLocalDateDays(start, maxSpan - 1);
    totalDays = maxSpan;
  }
  if (totalDays < minDays) {
    end = addLocalDateDays(start, minDays - 1);
    totalDays = minDays;
  }

  const dayWidthPx = TIMELINE_DAY_WIDTH_PX[zoom];
  const todayOffsetDays = Math.max(0, Math.min(totalDays - 1, timelineDaysBetween(start, today)));

  return {
    start,
    end,
    totalDays,
    dayWidthPx,
    totalWidthPx: totalDays * dayWidthPx,
    todayOffsetPx: Math.round(todayOffsetDays * dayWidthPx + dayWidthPx / 2),
  };
}

export function computeTimelineHeaderBuckets(
  window: TimelineWindow,
  zoom: TimelineZoom,
  locale: 'vi' | 'en',
): TimelineHeaderBucket[] {
  const buckets: TimelineHeaderBucket[] = [];
  if (zoom === 'week') {
    for (let offset = 0; offset < window.totalDays; offset += 7) {
      const spanDays = Math.min(7, window.totalDays - offset);
      const day = addLocalDateDays(window.start, offset);
      const [, month, dateNum] = day.split('-');
      const label = `${dateNum}/${month}`;
      buckets.push({
        key: day,
        label,
        leftPx: offset * window.dayWidthPx,
        widthPx: spanDays * window.dayWidthPx,
      });
    }
    return buckets;
  }

  let cursor = 0;
  while (cursor < window.totalDays) {
    const day = addLocalDateDays(window.start, cursor);
    const monthPrefix = day.slice(0, 7);
    const [year, month] = monthPrefix.split('-');
    let spanDays = 1;
    while (cursor + spanDays < window.totalDays) {
      const nextDay = addLocalDateDays(window.start, cursor + spanDays);
      if (nextDay.slice(0, 7) !== monthPrefix) break;
      spanDays += 1;
    }
    const label = locale === 'vi' ? `Th${Number(month)}/${year}` : `${month}/${year}`;
    buckets.push({
      key: monthPrefix,
      label,
      leftPx: cursor * window.dayWidthPx,
      widthPx: spanDays * window.dayWidthPx,
    });
    cursor += spanDays;
  }
  return buckets;
}

export interface TimelineBarLayout {
  task: ProjectTimelineTask;
  span: TaskScheduleSpan;
  rowIndex: number;
  leftPx: number;
  widthPx: number;
  centerY: number;
  hasConflict: boolean;
  isCritical: boolean;
}

export function computeTimelineBars(
  tasks: readonly ProjectTimelineTask[],
  window: TimelineWindow,
  conflicts: readonly ProjectTimelineConflict[],
  criticalPathTaskIds: readonly string[],
): TimelineBarLayout[] {
  const conflictTaskIds = new Set<string>();
  for (const conflict of conflicts) {
    conflictTaskIds.add(conflict.blockerTaskId);
    conflictTaskIds.add(conflict.blockedTaskId);
  }
  const criticalSet = new Set(criticalPathTaskIds);

  const bars: TimelineBarLayout[] = [];
  let rowIndex = 0;
  for (const task of tasks) {
    const span = taskScheduleSpan(task);
    if (!span) continue;
    const startDays = timelineDaysBetween(window.start, span.start);
    const spanDays = Math.max(1, timelineDaysBetween(span.start, span.end) + 1);
    bars.push({
      task,
      span,
      rowIndex,
      leftPx: startDays * window.dayWidthPx,
      widthPx: Math.max(window.dayWidthPx, spanDays * window.dayWidthPx),
      centerY: rowIndex * TIMELINE_ROW_HEIGHT_PX + Math.round(TIMELINE_ROW_HEIGHT_PX / 2),
      hasConflict: conflictTaskIds.has(task.id),
      isCritical: criticalSet.has(task.id),
    });
    rowIndex += 1;
  }
  return bars;
}

export interface TimelineCycleBandLayout {
  cycle: ProjectTimelineCycle;
  leftPx: number;
  widthPx: number;
}

export function computeCycleBands(
  cycles: readonly ProjectTimelineCycle[],
  window: TimelineWindow,
): TimelineCycleBandLayout[] {
  const bands: TimelineCycleBandLayout[] = [];
  for (const cycle of cycles) {
    if (!isCalendarDate(cycle.startsOn) || !isCalendarDate(cycle.endsOn)) continue;
    if (cycle.endsOn < window.start || cycle.startsOn > window.end) continue;
    const clampedStart = cycle.startsOn < window.start ? window.start : cycle.startsOn;
    const clampedEnd = cycle.endsOn > window.end ? window.end : cycle.endsOn;
    const offsetDays = timelineDaysBetween(window.start, clampedStart);
    const spanDays = Math.max(1, timelineDaysBetween(clampedStart, clampedEnd) + 1);
    bands.push({
      cycle,
      leftPx: offsetDays * window.dayWidthPx,
      widthPx: spanDays * window.dayWidthPx,
    });
  }
  return bands;
}

export interface TimelineConnectorLayout {
  edge: ProjectTimelineEdge;
  path: string;
  isConflict: boolean;
  isCritical: boolean;
}

export function computeDependencyConnectors(
  bars: readonly TimelineBarLayout[],
  edges: readonly ProjectTimelineEdge[],
  conflicts: readonly ProjectTimelineConflict[],
  criticalPathTaskIds: readonly string[],
): TimelineConnectorLayout[] {
  const byTaskId = new Map<string, TimelineBarLayout>();
  for (const bar of bars) {
    byTaskId.set(bar.task.id, bar);
  }
  const conflictKeys = new Set(
    conflicts.map((conflict) => `${conflict.blockerTaskId}:${conflict.blockedTaskId}`),
  );
  const criticalSet = new Set(criticalPathTaskIds);

  const connectors: TimelineConnectorLayout[] = [];
  for (const edge of edges) {
    const from = byTaskId.get(edge.blockerTaskId);
    const to = byTaskId.get(edge.blockedTaskId);
    if (!from || !to) continue;

    const x1 = from.leftPx + from.widthPx;
    const y1 = from.centerY;
    const x2 = to.leftPx;
    const y2 = to.centerY;

    let path: string;
    if (x2 >= x1 + 12) {
      const midX = Math.round((x1 + x2) / 2);
      path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
    } else {
      const stepOutX = x1 + 10;
      const stepInX = x2 - 10;
      const midY = Math.round((y1 + y2) / 2);
      path = `M ${x1} ${y1} L ${stepOutX} ${y1} L ${stepOutX} ${midY} L ${stepInX} ${midY} L ${stepInX} ${y2} L ${x2} ${y2}`;
    }

    connectors.push({
      edge,
      path,
      isConflict: conflictKeys.has(`${edge.blockerTaskId}:${edge.blockedTaskId}`),
      isCritical: criticalSet.has(edge.blockerTaskId) && criticalSet.has(edge.blockedTaskId),
    });
  }
  return connectors;
}

export function partitionTimelineTasks(
  tasks: readonly ProjectTimelineTask[],
  searchQuery = '',
): {
  filtered: ProjectTimelineTask[];
  scheduled: ProjectTimelineTask[];
  unscheduled: ProjectTimelineTask[];
} {
  const needle = searchQuery.trim().toLowerCase();
  const filtered = needle
    ? tasks.filter(
        (task) =>
          task.title.toLowerCase().includes(needle) ||
          (task.assigneeTitle?.toLowerCase().includes(needle) ?? false),
      )
    : [...tasks];

  const scheduled: ProjectTimelineTask[] = [];
  const unscheduled: ProjectTimelineTask[] = [];
  for (const task of filtered) {
    if (taskScheduleSpan(task)) {
      scheduled.push(task);
    } else {
      unscheduled.push(task);
    }
  }
  return { filtered, scheduled, unscheduled };
}
