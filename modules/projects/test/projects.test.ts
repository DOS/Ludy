// SPDX-License-Identifier: AGPL-3.0-only
// Manifest, column classification and command/query contract checks for @ludy/mod-projects (#2591).
import { MODULE_SCREENS } from '@ludy/kernel-contract';
import { describe, expect, it } from 'vitest';
import { hasDependencyPath, projectsCommands, projectsManifest, projectsQueries } from '../src/index.ts';

describe('@ludy/mod-projects (#2591)', () => {
  it('registers manifest tables, column classes, entity metadata and screen definitions', () => {
    expect(projectsManifest.id).toBe('projects');
    expect(projectsManifest.dependsOn).toEqual(['kernel']);
    expect(Object.keys(projectsManifest.tables.crove_projects).sort()).toEqual([
      'project',
      'project_column',
      'project_member',
      'project_task',
      'task_dependency',
    ]);
    expect(projectsManifest.tables.crove_projects.project_column.name).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project_column.task_status).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.column_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project.name).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project.description).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project.template_tasks).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project.is_template).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project.owner_user_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_member.user_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.task_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.recurrence).toBe('internal');
    expect(projectsManifest.tables.crove_projects.task_dependency.blocker_task_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.task_dependency.blocked_task_id).toBe('internal');
    expect(projectsManifest.entities).toEqual([
      { type: 'projects.project', table: 'project', legalEntityScoped: false, audit: 'command' },
    ]);
    expect(projectsManifest.routes).toEqual(MODULE_SCREENS.projects.routes);
    expect(projectsManifest.nav).toEqual(MODULE_SCREENS.projects.nav);
  });

  it('exports all 31 commands and 14 queries with consistent module prefix', () => {
    expect(projectsCommands.map((c) => c.name).sort()).toEqual([
      'projects.column.create',
      'projects.column.delete',
      'projects.column.init_defaults',
      'projects.column.reorder',
      'projects.column.update',
      'projects.dependency.add',
      'projects.dependency.remove',
      'projects.member.add',
      'projects.member.remove',
      'projects.project.archive',
      'projects.project.create',
      'projects.project.create_from_template',
      'projects.project.set_owner',
      'projects.project.set_status',
      'projects.project.update',
      'projects.recurring.advance',
      'projects.task.add',
      'projects.task.create',
      'projects.task.move_column',
      'projects.task.recurrence.clear',
      'projects.task.recurrence.set',
      'projects.task.remove',
      'projects.task.reorder',
      'projects.tasks_from_note.confirm',
      'projects.tasks_from_note.start',
      'projects.tasks_from_source.confirm',
      'projects.tasks_from_source.start',
      'projects.template.archive',
      'projects.template.create',
      'projects.weekly_status.send_mail',
      'projects.weekly_status.share_note',
    ]);
    expect(projectsQueries.map((q) => q.name).sort()).toEqual([
      'projects.board',
      'projects.dependency.list',
      'projects.project.get',
      'projects.project.list',
      'projects.task.recurrence.get',
      'projects.task_projects',
      'projects.tasks_from_note.seats',
      'projects.tasks_from_note.status',
      'projects.tasks_from_source.seats',
      'projects.tasks_from_source.status',
      'projects.template.list',
      'projects.today',
      'projects.unassigned_tasks',
      'projects.weekly_status_source',
    ]);
    for (const command of projectsCommands) {
      if (command.name === 'projects.weekly_status.send_mail') {
        expect(command.risk).toBe('R2');
        expect(command.sideEffect).toBe('external');
      } else {
        expect(command.risk).toBe('R1');
        expect(command.sideEffect).toBe('internal');
      }
      if (
        command.name === 'projects.task.create' ||
        command.name === 'projects.task.move_column' ||
        command.name === 'projects.column.delete' ||
        command.name === 'projects.project.create_from_template' ||
        command.name === 'projects.recurring.advance' ||
        command.name.startsWith('projects.tasks_from_note.') ||
        command.name.startsWith('projects.tasks_from_source.') ||
        command.name.startsWith('projects.weekly_status.')
      ) {
        expect(command.writes).toBeUndefined();
      } else {
        expect((command.writes ?? []).length).toBeGreaterThan(0);
      }
    }
    for (const query of projectsQueries) {
      expect(query.name.startsWith('projects.')).toBe(true);
    }
  });

  it('detects direct and transitive dependency cycles while allowing diamond DAGs (#2601)', () => {
    const A = '01900000-0000-7000-8000-000000000001';
    const B = '01900000-0000-7000-8000-000000000002';
    const C = '01900000-0000-7000-8000-000000000003';
    const D = '01900000-0000-7000-8000-000000000004';
    const chain = [
      { blocker_task_id: A, blocked_task_id: B },
      { blocker_task_id: B, blocked_task_id: C },
    ];
    // Self-loop and direct 2-cycle and transitive A->B->C->A all close a cycle.
    expect(hasDependencyPath(chain, A, A)).toBe(true);
    expect(hasDependencyPath(chain, A, B)).toBe(true);
    expect(hasDependencyPath(chain, A, C)).toBe(true);
    // Reverse C->D or adding D->A or diamond A->C, B->D->E stay acyclic.
    expect(hasDependencyPath(chain, C, A)).toBe(false);
    const diamond = [
      { blocker_task_id: A, blocked_task_id: B },
      { blocker_task_id: A, blocked_task_id: C },
      { blocker_task_id: B, blocked_task_id: D },
    ];
    expect(hasDependencyPath(diamond, D, C)).toBe(false);
    expect(hasDependencyPath(diamond, B, A)).toBe(false);
  });
});
