// SPDX-License-Identifier: AGPL-3.0-only
// The projects module's manifest (plan docs/plan/projects.md sections 4.1 and 6, ADR-0048): the three tables of
// crove_projects and the class of every column. Project name and description are free text a member writes, which may
// name people, so pii: audit rows keep a marker for them (auditValue), never the text.
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const projectsManifest = defineModule({
  id: 'projects',
  dependsOn: ['kernel'],
  tables: {
    crove_projects: {
      project: columns(
        ['org_id', 'id', 'owner_user_id', 'status', 'created_by', 'created_at', 'updated_at'],
        { name: 'pii', description: 'pii' },
      ),
      project_member: columns(['org_id', 'id', 'project_id', 'user_id', 'created_at']),
      project_task: columns(['org_id', 'id', 'project_id', 'task_id', 'added_by', 'created_at']),
    },
  },
  // Access comes from the base role (every member and viewer reads; owners, admins and members create projects and add
  // or remove tasks; the project owner, owners and admins manage the project itself).
  permissions: [],
  entities: [
    { type: 'projects.project', table: 'project', legalEntityScoped: false, audit: 'command' },
  ],
  ...MODULE_SCREENS.projects,
});
