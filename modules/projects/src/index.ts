// SPDX-License-Identifier: AGPL-3.0-only
import {
  projectBoard,
  projectGet,
  projectList,
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

export { hasDependencyPath, projectDependencyAdd, projectDependencyList, projectDependencyRemove } from './dependencies.ts';
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
export {
  projectArchive,
  projectBoard,
  projectCreate,
  projectGet,
  projectList,
  projectMemberAdd,
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
];

export const projectsQueries = [
  projectList,
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
];
