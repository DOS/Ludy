// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's proposal of the reason code of a correcting e-invoice (#3690): what the checks refuse after the call, that the code can only come from the list by number, and what leaves for the
// model on the real path (a fake fetch behind chatModel, through metered() and generateText).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, checkEInvoiceReason, einvoiceReasonInstructions, einvoiceReasonPrompt, withAiScope, type AiMeter, type EInvoiceReasonFacts } from '../src/index.ts';

// A stand-in list: the real one is data (packages/einvoice reason-codes.ts) and is empty until it is read from MISA's guide; these are made up for the tests and mean nothing.
const CODES = [
  { code: 'T-1', label: 'Sai thông tin người mua' },
  { code: 'T-2', label: 'Sai số lượng hoặc đơn giá' },
  { code: 'T-3', label: 'Sai thuế suất' },
];
const FACTS: EInvoiceReasonFacts = {
  codes: CODES,
  adjustment: true,
  buyerKind: 'business',
  originalDate: '2026-11-20',
  lines: [{ description: 'Bánh hộp A', unit: 'hộp', quantity: '10', vatRate: '8%' }],
  note: 'Ghi sai số lượng, đúng là 12 hộp',
};
const check = (output: { choice: number | null; why: string } | null, facts: EInvoiceReasonFacts = FACTS) => checkEInvoiceReason(facts, output);

describe('the check on what the model answered', () => {
  it('takes the code from the list by number and keeps the why', () => {
    expect(check({ choice: 2, why: 'Mô tả nói sai số lượng, đúng là 12 hộp.' })).toEqual({ kind: 'proposal', index: 1, why: 'Mô tả nói sai số lượng, đúng là 12 hộp.' });
  });
  it('gives no code for a number outside the list, none, or a number that is not whole', () => {
    for (const choice of [0, 4, -1, 99, 1.5, Number.NaN, null]) expect(check({ choice, why: 'Sai số lượng.' })).toEqual({ kind: 'none', code: 'NO_MATCH' });
    expect(check(null)).toEqual({ kind: 'none', code: 'NO_MATCH' });
  });
  it('asks nothing without a list or a note', () => {
    expect(check({ choice: 1, why: 'x' }, { ...FACTS, codes: [] })).toEqual({ kind: 'none', code: 'NO_LIST' });
    expect(check({ choice: 1, why: 'x' }, { ...FACTS, note: '   ' })).toEqual({ kind: 'none', code: 'NO_NOTE' });
  });
  it('refuses an empty why, a long one and more than one sentence', () => {
    expect(check({ choice: 2, why: '  ' })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(check({ choice: 2, why: `Sai số lượng ${'rất '.repeat(80)}.` })).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(check({ choice: 2, why: 'Sai số lượng. Còn sai cả giá.' })).toEqual({ kind: 'none', code: 'TOO_LONG' });
  });
  it('refuses a figure the note, the lines and the labels do not hold, and a link', () => {
    expect(check({ choice: 2, why: 'Đúng là 15 hộp.' })).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(check({ choice: 2, why: 'Chênh lệch 500000 đồng.' })).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(check({ choice: 2, why: 'Xem https://example.test để biết thêm.' })).toEqual({ kind: 'none', code: 'LINK' });
    // A figure that IS in the note, the lines or a label is fine.
    expect(check({ choice: 2, why: 'Số lượng ghi 10 nhưng đúng là 12.' })).toMatchObject({ kind: 'proposal' });
  });
  it('states no figure that is only the numbering of the list, the lines or the date', () => {
    // 3 is the third code, 1 the first line, 20 and 11 and 2026 the date: none of them was stated by anyone.
    for (const why of ['Số lượng đúng là 3 hộp.', 'Số lượng đúng là 20 hộp.', 'Số lượng đúng là 2026 hộp.', 'Số lượng đúng là 11 hộp.']) expect(check({ choice: 2, why })).toEqual({ kind: 'none', code: 'FIGURES' });
  });
  it('lets plain facts about the original through (it is issued by definition)', () => {
    for (const why of ['Số lượng cần được điều chỉnh cho đúng.', 'Hóa đơn cần được thay thế vì sai số lượng.', 'Hóa đơn đã lập ghi sai số lượng.', 'Hóa đơn đã xuất ghi sai số lượng hàng.']) {
      expect(check({ choice: 2, why })).toMatchObject({ kind: 'proposal' });
    }
  });
  it('refuses a foreign script and a claim that a step was done', () => {
    expect(check({ choice: 2, why: 'Sai số lượng (пример).' })).toEqual({ kind: 'none', code: 'SCRIPT' });
    expect(check({ choice: 1, why: 'Hóa đơn đã gửi cho người mua nên cần sửa.' })).toEqual({ kind: 'none', code: 'CLAIM' });
    expect(check({ choice: 1, why: 'The invoice was issued with the wrong buyer.' })).toEqual({ kind: 'none', code: 'CLAIM' });
    for (const why of ['Cơ quan thuế đã chấp nhận hóa đơn này.', 'Hóa đơn đã được cấp mã rồi.', 'We sent it to the buyer yesterday.', 'Hóa đơn được duyệt xong.']) expect(check({ choice: 1, why })).toEqual({ kind: 'none', code: 'CLAIM' });
    expect(check({ choice: 1, why: 'Người mua đã đổi địa chỉ nên ghi lại.' })).toMatchObject({ kind: 'proposal' });
  });
  it('offers at most the first 60 codes and refuses a number past them', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ code: `C-${i + 1}`, label: `Lý do ${i + 1}` }));
    expect(check({ choice: 61, why: 'Sai.' }, { ...FACTS, codes: many })).toEqual({ kind: 'none', code: 'NO_MATCH' });
    expect(check({ choice: 60, why: 'Sai.' }, { ...FACTS, codes: many })).toMatchObject({ kind: 'proposal', index: 59 });
  });
});

const meter: AiMeter = { admit: async () => {}, record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });

afterEach(() => vi.unstubAllGlobals());

describe('the proposal on the real path', () => {
  const PLANTED = ['Công ty TNHH Mua Thử', '0100000001', 'INV-0000007', '12.345.678', 'nguyen@example.test', '99 Phố Kín', 'VCB 1234 5678'];
  // A careless caller's object: the same facts plus what an invoice and its buyer have.
  const tainted = { ...FACTS, buyer: { name: PLANTED[0], taxCode: PLANTED[1] }, number: PLANTED[2], total: PLANTED[3], email: PLANTED[4], address: PLANTED[5], bank: PLANTED[6] } as unknown as EInvoiceReasonFacts;
  const fetchOf = (answer: unknown, bodies: string[] = []) =>
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify(completion(answer)), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  const reader = () => new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });

  it('sends the instructions, the list, the buyer kind, the lines and the note, and nothing else', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', fetchOf({ choice: 2, why: 'Mô tả nói sai số lượng, đúng là 12 hộp.' }, bodies));
    const result = await withAiScope({ orgId: 'org', meter }, () => reader().einvoiceReasonSuggestion(tainted));
    expect(result).toMatchObject({ kind: 'proposal', index: 1 });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const secret of PLANTED) expect(body).not.toContain(secret);
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(einvoiceReasonInstructions());
    expect(messages[1]?.content).toBe(einvoiceReasonPrompt(FACTS));
    // The list is offered with numbers and labels only: the codes themselves are the caller's.
    expect(messages[1]?.content).toContain('2. Sai số lượng hoặc đơn giá');
    expect(messages[1]?.content).not.toContain('T-2');
  });

  it('makes no call with no list or no note', async () => {
    const fetchMock = fetchOf({ choice: 1, why: 'x' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await withAiScope({ orgId: 'org', meter }, () => reader().einvoiceReasonSuggestion({ ...FACTS, codes: [] }))).toEqual({ kind: 'none', code: 'NO_LIST' });
    expect(await withAiScope({ orgId: 'org', meter }, () => reader().einvoiceReasonSuggestion({ ...FACTS, note: '' }))).toEqual({ kind: 'none', code: 'NO_NOTE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is refused, not repaired, when the model answers a number outside the list or states a figure the facts do not hold', async () => {
    vi.stubGlobal('fetch', fetchOf({ choice: 7, why: 'Sai số lượng.' }));
    expect(await withAiScope({ orgId: 'org', meter }, () => reader().einvoiceReasonSuggestion(FACTS))).toEqual({ kind: 'none', code: 'NO_MATCH' });
    vi.stubGlobal('fetch', fetchOf({ choice: 2, why: 'Đúng là 15 hộp.' }));
    expect(await withAiScope({ orgId: 'org', meter }, () => reader().einvoiceReasonSuggestion(FACTS))).toEqual({ kind: 'none', code: 'FIGURES' });
  });
});
