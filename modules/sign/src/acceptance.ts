// SPDX-License-Identifier: AGPL-3.0-only
// Read source query for Vy's deliverable summary on project acceptance minutes (#3812, docs/plan/esign.md Slice 3b).
// Reads project metadata and caller-visible completed tasks strictly via ctx.query('projects.board') inside the human
// caller's own transaction so per-org 'projects' enablement, project access, and le_scope task RLS all apply unchanged.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { zId, type ProjectBoard, type ProjectDetail, type ProjectStatus } from '@ludy/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export interface SignAcceptanceSourceTask {
  id: string;
  title: string;
}

export interface SignAcceptanceSource {
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  completedTasks: SignAcceptanceSourceTask[];
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

export const signAcceptanceSource = defineQuery({
  name: 'sign.acceptance.source',
  input: z.strictObject({ projectId: zId }),
  access: WRITERS,
  handler: async (ctx: QueryContext, input: { projectId: string }): Promise<SignAcceptanceSource> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can run this query');
    }

    const boardRes = await ctx.query<ProjectBoard>('projects.board', {
      projectId: input.projectId,
      status: ['done'],
    });
    if (boardRes.status === 'not_installed') {
      throw new DomainError('MODULE_OFF', 404, 'Ứng dụng projects chưa được bật cho công ty này', {
        module: 'projects',
      });
    }

    const { rows: metaRows } = await sql<{ ai_stopped: boolean; budget_spent: boolean }>`
      SELECT
        (
          crove_kernel.global_kill_switch_on('ai')
          OR EXISTS (
            SELECT 1 FROM crove_kernel.kill_switch k
             WHERE k.org_id = ${ctx.orgId}::uuid
               AND k.released_at IS NULL
               AND (k.scope = 'org' OR (k.scope = 'module' AND k.target IN ('sign', 'projects')))
          )
        ) AS ai_stopped,
        crove_kernel.ai_budget_exhausted(${ctx.orgId}::uuid, 'sign', NULL::uuid) AS budget_spent
    `.execute(ctx.trx);

    const meta = metaRows[0];
    const board = boardRes.value;
    const completedTasks: SignAcceptanceSourceTask[] = board.tasks
      .filter((t) => t.status === 'done')
      .map((t) => ({ id: t.id, title: t.title }));

    return {
      projectId: board.project.id,
      projectName: board.project.name,
      projectStatus: board.project.status,
      completedTasks,
      aiStopped: meta?.ai_stopped === true,
      aiBudgetSpent: meta?.budget_spent === true,
    };
  },
});

export interface SignAcceptanceAiStatus {
  aiStopped: boolean;
}

export const signAcceptanceAiStatus = defineQuery({
  name: 'sign.acceptance.ai_status',
  input: z.strictObject({ projectId: zId }),
  access: WRITERS,
  handler: async (ctx: QueryContext, input: { projectId: string }): Promise<SignAcceptanceAiStatus> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can run this query');
    }

    const projRes = await ctx.query<ProjectDetail>('projects.project.get', { id: input.projectId });
    if (projRes.status === 'not_installed') {
      throw new DomainError('MODULE_OFF', 404, 'Ứng dụng projects chưa được bật cho công ty này', {
        module: 'projects',
      });
    }

    const { rows } = await sql<{ ai_stopped: boolean }>`
      SELECT
        (
          crove_kernel.global_kill_switch_on('ai')
          OR EXISTS (
            SELECT 1 FROM crove_kernel.kill_switch k
             WHERE k.org_id = ${ctx.orgId}::uuid
               AND k.released_at IS NULL
               AND (k.scope = 'org' OR (k.scope = 'module' AND k.target IN ('sign', 'projects')))
          )
        ) AS ai_stopped
    `.execute(ctx.trx);

    return { aiStopped: rows[0]?.ai_stopped === true };
  },
});

export const signAcceptanceQueries = [signAcceptanceSource, signAcceptanceAiStatus];
