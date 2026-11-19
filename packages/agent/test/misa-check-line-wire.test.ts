// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's line above the MISA export check on the real path (#3848 slice B): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText.
// The facts hold six counts; a careless caller that adds a column, a voucher number, a party or an account to the object changes nothing on the wire, and the feature is booked under its own AI budget key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, misaCheckLineFactsText, misaCheckLineInstructions, withAiScope, type AiMeter, type MisaCheckLineFacts } from '../src/index.ts';

const PLANTED = ['Mã dịch vụ (*)', 'CRMDV000000123', 'Công ty TNHH Giấy Canary', '0101234564', 'TK chi phí/TK kho', '6422'];
const FACTS: MisaCheckLineFacts = { language: 'vi', rows: 40, codes: 12, required: 0, vat: 3, accounts: 2, tooLong: 5 };
const tainted = { ...FACTS, column: PLANTED[0], voucherNo: PLANTED[1], party: PLANTED[2], taxCode: PLANTED[3], header: PLANTED[4], account: PLANTED[5] } as MisaCheckLineFacts;

const booked: string[] = [];
const meter: AiMeter = { admit: async (call) => void booked.push(`${call.feature}:${call.module}`), record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
const reader = () => new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });

afterEach(() => vi.unstubAllGlobals());

describe('what leaves for the model for the MISA check line (the bytes of the HTTP request)', () => {
  it('is the instructions and the six counts, with no planted column, voucher, party, tax code or account, and is metered', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion({ sentence: 'Có 12 ô mã cần điền trong file: hãy điền mã trước khi nhập.' })), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    booked.length = 0;
    const result = await withAiScope({ orgId: 'org', meter }, () => reader().misaCheckLineSentence(tainted));
    expect(result).toMatchObject({ kind: 'sentence' });
    expect(booked).toEqual(['finance.misa_check_line:finance']);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const secret of PLANTED) expect(body).not.toContain(secret);
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(misaCheckLineInstructions('vi'));
    expect(messages[1]?.content).toBe(`${misaCheckLineFactsText(FACTS)}\n\nWrite the sentence on what the problems mean and how to fix them.`);
  });

  it('is refused, not repaired, when the model writes a number the counts do not hold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(completion({ sentence: 'Có 13 ô mã cần điền trong file.' })), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await withAiScope({ orgId: 'org', meter }, () => reader().misaCheckLineSentence(FACTS))).toEqual({ kind: 'none', code: 'FIGURES' });
  });
});
