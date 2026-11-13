// SPDX-License-Identifier: AGPL-3.0-only
// Dy's meeting brief on the real path (#3115): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText. The meter is asked once and told
// once per brief under crm.meeting_brief, and told tokens only; a tampered figure in the answer gives no brief but the call is still counted; a call outside an AI scope never leaves.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, withAiScope, type AiCall, type AiMeter, type AiUsage, type MeetingBriefFacts } from '../src/index.ts';

const FACTS: MeetingBriefFacts = {
  meeting: { title: 'Tư vấn gói năm', startsOn: '2026-12-02', startsTime: '09:30', guestName: 'Lê Thị Bích Ngọc' },
  deal: { title: 'Gói phần mềm kế toán', stage: 'Đàm phán', status: 'open', amount: '25000000.00', expectedClose: '2026-12-31', contactName: 'Công ty Ánh Dương' },
  nextSteps: [],
  quote: { label: 'BG-2026-0042', total: '48250000.00', status: 'sent', validUntil: '2026-12-20', expired: false, sentOn: '2026-11-20' },
  messages: ['Cho chị hỏi lại báo giá nhé'],
};
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 21, total_tokens: 61 } });

function recorder() {
  const admitted: AiCall[] = [];
  const recorded: Array<{ call: AiCall; usage: AiUsage }> = [];
  const meter: AiMeter = { admit: async (call) => void admitted.push(call), record: async (call, usage) => void recorded.push({ call, usage }) };
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

const reader = () => new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });

afterEach(() => vi.unstubAllGlobals());

describe('the meeting brief on the wire', () => {
  it('sends the facts once and the meter counts one call under crm.meeting_brief, tokens only', async () => {
    const answer = { summary: 'Cơ hội đang ở giai đoạn Đàm phán, giá trị 25.000.000 đồng.', points: ['Hỏi khách về báo giá BG-2026-0042 (48.250.000 đồng).', 'Xác nhận ngày chốt 31/12/2026.'] };
    const bodies = model(answer);
    const { meter, admitted, recorded } = recorder();
    const used: AiUsage[] = [];
    const result = await withAiScope({ orgId: 'org-1', meter }, () => reader().meetingBrief(FACTS, (u) => used.push(u)));
    expect(result).toEqual({ kind: 'brief', brief: answer });
    expect(bodies).toHaveLength(1);
    const messages = (JSON.parse(bodies[0] as string) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]?.content).toContain('48.250.000 đồng');
    expect(messages[1]?.content).toContain('Cho chị hỏi lại báo giá nhé');
    // Exactly one call, asked once and recorded once, in the CRM's budget line; the meter is given ids and tokens, never the prompt or the answer.
    expect(admitted).toEqual([{ feature: 'crm.meeting_brief', module: 'crm', orgId: 'org-1', agentId: null, memberRunId: null }]);
    expect(recorded).toEqual([{ call: admitted[0], usage: { inputTokens: 40, outputTokens: 21 } }]);
    expect(JSON.stringify(recorded)).not.toContain('Đàm phán');
    expect(used).toEqual([{ inputTokens: 40, outputTokens: 21 }]);
  });

  it('refuses a tampered figure, and still counts the call the model was paid for', async () => {
    model({ summary: 'Giá trị 99.000.000 đồng.', points: ['Hỏi khách.', 'Chốt ngày 31/12/2026.'] });
    const { meter, admitted, recorded } = recorder();
    const result = await withAiScope({ orgId: 'org-1', meter }, () => reader().meetingBrief(FACTS));
    expect(result).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(admitted).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it('makes no call at all outside an AI scope', async () => {
    const bodies = model({ summary: 'x', points: ['y', 'z'] });
    await expect(reader().meetingBrief(FACTS)).rejects.toThrow(/outside an AI scope/);
    expect(bodies).toHaveLength(0);
  });
});
