// SPDX-License-Identifier: AGPL-3.0-only
import {
  projectBoard,
  projectGet,
  projectList,
  projectTaskProjects,
  projectUnassignedTasks,
} from './projects.ts';
import { projectsToday } from './today.ts';
import { projectWeeklyStatusSource } from './weekly-status.ts';

export { projectsManifest } from './manifest.ts';
export { projectsToday } from './today.ts';
export { projectWeeklyStatusSource, type ProjectWeeklyStatusSource } from './weekly-status.ts';
export {
  projectArchive,
  projectBoard,
  projectCreate,
  projectGet,
  projectList,
  projectMemberAdd,
  projectMemberRemove,
  projectsCommands,
  projectSetOwner,
  projectSetStatus,
  projectTaskAdd,
  projectTaskCreate,
  projectTaskProjects,
  projectTaskRemove,
  projectUnassignedTasks,
  projectUpdate,
} from './projects.ts';

export const projectsQueries = [
  projectList,
  projectGet,
  projectBoard,
  projectUnassignedTasks,
  projectTaskProjects,
  projectsToday,
  projectWeeklyStatusSource,
];
