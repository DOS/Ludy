// SPDX-License-Identifier: AGPL-3.0-only
// Manifest, column classification and command/query contract checks for @crove/mod-projects (#2591).
import { MODULE_SCREENS } from '@crove/kernel-contract';
import { describe, expect, it } from 'vitest';
import { projectsCommands, projectsManifest, projectsQueries } from '../src/index.ts';

describe('@crove/mod-projects (#2591)', () => {
  it('registers manifest tables, column classes, entity metadata and screen definitions', () => {
    expect(projectsManifest.id).toBe('projects');
    expect(projectsManifest.dependsOn).toEqual(['kernel']);
    expect(Object.keys(projectsManifest.tables.crove_projects).sort()).toEqual([
      'project',
      'project_member',
      'project_task',
    ]);
    expect(projectsManifest.tables.crove_projects.project.name).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project.description).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project.owner_user_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_member.user_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.task_id).toBe('internal');
    expect(projectsManifest.entities).toEqual([
      { type: 'projects.project', table: 'project', legalEntityScoped: false, audit: 'command' },
    ]);
    expect(projectsManifest.routes).toEqual(MODULE_SCREENS.projects.routes);
    expect(projectsManifest.nav).toEqual(MODULE_SCREENS.projects.nav);
  });

  it('exports all 10 commands and 4 queries with consistent module prefix', () => {
    expect(projectsCommands.map((c) => c.name).sort()).toEqual([
      'projects.member.add',
      'projects.member.remove',
      'projects.project.archive',
      'projects.project.create',
      'projects.project.set_owner',
      'projects.project.set_status',
      'projects.project.update',
      'projects.task.add',
      'projects.task.create',
      'projects.task.remove',
    ]);
    expect(projectsQueries.map((q) => q.name).sort()).toEqual([
      'projects.board',
      'projects.project.get',
      'projects.project.list',
      'projects.unassigned_tasks',
    ]);
    for (const command of projectsCommands) {
      expect(command.risk).toBe('R1');
      expect(command.sideEffect).toBe('internal');
      if (command.name === 'projects.task.create') {
        expect(command.writes).toBeUndefined();
      } else {
        expect((command.writes ?? []).length).toBeGreaterThan(0);
      }
    }
    for (const query of projectsQueries) {
      expect(query.name.startsWith('projects.')).toBe(true);
    }
  });
});
