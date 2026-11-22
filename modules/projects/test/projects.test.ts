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
      'project_cycle',
      'project_member',
      'project_task',
      'roadmap_board',
      'roadmap_item',
      'roadmap_otp',
      'roadmap_subscriber',
      'roadmap_vote',
      'task_dependency',
    ]);
    expect(projectsManifest.tables.crove_projects.project_column.name).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project_column.task_status).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.column_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.roadmap_board.title).toBe('pii');
    expect(projectsManifest.tables.crove_projects.roadmap_board.description).toBe('pii');
    expect(projectsManifest.tables.crove_projects.roadmap_item.public_title).toBe('pii');
    expect(projectsManifest.tables.crove_projects.roadmap_item.public_summary).toBe('pii');
    expect(projectsManifest.tables.crove_projects.roadmap_item.submitter_display_name).toBe('pii');
    expect(projectsManifest.tables.crove_projects.roadmap_otp.email).toBe('contact');
    expect(projectsManifest.tables.crove_projects.roadmap_otp.otp_sha256).toBe('sensitive');
    expect(projectsManifest.tables.crove_projects.roadmap_otp.claim_sha256).toBe('sensitive');
    expect(projectsManifest.tables.crove_projects.roadmap_subscriber.email_sealed).toBe('contact');
    expect(projectsManifest.tables.crove_projects.roadmap_subscriber.unsubscribe_token_sha256).toBe('sensitive');
    expect(projectsManifest.tables.crove_projects.project.name).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project.description).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project.template_tasks).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project.is_template).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project.cycles_enabled).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project.cycle_duration_weeks).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project.points_enabled).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project.owner_user_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_cycle.name).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project_cycle.goal).toBe('pii');
    expect(projectsManifest.tables.crove_projects.project_cycle.status).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_member.user_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.task_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.start_on).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.cycle_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.story_points).toBe('internal');
    expect(projectsManifest.tables.crove_projects.project_task.recurrence).toBe('internal');
    expect(projectsManifest.tables.crove_projects.task_dependency.blocker_task_id).toBe('internal');
    expect(projectsManifest.tables.crove_projects.task_dependency.blocked_task_id).toBe('internal');
    expect(projectsManifest.entities).toEqual([
      { type: 'projects.project', table: 'project', legalEntityScoped: false, audit: 'command' },
      { type: 'projects.roadmap_board', table: 'roadmap_board', legalEntityScoped: false, audit: 'command' },
      { type: 'projects.roadmap_item', table: 'roadmap_item', legalEntityScoped: false, audit: 'command' },
    ]);
    expect(projectsManifest.routes).toEqual(MODULE_SCREENS.projects.routes);
    expect(projectsManifest.nav).toEqual(MODULE_SCREENS.projects.nav);
  });

  it('exports all 47 commands and 20 queries with consistent module prefix', () => {
    expect(projectsCommands.map((c) => c.name).sort()).toEqual([
      'projects.column.create',
      'projects.column.delete',
      'projects.column.init_defaults',
      'projects.column.reorder',
      'projects.column.update',
      'projects.cycle.complete',
      'projects.cycle.create',
      'projects.cycle.delete',
      'projects.cycle.start',
      'projects.cycle.update',
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
      'projects.roadmap.board.create',
      'projects.roadmap.board.update',
      'projects.roadmap.item.convert_to_task',
      'projects.roadmap.item.create',
      'projects.roadmap.item.merge',
      'projects.roadmap.item.moderate',
      'projects.roadmap.item.sync_stage',
      'projects.roadmap.otp_mail_data',
      'projects.task.add',
      'projects.task.create',
      'projects.task.move_column',
      'projects.task.recurrence.clear',
      'projects.task.recurrence.set',
      'projects.task.remove',
      'projects.task.reorder',
      'projects.task.set_cycle',
      'projects.task.set_dates',
      'projects.task.set_points',
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
      'projects.cycle.list',
      'projects.cycle.metrics',
      'projects.cycle_summary_source',
      'projects.dependency.list',
      'projects.project.get',
      'projects.project.list',
      'projects.roadmap.board.get',
      'projects.roadmap.boards',
      'projects.task.recurrence.get',
      'projects.task_projects',
      'projects.tasks_from_note.seats',
      'projects.tasks_from_note.status',
      'projects.tasks_from_source.seats',
      'projects.tasks_from_source.status',
      'projects.template.list',
      'projects.timeline',
      'projects.today',
      'projects.unassigned_tasks',
      'projects.weekly_status_source',
    ]);
    for (const command of projectsCommands) {
      if (command.name === 'projects.weekly_status.send_mail') {
        expect(command.risk).toBe('R2');
        expect(command.sideEffect).toBe('external');
      } else if (command.name === 'projects.roadmap.board.create' || command.name === 'projects.roadmap.board.update') {
        expect(command.risk).toBe('R2');
        expect(command.sideEffect).toBe('internal');
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
        command.name === 'projects.roadmap.item.convert_to_task' ||
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
