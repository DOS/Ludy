// SPDX-License-Identifier: AGPL-3.0-only
// Vy's "Tuần này" on the real path (#3257): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText. The meter is asked once and told
// once per status under today.weekly in the kernel's budget line, and told tokens only; a refusal by the meter (the budget is spent or a kill switch is on) sends nothing; a call outside an AI scope
// never leaves; and a tampered figure in the answer gives the template while the call is still counted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, WeeklyWriter, templateWeekly, withAiScope, type AiCall, type AiMeter, type AiUsage, type WeeklyFacts } from '../src/index.ts';

const FACTS: WeeklyFacts = {
  language: 'vi',
  deals: { won: { count: 3, amount: '45000000' }, open: 12 },
  money: { cash: { amount: '120000000', previous: '100000000' }, receivables: { amount: '30000000', previous: '35500000' }, payables: { amount: '8000000', previous: '8000000' } },
  tasks: { late: 2 },
};
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 21, total_tokens: 61 } });

function recorder(refuse = false) {
  const admitted: AiCall[] = [];
  const recorded: Array<{ call: AiCall; usage: AiUsage }> = [];
  const meter: AiMeter = {
    admit: async (call) => {
      if (refuse) throw new AiBudgetExhaustedError('org', '2026-12-01T00:00:00Z');
      admitted.push(call);
    },
    record: async (call, usage) => void recorded.push({ call, usage }),
  };
  return { meter, admitted, recorded };
}

function model(content: unknown) {
  const bodies: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify(completion(content)), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return bodies;
}

const writer = () => new WeeklyWriter({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });

afterEach(() => vi.unstubAllGlobals());

describe('"Tuần này" on the wire', () => {
  it('sends the figures once and the meter counts one call under today.weekly, tokens only', async () => {
    const bodies = model({ sentences: ['Tuần qua có 3 deal thắng, tổng 45.000.000 đồng.', 'Tiền mặt tăng 20.000.000 đồng.'] });
    const { meter, admitted, recorded } = recorder();
    const result = await withAiScope({ orgId: 'org-1', meter }, () => writer().weekly(FACTS));
    expect(result).toEqual({ sentences: ['Tuần qua có 3 deal thắng, tổng 45.000.000 đồng.', 'Tiền mặt tăng 20.000.000 đồng.'], writtenBy: 'vy', final: true });
    expect(bodies).toHaveLength(1);
    const messages = (JSON.parse(bodies[0] as string) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]?.content).toContain('45.000.000 đồng');
    // Exactly one call, asked once and recorded once, in the kernel's budget line; the meter is given ids and tokens, never the prompt or the answer.
    expect(admitted).toEqual([{ feature: 'today.weekly', module: 'kernel', orgId: 'org-1', agentId: null, memberRunId: null }]);
    expect(recorded).toEqual([{ call: admitted[0], usage: { inputTokens: 40, outputTokens: 21 } }]);
    expect(JSON.stringify(recorded)).not.toContain('45.000.000');
  });

  it('is refused when the meter refuses, and nothing leaves for the model', async () => {
    const bodies = model({ sentences: ['x'] });
    const { meter, recorded } = recorder(true);
    await expect(withAiScope({ orgId: 'org-1', meter }, () => writer().weekly(FACTS))).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(bodies).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it('gives the template for a tampered figure, and still counts the call the model was paid for', async () => {
    model({ sentences: ['Doanh thu đạt 99.000.000 đồng.'] });
    const { meter, admitted, recorded } = recorder();
    const result = await withAiScope({ orgId: 'org-1', meter }, () => writer().weekly(FACTS));
    expect(result).toEqual({ sentences: templateWeekly(FACTS), writtenBy: 'template', final: false });
    expect(admitted).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it('makes no call at all outside an AI scope', async () => {
    const bodies = model({ sentences: ['x'] });
    // The failure is logged and the template shown, never an unmetered call.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await writer().weekly(FACTS);
    error.mockRestore();
    expect(result.writtenBy).toBe('template');
    expect(bodies).toHaveLength(0);
  });
});
