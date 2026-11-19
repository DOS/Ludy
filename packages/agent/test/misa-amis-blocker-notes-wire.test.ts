// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's notes on the AMIS preview on the real path (#3904): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText. The facts hold the
// kinds of blocker and nothing else; a careless caller that adds a count, a voucher number, a party or an item code to the object changes nothing on the wire, and the feature is booked under its own AI budget key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, misaAmisBlockerNotesFactsText, misaAmisBlockerNotesInstructions, withAiScope, type AiMeter, type MisaAmisBlockerNotesFacts } from '../src/index.ts';

const PLANTED = ['CRMDV000000123', 'Công ty TNHH Giấy Canary', '0101234564', 'DV-GIAY-001', '4242000'];
const FACTS: MisaAmisBlockerNotesFacts = { language: 'vi', kinds: ['item_code_unknown', 'vat_rate_unmapped'] };
const tainted = { ...FACTS, count: 4242000, voucherNo: PLANTED[0], party: PLANTED[1], taxCode: PLANTED[2], itemCode: PLANTED[3] } as MisaAmisBlockerNotesFacts;

const booked: string[] = [];
const meter: AiMeter = { admit: async (call) => void booked.push(`${call.feature}:${call.module}`), record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
const reader = () => new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });

afterEach(() => vi.unstubAllGlobals());

describe('what leaves for the model for the AMIS blocker notes (the bytes of the HTTP request)', () => {
  it('is the instructions and the kinds with their meaning, with nothing planted, and is metered', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(
          JSON.stringify(completion({ notes: [{ kind: 'item_code_unknown', text: 'Dòng chưa có mã hàng AMIS: hãy nhập mã hàng AMIS trong Ludy.' }, { kind: 'vat_rate_unmapped', text: 'Thuế suất của dòng không nằm trong số AMIS nhận: hãy sửa thuế suất trong Ludy.' }] })),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    booked.length = 0;
    const result = await withAiScope({ orgId: 'org', meter }, () => reader().misaAmisBlockerNotes(tainted));
    expect(result).toMatchObject({ kind: 'notes' });
    expect(booked).toEqual(['finance.misa_amis_blocker_notes:finance']);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const secret of PLANTED) expect(body).not.toContain(secret);
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(misaAmisBlockerNotesInstructions('vi'));
    expect(messages[1]?.content).toBe(`Kinds of problem and their meaning:\n${misaAmisBlockerNotesFactsText(FACTS)}\n\nWrite one note for each kind.`);
  });

  it('drops a note the model writes with a number, and keeps the one that stands', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(completion({ notes: [{ kind: 'item_code_unknown', text: 'Có 13 dòng thiếu mã.' }, { kind: 'vat_rate_unmapped', text: 'Thuế suất của dòng không nằm trong số AMIS nhận: hãy sửa thuế suất trong Ludy.' }] })), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const result = await withAiScope({ orgId: 'org', meter }, () => reader().misaAmisBlockerNotes(FACTS));
    expect(result).toEqual({ kind: 'notes', notes: [{ kind: 'vat_rate_unmapped', text: 'Thuế suất của dòng không nằm trong số AMIS nhận: hãy sửa thuế suất trong Ludy.' }] });
  });
});
