// SPDX-License-Identifier: AGPL-3.0-only
// The pipeline's stages and the board (#2226, docs/plan/crm.md step K2). Owners and admins add, rename, reorder and
// remove the open stages; the pipeline keeps at most PIPELINE_STAGE_MAX stages, at least one open stage, and Won then
// Lost as its last two. Every edit runs under the pipeline lock (deals.ts), so two edits, or an edit and a deal placed
// at the same time, wait for each other. Each command answers the stages as they are afterwards. The board query reads
// the stages with their deals, in the order the deals are placed.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  BOARD_CARD_LIMIT,
  BOARD_CLOSED_DAYS,
  PIPELINE_STAGE_MAX,
  zStageAdd,
  zStageRemove,
  zStageRename,
  zStageReorder,
  type Board,
  type BoardColumn,
  type PipelineStage,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { base, ensureStages, loadStages, mayDelete, view } from './deals.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

function userOf(actor: CommandContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

// Writes the positions 1 upward in the order given, all in one statement (the unique key is deferred).
async function writePositions(ctx: CommandContext, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const values = sql.join(ids.map((id, i) => sql`(${id}::uuid, ${i + 1}::smallint)`));
  await sql`
    UPDATE crove_crm.pipeline_stage s SET position = v.position, updated_at = ${ctx.now}
    FROM (VALUES ${values}) AS v(id, position)
    WHERE s.org_id = ${ctx.orgId}::uuid AND s.id = v.id AND s.position IS DISTINCT FROM v.position`.execute(ctx.trx);
}

// The stages under the lock, with the pipeline set up when the org has none.
async function lockedStages(ctx: CommandContext): Promise<PipelineStage[]> {
  userOf(ctx.actor);
  return ensureStages(ctx);
}

export const stageAdd = defineCommand({
  name: 'crm.stage.add',
  input: zStageAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<PipelineStage[]> => {
    const stages = await lockedStages(ctx);
    if (stages.length >= PIPELINE_STAGE_MAX) throw new DomainError('PIPELINE_FULL', 422, `Quy trình chỉ có tối đa ${PIPELINE_STAGE_MAX} giai đoạn`);
    const name = oneLine(input.name);
    if (!name) throw new DomainError('INVALID_STAGE_NAME', 422, 'Tên giai đoạn không được để trống');
    // After the last open stage, before Won and Lost.
    const open = stages.filter((s) => s.kind === 'open');
    const closing = stages.filter((s) => s.kind !== 'open');
    const inserted = await ctx.trx
      .insertInto('crove_crm.pipeline_stage')
      .values({ org_id: ctx.orgId, name, kind: 'open', position: stages.length + 1, created_at: ctx.now, updated_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writePositions(ctx, [...open.map((s) => s.id), inserted.id, ...closing.map((s) => s.id)]);
    ctx.audit({ stageId: inserted.id, stages: stages.length + 1 });
    return loadStages(ctx);
  },
});

export const stageRename = defineCommand({
  name: 'crm.stage.rename',
  input: zStageRename,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'crm.stage', id: input.stageId }),
  handler: async (ctx, input): Promise<PipelineStage[]> => {
    const stages = await lockedStages(ctx);
    if (!stages.some((s) => s.id === input.stageId)) throw new DomainError('STAGE_NOT_FOUND', 404, 'Không tìm thấy giai đoạn này');
    const name = oneLine(input.name);
    if (!name) throw new DomainError('INVALID_STAGE_NAME', 422, 'Tên giai đoạn không được để trống');
    await ctx.trx.updateTable('crove_crm.pipeline_stage').set({ name, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.stageId).execute();
    ctx.audit({ stageId: input.stageId });
    return loadStages(ctx);
  },
});

export const stageReorder = defineCommand({
  name: 'crm.stage.reorder',
  input: zStageReorder,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<PipelineStage[]> => {
    const stages = await lockedStages(ctx);
    const open = stages.filter((s) => s.kind === 'open');
    const wanted = new Set(input.stageIds);
    if (wanted.size !== input.stageIds.length || wanted.size !== open.length || !open.every((s) => wanted.has(s.id))) {
      throw new DomainError('STAGE_ORDER_INVALID', 422, 'Danh sách phải có đủ mọi giai đoạn đang mở, mỗi giai đoạn một lần');
    }
    await writePositions(ctx, [...input.stageIds, ...stages.filter((s) => s.kind !== 'open').map((s) => s.id)]);
    ctx.audit({ stages: stages.length });
    return loadStages(ctx);
  },
});

export const stageRemove = defineCommand({
  name: 'crm.stage.remove',
  input: zStageRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'crm.stage', id: input.stageId }),
  handler: async (ctx, input): Promise<PipelineStage[]> => {
    const stages = await lockedStages(ctx);
    const stage = stages.find((s) => s.id === input.stageId);
    if (!stage) throw new DomainError('STAGE_NOT_FOUND', 404, 'Không tìm thấy giai đoạn này');
    if (stage.kind !== 'open') throw new DomainError('STAGE_CLOSING', 422, 'Giai đoạn Thắng và Thua không xóa được');
    if (stages.filter((s) => s.kind === 'open').length <= 1) throw new DomainError('LAST_OPEN_STAGE', 422, 'Quy trình cần ít nhất một giai đoạn đang mở');
    const held = await ctx.trx.selectFrom('crove_crm.deal').select('id').where('org_id', '=', ctx.orgId).where('stage_id', '=', stage.id).limit(1).executeTakeFirst();
    if (held) throw new DomainError('STAGE_HAS_DEALS', 409, 'Giai đoạn còn cơ hội; hãy chuyển các cơ hội đi trước khi xóa');
    await ctx.trx.deleteFrom('crove_crm.pipeline_stage').where('org_id', '=', ctx.orgId).where('id', '=', stage.id).execute();
    await writePositions(ctx, stages.filter((s) => s.id !== stage.id).map((s) => s.id));
    ctx.audit({ stageId: stage.id, stages: stages.length - 1 });
    return loadStages(ctx);
  },
});

export const stageCommands = [stageAdd, stageRename, stageReorder, stageRemove];

// The board: every open stage with its deals in order, Won and Lost with the deals closed in the last BOARD_CLOSED_DAYS
// days. Counts and totals come from the database over the same deals, so a long column still adds up.
export const dealBoard = defineQuery({
  name: 'crm.deal.board',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<Board> => {
    const stages = await loadStages(ctx);
    if (stages.length === 0) return { columns: [] };
    // Closed deals count while they were closed within the window; the database's clock decides, as a query has none.
    const window = sql.raw(`now() - interval '${Math.trunc(BOARD_CLOSED_DAYS)} days'`);
    const sums = await sql<{ stage_id: string; n: string; total: string }>`
      SELECT d.stage_id, pg_catalog.count(*)::text AS n, pg_catalog.sum(d.amount)::text AS total
      FROM crove_crm.deal d JOIN crove_crm.pipeline_stage s ON s.org_id = d.org_id AND s.id = d.stage_id
      WHERE d.org_id = ${ctx.orgId}::uuid AND (s.kind = 'open' OR d.closed_at >= ${window})
      GROUP BY d.stage_id`.execute(ctx.trx);
    const byStage = new Map(sums.rows.map((r) => [r.stage_id, r]));
    const columns: BoardColumn[] = [];
    for (const stage of stages) {
      let q = base(ctx).where('d.stage_id', '=', stage.id);
      if (stage.kind !== 'open') q = q.where(sql<boolean>`d.closed_at >= ${window}`);
      const rows = await q.orderBy('d.sort_key').orderBy('d.id').limit(BOARD_CARD_LIMIT + 1).execute();
      const sum = byStage.get(stage.id);
      columns.push({
        stage,
        count: sum ? Number(sum.n) : 0,
        total: sum ? sum.total : '0',
        cards: rows.slice(0, BOARD_CARD_LIMIT).map((r) => view(r, mayDelete(ctx, r.created_by))),
        truncated: rows.length > BOARD_CARD_LIMIT,
      });
    }
    return { columns };
  },
});

export const boardQueries = [dealBoard];
