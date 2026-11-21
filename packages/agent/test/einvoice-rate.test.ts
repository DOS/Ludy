// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's explanation of the VAT rate a correcting e-invoice proposes (#3709): what the checks refuse after the call, and what leaves for the model on the real path (a fake fetch
// behind chatModel, through metered() and generateText).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, checkEInvoiceRate, einvoiceRateFactsText, einvoiceRateInstructions, einvoiceRatePrompt, withAiScope, type AiMeter, type EInvoiceRateFacts } from '../src/index.ts';

const MOVED: EInvoiceRateFacts = { nature: 'amount_change', basis: 'correction_date', originalDate: '2026-11-20', correctionDate: '2027-01-10', reducedUntil: '2026-12-31', changes: [{ from: '8%', to: '10%' }], kept: ['5%'] };
const KEPT: EInvoiceRateFacts = { nature: 'return', basis: 'original', originalDate: '2026-11-20', correctionDate: '2027-01-10', reducedUntil: '2026-12-31', changes: [], kept: ['8%'] };
const say = (facts: EInvoiceRateFacts, sentence: string) => checkEInvoiceRate(facts, { sentence });

describe('the check on what the model wrote', () => {
  it('lets through a plain sentence that cites only the facts', () => {
    expect(say(MOVED, 'Sai số lượng làm đổi số tiền nên tính theo ngày 10/01/2027, sau 31/12/2026 nên dòng 8% chuyển sang 10%.')).toMatchObject({ kind: 'sentence' });
    expect(say(KEPT, 'Hàng bị trả lại nên các dòng giữ thuế suất 8% của hóa đơn gốc.')).toMatchObject({ kind: 'sentence' });
  });
  it('refuses a figure, a date or a percentage the facts do not hold', () => {
    expect(say(MOVED, 'Thuế suất mới là 12% từ 10/01/2027.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(say(MOVED, 'Tính theo ngày 15/02/2027.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(say(MOVED, 'Số tiền chênh lệch là 1500000 đồng.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(say(MOVED, 'Dòng 8% chuyển sang tám phần trăm.')).toEqual({ kind: 'none', code: 'FIGURES' });
  });
  it('refuses a rate that is not in a proposal that keeps every rate', () => {
    // 10% appears nowhere in the facts of a proposal that keeps 8%.
    expect(say(KEPT, 'Các dòng chuyển sang 10% vì hàng bị trả lại.')).toEqual({ kind: 'none', code: 'FIGURES' });
    // 5% is in the facts of the other proposal (a rate it keeps), but not in this one's: still a percentage the facts do not offer here.
    expect(say(KEPT, 'Các dòng giữ thuế suất 5%.')).toEqual({ kind: 'none', code: 'FIGURES' });
  });
  it('refuses an explanation that contradicts what the code decided (a moved rate kept, the wrong direction, a kept rate moved)', () => {
    expect(say(MOVED, 'Các dòng giữ nguyên thuế suất 8% của hóa đơn gốc.')).toEqual({ kind: 'none', code: 'RATE' });
    expect(say(MOVED, 'Dòng 8% giữ nguyên vì sai số lượng.')).toEqual({ kind: 'none', code: 'RATE' });
    expect(say(MOVED, 'Dòng 10% chuyển sang 8% vì sai số lượng.')).toEqual({ kind: 'none', code: 'RATE' });
    expect(say(MOVED, 'Dòng 5% chuyển sang 10%.')).toEqual({ kind: 'none', code: 'RATE' });
    // The true story passes, with a kept rate named as kept.
    expect(say(MOVED, 'Dòng 8% chuyển sang 10%, còn dòng 5% giữ nguyên.')).toMatchObject({ kind: 'sentence' });
    expect(say(KEPT, 'Các dòng giữ nguyên thuế suất 8%.')).toMatchObject({ kind: 'sentence' });
  });
  it('refuses a link, a foreign script, an empty text, a long one and more than two sentences', () => {
    expect(say(KEPT, 'Xem https://example.test để biết thêm.')).toEqual({ kind: 'none', code: 'LINK' });
    expect(say(KEPT, 'Hàng bị trả lại nên giữ thuế suất 8% (пример).')).toEqual({ kind: 'none', code: 'SCRIPT' });
    expect(say(KEPT, '   ')).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkEInvoiceRate(KEPT, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(say(KEPT, 'Hàng bị trả lại nên giữ thuế suất 8%. Đây là một câu. Và đây là câu thứ ba.')).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(say(KEPT, `Giữ thuế suất 8% ${'rất '.repeat(120)}.`)).toEqual({ kind: 'none', code: 'TOO_LONG' });
  });
});

describe('what the model is told', () => {
  it('is the nature, the two dates, the day 8% ended and the rates, and nothing else', () => {
    const text = einvoiceRateFactsText(MOVED);
    expect(text).toContain('10/01/2027');
    expect(text).toContain('20/11/2026');
    expect(text).toContain('31/12/2026');
    expect(text).toContain('8% to 10%');
    expect(Object.keys(MOVED).sort()).toEqual(['basis', 'changes', 'correctionDate', 'kept', 'nature', 'originalDate', 'reducedUntil']);
  });
});

const meter: AiMeter = { admit: async () => {}, record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });

afterEach(() => vi.unstubAllGlobals());

describe('the explanation on the real path', () => {
  const PLANTED = ['Công ty TNHH Mua Thử', '0100000001', 'INV-0000007', '12.345.678', 'nguyen@example.test'];
  // A careless caller's object: the same facts plus what an invoice has.
  const tainted = { ...MOVED, buyer: PLANTED[0], taxCode: PLANTED[1], number: PLANTED[2], total: PLANTED[3], email: PLANTED[4] } as EInvoiceRateFacts;

  it('sends the instructions and the facts only, and returns the checked sentence', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion({ sentence: 'Sai số lượng làm đổi số tiền nên dòng 8% chuyển sang 10% theo ngày 10/01/2027.' })), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const reader = new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    const result = await withAiScope({ orgId: 'org', meter }, () => reader.einvoiceRateExplanation(tainted));
    expect(result).toMatchObject({ kind: 'sentence' });
    const body = bodies[0] as string;
    for (const secret of PLANTED) expect(body).not.toContain(secret);
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(einvoiceRateInstructions());
    expect(messages[1]?.content).toBe(einvoiceRatePrompt(MOVED));
  });

  it('is refused, not repaired, when the model states a rate the facts do not hold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(completion({ sentence: 'Dòng 8% chuyển sang 12%.' })), { status: 200, headers: { 'content-type': 'application/json' } })));
    const reader = new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    expect(await withAiScope({ orgId: 'org', meter }, () => reader.einvoiceRateExplanation(MOVED))).toEqual({ kind: 'none', code: 'FIGURES' });
  });
});
