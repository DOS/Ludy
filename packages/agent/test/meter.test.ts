// SPDX-License-Identifier: AGPL-3.0-only
// The AI budget meter's door (#2382): what metered() asks before a call and tells after it.
import { NoObjectGeneratedError } from 'ai';
import { describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError, AiMeterMissingError, aiCost, metered, withAiScope, type AiCall, type AiMeter, type AiUsage } from '../src/index.ts';

function recorder(admit?: (call: AiCall) => void) {
  const admitted: AiCall[] = [];
  const recorded: { call: AiCall; usage: AiUsage }[] = [];
  const meter: AiMeter = {
    admit: async (call) => {
      admitted.push(call);
      admit?.(call);
    },
    record: async (call, usage) => {
      recorded.push({ call, usage });
    },
  };
  return { meter, admitted, recorded };
}

const answer = { usage: { inputTokens: 120, outputTokens: 30 } };

describe('metered', () => {
  it('refuses a call made outside an AI scope, before it runs', async () => {
    let ran = false;
    await expect(
      metered('social.draft', async () => {
        ran = true;
        return answer;
      }),
    ).rejects.toBeInstanceOf(AiMeterMissingError);
    expect(ran).toBe(false);
  });

  it('asks the meter first, runs the call, then records the feature, the org, the agent and the tokens', async () => {
    const { meter, admitted, recorded } = recorder();
    const seen: AiUsage[] = [];
    const result = await withAiScope({ orgId: 'org-1', agentId: 'agent-1', meter }, () =>
      metered('finance.invoice_extract', async () => answer, (u) => seen.push(u)),
    );
    expect(result).toBe(answer);
    expect(admitted).toEqual([{ feature: 'finance.invoice_extract', module: 'finance', orgId: 'org-1', agentId: 'agent-1' }]);
    expect(recorded).toEqual([{ call: admitted[0], usage: { inputTokens: 120, outputTokens: 30 } }]);
    expect(seen).toEqual([{ inputTokens: 120, outputTokens: 30 }]);
  });

  it('does not run the call when the meter refuses it (a spent budget), and records nothing', async () => {
    const { meter, recorded } = recorder(() => {
      throw new AiBudgetExhaustedError('org', '2026-12-01T00:00:00.000Z');
    });
    let ran = false;
    await expect(
      withAiScope({ orgId: 'org-1', meter }, () =>
        metered('social.rewrite', async () => {
          ran = true;
          return answer;
        }),
      ),
    ).rejects.toMatchObject({ name: 'AiBudgetExhaustedError', scope: 'org', retryAt: '2026-12-01T00:00:00.000Z' });
    expect(ran).toBe(false);
    expect(recorded).toEqual([]);
  });

  it('counts nothing for a call that failed before an answer, and what a model that answered badly used', async () => {
    const failed = recorder();
    await expect(
      withAiScope({ orgId: 'org-1', meter: failed.meter }, () =>
        metered('social.hashtags', async () => {
          throw new Error('endpoint down');
        }),
      ),
    ).rejects.toThrow('endpoint down');
    expect(failed.recorded).toEqual([]);

    const unusable = recorder();
    const noObject = new NoObjectGeneratedError({
      message: 'bad json',
      text: 'x',
      response: { id: 'r', timestamp: new Date(), modelId: 'm' },
      usage: { inputTokens: 40, outputTokens: 7, totalTokens: 47 } as never,
      finishReason: 'stop',
    });
    await expect(
      withAiScope({ orgId: 'org-1', meter: unusable.meter }, () =>
        metered('social.draft', async () => {
          throw noObject;
        }),
      ),
    ).rejects.toBe(noObject);
    expect(unusable.recorded.map((r) => r.usage)).toEqual([{ inputTokens: 40, outputTokens: 7 }]);
  });

  it('never fails a finished call because the ledger could not be written', async () => {
    const meter: AiMeter = {
      admit: async () => {},
      record: async () => {
        throw new Error('database down');
      },
    };
    await expect(withAiScope({ orgId: 'org-1', meter }, () => metered('social.ideas', async () => answer))).resolves.toBe(answer);
  });

  it('keeps the scopes of two orgs apart when their calls run at the same time', async () => {
    const a = recorder();
    const b = recorder();
    await Promise.all([
      withAiScope({ orgId: 'org-a', meter: a.meter }, () => metered('social.summary', async () => answer)),
      withAiScope({ orgId: 'org-b', meter: b.meter }, () => metered('social.summary', async () => answer)),
    ]);
    expect(a.admitted.map((c) => c.orgId)).toEqual(['org-a']);
    expect(b.admitted.map((c) => c.orgId)).toEqual(['org-b']);
  });
});

describe('aiCost', () => {
  const price = { inputPerMTok: '3', outputPerMTok: '15' };
  it('prices tokens with decimal arithmetic, six decimals', () => {
    expect(aiCost([{ inputTokens: 2000, outputTokens: 500 }, { inputTokens: 1000, outputTokens: 0 }], price)).toBe('0.016500');
    expect(aiCost([{ inputTokens: 1, outputTokens: 1 }], { inputPerMTok: '0.1', outputPerMTok: '0.2' })).toBe('0.000000');
    expect(aiCost([], price)).toBe('0.000000');
  });
  it('costs nothing without a price', () => {
    expect(aiCost([{ inputTokens: 2000, outputTokens: 500 }], undefined)).toBe('0');
  });
});
