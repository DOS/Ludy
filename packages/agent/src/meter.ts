// SPDX-License-Identifier: AGPL-3.0-only
// The AI budget meter (#2382): every model call of Ludy goes through `metered`, which asks the deployment's meter
// whether the org may spend before the call and tells it what the call used after. At 100% of a budget the meter
// refuses a new call with AiBudgetExhaustedError; calls already in flight finish. The meter itself (the ledger, the
// budgets, the notices) lives in the kernel; this file is the one door to the model, so nothing can reach the endpoint
// without passing it:
//   - a call names its feature from AI_FEATURES, which also says which module's budget it counts against;
//   - the org (and the agent, when an agent run makes the call) and the meter that speaks for the caller's authority
//     (the API's user context, the worker's system context) come from the scope the caller entered with `withAiScope`,
//     never from a parameter the call could leave out; a call outside a scope is refused.
// packages/agent/test/meter-coverage.test.ts fails when a model call is made anywhere else, or a feature is not here.
// What the meter is given is ids, the feature key and the tokens the provider reported: never a prompt, the text of a
// document or a model's answer.
import { AsyncLocalStorage } from 'node:async_hooks';
import { NoObjectGeneratedError } from 'ai';
import { Decimal } from '@crove/l10n-vn';

// Every use of a model, by feature key ('<module>.<what>'), with the module whose budget it counts against. A new use
// (Marketing's campaign drafts, Vy's reply drafts, the daily brief) is added here first.
export const AI_FEATURES = {
  'finance.invoice_extract': 'finance',
  'social.draft': 'social',
  'social.rewrite': 'social',
  'social.hashtags': 'social',
  'social.alt_text': 'social',
  'social.ideas': 'social',
  'social.summary': 'social',
  'crm.booking_schedule': 'crm',
} as const satisfies Record<string, string>;
export type AiFeature = keyof typeof AI_FEATURES;
export const AI_FEATURE_KEYS = Object.keys(AI_FEATURES) as AiFeature[];

// The tokens one model call used, as the provider reported them (0 when it reported none).
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}
export type AiUsageSink = (usage: AiUsage) => void;

// Who a call is for: the org whose budget it counts against, the agent that made it, if one did, and the meter that asks
// the database in the caller's own authority.
export interface AiScope {
  orgId: string;
  agentId?: string | undefined;
  meter: AiMeter;
}

export interface AiCall {
  feature: AiFeature;
  module: string;
  orgId: string;
  agentId: string | null;
}

export interface AiMeter {
  // Before the call. Throws AiBudgetExhaustedError when a budget that covers it is spent.
  admit(call: AiCall): Promise<void>;
  // After the call, with what it used. A failure here never fails the call: the caller logs it.
  record(call: AiCall, usage: AiUsage): Promise<void>;
}

// A budget that covers the call is spent: the org's, the module's or the agent's. retryAt: when the month turns and
// the budget starts again (an owner can raise it sooner).
export class AiBudgetExhaustedError extends Error {
  readonly scope: 'org' | 'module' | 'agent';
  readonly retryAt: string | null;
  constructor(scope: 'org' | 'module' | 'agent', retryAt: string | null) {
    super(`AI budget spent (${scope})`);
    this.name = 'AiBudgetExhaustedError';
    this.scope = scope;
    this.retryAt = retryAt;
  }
}

// A call made outside withAiScope: refused, never sent unmetered.
export class AiMeterMissingError extends Error {
  constructor(feature: string) {
    super(`AI call ${feature} refused: it was made outside an AI scope`);
    this.name = 'AiMeterMissingError';
  }
}

const scopes = new AsyncLocalStorage<AiScope>();

// Runs fn with the org (and agent) its model calls count against. The API enters it per request, the worker per job.
export function withAiScope<T>(scope: AiScope, fn: () => Promise<T>): Promise<T> {
  return scopes.run(scope, fn);
}

// For the evals and the conformance suite, which measure the model itself against no org: calls count nowhere. Never
// import it from product code (meter-coverage.test.ts fails when something outside a test directory does).
export const UNMETERED: AiMeter = {
  admit: async () => {},
  record: async () => {},
};

function tokens(usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined): AiUsage {
  return { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 };
}

// The one door to the model: `call` is the generateText call, made only once the meter admitted it. The caller's own
// sink (onUsage) sees the same tokens. Counts what the call used even when the answer was unusable (the model was paid
// for it); a call that failed before an answer counts nothing.
export async function metered<R extends { usage: { inputTokens: number | undefined; outputTokens: number | undefined } }>(
  feature: AiFeature,
  call: () => Promise<R>,
  onUsage?: AiUsageSink,
): Promise<R> {
  const scope = scopes.getStore();
  if (!scope) throw new AiMeterMissingError(feature);
  const { meter } = scope;
  const info: AiCall = { feature, module: AI_FEATURES[feature], orgId: scope.orgId, agentId: scope.agentId ?? null };
  await meter.admit(info);
  const settle = async (used: AiUsage) => {
    onUsage?.(used);
    try {
      await meter.record(info, used);
    } catch (error: unknown) {
      console.error(`[ai-meter] could not record a ${feature} call`, error instanceof Error ? error.name : typeof error);
    }
  };
  let result: R;
  try {
    result = await call();
  } catch (error: unknown) {
    if (NoObjectGeneratedError.isInstance(error) && error.usage) await settle(tokens(error.usage));
    throw error;
  }
  await settle(tokens(result.usage));
  return result;
}

// The estimated cost of calls in the deployment's price unit (AI_PRICE_*, per million tokens), as a decimal string with
// 6 decimals. Without a price AI costs nothing to count: the budget then counts calls' tokens only through its report.
export function aiCost(usage: readonly AiUsage[], price: { inputPerMTok: string; outputPerMTok: string } | undefined): string {
  if (!price) return '0';
  let cost = new Decimal(0);
  for (const call of usage) {
    cost = cost.plus(new Decimal(call.inputTokens).times(price.inputPerMTok)).plus(new Decimal(call.outputTokens).times(price.outputPerMTok));
  }
  return cost.dividedBy(1_000_000).toFixed(6);
}
