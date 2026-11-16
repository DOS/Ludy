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

export { projectsManifest } from './manifest.ts';
export { projectsToday } from './today.ts';
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
];
