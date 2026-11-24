// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for mid-flight kill-switch and stop-read failure refund handling in HR Stage 6A kernel orchestration (#4526).
import { describe, expect, it, vi } from 'vitest';
import { metered } from '@ludy/agent';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { draftSelfHrRequest, hrSelfAi } from '../src/hr-self-ai.ts';

const dummyRuntime = {
  execute: vi.fn(),
  query: vi.fn(),
};
const actor = {
  type: 'user' as const,
  userId: '00000000-0000-7000-8000-000000000011',
  aal: 'aal1' as const,
};

describe('HR Stage 6A metered admission guard (#4526)', () => {
  it('refunds DraftBudget ticket if isAiStopped throws during admission', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    let callCount = 0;
    const isAiStopped = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('stop lookup transient failure');
      return false;
    });
    const reader = {
      hrRequestDraft: vi.fn(async () => {
        const res = await metered('hr.request_draft', async () => ({
          result: {
            aiStatus: 'used' as const,
            source: 'ai' as const,
            tainted: true as const,
            draft: {
              kind: 'leave' as const,
              startOn: '2026-11-27',
              endOn: '2026-11-27',
              leaveKind: 'annual_leave' as const,
              days: '0.5',
              reason: 'xin nghi phep chieu thu 6',
              halfDaySession: 'afternoon' as const,
            },
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        }));
        return res.result;
      }),
    };
    const meter = { admit: vi.fn(async () => undefined), record: vi.fn(async () => undefined) };
    const ports = {
      readDraftContext: async () => ({ aiStopped: false, aiBudgetSpent: false }),
      searchPolicyNotes: async () => ({ notesAvailable: false, aiStopped: false, aiBudgetSpent: false, candidates: [] }),
      isAiStopped,
    };
    const ai = hrSelfAi(reader, budget, new DraftBudget());

    const first = await draftSelfHrRequest(
      ai,
      ports,
      dummyRuntime,
      'org-1',
      actor,
      { text: 'xin nghi phep chieu thu 6', lang: 'vi', referenceDate: '2026-11-23' },
      meter,
    );
    expect(first.aiStatus).toBe('failed');
    expect(first.source).toBe('deterministic');

    const second = await draftSelfHrRequest(
      ai,
      ports,
      dummyRuntime,
      'org-1',
      actor,
      { text: 'xin nghi phep chieu thu 6', lang: 'vi', referenceDate: '2026-11-23' },
      meter,
    );
    expect(second.aiStatus).toBe('used');
    expect(second.source).toBe('ai');
  });

  it('aborts with deterministic off and refunds ticket when kill switch engages during baseMeter.admit', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    let stopped = false;
    const isAiStopped = vi.fn(async () => stopped);
    const providerSpy = vi.fn();
    const reader = {
      hrRequestDraft: vi.fn(async () => {
        const res = await metered('hr.request_draft', async () => {
          providerSpy();
          return {
            result: {
              aiStatus: 'used' as const,
              source: 'ai' as const,
              tainted: true as const,
              draft: {
                kind: 'unknown' as const,
                reason: 'test',
                hint: 'test',
              },
            },
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        });
        return res.result;
      }),
    };
    const meter = {
      admit: vi.fn(async () => undefined).mockImplementationOnce(async () => {
        stopped = true;
      }),
      record: vi.fn(async () => undefined),
    };
    const ports = {
      readDraftContext: async () => ({ aiStopped: false, aiBudgetSpent: false }),
      searchPolicyNotes: async () => ({ notesAvailable: false, aiStopped: false, aiBudgetSpent: false, candidates: [] }),
      isAiStopped,
    };
    const ai = hrSelfAi(reader, budget, new DraftBudget());

    const res = await draftSelfHrRequest(
      ai,
      ports,
      dummyRuntime,
      'org-1',
      actor,
      { text: 'xin nghi phep chieu thu 6', lang: 'vi', referenceDate: '2026-11-23' },
      meter,
    );
    expect(res.aiStatus).toBe('off');
    expect(res.source).toBe('deterministic');
    expect(providerSpy).not.toHaveBeenCalled();

    // Ticket refunded: resetting kill switch allows immediate next request.
    stopped = false;
    const retry = await draftSelfHrRequest(
      ai,
      ports,
      dummyRuntime,
      'org-1',
      actor,
      { text: 'xin nghi phep chieu thu 6', lang: 'vi', referenceDate: '2026-11-23' },
      meter,
    );
    expect(retry.aiStatus).toBe('used');
    expect(providerSpy).toHaveBeenCalledTimes(1);
  });
});
