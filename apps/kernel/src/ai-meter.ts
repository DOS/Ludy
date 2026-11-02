// SPDX-License-Identifier: AGPL-3.0-only
// The kernel's AiMeter (#2382): what @crove/agent's metered() asks before a model call and tells after it, answered by
// the database (packages/kernel/src/ai-budget.ts). Two authorities, since the API cannot enter the system context: the
// worker's calls run as the system (an extraction), the API's as the member who asked (a draft, a rewrite, a booking
// suggestion). Both write the same rows, ids and counts only: the tokens the provider reported and the estimated cost.
//
// A refused check throws AiBudgetExhaustedError; the caller turns it into "Vy đã hết ngân sách tháng này" (the API) or
// keeps the work for later (the worker). A failure to ask the database is the caller's to handle too: the call is not
// made, since an unmetered call is worse than a retried one.
import { AiBudgetExhaustedError, aiCost, type AiCall, type AiMeter, type AiUsage } from '@crove/agent';
import type { AiBudgetCheck } from '@crove/kernel';
import type { Runtime, UserActor } from '@crove/kernel-runtime';

export interface AiPrice {
  inputPerMTok: string;
  outputPerMTok: string;
}

export interface MeterOptions {
  // The price of one million input and output tokens, in the deployment's unit (AI_PRICE_*). Without it a call costs 0:
  // it is still counted, but no budget can be spent.
  price?: AiPrice | undefined;
  // The monthly budget an org with none of its own gets (AI_DEFAULT_MONTHLY_BUDGET), or null for none.
  defaultMonthlyBudget?: string | null | undefined;
}

type Authority = { kind: 'system' } | { kind: 'member'; actor: UserActor };

class RuntimeMeter implements AiMeter {
  private readonly runtime: Runtime;
  private readonly authority: Authority;
  private readonly options: MeterOptions;

  constructor(runtime: Runtime, authority: Authority, options: MeterOptions) {
    this.runtime = runtime;
    this.authority = authority;
    this.options = options;
  }

  private as(orgId: string) {
    return this.authority.kind === 'system' ? { actor: { type: 'system' as const, component: 'kernel.ai_meter' }, orgId } : { actor: this.authority.actor, orgId };
  }

  private check(call: AiCall): Promise<AiBudgetCheck> {
    return this.runtime.query<AiBudgetCheck>(this.authority.kind === 'system' ? 'kernel.ai.budget.check' : 'kernel.ai.budget.check_member', { module: call.module, agentId: call.agentId }, this.as(call.orgId));
  }

  async admit(call: AiCall): Promise<void> {
    let check = await this.check(call);
    // The first call of an org with no budget of its own gives it the deployment's default (the worker seeds the rest in
    // its sweep: the API cannot write a budget).
    const fallback = this.options.defaultMonthlyBudget;
    if (check.allowed && !check.hasOrgBudget && fallback && this.authority.kind === 'system') {
      await this.runtime.execute('kernel.ai.budget.ensure_default', { monthlyLimit: fallback }, this.as(call.orgId));
      check = await this.check(call);
    }
    if (!check.allowed) throw new AiBudgetExhaustedError(check.scope, check.retryAt);
  }

  async record(call: AiCall, usage: AiUsage): Promise<void> {
    await this.runtime.execute(
      this.authority.kind === 'system' ? 'kernel.ai.usage.record' : 'kernel.ai.usage.record_member',
      { feature: call.feature, module: call.module, agentId: call.agentId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: aiCost([usage], this.options.price) },
      this.as(call.orgId),
    );
  }
}

// The meter for the worker's calls, as the system.
export function systemMeter(runtime: Runtime, options: MeterOptions): AiMeter {
  return new RuntimeMeter(runtime, { kind: 'system' }, options);
}

// The meter for an API request's calls, as the member who made it.
export function memberMeter(runtime: Runtime, actor: UserActor, options: MeterOptions): AiMeter {
  return new RuntimeMeter(runtime, { kind: 'member', actor }, options);
}
