// SPDX-License-Identifier: AGPL-3.0-only
// Vy working for one member, stage A (ADR-0049 decisions 0 to 4 and 6, issue #2782): the member's own commands, in the member's own
// user context. A run is started here and its text is stored here, and nothing else writes what Vy produced:
//   kernel.member_vy.run.start     the member asks for one feature on one subject: checks vy.use, the kill switches and the budget,
//                                  makes the member's Vy (once) and one run and one result row in status running;
//   kernel.member_vy.result.store  the single writer of the text (no transaction is held across the model call): re-checks vy.use, the
//                                  kill switches and that the run is still live, then writes the text, tainted, with the private-read
//                                  flag computed here and never taken from the caller;
//   kernel.member_vy.memory.save / .delete   what Vy keeps about the member: only what the member typed, never model output;
//   kernel.member_vy.result.get / kernel.member_vy.memory.list   the member's own rows.
// Audit rows, activity and events carry ids, an enum and numbers, never text (decision 4): no body, title or subject text reaches them.
import { sql } from 'kysely';
import { z } from 'zod';
import { tableWrite, zId } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { kernelManifest } from './manifest.ts';

const MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

// What the store command writes, declared (P04, #1710): the result's text and state, and in the member's own session the run it closes. In the
// background (Vy in member mode) it writes the result alone; the worker closes the run afterwards (crove_kernel.member_vy_run_finish).
const STORE_WRITES = [
  tableWrite(kernelManifest.tables, 'crove_kernel', 'member_vy_result', ['status', 'body', 'error_code', 'source_revision', 'private_read']),
  tableWrite(kernelManifest.tables, 'crove_kernel', 'ai_run', ['status', 'finished_at', 'error', 'private_read']),
];

// What a member may ask Vy for in stage A, with the module whose budget and kill switch it counts against and how long a run may live
// (the kernel caps it at 4 hours). A feature is added here with the AI_FEATURES key it meters under.
export const MEMBER_VY_FEATURES = {
  'notes.summary': { module: 'notes', expiryMinutes: 30 },
  'notes.todo_suggest': { module: 'notes', expiryMinutes: 30 },
} as const;
export type MemberVyFeature = keyof typeof MEMBER_VY_FEATURES;
const FEATURE_KEYS = Object.keys(MEMBER_VY_FEATURES) as [MemberVyFeature, ...MemberVyFeature[]];

// How long a result is kept (decision 3).
const RESULT_DAYS = 30;
const MAX_BODY = 100_000;

function requireUser(ctx: Pick<CommandContext, 'actor'>): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

const aiOff = () =>
  new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Vy đang tạm dừng hoặc đã hết ngân sách tháng này; sổ sách và mọi việc không cần AI vẫn chạy bình thường');

// A kill switch that covers the org, the module or the member's Vy, or the operator's global switch for AI.
async function stopped(ctx: Pick<CommandContext, 'trx' | 'orgId'>, module: string, agentId: string | null): Promise<boolean> {
  const { rows } = await sql<{ stopped: boolean }>`
    SELECT crove_kernel.global_kill_switch_on('ai') OR EXISTS (
      SELECT 1 FROM crove_kernel.kill_switch k
      WHERE k.org_id = ${ctx.orgId}::uuid AND k.released_at IS NULL
        AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = ${module}) OR (k.scope = 'agent' AND k.target = ${agentId}::text))) AS stopped`.execute(ctx.trx);
  return rows[0]?.stopped === true;
}

async function budgetSpent(ctx: Pick<CommandContext, 'trx' | 'orgId'>, module: string, agentId: string | null): Promise<boolean> {
  const { rows } = await sql<{ spent: boolean }>`SELECT crove_kernel.ai_budget_exhausted(${ctx.orgId}::uuid, ${module}, ${agentId}::uuid) AS spent`.execute(ctx.trx);
  return rows[0]?.spent === true;
}

async function mayUseVy(ctx: Pick<CommandContext, 'trx'>): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`SELECT crove_kernel.ctx_vy_use() AS ok`.execute(ctx.trx);
  return rows[0]?.ok === true;
}

// Ends the live runs of a member's Vy (the definer checks that the caller is an owner, an admin or the system): on a removal, a loss of
// vy.use, a kill switch and a pause. A model call already in flight finishes, but storing its text needs a live run, so it is discarded.
export async function cancelMemberVyRuns(ctx: Pick<CommandContext, 'trx'>, filter: { agentIds?: readonly string[]; userId?: string; module?: string }, reason: string): Promise<number> {
  const agents = filter.agentIds && filter.agentIds.length > 0 ? `{${filter.agentIds.join(',')}}` : null;
  const { rows } = await sql<{ n: string }>`
    SELECT crove_kernel.member_vy_runs_cancel(${agents}::uuid[], ${filter.userId ?? null}::uuid, ${filter.module ?? null}::text, ${reason}::text) AS n`.execute(ctx.trx);
  return Number(rows[0]?.n ?? 0);
}

// After a change that can take vy.use away from a member (a deny, a revoked role, a demotion): their live runs end unless they still hold it.
export async function cancelMemberVyRunsUnlessAllowed(ctx: Pick<CommandContext, 'trx' | 'orgId'>, userId: string, reason: string): Promise<number> {
  const { rows } = await sql<{ ok: boolean }>`SELECT crove_kernel.member_has_permission(${ctx.orgId}::uuid, ${userId}::uuid, 'vy.use') AS ok`.execute(ctx.trx);
  return rows[0]?.ok === true ? 0 : cancelMemberVyRuns(ctx, { userId }, reason);
}

export const memberVyRunStart = defineCommand({
  name: 'kernel.member_vy.run.start',
  input: z.object({ feature: z.enum(FEATURE_KEYS), subjectType: z.string().min(1).max(100), subjectId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBER_ROLES,
  handler: async (ctx, input): Promise<{ runId: string; resultId: string; expiresAt: string }> => {
    const userId = requireUser(ctx);
    if (!(await mayUseVy(ctx))) throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    const feature = MEMBER_VY_FEATURES[input.feature];
    let agent = await ctx.trx
      .selectFrom('crove_kernel.agent')
      .select(['id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('kind', '=', 'member_vy')
      .where('member_user_id', '=', userId)
      .executeTakeFirst();
    if (agent && agent.status !== 'active') throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    if ((await stopped(ctx, feature.module, agent?.id ?? null)) || (await budgetSpent(ctx, feature.module, agent?.id ?? null))) throw aiOff();
    if (!agent) {
      agent = await ctx.trx
        .insertInto('crove_kernel.agent')
        .values({ org_id: ctx.orgId, template_key: 'kernel.member_vy', display_name: 'Vy', kind: 'member_vy', member_user_id: userId, created_by: userId })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
    }
    // A run abandoned by a crashed request does not block the next one: the member has one run at a time.
    await ctx.trx
      .updateTable('crove_kernel.ai_run')
      .set({ status: 'cancelled', finished_at: ctx.now, error: 'RUN_SUPERSEDED' })
      .where('org_id', '=', ctx.orgId)
      .where('agent_id', '=', agent.id)
      .where('status', '=', 'running')
      .execute();
    const expiresAt = new Date(ctx.now.getTime() + feature.expiryMinutes * 60_000);
    const run = await ctx.trx
      .insertInto('crove_kernel.ai_run')
      .values({ org_id: ctx.orgId, agent_id: agent.id, module: feature.module, status: 'running', tainted: true, started_at: ctx.now, expires_at: expiresAt })
      .returning('id')
      .executeTakeFirstOrThrow();
    const result = await ctx.trx
      .insertInto('crove_kernel.member_vy_result')
      .values({
        org_id: ctx.orgId,
        member_user_id: userId,
        run_id: run.id,
        feature: input.feature,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        status: 'running',
        expires_at: new Date(ctx.now.getTime() + RESULT_DAYS * 86_400_000),
        created_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ run_id: run.id, result_id: result.id, feature: input.feature, module: feature.module });
    return { runId: run.id, resultId: result.id, expiresAt: expiresAt.toISOString() };
  },
});

const zOutcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), body: z.string().min(1).max(MAX_BODY), sourceRevision: z.number().int().min(0).max(2_000_000_000).optional() }),
  z.object({ status: z.literal('failed'), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }),
]);

export const memberVyResultStore = defineCommand({
  name: 'kernel.member_vy.result.store',
  input: z.object({ runId: zId, outcome: zOutcome }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBER_ROLES,
  writes: STORE_WRITES,
  // Also the background run of the member's Vy (ADR-0049 stage B): the worker enters the member's context, and the runtime ran the entry's checks
  // (the member active, vy.use held, no kill switch, no spent budget) before this handler.
  memberVy: { taint: 'propagate' },
  target: (input) => ({ type: 'kernel.ai_run', id: input.runId }),
  handler: async (ctx, input): Promise<{ stored: boolean; status: 'ready' | 'failed' }> => {
    // In member mode the member is the one the context was sealed for; in the member's own session it is the user, who must still hold vy.use.
    const background = ctx.memberVy !== null;
    const userId = ctx.memberVy ? ctx.memberVy.memberUserId : requireUser(ctx);
    // A background run stores into the one run its context was sealed for, never another run of the same member.
    if (ctx.memberVy && input.runId !== ctx.memberVy.runId) throw new DomainError('FORBIDDEN', 403, 'Lượt chạy này không phải của ngữ cảnh hiện tại', { rule: 'member_vy_context' });
    if (!background && !(await mayUseVy(ctx))) throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    // The run must be this member's own Vy run, still running and not expired, and have its result row waiting.
    const run = await ctx.trx
      .selectFrom('crove_kernel.ai_run as r')
      .innerJoin('crove_kernel.agent as a', (j) => j.onRef('a.org_id', '=', 'r.org_id').onRef('a.id', '=', 'r.agent_id'))
      .select(['r.id', 'r.module', 'r.agent_id', 'r.status', 'r.expires_at'])
      .where('r.org_id', '=', ctx.orgId)
      .where('r.id', '=', input.runId)
      .where('a.kind', '=', 'member_vy')
      .where('a.member_user_id', '=', userId)
      .forUpdate('r')
      .executeTakeFirst();
    const result = run
      ? await ctx.trx
          .selectFrom('crove_kernel.member_vy_result')
          .select(['id', 'subject_type', 'subject_id', 'status'])
          .where('org_id', '=', ctx.orgId)
          .where('run_id', '=', input.runId)
          .where('member_user_id', '=', userId)
          .executeTakeFirst()
      : undefined;
    if (!run || !result || run.status !== 'running' || run.expires_at <= ctx.now || result.status !== 'running') {
      throw new DomainError('VY_RUN_NOT_LIVE', 409, 'Lượt làm việc này của Vy đã kết thúc hoặc không còn hiệu lực');
    }
    // A kill switch or a spent budget since the run started: the text is discarded, not stored.
    const off = (await stopped(ctx, run.module, run.agent_id)) || (await budgetSpent(ctx, run.module, run.agent_id));
    const outcome = off ? ({ status: 'failed', errorCode: 'AI_STOPPED' } as const) : input.outcome;
    // The flag is the kernel's, never the caller's, and it only ever goes up: a result is inserted private (the member's own text from a
    // subject that is private or whose visibility is unknown) and stays so; a module that can show a subject is org-visible would lower the
    // insert default in its own reviewed change, never here. A run that reads the member's memory or an earlier result inherits the flag.
    const privateRead = true;
    // Each update is guarded by the status it expects and must touch exactly one row: a cancel that committed between the checks above and here
    // (the run row is locked FOR UPDATE, in the order the cancel definer takes its locks: run, then result) leaves nothing to write.
    const wrote = await ctx.trx
      .updateTable('crove_kernel.member_vy_result')
      .set(
        outcome.status === 'ready'
          ? { status: 'ready', body: outcome.body, error_code: null, source_revision: outcome.sourceRevision ?? null, private_read: privateRead }
          : { status: 'failed', body: null, error_code: outcome.errorCode, private_read: privateRead },
      )
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', result.id)
      .where('status', '=', 'running')
      .executeTakeFirst();
    // In the background the run is closed by the worker afterwards, never here: a member-mode context writes no ai_run row.
    const closed = background
      ? null
      : await ctx.trx
          .updateTable('crove_kernel.ai_run')
          .set({ status: outcome.status === 'ready' ? 'succeeded' : 'failed', finished_at: ctx.now, error: outcome.status === 'failed' ? outcome.errorCode : null, private_read: privateRead })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', run.id)
          .where('status', '=', 'running')
          .executeTakeFirst();
    if (wrote.numUpdatedRows !== 1n || (closed !== null && closed.numUpdatedRows !== 1n)) {
      throw new DomainError('VY_RUN_NOT_LIVE', 409, 'Lượt làm việc này của Vy đã kết thúc hoặc không còn hiệu lực');
    }
    // Ids, an enum and numbers only. The background context's audit rows are checked by the write guard against exactly these shapes (camel-case keys).
    if (background) ctx.audit({ runId: run.id, resultId: result.id, status: outcome.status, bodyLength: outcome.status === 'ready' ? outcome.body.length : 0 });
    else ctx.audit({ run_id: run.id, result_id: result.id, status: outcome.status, private_read: privateRead, body_length: outcome.status === 'ready' ? outcome.body.length : 0 });
    return { stored: outcome.status === 'ready', status: outcome.status };
  },
});

export const memberVyMemorySave = defineCommand({
  name: 'kernel.member_vy.memory.save',
  input: z.object({ id: zId.optional(), body: z.string().min(1).max(2000) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBER_ROLES,
  target: (input) => ({ type: 'kernel.member_vy_memory', id: input.id ?? '00000000-0000-0000-0000-000000000000' }),
  handler: async (ctx, input): Promise<{ id: string }> => {
    const userId = requireUser(ctx);
    if (input.id) {
      const updated = await ctx.trx
        .updateTable('crove_kernel.member_vy_memory')
        .set({ body: input.body, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.id)
        .where('member_user_id', '=', userId)
        .returning('id')
        .executeTakeFirst();
      if (!updated) throw new DomainError('MEMORY_NOT_FOUND', 404, 'Không tìm thấy mục ghi nhớ này');
      ctx.audit({ memory_id: updated.id, created: false, body_length: input.body.length });
      return { id: updated.id };
    }
    const created = await ctx.trx
      .insertInto('crove_kernel.member_vy_memory')
      .values({ org_id: ctx.orgId, member_user_id: userId, body: input.body })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ memory_id: created.id, created: true, body_length: input.body.length });
    return { id: created.id };
  },
});

export const memberVyMemoryDelete = defineCommand({
  name: 'kernel.member_vy.memory.delete',
  input: z.object({ id: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBER_ROLES,
  target: (input) => ({ type: 'kernel.member_vy_memory', id: input.id }),
  handler: async (ctx, input): Promise<{ deleted: boolean }> => {
    const userId = requireUser(ctx);
    const gone = await ctx.trx
      .deleteFrom('crove_kernel.member_vy_memory')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .where('member_user_id', '=', userId)
      .returning('id')
      .executeTakeFirst();
    ctx.audit({ memory_id: input.id, deleted: gone !== undefined });
    return { deleted: gone !== undefined };
  },
});

export const memberVyResultGet = defineQuery({
  name: 'kernel.member_vy.result.get',
  input: z.object({ runId: zId }),
  access: MEMBER_ROLES,
  handler: async (ctx: QueryContext, input) => {
    const userId = requireUser(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.member_vy_result')
      .select(['id', 'run_id', 'feature', 'subject_type', 'subject_id', 'status', 'error_code', 'source_revision', 'body', 'tainted', 'private_read', 'created_at', 'expires_at'])
      .where('org_id', '=', ctx.orgId)
      .where('run_id', '=', input.runId)
      .where('member_user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new DomainError('RESULT_NOT_FOUND', 404, 'Không tìm thấy kết quả này');
    return {
      id: row.id,
      runId: row.run_id,
      feature: row.feature,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      status: row.status,
      errorCode: row.error_code,
      sourceRevision: row.source_revision,
      body: row.body,
      tainted: row.tainted,
      privateRead: row.private_read,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    };
  },
});

export const memberVyMemoryList = defineQuery({
  name: 'kernel.member_vy.memory.list',
  input: z.object({}),
  access: MEMBER_ROLES,
  handler: async (ctx: QueryContext) => {
    const userId = requireUser(ctx);
    const rows = await ctx.trx
      .selectFrom('crove_kernel.member_vy_memory')
      .select(['id', 'body', 'created_at', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('member_user_id', '=', userId)
      .orderBy('created_at')
      .execute();
    return { entries: rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() })) };
  },
});

// The meter's two doors for a member-Vy call (decision 6). The agent is the kernel's: the member's own Vy, derived from the sealed user and
// never from the input, so a cap cannot be dodged with another agent id or null, and spend is never charged to another member's agent.
async function ownAgent(ctx: Pick<QueryContext, 'trx' | 'orgId'>, userId: string): Promise<string | null> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.agent')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('kind', '=', 'member_vy')
    .where('member_user_id', '=', userId)
    .executeTakeFirst();
  return row?.id ?? null;
}

export type MemberVyMeterCheck = { allowed: true } | { allowed: false; scope: 'org' | 'module' | 'agent'; retryAt: string };

export const memberVyMeterCheck = defineQuery({
  name: 'kernel.member_vy.meter.check',
  input: z.object({ feature: z.enum(FEATURE_KEYS) }),
  access: MEMBER_ROLES,
  handler: async (ctx: QueryContext, input): Promise<MemberVyMeterCheck> => {
    const userId = requireUser(ctx);
    if (!(await mayUseVy(ctx))) throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    const module = MEMBER_VY_FEATURES[input.feature].module;
    const agentId = await ownAgent(ctx, userId);
    const retryAt = (
      await sql<{ retry_at: Date }>`SELECT ((pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + pg_catalog.make_interval(months => 1)) AT TIME ZONE 'Asia/Ho_Chi_Minh') AS retry_at`.execute(ctx.trx)
    ).rows[0]?.retry_at.toISOString() as string;
    // The four kill switches: the org's, the module's, the agent's and the operator's global switch for AI.
    const { rows: switches } = await sql<{ scope: 'org' | 'module' | 'agent' | null; global: boolean }>`
      SELECT (SELECT k.scope FROM crove_kernel.kill_switch k
              WHERE k.org_id = ${ctx.orgId}::uuid AND k.released_at IS NULL
                AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = ${module}) OR (k.scope = 'agent' AND k.target = ${agentId}::text))
              ORDER BY CASE k.scope WHEN 'agent' THEN 0 WHEN 'module' THEN 1 ELSE 2 END LIMIT 1) AS scope,
             crove_kernel.global_kill_switch_on('ai') AS global`.execute(ctx.trx);
    if (switches[0]?.scope) return { allowed: false, scope: switches[0].scope, retryAt };
    if (switches[0]?.global) return { allowed: false, scope: 'org', retryAt };
    const { rows } = await sql<{ scope: 'org' | 'module' | 'agent' | null }>`
      SELECT (SELECT b.scope FROM crove_kernel.budget_policy b
              WHERE b.org_id = ${ctx.orgId}::uuid AND b.hard_stop
                AND (b.scope = 'org' OR (b.scope = 'module' AND b.target = ${module}) OR (b.scope = 'agent' AND b.target = ${agentId}::text))
                AND crove_kernel.ai_budget_spent(b.org_id, b.scope, b.target) >= b.monthly_limit
              ORDER BY CASE b.scope WHEN 'agent' THEN 0 WHEN 'module' THEN 1 ELSE 2 END LIMIT 1) AS scope`.execute(ctx.trx);
    return rows[0]?.scope ? { allowed: false, scope: rows[0].scope, retryAt } : { allowed: true };
  },
});

export const memberVyMeterRecord = defineCommand({
  name: 'kernel.member_vy.meter.record',
  input: z.object({
    feature: z.enum(FEATURE_KEYS),
    inputTokens: z.number().int().min(0).max(100_000_000),
    outputTokens: z.number().int().min(0).max(100_000_000),
    cost: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBER_ROLES,
  handler: async (ctx, input): Promise<{ recorded: boolean }> => {
    const userId = requireUser(ctx);
    const agentId = await ownAgent(ctx, userId);
    if (!agentId) throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    const module = MEMBER_VY_FEATURES[input.feature].module;
    await ctx.trx
      .insertInto('crove_kernel.org_usage')
      .values({ org_id: ctx.orgId, metric: 'ai_cost', amount: input.cost, feature: input.feature, module, agent_id: agentId, input_tokens: input.inputTokens, output_tokens: input.outputTokens })
      .execute();
    ctx.audit({ feature: input.feature, module, agent: agentId, inputTokens: input.inputTokens, outputTokens: input.outputTokens, cost: input.cost });
    return { recorded: true };
  },
});

export const memberVyCommands = [memberVyRunStart, memberVyResultStore, memberVyMemorySave, memberVyMemoryDelete, memberVyMeterRecord];
export const memberVyQueries = [memberVyResultGet, memberVyMemoryList, memberVyMeterCheck];
