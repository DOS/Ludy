// SPDX-License-Identifier: AGPL-3.0-only
import {
  projectBoard,
  projectGet,
  projectList,
  projectMemberCompletedTasks,
  projectTaskProjects,
  projectUnassignedTasks,
} from './projects.ts';
import { projectsToday } from './today.ts';
import { tasksFromNoteSeats, tasksFromNoteStatus } from './tasks-from-note.ts';
import {
  tasksFromSourceConfirm,
  tasksFromSourceSeats,
  tasksFromSourceStart,
  tasksFromSourceStatus,
} from './tasks-from-source.ts';
import { projectWeeklyStatusSendMail, projectWeeklyStatusShareNote, projectWeeklyStatusSource } from './weekly-status.ts';
import {
  projectRecurringAdvance,
  projectTaskRecurrenceClear,
  projectTaskRecurrenceGet,
  projectTaskRecurrenceSet,
} from './recurring.ts';
import {
  projectCreateFromTemplate,
  projectTemplateArchive,
  projectTemplateCreate,
  projectTemplateList,
} from './templates.ts';
import { projectDependencyAdd, projectDependencyList, projectDependencyRemove } from './dependencies.ts';
import { projectTaskSetDates, projectTimeline } from './timeline.ts';
import { projectCycleCommands, projectCycleQueries } from './cycles.ts';
import {
  projectTimeDelete,
  projectTimeExportCsv,
  projectTimeLog,
  projectTimeStart,
  projectTimeStop,
  projectTimeSummary,
  projectTimeUpdate,
} from './time.ts';

export { hasDependencyPath, projectDependencyAdd, projectDependencyList, projectDependencyRemove } from './dependencies.ts';
export {
  computeCriticalPath,
  daysBetweenLocalDates as timelineDaysBetween,
  detectTimelineConflicts,
  isValidScheduleRange,
  taskScheduleSpanDays,
  type CriticalPathResult,
  type TimelineEdgeRef,
  type TimelineScheduleTask,
} from './domain/timeline.ts';
export { projectTaskSetDates, projectTimeline } from './timeline.ts';
export {
  PROJECT_TIME_CSV_HEADERS,
  computeTimeBillableAmount,
  computeTimeHoursString,
  formatHourlyRateOutput,
  normalizeHourlyRateInput,
  projectTimeCsvCell,
  projectTimeDelete,
  projectTimeExportCsv,
  projectTimeLog,
  projectTimeStart,
  projectTimeStop,
  projectTimeSummary,
  projectTimeUpdate,
  resolveLogTimestamps,
  resolveUpdatedCompletedTimestamps,
  sumTimeBillableAmounts,
  validateEndedAndDuration,
} from './time.ts';
export { projectsManifest } from './manifest.ts';
export { projectsToday } from './today.ts';
export {
  addLocalDays,
  daysBetweenLocalDates,
  daysInMonth,
  nextProjectRecurrenceDate,
  parseStoredRecurrence,
  projectRecurringAdvance,
  projectTaskRecurrenceClear,
  projectTaskRecurrenceGet,
  projectTaskRecurrenceSet,
  type ProjectRecurringAdvanceResult,
} from './recurring.ts';
export {
  projectCreateFromTemplate,
  projectTemplateArchive,
  projectTemplateCreate,
  projectTemplateList,
  starterProjectTemplates,
} from './templates.ts';
export {
  projectWeeklyStatusSendMail,
  projectWeeklyStatusShareNote,
  projectWeeklyStatusSource,
  type ProjectWeeklyStatusSource,
} from './weekly-status.ts';
export {
  computeCycleBurndown,
  projectCycleComplete,
  projectCycleCreate,
  projectCycleDelete,
  projectCycleList,
  projectCycleMetrics,
  projectCycleStart,
  projectCycleSummarySource,
  projectCycleUpdate,
  projectTaskSetCycle,
  projectTaskSetPoints,
  type BurndownTaskSample,
  type ProjectCycleSummarySource,
} from './cycles.ts';
export {
  tasksFromNoteConfirm,
  tasksFromNoteSeats,
  tasksFromNoteStart,
  tasksFromNoteStatus,
} from './tasks-from-note.ts';
export {
  formatConversationTaskSource,
  formatMeetingTaskSource,
  readTasksFromSourceData,
  tasksFromSourceConfirm,
  tasksFromSourceSeats,
  tasksFromSourceStart,
  tasksFromSourceStatus,
  type ReadableTasksSource,
  type SourceQueryFn,
  type SourceQueryResponse,
} from './tasks-from-source.ts';
import { projectsCommands as baseProjectsCommands } from './projects.ts';
import {
  projectColumnCreate,
  projectColumnDelete,
  projectColumnInitDefaults,
  projectColumnReorder,
  projectColumnUpdate,
  projectTaskMoveColumn,
} from './columns.ts';
export {
  loadProjectColumns,
  placeProjectTaskBetween,
  projectColumnCreate,
  projectColumnDelete,
  projectColumnInitDefaults,
  projectColumnReorder,
  projectColumnUpdate,
  projectTaskMoveColumn,
  resolveTaskColumnId,
  type ProjectOrderRow,
} from './columns.ts';
import { roadmapCommands, roadmapQueries } from './roadmap.ts';
import { roadmapMcpQueries } from './roadmap-mcp.ts';
import { roadmapSignalCommands, roadmapSignalQueries } from './roadmap-signals.ts';
export {
  generateEphemeralOtpWrapKey,
  openEphemeralOtpCode,
  renderRoadmapOtpMail,
  renderRoadmapShippedMail,
  sealEphemeralOtpCode,
} from './roadmap-mail.ts';
export {
  type RoadmapAiChangelogSource,
  type RoadmapAiDedupeSource,
} from './roadmap.ts';
export {
  computeSignalRollup,
  enrichMeetingSignalMatchSource,
  type RoadmapAiSignalMatchSource,
} from './roadmap-signals.ts';
export {
  MCP_ROADMAP_DEFAULT,
  MCP_ROADMAP_MAX,
  zMcpRoadmapDemandSummaryInput,
  zMcpRoadmapIdeasInput,
  type McpRoadmapDemandSummaryInput,
  type McpRoadmapIdeasInput,
} from './roadmap-mcp.ts';
export {
  roadmapBoardCreate,
  roadmapBoardGet,
  roadmapBoardUpdate,
  roadmapBoards,
  roadmapItemConvertToTask,
  roadmapItemCreate,
  roadmapItemMerge,
  roadmapItemModerate,
  roadmapItemSyncStage,
  roadmapOtpMailData,
} from './roadmap.ts';
export {
  projectArchive,
  projectBoard,
  projectCreate,
  projectGet,
  projectList,
  projectMemberAdd,
  projectMemberCompletedTasks,
  projectMemberRemove,
  projectSetOwner,
  projectSetStatus,
  projectTaskAdd,
  projectTaskCreate,
  projectTaskProjects,
  projectTaskRemove,
  projectTaskReorder,
  projectUnassignedTasks,
  projectUpdate,
} from './projects.ts';

export const projectsCommands = [
  ...baseProjectsCommands,
  projectColumnInitDefaults,
  projectColumnCreate,
  projectColumnUpdate,
  projectColumnReorder,
  projectColumnDelete,
  projectTaskMoveColumn,
  projectWeeklyStatusShareNote,
  projectWeeklyStatusSendMail,
  tasksFromSourceStart,
  tasksFromSourceConfirm,
  projectTemplateCreate,
  projectTemplateArchive,
  projectCreateFromTemplate,
  projectTaskRecurrenceSet,
  projectTaskRecurrenceClear,
  projectRecurringAdvance,
  projectDependencyAdd,
  projectDependencyRemove,
  projectTaskSetDates,
  ...projectCycleCommands,
  ...roadmapCommands,
  ...roadmapSignalCommands,
  projectTimeStart,
  projectTimeStop,
  projectTimeLog,
  projectTimeUpdate,
  projectTimeDelete,
];

export const projectsQueries = [
  projectList,
  projectMemberCompletedTasks,
  projectGet,
  projectBoard,
  projectUnassignedTasks,
  projectTaskProjects,
  projectsToday,
  projectWeeklyStatusSource,
  tasksFromNoteStatus,
  tasksFromNoteSeats,
  tasksFromSourceStatus,
  tasksFromSourceSeats,
  projectTemplateList,
  projectTaskRecurrenceGet,
  projectDependencyList,
  projectTimeline,
  ...projectCycleQueries,
  ...roadmapQueries,
  ...roadmapMcpQueries,
  ...roadmapSignalQueries,
  projectTimeSummary,
  projectTimeExportCsv,
];
