// SPDX-License-Identifier: AGPL-3.0-only
// The API side of Dy's meeting brief (#3115) without a database: through InboxReader, metered() and the member's draft budget, a brief is exactly one metered model call; AI off and a member asking
// too often make no call at all; a spent AI budget and a failing call give the facts alone; words with a figure the facts do not hold are refused. Nothing is stored.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, InboxReader, withAiScope, type AiCall, type AiMeter, type AiUsage } from '@crove/agent';
import type { MeetingBriefSource } from '@crove/mod-crm';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { meetingBriefAi, prepareMeetingBrief } from '../src/crm-meeting-brief-ai.ts';

const SOURCE: MeetingBriefSource = {
  bookingId: '00000000-0000-4000-8000-000000000071',
  dealId: '00000000-0000-4000-8000-000000000040',
  wordsAllowed: true,
  meeting: { title: 'Tư vấn thuế', startsOn: '2026-12-02', startsTime: '09:30', timeZone: 'Asia/Ho_Chi_Minh', guestName: 'Lê Thị Bích Ngọc' },
  deal: { title: 'Gói kế toán năm', stage: 'Đàm phán', status: 'open', amount: '25000000.00', expectedClose: '2026-12-31', contactName: 'Công ty Ánh Dương' },
  nextSteps: [],
  quote: { label: 'BG-2026-0042', total: '48250000.0000', status: 'sent', validUntil: '2026-12-20', expired: false, sentOn: '2026-11-20' },
  messages: ['Cho chị hỏi lại báo giá nhé'],
};
const GOOD = { summary: 'Cơ hội đang ở giai đoạn Đàm phán, giá trị 25.000.000 đồng.', points: ['Hỏi khách về báo giá BG-2026-0042 (48.250.000 đồng).', 'Xác nhận ngày chốt 31/12/2026.'] };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 21, total_tokens: 61 } });

function setup(content: unknown, admit?: AiMeter['admit']) {
  const admitted: AiCall[] = [];
  const recorded: Array<{ call: AiCall; usage: AiUsage }> = [];
  const meter: AiMeter = { admit: admit ?? (async (call) => void admitted.push(call)), record: async (call, usage) => void recorded.push({ call, usage }) };
  const fetched = vi.fn(async () => new Response(JSON.stringify(completion(content)), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetched);
  const reader = new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
  const budget = new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 });
  const run = (ai = meetingBriefAi(reader, budget)) => withAiScope({ orgId: 'org-1', meter }, () => prepareMeetingBrief(ai, 'org-1', 'user-1', SOURCE));
  return { admitted, recorded, fetched, run, reader, budget };
}

afterEach(() => vi.unstubAllGlobals());

describe('the meeting brief on the API side', () => {
  it('is one metered model call, and the answer holds the facts and Dy\'s words', async () => {
    const t = setup(GOOD);
    const got = await t.run();
    expect(got).toMatchObject({ ai: 'used', summary: GOOD.summary, points: GOOD.points, bookingId: SOURCE.bookingId, messages: SOURCE.messages, quote: { total: '48250000.0000' } });
    expect(t.fetched).toHaveBeenCalledTimes(1);
    expect(t.admitted).toEqual([{ feature: 'crm.meeting_brief', module: 'crm', orgId: 'org-1', agentId: null, memberRunId: null }]);
    expect(t.recorded).toHaveLength(1);
  });

  it('makes no model call, and counts nothing, with AI off', async () => {
    const t = setup(GOOD);
    const got = await t.run(meetingBriefAi(null, t.budget));
    expect(got).toMatchObject({ ai: 'off', summary: null, points: [], deal: { title: 'Gói kế toán năm' }, messages: SOURCE.messages });
    expect(t.fetched).not.toHaveBeenCalled();
    expect(t.admitted).toEqual([]);
  });

  it('makes no call for a member who asks while a brief of theirs is still running', async () => {
    const t = setup(GOOD);
    const held = t.budget.take('org-1', 'user-1');
    expect(held.allowed).toBe(true);
    expect(await t.run()).toMatchObject({ ai: 'busy', summary: null, points: [] });
    expect(t.fetched).not.toHaveBeenCalled();
  });

  it('gives the facts alone when the AI budget is spent, and when the call fails', async () => {
    const spent = setup(GOOD, async () => {
      throw new AiBudgetExhaustedError('org', null);
    });
    expect(await spent.run()).toMatchObject({ ai: 'budget', summary: null, points: [] });
    expect(spent.fetched).not.toHaveBeenCalled();
    const broken = setup(GOOD);
    broken.fetched.mockImplementation(async () => new Response('nope', { status: 500 }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await broken.run()).toMatchObject({ ai: 'failed', summary: null, points: [] });
    error.mockRestore();
  });

  it('refuses words with a tampered figure and still counts the call, giving the facts alone', async () => {
    const t = setup({ summary: 'Giá trị 99.000.000 đồng.', points: GOOD.points });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await t.run()).toMatchObject({ ai: 'failed', summary: null, points: [], quote: { total: '48250000.0000' } });
    error.mockRestore();
    expect(t.admitted).toHaveLength(1);
    expect(t.recorded).toHaveLength(1);
  });

  it('gives the model no customer message while the org keeps customers\' words from it, and still shows them to the member', async () => {
    const t = setup(GOOD);
    const got = await withAiScope({ orgId: 'org-1', meter: { admit: async () => {}, record: async () => {} } }, () => prepareMeetingBrief(meetingBriefAi(t.reader, t.budget), 'org-1', 'user-1', { ...SOURCE, wordsAllowed: false }));
    expect(got.messages).toEqual(SOURCE.messages);
    const body = String((t.fetched.mock.calls[0] as unknown as [string, { body?: unknown }])[1]?.body);
    expect(body).not.toContain('Cho chị hỏi lại báo giá nhé');
    expect(body).toContain('No customer message is available.');
  });
});
