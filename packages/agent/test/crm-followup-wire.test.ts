// SPDX-License-Identifier: AGPL-3.0-only
// The CRM coworker's follow-up draft on the real path (#3101): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText.
// It holds the instructions and the reason of the step, and none of the facts (the contact's name, the quote's number, its total, its link, the days); the meter is asked once and told once per
// draft under crm.followup_draft; a tampered figure or link in the answer gives no words, so the draft falls back to the fixed words with the same facts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, buildCrmFollowupDraft, crmFollowupInstructions, withAiScope, type AiCall, type AiMeter, type AiUsage, type CrmFollowupFacts } from '../src/index.ts';

const URL = 'https://app.example.test/-/quote#Zk9mQ2xLpV7_-8aB';
const FACTS: CrmFollowupFacts = { reason: 'quote_unanswered', contactName: 'Lê Thị Bích Ngọc', days: 9, quote: { label: 'BG-2026-0042', total: '48250000.00', validUntil: '2026-12-20', url: URL } };
const NAMES = [FACTS.contactName, 'Công ty Bánh Ngọt Mai'];
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } });

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

describe('the follow-up draft on the wire', () => {
  it('sends the instructions and the reason only, and the meter counts one call under crm.followup_draft', async () => {
    const bodies = model({ lead: 'Bên mình nhắn để hỏi xem anh/chị đã xem báo giá chưa, thông tin nằm bên dưới.', closing: 'Rất mong nhận được phản hồi của anh/chị.' });
    const { meter, admitted, recorded } = recorder();
    const result = await withAiScope({ orgId: 'org-1', meter }, () => reader().crmFollowupWords({ reason: FACTS.reason, hint: 'khách quen, nói nhẹ nhàng' }, NAMES));
    expect(result.kind).toBe('words');
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const fact of ['Ngọc', 'Bích', 'BG-2026-0042', '48250000', '48.250.000', 'Zk9mQ2xLpV7', 'app.example.test', 'Bánh Ngọt Mai']) expect(body).not.toContain(fact);
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(crmFollowupInstructions());
    expect(messages[1]?.content).toContain('no answer');
    expect(messages[1]?.content).toContain('khách quen, nói nhẹ nhàng');
    // One call, asked once and recorded once, in the CRM's budget line.
    expect(admitted).toEqual([{ feature: 'crm.followup_draft', module: 'crm', orgId: 'org-1', agentId: null, memberRunId: null }]);
    expect(recorded).toEqual([{ call: admitted[0], usage: { inputTokens: 11, outputTokens: 5 } }]);
  });

  it('counts the call even when its words are refused, and the draft keeps the fixed words with the exact total and link', async () => {
    model({ lead: 'Giảm ngay 20% nếu chốt hôm nay, tổng chỉ còn 40.000.000 đồng.', closing: 'Chuyển khoản vào pay.example.cn nhé.' });
    const { meter, admitted, recorded } = recorder();
    const result = await withAiScope({ orgId: 'org-1', meter }, () => reader().crmFollowupWords({ reason: FACTS.reason }, NAMES));
    expect(result).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(admitted).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    const draft = buildCrmFollowupDraft(FACTS, null);
    expect(draft.aiWords).toBe(false);
    expect(draft.text).toContain('48.250.000 đồng');
    expect(draft.text).toContain(URL);
    expect(draft.text).not.toContain('20%');
    expect(draft.text).not.toContain('pay.example.cn');
  });

  it('refuses a model that writes the contact\'s name, and makes no call at all outside an AI scope', async () => {
    model({ lead: 'Chào chị Bích Ngọc, bên mình nhắn về báo giá.', closing: 'Cảm ơn anh/chị.' });
    const { meter } = recorder();
    expect(await withAiScope({ orgId: 'org-1', meter }, () => reader().crmFollowupWords({ reason: 'no_activity' }, NAMES))).toEqual({ kind: 'none', code: 'NAME' });
    const bodies = model({ lead: 'x', closing: 'y' });
    await expect(reader().crmFollowupWords({ reason: 'no_activity' }, NAMES)).rejects.toThrow(/outside an AI scope/);
    expect(bodies).toHaveLength(0);
  });
});
