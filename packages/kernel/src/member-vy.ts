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
  // The recorder's Vy transcribing one meeting in the background (#2578, M4b): the longest run, so the 4 hour cap of the kernel.
  'meetings.transcribe': { module: 'meetings', expiryMinutes: 240 },
  // The recorder's Vy summarizing one meeting in the foreground (#2580, M6): one model call over the transcript, the member waiting for it.
  'meetings.summary': { module: 'meetings', expiryMinutes: 30 },
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
    // A run abandoned by a crashed request does not block the next one: a member has one live run PER FEATURE (ADR-0049 decision 1, amended 2026-11-12, #3029), so a start
    // supersedes only a running run of the same feature. A run of another feature (a transcription that is still going) is left alone. A run whose result is already stored
    // `ready` (the worker has not closed it yet, or died before it did) is not superseded but closed as succeeded, as the worker's finish would, with the result's private_read
    // carried over (#3058): never a superseded run beside a ready result. The run row is locked first, then its result (the order of the store and the finish), and the result is
    // read in a statement of its own, so a store in progress is waited for and its committed result seen.
    const live = await ctx.trx
      .selectFrom('crove_kernel.ai_run')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('agent_id', '=', agent.id)
      .where('feature', '=', input.feature)
      .where('status', '=', 'running')
      .orderBy('id')
      .forUpdate()
      .execute();
    for (const old of live) {
      const stored = await ctx.trx
        .selectFrom('crove_kernel.member_vy_result')
        .select(['status', 'private_read'])
        .where('org_id', '=', ctx.orgId)
        .where('run_id', '=', old.id)
        .where('member_user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (stored?.status === 'ready') {
        await ctx.trx
          .updateTable('crove_kernel.ai_run')
          .set({ status: 'succeeded', finished_at: ctx.now, error: null, ...(stored.private_read ? { private_read: true } : {}) })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', old.id)
          .where('status', '=', 'running')
          .execute();
      } else {
        await ctx.trx
          .updateTable('crove_kernel.ai_run')
          .set({ status: 'cancelled', finished_at: ctx.now, error: 'RUN_SUPERSEDED' })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', old.id)
          .where('status', '=', 'running')
          .execute();
      }
    }
    const expiresAt = new Date(ctx.now.getTime() + feature.expiryMinutes * 60_000);
    // Two starts of one feature at the same moment: both see no live run, and the unique index (ai_run_one_running_feature_uq) lets one insert through. The other is told to
    // try again (a savepoint keeps the transaction usable for the refusal), never left with two running runs.
    await sql`SAVEPOINT member_vy_run_start`.execute(ctx.trx);
    let run: { id: string };
    try {
      run = await ctx.trx
        .insertInto('crove_kernel.ai_run')
        .values({ org_id: ctx.orgId, agent_id: agent.id, module: feature.module, feature: input.feature, status: 'running', tainted: true, started_at: ctx.now, expires_at: expiresAt })
        .returning('id')
        .executeTakeFirstOrThrow();
    } catch (error: unknown) {
      const e = error as { code?: string; constraint?: string };
      if (e.code === '23505' && (e.constraint === 'ai_run_one_running_feature_uq' || e.constraint === 'ai_run_one_running_agent_uq')) {
        await sql`ROLLBACK TO SAVEPOINT member_vy_run_start`.execute(ctx.trx);
        throw new DomainError('VY_RUN_BUSY', 409, 'Vy đang làm việc này cho bạn; hãy thử lại sau ít giây');
      }
      throw error;
    }
    await sql`RELEASE SAVEPOINT member_vy_run_start`.execute(ctx.trx);
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

// The member ends their own running run (#3033): a lost job otherwise holds the member's slot for the feature until the run expires (up to 4 hours for a meeting) and the member
// has no way to free it. Only a running run of the caller's own Vy: another member's run, a finished run and an unknown id all answer `cancelled: false` the same way, so the answer
// tells nothing about a run that is not theirs. It does what the start's supersede and the result store already do in the member's own context (the run is cancelled with the fixed word
// RUN_CANCELLED, its result row fails with the same word); a model call already in flight finishes but cannot store its text, since a store needs a live run.
export const memberVyRunCancel = defineCommand({
  name: 'kernel.member_vy.run.cancel',
  input: z.object({ runId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBER_ROLES,
  target: (input) => ({ type: 'kernel.ai_run', id: input.runId }),
  handler: async (ctx, input): Promise<{ cancelled: boolean }> => {
    const userId = requireUser(ctx);
    const agent = await ctx.trx
      .selectFrom('crove_kernel.agent')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('kind', '=', 'member_vy')
      .where('member_user_id', '=', userId)
      .executeTakeFirst();
    if (!agent) return { cancelled: false };
    // The run row is locked first, the same order the result store and the worker's finish take (run, then result), so a store in progress is waited for. A background run's
    // text is stored as `ready` in one transaction and the run is closed in another (the worker's run.finish): in the gap the run still reads `running`, and cancelling it then would
    // leave a cancelled run beside a ready result, which the finish definer says never to record. So the result is read after the lock, in a statement of its own (READ COMMITTED
    // sees what the store committed), and a result that is no longer running leaves the run to the worker's finish: `cancelled: false`.
    const run = await ctx.trx
      .selectFrom('crove_kernel.ai_run')
      .select(['id', 'feature'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.runId)
      .where('agent_id', '=', agent.id)
      .where('status', '=', 'running')
      .forUpdate()
      .executeTakeFirst();
    if (!run) return { cancelled: false };
    const result = await ctx.trx
      .selectFrom('crove_kernel.member_vy_result')
      .select('status')
      .where('org_id', '=', ctx.orgId)
      .where('run_id', '=', input.runId)
      .where('member_user_id', '=', userId)
      .executeTakeFirst();
    if (result && result.status !== 'running') return { cancelled: false };
    await ctx.trx
      .updateTable('crove_kernel.ai_run')
      .set({ status: 'cancelled', finished_at: ctx.now, error: 'RUN_CANCELLED' })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.runId)
      .where('agent_id', '=', agent.id)
      .where('status', '=', 'running')
      .execute();
    await ctx.trx
      .updateTable('crove_kernel.member_vy_result')
      .set({ status: 'failed', error_code: 'RUN_CANCELLED' })
      .where('org_id', '=', ctx.orgId)
      .where('run_id', '=', input.runId)
      .where('member_user_id', '=', userId)
      .where('status', '=', 'running')
      .execute();
    ctx.audit({ run_id: input.runId, feature: run.feature });
    return { cancelled: true };
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

// Whether the caller has a run of this feature going (and, with a subject, for that subject): a feature that must not cut off a paid run asks this instead of
// reading the private result rows itself (#2941). The caller's own rows only (the user's own member id is the filter and the rows are sealed to it); no text, no
// id, no subject comes back.
export const memberVyRunLive = defineQuery({
  name: 'kernel.member_vy.run.live',
  input: z.object({ feature: z.enum(FEATURE_KEYS), subjectId: zId.optional() }),
  access: MEMBER_ROLES,
  handler: async (ctx: QueryContext, input): Promise<{ live: boolean }> => {
    const userId = requireUser(ctx);
    let query = ctx.trx
      .selectFrom('crove_kernel.member_vy_result as v')
      .innerJoin('crove_kernel.ai_run as r', (j) => j.onRef('r.org_id', '=', 'v.org_id').onRef('r.id', '=', 'v.run_id'))
      .select('v.id')
      .where('v.org_id', '=', ctx.orgId)
      .where('v.member_user_id', '=', userId)
      .where('v.feature', '=', input.feature)
      .where('v.status', '=', 'running')
      .where('r.status', '=', 'running')
      .where('r.expires_at', '>', new Date());
    if (input.subjectId !== undefined) query = query.where('v.subject_id', '=', input.subjectId);
    return { live: (await query.executeTakeFirst()) !== undefined };
  },
});

// The state of the caller's latest run of a feature for one subject, for a screen (#2941): the run id, its state, the fixed error word and when it expires, and
// nothing else (never a body, never a subject). A run that was left running when its run ended or expired shows as failed with RUN_ENDED, never as running for ever.
export const memberVyRunLatest = defineQuery({
  name: 'kernel.member_vy.run.latest',
  input: z.object({ feature: z.enum(FEATURE_KEYS), subjectType: z.string().min(1).max(40), subjectId: zId }),
  access: MEMBER_ROLES,
  handler: async (ctx: QueryContext, input): Promise<{ runId: string; state: 'running' | 'ready' | 'failed'; errorCode: string | null; expiresAt: string } | null> => {
    const userId = requireUser(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.member_vy_result as v')
      .leftJoin('crove_kernel.ai_run as r', (j) => j.onRef('r.org_id', '=', 'v.org_id').onRef('r.id', '=', 'v.run_id'))
      .select(['v.run_id', 'v.status', 'v.error_code', 'v.expires_at', 'r.status as run_status', 'r.expires_at as run_expires_at'])
      .where('v.org_id', '=', ctx.orgId)
      .where('v.member_user_id', '=', userId)
      .where('v.feature', '=', input.feature)
      .where('v.subject_type', '=', input.subjectType)
      .where('v.subject_id', '=', input.subjectId)
      .orderBy('v.created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row || !['running', 'ready', 'failed'].includes(row.status)) return null;
    const dead = row.status === 'running' && (row.run_status !== 'running' || (row.run_expires_at !== null && row.run_expires_at <= new Date()));
    return {
      runId: row.run_id,
      state: dead ? 'failed' : (row.status as 'running' | 'ready' | 'failed'),
      errorCode: dead ? 'RUN_ENDED' : row.error_code,
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

// The fixed words a background run of a member's Vy may close under (ai_run.error): the codes its callers emit and nothing else (#2822 part 3b). The database
// holds the same list (crove_kernel.member_vy_run_error_code_ok, migration 20261215020000) and refuses any other; a unit test ties the two together. A caller maps a
// failure it has no word for to TRANSCRIBE_FAILED (failureCode in apps/kernel/src/meetings-transcribe.ts), never invents one.
export const MEMBER_VY_RUN_ERROR_CODES = [
  'AGENT_FORBIDDEN',
  'AGENT_NOT_ACTIVE',
  'AGENT_NOT_MEMBER_VY',
  'AGENT_RUN_NOT_LIVE',
  'AI_BUDGET_EXHAUSTED',
  'AI_STOPPED',
  'AUDIO_NOT_FOUND',
  'FORBIDDEN',
  'MEDIA_KEY_SHREDDED',
  'MEDIA_KEY_UNAVAILABLE',
  'MEETING_NO_AUDIO',
  'MEETING_NOT_FOUND',
  'MEMBER_NOT_ACTIVE',
  'NOT_A_MEMBER',
  'RUN_CANCELLED',
  'TENANT_NOT_ACTIVE',
  'TRANSCRIBE_AUTH',
  'TRANSCRIBE_FAILED',
  'TRANSCRIBE_INVALID_REQUEST',
  'TRANSCRIBE_INVALID_RESPONSE',
  'TRANSCRIBE_NETWORK',
  'TRANSCRIBE_RATE_LIMIT',
  'TRANSCRIBE_TIMEOUT',
  'TRANSCRIBE_UNAVAILABLE',
  'TRANSCRIPT_EMPTY',
  'TRANSCRIPT_RESULT_INVALID',
  'TRANSCRIPT_TOO_LONG',
  'VY_NOT_ALLOWED',
] as const;
export type MemberVyRunErrorCode = (typeof MEMBER_VY_RUN_ERROR_CODES)[number];

// The worker closes the run of a member's background Vy after the member-mode store wrote the result (the context of a member never writes ai_run):
// the system command of the worker login, through crove_kernel.member_vy_run_finish, which refuses every other caller and answers whether it closed a
// run that was still running. The status and the code are fixed words, never text (the definer checks the code's shape).
export const memberVyRunFinish = defineCommand({
  name: 'kernel.member_vy.run.finish',
  // The status is left out to have it derived from the result (a ready result succeeded, anything else failed); only a cancel says so. The code is one of
  // the definer's fixed words (crove_kernel.member_vy_run_error_code_ok), which refuses any other.
  input: z.object({ runId: zId, status: z.enum(['succeeded', 'failed', 'cancelled']).optional(), errorCode: z.enum(MEMBER_VY_RUN_ERROR_CODES).nullable() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.ai_run', id: input.runId }),
  handler: async (ctx, input): Promise<{ closed: boolean }> => {
    const { rows } = await sql<{ closed: boolean }>`
      SELECT crove_kernel.member_vy_run_finish(${input.runId}::uuid, ${input.status ?? null}::text, ${input.errorCode}::text) AS closed`.execute(ctx.trx);
    const closed = rows[0]?.closed === true;
    ctx.audit({ run_id: input.runId, status: input.status ?? 'derived', closed });
    return { closed };
  },
});

// The admit of a background run (ADR-0049 decision 6): entering the member-scoped context re-checks the member, vy.use, the org, module and agent kill
// switches, the global ai switch, the hard-stop budget and that the run is live, so a feature calls this before each model call and the entry is the check.
// It answers nothing but ok.
//
// A call that costs a known amount (a transcription chunk: its measured seconds times the price per second) also sends that `projectedCost`, and the check refuses the call
// before it is made when it would REACH a hard-stop budget (#2863 item 8): spent + projected >= the limit, the entry's own rule (spent >= limit) applied to the spend the call
// would leave, so a run no longer overruns by up to one chunk. A call that would land exactly on the limit is refused too: the budget would then be spent, and the store of the
// run's result (its own entry) would be refused, so the paid text would be thrown away. Only hard stops count, as in ai_budget_exhausted; a soft budget never refuses. The module
// and the agent are the run's own, from the sealed context and never from the input, so a call cannot name another target to dodge a budget. A missing or zero projection is the
// entry's check alone. The sum is decimal arithmetic in the database (numeric), never a JS number. A refusal is the entry's own code, BUDGET_EXHAUSTED, naming the scope as meter.check does.
// At most 1e9, six decimals (the cap the Platform PO asked for); anything else is refused by the input check.
const PROJECTED_COST = z.string().regex(/^(?:\d{1,9}(?:\.\d{1,6})?|1000000000(?:\.0{1,6})?)$/);
const ZERO_COST = /^0+(?:\.0+)?$/;

export const memberVyRunCheck = defineQuery({
  name: 'kernel.member_vy.run.check',
  input: z.object({ projectedCost: PROJECTED_COST.optional() }),
  access: MEMBER_ROLES,
  memberVy: { reads: [] },
  handler: async (ctx: QueryContext, input): Promise<{ ok: true }> => {
    const projected = input.projectedCost;
    if (projected === undefined || ZERO_COST.test(projected)) return { ok: true };
    if (!ctx.memberVy) throw new DomainError('FORBIDDEN', 403, 'Chỉ lượt chạy nền của Vy mới kiểm tra được chi phí dự kiến', { rule: 'member_vy_context' });
    const { module, agentId } = ctx.memberVy;
    const { rows } = await sql<{ scope: 'org' | 'module' | 'agent' | null }>`
      SELECT (SELECT b.scope FROM crove_kernel.budget_policy b
              WHERE b.org_id = ${ctx.orgId}::uuid AND b.hard_stop
                AND (b.scope = 'org' OR (b.scope = 'module' AND b.target = ${module}) OR (b.scope = 'agent' AND b.target = ${agentId}::text))
                AND crove_kernel.ai_budget_spent(b.org_id, b.scope, b.target) + ${projected}::numeric >= b.monthly_limit
              ORDER BY CASE b.scope WHEN 'agent' THEN 0 WHEN 'module' THEN 1 ELSE 2 END LIMIT 1) AS scope`.execute(ctx.trx);
    const scope = rows[0]?.scope;
    if (scope) throw new DomainError('BUDGET_EXHAUSTED', 422, 'Vy đã hết ngân sách tháng này', { scope });
    return { ok: true };
  },
});

// The recorder's own recording, for the recorder's own transcription run (ADR-0049 decision 8, #2578): the file ids, the order, the offsets and lengths and the
// wrapped key of ONE meeting's audio, never plaintext (the worker fetches and decrypts). The database function crove_meetings.audio_for_member_vy is the gate:
// it answers only in this run's own context, for the meeting the run's result row names, when the run's member is that meeting's recorder and is active. The
// file rows (visible to every member of the org) are then read by exactly the ids it returned. It is a command, not a query, so that the read is audited (ids and
// a count; the runtime audits no read of a member-scoped context, and a sensitive query is refused to an agent): the one memberVy command beside the store.
export const memberVyMeetingAudioOpen = defineCommand({
  name: 'kernel.member_vy.meeting_audio.open',
  input: z.object({ meetingId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin', 'member'],
  writes: [],
  memberVy: { taint: 'propagate' },
  handler: async (ctx, input) => {
    if (!ctx.memberVy) throw new DomainError('FORBIDDEN', 403, 'Chỉ lượt chạy nền của Vy mới đọc được bản ghi này', { rule: 'member_vy_context' });
    type Row = { segment_order: number; start_offset_seconds: number; length_seconds: number; file_id: string; is_english: boolean; key_id: string; wrapped_key: Buffer };
    let rows: Row[];
    try {
      rows = (await sql<Row>`SELECT * FROM crove_meetings.audio_for_member_vy(${ctx.orgId}::uuid, ${input.meetingId}::uuid)`.execute(ctx.trx)).rows;
    } catch (error: unknown) {
      const code = /MEETINGS_(RUN_REQUIRED|NOT_RECORDER|KEY_SHREDDED|WORKER_ONLY|AUDIO_EXPIRED)/.exec(error instanceof Error ? error.message : '')?.[0];
      if (code === 'MEETINGS_KEY_SHREDDED' || code === 'MEETINGS_AUDIO_EXPIRED') throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Khóa giải mã của bản ghi đã bị hủy');
      if (code) throw new DomainError('FORBIDDEN', 403, 'Lượt chạy này không đọc được bản ghi của cuộc họp này');
      throw error;
    }
    const first = rows[0];
    if (!first) throw new DomainError('AUDIO_NOT_FOUND', 404, 'Cuộc họp này chưa có âm thanh');
    const files = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'storage_key', 'generation', 'size_bytes', 'sha256', 'content_type'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', rows.map((r) => r.file_id))
      .execute();
    const byId = new Map(files.map((f) => [f.id, f]));
    ctx.audit({ runId: ctx.memberVy.runId, subjectId: input.meetingId, count: rows.length });
    return {
      language: first.is_english ? 'en' : 'vi',
      keyId: first.key_id,
      wrappedKey: first.wrapped_key,
      segments: rows.map((r) => {
        const file = byId.get(r.file_id);
        if (!file) throw new DomainError('AUDIO_NOT_FOUND', 404, 'Không thấy tệp âm thanh của cuộc họp này');
        return {
          order: r.segment_order,
          startOffsetSeconds: r.start_offset_seconds,
          lengthSeconds: r.length_seconds,
          fileId: r.file_id,
          storageKey: file.storage_key,
          generation: file.generation,
          sizeBytes: Number(file.size_bytes),
          sha256: file.sha256,
          contentType: file.content_type,
        };
      }),
    };
  },
});

// The sweeps of a member's private Vy data (ADR-0049 decision 3, #2822), the system commands of the worker's daily member-vy-sweep job: results past
// their expires_at, and a former member's results and memory. Both reach the rows only through definers that answer a count, never text; the audit
// carries counts and ids. The worker finds the orgs and the users to ask about through crove_kernel.member_vy_results_due and member_vy_former_members_due.
// The sweep commands run as the worker's system actor only: the access list already says so, and the handler says it again, so a loosened access never opens them to a person.
function requireSystem(ctx: Pick<CommandContext, 'actor'>): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình nền mới dọn được dữ liệu riêng của Vy');
}

const EXPIRE_BATCH = 1000;
// Batches one run removes at most (1,000 results each): the rest wait for the next night, so one org cannot hold the worker.
const EXPIRE_MAX_BATCHES = 50;

export const memberVyResultsExpire = defineCommand({
  name: 'kernel.vy_data.results.expire',
  input: z.strictObject({}),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  handler: async (ctx): Promise<{ removed: number }> => {
    requireSystem(ctx);
    let removed = 0;
    for (let batch = 0; batch < EXPIRE_MAX_BATCHES; batch += 1) {
      const { rows } = await sql<{ n: string }>`SELECT crove_kernel.member_vy_results_expire(${EXPIRE_BATCH}::int) AS n`.execute(ctx.trx);
      const n = Number(rows[0]?.n ?? 0);
      removed += n;
      if (n < EXPIRE_BATCH) break;
    }
    ctx.audit({ removed });
    return { removed };
  },
});

export const memberVyMemberDataPurge = defineCommand({
  name: 'kernel.vy_data.member_data.purge',
  input: z.strictObject({ userId: zId }),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  handler: async (ctx, input): Promise<{ removed: number }> => {
    requireSystem(ctx);
    const { rows } = await sql<{ n: string }>`SELECT crove_kernel.member_vy_member_data_purge(${ctx.orgId}::uuid, ${input.userId}::uuid) AS n`.execute(ctx.trx);
    const removed = Number(rows[0]?.n ?? 0);
    ctx.audit({ userId: input.userId, removed });
    return { removed };
  },
});

export const memberVyCommands = [memberVyRunStart, memberVyRunCancel, memberVyResultStore, memberVyMemorySave, memberVyMemoryDelete, memberVyMeterRecord, memberVyRunFinish, memberVyMeetingAudioOpen, memberVyResultsExpire, memberVyMemberDataPurge];
export const memberVyQueries = [memberVyResultGet, memberVyMemoryList, memberVyMeterCheck, memberVyRunCheck, memberVyRunLive, memberVyRunLatest];
