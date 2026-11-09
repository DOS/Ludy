// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's line on a payroll payment match on the real path (#2532): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText.
// The facts hold the kind, month, amount and date and a yes or no; a caller that carelessly adds the statement line's description, counterparty, account or a person's name to the object changes nothing
// on the wire, and the text it brings back is display only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, payrollMatchFactsText, payrollMatchInstructions, withAiScope, type AiMeter, type PayrollMatchFacts } from '../src/index.ts';

const PLANTED = ['Nguyễn Văn Thử', 'Nguyen Van Thu', '0123456789012', 'VCB 1234 5678 9012', 'CK LUONG THANG 03 CHO NGUYEN VAN THU', 'Công ty Bảng Lương Thử', 'Ngân hàng Ngoại thương'];
const FACTS: PayrollMatchFacts = { language: 'vi', kind: 'net_pay', month: '2026-03', amount: '18450000', date: '2026-04-05', described: true };
// A careless caller's object: the same facts plus fields a statement line has.
const tainted = { ...FACTS, description: PLANTED[4], counterparty: PLANTED[0], counterpartyAccount: PLANTED[2], bankAccount: PLANTED[3], employer: PLANTED[5], bank: PLANTED[6], name: PLANTED[1] } as PayrollMatchFacts;

const meter: AiMeter = { admit: async () => {}, record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });

afterEach(() => vi.unstubAllGlobals());

describe('what leaves for the model for a payroll match (the bytes of the HTTP request)', () => {
  it('is the instructions and the four facts and a yes or no, with no planted description, name, account or bank', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion({ sentence: 'Số tiền 18.450.000 đồng khớp khoản chi lương tháng 03/2026.' })), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const reader = new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    const result = await withAiScope({ orgId: 'org', meter }, () => reader.payrollMatchSentence(tainted));
    expect(result).toMatchObject({ kind: 'sentence' });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const secret of PLANTED) expect(body).not.toContain(secret);
    expect(body).not.toMatch(/Nguy|0123456789|VCB|LUONG THANG|Ngoại thương|Bảng Lương/);
    // The request is the real one, and its messages are exactly the instructions and the facts.
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(payrollMatchInstructions('vi'));
    expect(messages[1]?.content).toBe(`${payrollMatchFactsText(FACTS)}\n\nWrite the sentence on why this line may be that payment.`);
  });
});
