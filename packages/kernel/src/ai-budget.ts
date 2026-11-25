// SPDX-License-Identifier: AGPL-3.0-only
// The AI budget meter's side of the database (#2382, ADR-0029 section 7). One ledger and one set of limits, both older
// than the meter: ludy_kernel.org_usage (metric 'ai_cost', one row per model call with its feature, module, agent and
// tokens: ids and counts only, never a prompt, a document's text or an answer) and ludy_kernel.budget_policy (the
// monthly limit of the org, a module or an agent; set by kernel.agent.budget.set, R3, owner only, with a fresh second
// factor). What a budget has spent is ludy_kernel.ai_budget_spent, the one function the agent run gates and this meter
// read, so the numbers cannot disagree. The month is the calendar month in Asia/Ho_Chi_Minh.
//
// The worker (as the system) and the API (as the member who asked) reserve against covering hard-stop budgets under an
// org-scoped advisory transaction lock before a model call begins (@ludy/agent's metered(), through the AiMeter the
// caller's scope carries), release that reservation atomically when recording what the call used, and release it early
// if the call fails without usage (unsettled holds expire after 10 minutes). Nothing else is gated: posting, reading,
// approving, exports and the deterministic checks never ask.
//
// The worker's sweep tells the org's owners and admins once per budget, month and level when a budget crossed its
// warning percentage or 100% (notification kind kernel.ai_budget, one key each), and gives an org with no budget of its
// own the deployment's default.
import { sql } from "kysely";
import { z } from "zod";
import {
  DomainError,
  defineCommand,
  defineQuery,
  type CommandContext,
} from "@ludy/kernel-runtime";
import type { AgentScope, MemberRole } from "@ludy/db";
import { acquireAdvisoryXactLock, advisoryLockKey } from "./advisory-lock.ts";
import { notifyMembers, ownersAndAdmins } from "./notifications.ts";

export const AI_BUDGET_NOTICE = "kernel.ai_budget";
// The user a budget the deployment's default created names as its setter: nobody.
export const DEPLOYMENT_DEFAULT_SETTER = "00000000-0000-0000-0000-000000000000";

const zAmount = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
const zFeature = z
  .string()
  .max(60)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const zModule = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/);
const zAgentId = z.uuid();
const zId = z.uuid();

export type AiBudgetCheck =
  | { allowed: true; hasOrgBudget: boolean }
  | { allowed: false; scope: AgentScope; retryAt: string };

export type AiBudgetReserve =
  | { allowed: true; reservationId: string }
  | { allowed: false; scope: AgentScope; retryAt: string };

// Acquires the per-org advisory transaction lock for AI budget admission and default-budget seeding.
export async function lockAiBudgetOrg(
  trx: CommandContext["trx"],
  orgId: string,
): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(trx);
  await acquireAdvisoryXactLock(trx, advisoryLockKey("ai.budget", orgId));
}

// Atomically sweeps expired holds, seeds defaultMonthlyBudget if permitted and missing, checks all covering hard-stop
// policies against spent + reserved + projectedCost, and inserts a 10-minute reservation hold when admitted.
export async function reserveAiBudget(
  trx: CommandContext["trx"],
  params: {
    orgId: string;
    module: string;
    agentId: string | null;
    actorUserId: string | null;
    feature: string;
    projectedCost: string;
    defaultMonthlyBudget?: string | undefined;
    allowDefaultSeed: boolean;
  },
): Promise<AiBudgetReserve> {
  await lockAiBudgetOrg(trx, params.orgId);

  await trx
    .deleteFrom("ludy_kernel.ai_budget_reservation")
    .where("org_id", "=", params.orgId)
    .where("expires_at", "<=", sql<Date>`pg_catalog.now()`)
    .execute();

  const readCheck = async () => {
    const { rows } = await sql<{
      scope: AgentScope | null;
      has_org: boolean;
      retry_at: Date;
    }>`
      SELECT
        (SELECT b.scope FROM ludy_kernel.budget_policy b
         WHERE b.org_id = ${params.orgId}::uuid AND b.hard_stop
           AND (b.scope = 'org' OR (b.scope = 'module' AND b.target = ${params.module}) OR (b.scope = 'agent' AND b.target = ${params.agentId}::text))
           AND ludy_kernel.ai_budget_spent(b.org_id, b.scope, b.target)
             + ludy_kernel.ai_budget_reserved(b.org_id, b.scope, b.target)
             + ${params.projectedCost}::numeric >= b.monthly_limit
         ORDER BY CASE b.scope WHEN 'agent' THEN 0 WHEN 'module' THEN 1 ELSE 2 END LIMIT 1) AS scope,
        EXISTS (SELECT 1 FROM ludy_kernel.budget_policy o WHERE o.org_id = ${params.orgId}::uuid AND o.scope = 'org') AS has_org,
        ((pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + pg_catalog.make_interval(months => 1)) AT TIME ZONE 'Asia/Ho_Chi_Minh') AS retry_at`.execute(
      trx,
    );
    const row = rows[0];
    if (!row) throw new Error("budget reserve check returned no row");
    return row;
  };

  let check = await readCheck();
  if (
    !check.scope &&
    !check.has_org &&
    params.allowDefaultSeed &&
    params.defaultMonthlyBudget !== undefined
  ) {
    await trx
      .insertInto("ludy_kernel.budget_policy")
      .values({
        org_id: params.orgId,
        scope: "org",
        target: "*",
        monthly_limit: params.defaultMonthlyBudget,
        warn_percent: 80,
        hard_stop: true,
        updated_by: DEPLOYMENT_DEFAULT_SETTER,
      })
      .onConflict((oc) => oc.columns(["org_id", "scope", "target"]).doNothing())
      .execute();
    check = await readCheck();
  }

  if (check.scope) {
    return {
      allowed: false,
      scope: check.scope,
      retryAt: check.retry_at.toISOString(),
    };
  }

  const inserted = await trx
    .insertInto("ludy_kernel.ai_budget_reservation")
    .values({
      org_id: params.orgId,
      module: params.module,
      agent_id: params.agentId,
      actor_user_id: params.actorUserId,
      feature: params.feature,
      amount: params.projectedCost,
      expires_at: sql<Date>`pg_catalog.now() + pg_catalog.make_interval(mins => 10)`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { allowed: true, reservationId: inserted.id };
}

// Deletes one reservation hold scoped to the caller's org, actor ownership, and optional agent scope.
export async function deleteAiBudgetReservation(
  trx: CommandContext["trx"],
  orgId: string,
  reservationId: string,
  scope: { actorUserId: string | null; agentId?: string | null },
): Promise<boolean> {
  let query = trx
    .deleteFrom("ludy_kernel.ai_budget_reservation")
    .where("org_id", "=", orgId)
    .where("id", "=", reservationId);
  query =
    scope.actorUserId === null
      ? query.where("actor_user_id", "is", null)
      : query.where("actor_user_id", "=", scope.actorUserId);
  if (scope.agentId !== undefined) {
    query =
      scope.agentId === null
        ? query.where("agent_id", "is", null)
        : query.where("agent_id", "=", scope.agentId);
  }
  const deleted = await query.returning("id").executeTakeFirst();
  return deleted !== undefined;
}

function reservationScope(
  ctx: Pick<CommandContext, "actor">,
  access: readonly MemberRole[] | "system",
): { actorUserId: string | null; agentId?: null } {
  if (access === "system") return { actorUserId: null };
  if (ctx.actor.type !== "user") {
    throw new DomainError(
      "FORBIDDEN",
      403,
      "Chỉ người dùng mới thực hiện được việc này",
    );
  }
  return { actorUserId: ctx.actor.userId, agentId: null };
}

// Whether the org may start a model call for a module (and an agent): no hard-stop budget that covers it is spent or reserved.
// hasOrgBudget says whether the org has a budget of its own, so the caller can give it the deployment's default.
const checkQuery = (name: string, access: readonly MemberRole[] | "system") =>
  defineQuery({
    name,
    input: z.strictObject({ module: zModule, agentId: zAgentId.nullable() }),
    access,
    handler: async (ctx, input): Promise<AiBudgetCheck> => {
      const { rows } = await sql<{
        scope: AgentScope | null;
        has_org: boolean;
        retry_at: Date;
      }>`
      SELECT
        (SELECT b.scope FROM ludy_kernel.budget_policy b
         WHERE b.org_id = ${ctx.orgId}::uuid AND b.hard_stop
           AND (b.scope = 'org' OR (b.scope = 'module' AND b.target = ${input.module}) OR (b.scope = 'agent' AND b.target = ${input.agentId}::text))
           AND ludy_kernel.ai_budget_spent(b.org_id, b.scope, b.target)
             + ludy_kernel.ai_budget_reserved(b.org_id, b.scope, b.target) >= b.monthly_limit
         ORDER BY CASE b.scope WHEN 'agent' THEN 0 WHEN 'module' THEN 1 ELSE 2 END LIMIT 1) AS scope,
        EXISTS (SELECT 1 FROM ludy_kernel.budget_policy o WHERE o.org_id = ${ctx.orgId}::uuid AND o.scope = 'org') AS has_org,
        ((pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + pg_catalog.make_interval(months => 1)) AT TIME ZONE 'Asia/Ho_Chi_Minh') AS retry_at`.execute(
        ctx.trx,
      );
      const row = rows[0];
      if (!row) throw new Error("budget check returned no row");
      return row.scope
        ? {
            allowed: false,
            scope: row.scope,
            retryAt: row.retry_at.toISOString(),
          }
        : { allowed: true, hasOrgBudget: row.has_org };
    },
  });
export const AI_MEMBER_ROLES: readonly MemberRole[] = [
  "owner",
  "admin",
  "member",
];
export const aiBudgetCheck = checkQuery("kernel.ai.budget.check", "system");
export const aiBudgetCheckMember = checkQuery(
  "kernel.ai.budget.check_member",
  AI_MEMBER_ROLES,
);

const zReserveSystemInput = z.strictObject({
  module: zModule,
  agentId: zAgentId.nullable(),
  feature: zFeature,
  projectedCost: zAmount,
  defaultMonthlyBudget: zAmount.optional(),
});

const zReserveMemberInput = z.strictObject({
  module: zModule,
  agentId: z.null(),
  feature: zFeature,
  projectedCost: zAmount,
});

const reserveCommand = (
  name: string,
  access: readonly MemberRole[] | "system",
) =>
  defineCommand({
    name,
    input: access === "system" ? zReserveSystemInput : zReserveMemberInput,
    risk: "R1",
    sideEffect: "internal",
    access,
    handler: async (
      ctx,
      input: z.infer<typeof zReserveSystemInput>,
    ): Promise<AiBudgetReserve> => {
      const scope = reservationScope(ctx, access);
      const agentId = access === "system" ? input.agentId : null;
      const result = await reserveAiBudget(ctx.trx, {
        orgId: ctx.orgId,
        module: input.module,
        agentId,
        actorUserId: scope.actorUserId,
        feature: input.feature,
        projectedCost: input.projectedCost,
        defaultMonthlyBudget:
          access === "system" ? input.defaultMonthlyBudget : undefined,
        allowDefaultSeed: access === "system",
      });
      ctx.audit({
        feature: input.feature,
        module: input.module,
        agent: agentId,
        projectedCost: input.projectedCost,
        allowed: result.allowed,
        ...(result.allowed
          ? { reservationId: result.reservationId }
          : { scope: result.scope }),
      });
      return result;
    },
  });

export const aiBudgetReserve = reserveCommand(
  "kernel.ai.budget.reserve",
  "system",
);
export const aiBudgetReserveMember = reserveCommand(
  "kernel.ai.budget.reserve_member",
  AI_MEMBER_ROLES,
);

const releaseCommand = (
  name: string,
  access: readonly MemberRole[] | "system",
) =>
  defineCommand({
    name,
    input: z.strictObject({ reservationId: zId }),
    risk: "R1",
    sideEffect: "internal",
    access,
    handler: async (ctx, input): Promise<{ released: boolean }> => {
      const scope = reservationScope(ctx, access);
      const released = await deleteAiBudgetReservation(
        ctx.trx,
        ctx.orgId,
        input.reservationId,
        scope,
      );
      ctx.audit({
        reservationId: input.reservationId,
        released,
      });
      return { released };
    },
  });

export const aiBudgetRelease = releaseCommand(
  "kernel.ai.budget.release",
  "system",
);
export const aiBudgetReleaseMember = releaseCommand(
  "kernel.ai.budget.release_member",
  AI_MEMBER_ROLES,
);

// Gives an org that has no budget of its own the deployment's default (AI_DEFAULT_MONTHLY_BUDGET): the first time it uses
// AI. It never changes a budget that exists, so it cannot raise one; an owner replaces it with kernel.agent.budget.set.
export const aiBudgetEnsureDefault = defineCommand({
  name: "kernel.ai.budget.ensure_default",
  input: z.strictObject({ monthlyLimit: zAmount }),
  risk: "R1",
  sideEffect: "internal",
  access: "system",
  handler: async (ctx, input) => {
    await lockAiBudgetOrg(ctx.trx, ctx.orgId);
    const created = await ctx.trx
      .insertInto("ludy_kernel.budget_policy")
      .values({
        org_id: ctx.orgId,
        scope: "org",
        target: "*",
        monthly_limit: input.monthlyLimit,
        warn_percent: 80,
        hard_stop: true,
        updated_by: DEPLOYMENT_DEFAULT_SETTER,
      })
      .onConflict((oc) => oc.columns(["org_id", "scope", "target"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    ctx.audit({
      created: created !== undefined,
      monthly_limit: input.monthlyLimit,
    });
    return { created: created !== undefined };
  },
});

interface BudgetRow {
  scope: AgentScope;
  target: string;
  monthly_limit: string;
  warn_percent: number;
  hard_stop: boolean;
  spent: string;
  percent: number;
  month: string;
}

// The budgets that cover a call, with this month's spend, in SQL: money never goes through a JS number.
async function coveringBudgets(
  ctx: Pick<CommandContext, "trx" | "orgId">,
  module: string,
  agentId: string | null,
): Promise<BudgetRow[]> {
  const { rows } = await sql<BudgetRow>`
    SELECT b.scope, b.target, b.monthly_limit::text AS monthly_limit, b.warn_percent, b.hard_stop,
           s.spent::text AS spent,
           CASE WHEN b.monthly_limit = 0 THEN 100 ELSE LEAST(pg_catalog.floor(s.spent * 100 / b.monthly_limit), 100000)::int END AS percent,
           pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS month
    FROM ludy_kernel.budget_policy b
    CROSS JOIN LATERAL (SELECT ludy_kernel.ai_budget_spent(b.org_id, b.scope, b.target) AS spent) s
    WHERE b.org_id = ${ctx.orgId}::uuid
      AND (b.scope = 'org' OR (b.scope = 'module' AND b.target = ${module}) OR (b.scope = 'agent' AND b.target = ${agentId}::text))
    ORDER BY b.scope, b.target`.execute(ctx.trx);
  return rows;
}

const zRecordInput = z.strictObject({
  feature: zFeature,
  module: zModule,
  agentId: zAgentId.nullable(),
  inputTokens: z.number().int().min(0).max(100_000_000),
  outputTokens: z.number().int().min(0).max(100_000_000),
  cost: zAmount,
  reservationId: zId.optional(),
});

// What one model call used. The row holds the feature, the module, the agent, the tokens and the estimated cost, and
// nothing the call read or wrote. Releases its in-flight reservation in the same transaction when provided.
const recordCommand = (
  name: string,
  access: readonly MemberRole[] | "system",
) =>
  defineCommand({
    name,
    input: zRecordInput,
    risk: "R1",
    sideEffect: "internal",
    access,
    handler: async (ctx, input) => {
      await ctx.trx
        .insertInto("ludy_kernel.org_usage")
        .values({
          org_id: ctx.orgId,
          metric: "ai_cost",
          amount: input.cost,
          feature: input.feature,
          module: input.module,
          agent_id: input.agentId,
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
        })
        .execute();
      if (input.reservationId) {
        const scope = reservationScope(ctx, access);
        await deleteAiBudgetReservation(
          ctx.trx,
          ctx.orgId,
          input.reservationId,
          scope,
        );
      }
      ctx.audit({
        feature: input.feature,
        module: input.module,
        agent: input.agentId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cost: input.cost,
      });
      return { recorded: true };
    },
  });
export const aiUsageRecord = recordCommand("kernel.ai.usage.record", "system");
export const aiUsageRecordMember = recordCommand(
  "kernel.ai.usage.record_member",
  AI_MEMBER_ROLES,
);

// Tells the org's owners and admins that a budget crossed its warning percentage ('warn') or 100% ('stop') this month,
// once per budget, month and level (the notification's key). The crossing is read again from the database: the input
// names a budget and a level, never a number the notice shows.
export const aiBudgetNotify = defineCommand({
  name: "kernel.ai.budget.notify",
  input: z.strictObject({
    scope: z.enum(["org", "module", "agent"]),
    target: z.string().min(1).max(100),
    level: z.enum(["warn", "stop"]),
  }),
  risk: "R1",
  sideEffect: "internal",
  access: "system",
  handler: async (ctx, input) => {
    const { rows } = await sql<BudgetRow>`
      SELECT b.scope, b.target, b.monthly_limit::text AS monthly_limit, b.warn_percent, b.hard_stop,
             s.spent::text AS spent,
             CASE WHEN b.monthly_limit = 0 THEN 100 ELSE LEAST(pg_catalog.floor(s.spent * 100 / b.monthly_limit), 100000)::int END AS percent,
             pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS month
      FROM ludy_kernel.budget_policy b
      CROSS JOIN LATERAL (SELECT ludy_kernel.ai_budget_spent(b.org_id, b.scope, b.target) AS spent) s
      WHERE b.org_id = ${ctx.orgId}::uuid AND b.scope = ${input.scope} AND b.target = ${input.target}`.execute(
      ctx.trx,
    );
    const b = rows[0];
    const reached =
      b !== undefined &&
      (input.level === "stop"
        ? b.hard_stop && b.percent >= 100
        : b.percent >= b.warn_percent);
    if (!b || !reached) return { told: 0 };
    const told = await notifyMembers(ctx, {
      kind: AI_BUDGET_NOTICE,
      users: await ownersAndAdmins(ctx),
      key: `ai_budget:${b.scope}:${b.target}:${b.month}:${input.level}`,
      // Not one a member can turn off: the sweep counts a notice as sent by its row, so a muted one would be asked for again
      // every ten minutes, and the stop notice is the one an owner has to act on.
      required: true,
      detail: {
        level: input.level,
        scope: b.scope,
        target: b.target,
        percent: String(Math.min(b.percent, 999)),
      },
    });
    ctx.audit({
      scope: b.scope,
      target: b.target,
      level: input.level,
      percent: b.percent,
      told,
    });
    return { told };
  },
});

const MONTH_START = sql`ludy_kernel.ai_month_start()`;

export interface AiMeterStatus {
  // 'none': no budget covers it (use is still counted); 'stop': a hard-stop budget is spent.
  state: "none" | "ok" | "warn" | "stop";
  // Of the tightest budget that covers the module, in whole percent (capped at 100); null with state 'none'.
  percent: number | null;
  scope: AgentScope | null;
  // When the month turns and the budgets start again.
  resetAt: string;
}

// What the small meter beside the AI panels shows: where the tightest org or module budget stands. No amounts: every
// member sees it, the report with the money is the owners' and admins'.
export const aiMeterStatus = defineQuery({
  name: "kernel.ai.meter.status",
  input: z.strictObject({ module: zModule.optional() }),
  access: ["owner", "admin", "member", "viewer"],
  handler: async (ctx, input): Promise<AiMeterStatus> => {
    const budgets = (
      await coveringBudgets(ctx, input.module ?? "", null)
    ).filter((b) => b.scope !== "agent");
    const { rows } = await sql<{ reset_at: Date }>`
      SELECT ((pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + pg_catalog.make_interval(months => 1)) AT TIME ZONE 'Asia/Ho_Chi_Minh') AS reset_at`.execute(
      ctx.trx,
    );
    const resetAt = (rows[0]?.reset_at ?? new Date()).toISOString();
    let worst: BudgetRow | null = null;
    for (const b of budgets)
      if (worst === null || b.percent > worst.percent) worst = b;
    if (!worst) return { state: "none", percent: null, scope: null, resetAt };
    const spentOut = worst.percent >= 100 && worst.hard_stop;
    return {
      state: spentOut
        ? "stop"
        : worst.percent >= worst.warn_percent
          ? "warn"
          : "ok",
      percent: Math.min(worst.percent, 100),
      scope: worst.scope,
      resetAt,
    };
  },
});

export interface AiUsageReport {
  month: string;
  resetAt: string;
  // This month's estimated cost of every model call, a decimal string in the deployment's price unit.
  spent: string;
  calls: number;
  byFeature: {
    feature: string;
    module: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cost: string;
  }[];
  byAgent: {
    agentId: string;
    name: string | null;
    calls: number;
    cost: string;
  }[];
}

// This month's use for Settings, by feature and by agent. Owners and admins: costs are management data.
export const aiUsageReport = defineQuery({
  name: "kernel.ai.usage.report",
  input: z.strictObject({}),
  access: ["owner", "admin"],
  handler: async (ctx): Promise<AiUsageReport> => {
    const head = await sql<{
      month: string;
      reset_at: Date;
      spent: string;
      calls: number;
    }>`
      SELECT pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS month,
             ((pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + pg_catalog.make_interval(months => 1)) AT TIME ZONE 'Asia/Ho_Chi_Minh') AS reset_at,
             ludy_kernel.ai_budget_spent(${ctx.orgId}::uuid, 'org', '*')::text AS spent,
             (SELECT pg_catalog.count(*)::int FROM ludy_kernel.org_usage u WHERE u.org_id = ${ctx.orgId}::uuid AND u.metric = 'ai_cost' AND u.created_at >= ${MONTH_START}) AS calls`.execute(
      ctx.trx,
    );
    const byFeature = await sql<{
      feature: string;
      module: string;
      calls: number;
      input_tokens: string;
      output_tokens: string;
      cost: string;
    }>`
      SELECT coalesce(u.feature, 'kernel.unattributed') AS feature, coalesce(u.module, '') AS module, pg_catalog.count(*)::int AS calls,
             coalesce(pg_catalog.sum(u.input_tokens), 0)::text AS input_tokens, coalesce(pg_catalog.sum(u.output_tokens), 0)::text AS output_tokens,
             pg_catalog.sum(u.amount)::text AS cost
      FROM ludy_kernel.org_usage u
      WHERE u.org_id = ${ctx.orgId}::uuid AND u.metric = 'ai_cost' AND u.created_at >= ${MONTH_START}
      GROUP BY coalesce(u.feature, 'kernel.unattributed'), coalesce(u.module, '') ORDER BY pg_catalog.sum(u.amount) DESC, 1`.execute(
      ctx.trx,
    );
    const byAgent = await sql<{
      agent_id: string;
      name: string | null;
      calls: number;
      cost: string;
    }>`
      SELECT u.agent_id, a.display_name AS name, pg_catalog.count(*)::int AS calls, pg_catalog.sum(u.amount)::text AS cost
      FROM ludy_kernel.org_usage u LEFT JOIN ludy_kernel.agent a ON a.org_id = u.org_id AND a.id = u.agent_id
      WHERE u.org_id = ${ctx.orgId}::uuid AND u.metric = 'ai_cost' AND u.agent_id IS NOT NULL AND u.created_at >= ${MONTH_START}
      GROUP BY u.agent_id, a.display_name ORDER BY pg_catalog.sum(u.amount) DESC, u.agent_id`.execute(
      ctx.trx,
    );
    const h = head.rows[0];
    if (!h) throw new Error("usage report returned no row");
    return {
      month: h.month,
      resetAt: h.reset_at.toISOString(),
      spent: h.spent,
      calls: h.calls,
      byFeature: byFeature.rows.map((r) => ({
        feature: r.feature,
        module: r.module,
        calls: r.calls,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cost: r.cost,
      })),
      byAgent: byAgent.rows.map((r) => ({
        agentId: r.agent_id,
        name: r.name,
        calls: r.calls,
        cost: r.cost,
      })),
    };
  },
});

// The most documents a raised budget sends to be read again at once; the rest are asked again by their own recheck.
export const AI_BUDGET_RELEASE_LIMIT = 200;

// Sends the documents that wait for the AI budget to be read again, once the budget lets the finance module's model calls
// in: a raised budget is not left to wait for the next recheck. The same event a re-uploaded file raises, so the relay
// queues the read like any other and its consumers already handle a second one; a read that finds the budget still spent
// waits again and adds nothing. Returns how many were sent.
export async function releaseWaitingFiles(ctx: CommandContext): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    SELECT f.id FROM ludy_kernel.usage_deferral d
    JOIN ludy_kernel.file f ON f.org_id = d.org_id AND f.id::text = d.subject_id
    WHERE d.org_id = ${ctx.orgId}::uuid AND d.metric = 'ai_budget' AND d.subject_type = 'file' AND d.retry_at > pg_catalog.now()
      AND NOT EXISTS (SELECT 1 FROM ludy_kernel.extraction x WHERE x.org_id = d.org_id AND x.file_id = f.id)
      AND NOT ludy_kernel.ai_budget_exhausted(d.org_id, 'finance', NULL)
    GROUP BY f.id ORDER BY pg_catalog.min(d.created_at), f.id LIMIT ${AI_BUDGET_RELEASE_LIMIT}::int`.execute(ctx.trx);
  for (const row of rows) await ctx.emit('kernel.file.ingested', { fileId: row.id });
  return rows.length;
}

export const aiBudgetCommands = [
  aiBudgetEnsureDefault,
  aiBudgetReserve,
  aiBudgetReserveMember,
  aiBudgetRelease,
  aiBudgetReleaseMember,
  aiBudgetNotify,
  aiUsageRecord,
  aiUsageRecordMember,
];
export const aiBudgetQueries = [
  aiBudgetCheck,
  aiBudgetCheckMember,
  aiMeterStatus,
  aiUsageReport,
];
