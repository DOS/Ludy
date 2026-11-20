// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's notes under the Sàn table on the real path (#3711 slice 7): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText. The facts
// hold the fees, the age and past the cycle per numbered row and the cycle length; a careless caller that adds a platform name, a party or an entity to the object changes nothing on the wire, and the feature is
// booked under its own AI budget key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, marketplaceFeeNotesFactsText, marketplaceFeeNotesInstructions, withAiScope, type AiMeter, type MarketplaceFeeNoteFacts } from '../src/index.ts';

const PLANTED = ['Gian hàng Cửa Hàng Canary', 'Shopee', '0101234564', 'CRMDV000000123', '99999999'];
const FACTS: MarketplaceFeeNoteFacts = { language: 'vi', cycleDays: 45, rows: [{ fees: '1200000', ageDays: 51, overdue: true }] };
const tainted = { ...FACTS, rows: [{ ...FACTS.rows[0], platformName: PLANTED[0], platform: PLANTED[1], taxCode: PLANTED[2], voucher: PLANTED[3], legalEntityId: PLANTED[4] }] } as unknown as MarketplaceFeeNoteFacts;

const booked: string[] = [];
const meter: AiMeter = { admit: async (call) => void booked.push(`${call.feature}:${call.module}`), record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
const reader = () => new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });

afterEach(() => vi.unstubAllGlobals());

describe('what leaves for the model for the Sàn fee notes (the bytes of the HTTP request)', () => {
  it('is the instructions and the row facts, with nothing planted, and is metered', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion({ notes: [{ row: 1, text: 'Phí 1.200.000 đồng chờ 51 ngày, quá chu kỳ 45 ngày: hãy xin hóa đơn phí từ sàn hoặc nhập hóa đơn.' }] })), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    booked.length = 0;
    const result = await withAiScope({ orgId: 'org', meter }, () => reader().marketplaceFeeNotes(tainted));
    expect(result).toMatchObject({ kind: 'notes' });
    expect(booked).toEqual(['finance.marketplace_fee_note:finance']);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const secret of PLANTED) expect(body).not.toContain(secret);
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(marketplaceFeeNotesInstructions('vi'));
    expect(messages[1]?.content).toBe(`${marketplaceFeeNotesFactsText(FACTS)}\n\nWrite one note for each row.`);
  });

  it('drops a note the model writes with a number that is not its row, and says none stands', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(completion({ notes: [{ row: 1, text: 'Phí 9.999.000 đồng chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi.' }] })), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await withAiScope({ orgId: 'org', meter }, () => reader().marketplaceFeeNotes(FACTS))).toEqual({ kind: 'none', code: 'REFUSED' });
  });
});
