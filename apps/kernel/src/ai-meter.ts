// SPDX-License-Identifier: AGPL-3.0-only
// The kernel's AiMeter (#2382): what @ludy/agent's metered() asks before a model call and tells after it, answered by
// the database (packages/kernel/src/ai-budget.ts). Two authorities, since the API cannot enter the system context: the
// worker's calls run as the system (an extraction), the API's as the member who asked (a draft, a rewrite, a booking
// suggestion). Both write the same rows, ids and counts only: the tokens the provider reported and the estimated cost.
//
// A refused check throws AiBudgetExhaustedError; the caller turns it into "Vy đã hết ngân sách tháng này" (the API) or
// keeps the work for later (the worker). A failure to ask the database is the caller's to handle too: the call is not
// made, since an unmetered call is worse than a retried one.
import { AiBudgetExhaustedError, aiCost, type AiCall, type AiMeter, type AiUsage } from '@ludy/agent';
import type { AiBudgetReserve } from '@ludy/kernel';
import { DomainError, type MemberVyRuntime, type Runtime, type SystemActor, type UserActor } from '@ludy/kernel-runtime';

export interface AiPrice {
  inputPerMTok: string;
  outputPerMTok: string;
  audioPerMinute?: string | undefined;
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

  private projectedCost(call: AiCall): string {
    return call.expected ? aiCost([call.expected], this.options.price) : '0';
  }

  private async reserveMemberVy(call: AiCall, projected: string): Promise<string> {
    if (this.authority.kind !== 'member') throw new Error('a member Vy call needs the member as the meter authority');
    const answer = await this.runtime.execute<AiBudgetReserve>(
      'kernel.member_vy.meter.reserve',
      /^0+(?:\.0+)?$/.test(projected) ? { feature: call.feature } : { feature: call.feature, projectedCost: projected },
      this.as(call.orgId),
    );
    if (!answer.allowed) throw new AiBudgetExhaustedError(answer.scope, answer.retryAt);
    return answer.reservationId;
  }

  async admit(call: AiCall): Promise<string> {
    const projected = this.projectedCost(call);
    if (call.memberRunId != null) return this.reserveMemberVy(call, projected);
    const answer = await this.runtime.execute<AiBudgetReserve>(
      this.authority.kind === 'system' ? 'kernel.ai.budget.reserve' : 'kernel.ai.budget.reserve_member',
      {
        module: call.module,
        agentId: call.agentId,
        feature: call.feature,
        projectedCost: projected,
        ...(this.authority.kind === 'system' && this.options.defaultMonthlyBudget
          ? { defaultMonthlyBudget: this.options.defaultMonthlyBudget }
          : {}),
      },
      this.as(call.orgId),
    );
    if (!answer.allowed) throw new AiBudgetExhaustedError(answer.scope, answer.retryAt);
    return answer.reservationId;
  }

  async record(call: AiCall, usage: AiUsage, reservationId?: string): Promise<void> {
    if (call.memberRunId != null) {
      await this.runtime.execute(
        'kernel.member_vy.meter.record',
        {
          feature: call.feature,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: aiCost([usage], this.options.price),
          ...(reservationId ? { reservationId } : {}),
        },
        this.as(call.orgId),
      );
      return;
    }
    await this.runtime.execute(
      this.authority.kind === 'system' ? 'kernel.ai.usage.record' : 'kernel.ai.usage.record_member',
      {
        feature: call.feature,
        module: call.module,
        agentId: call.agentId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: aiCost([usage], this.options.price),
        ...(reservationId ? { reservationId } : {}),
      },
      this.as(call.orgId),
    );
  }

  async release(call: AiCall, reservationId: string): Promise<void> {
    if (call.memberRunId != null) {
      await this.runtime.execute('kernel.member_vy.meter.release', { reservationId }, this.as(call.orgId));
      return;
    }
    await this.runtime.execute(
      this.authority.kind === 'system' ? 'kernel.ai.budget.release' : 'kernel.ai.budget.release_member',
      { reservationId },
      this.as(call.orgId),
    );
  }
}

// The meter for a member's background Vy worker run (transcribe, live notes): re-checks run & kill switches in member_vy
// context and reserves/records/releases against the org/module/agent budget as system.
export function memberVyRunMeter(params: {
  runtime: Runtime;
  vy: MemberVyRuntime;
  actor: SystemActor;
  orgId: string;
  agentId: string;
  price?: AiPrice | undefined;
}): AiMeter {
  return {
    admit: async (call: AiCall): Promise<string> => {
      const projected = call.expected ? aiCost([call.expected], params.price) : '0';
      try {
        await params.vy.query('kernel.member_vy.run.check', /^0+(?:\.0+)?$/.test(projected) ? {} : { projectedCost: projected });
      } catch (error: unknown) {
        if (error instanceof DomainError && error.code === 'BUDGET_EXHAUSTED') {
          throw new AiBudgetExhaustedError('module', null);
        }
        throw error;
      }
      const reserved = await params.runtime.execute<AiBudgetReserve>(
        'kernel.ai.budget.reserve',
        { module: call.module, agentId: params.agentId, feature: call.feature, projectedCost: projected },
        { actor: params.actor, orgId: params.orgId },
      );
      if (!reserved.allowed) throw new AiBudgetExhaustedError(reserved.scope, reserved.retryAt);
      return reserved.reservationId;
    },
    record: async (call: AiCall, usage: AiUsage, reservationId?: string): Promise<void> => {
      await params.runtime.execute(
        'kernel.ai.usage.record',
        {
          feature: call.feature,
          module: call.module,
          agentId: params.agentId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: aiCost([usage], params.price),
          ...(reservationId ? { reservationId } : {}),
        },
        { actor: params.actor, orgId: params.orgId },
      );
    },
    release: async (_call: AiCall, reservationId: string): Promise<void> => {
      await params.runtime.execute(
        'kernel.ai.budget.release',
        { reservationId },
        { actor: params.actor, orgId: params.orgId },
      );
    },
  };
}

// Wraps an AiMeter with a live kill-switch guard, forwarding reservation IDs and releasing best-effort if stopped right after admit.
export function guardAiMeter(
  baseMeter: AiMeter,
  options: {
    isStopped: () => Promise<boolean>;
    stoppedError: () => Error;
    checkStoppedAfterAdmit?: boolean;
    onAdmitRejected?: () => void;
  },
): AiMeter {
  const baseRelease = baseMeter.release;
  return {
    admit: async (call) => {
      try {
        if (await options.isStopped()) {
          throw options.stoppedError();
        }
        const admitted = await baseMeter.admit(call);
        if (options.checkStoppedAfterAdmit) {
          try {
            if (await options.isStopped()) {
              throw options.stoppedError();
            }
          } catch (stopError: unknown) {
            if (typeof admitted === 'string' && baseRelease) {
              await baseRelease.call(baseMeter, call, admitted).catch((releaseError: unknown) => {
                console.error(
                  '[ai-meter] could not release reservation after kill switch',
                  releaseError instanceof Error ? releaseError.name : typeof releaseError,
                );
              });
            }
            throw stopError;
          }
        }
        return admitted;
      } catch (error: unknown) {
        options.onAdmitRejected?.();
        throw error;
      }
    },
    record: (call, usage, reservationId) => baseMeter.record(call, usage, reservationId),
    ...(baseRelease
      ? { release: (call: AiCall, reservationId: string) => baseRelease.call(baseMeter, call, reservationId) }
      : {}),
  };
}

// The meter for the worker's calls, as the system.
export function systemMeter(runtime: Runtime, options: MeterOptions): AiMeter {
  return new RuntimeMeter(runtime, { kind: 'system' }, options);
}

// The meter for an API request's calls, as the member who made it.
export function memberMeter(runtime: Runtime, actor: UserActor, options: MeterOptions): AiMeter {
  return new RuntimeMeter(runtime, { kind: 'member', actor }, options);
}
