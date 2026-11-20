// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's sentence on a bank line the matcher could not settle (#4219): the check lets through a sentence that repeats only the date, amount and count it was given, refuses (never repairs) any that
// states another figure, names or picks a candidate, claims a step was done, advises, links or runs on; and on the real path the request body holds only those facts and the call is metered under finance.bank_match_explain.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, bankCandidatesLineFactsText, bankCandidatesLineHasNews, bankCandidatesLineInstructions, checkBankCandidatesLineSentence, withAiScope, type AiMeter, type BankCandidatesLineFacts } from '../src/index.ts';

const FACTS: BankCandidatesLineFacts = { language: 'vi', direction: 'in', date: '2026-11-05', amount: '4500000', candidates: 3 };
const EN: BankCandidatesLineFacts = { ...FACTS, language: 'en' };
const TWO: BankCandidatesLineFacts = { ...FACTS, candidates: 2 };
const TWO_EN: BankCandidatesLineFacts = { ...TWO, language: 'en' };
const check = (facts: BankCandidatesLineFacts, sentence: string) => checkBankCandidatesLineSentence(facts, { sentence });

describe('checkBankCandidatesLineSentence', () => {
  it('passes a sentence that repeats only the given date, amount and count', () => {
    expect(check(FACTS, 'Ngày 05/11/2026 có 3 ứng viên cho khoản 4.500.000 đồng, cần một người chọn.')).toMatchObject({ kind: 'sentence' });
    expect(check(EN, 'On 05/11/2026 there are 3 candidates for 4,500,000 dong, so a person needs to choose.')).toMatchObject({ kind: 'sentence' });
    expect(check(EN, 'Several candidates fit this line, so a person needs to choose.')).toMatchObject({ kind: 'sentence' });
    expect(check(EN, 'Money in on 05/11/2026: more than one candidate fits this line, so a person needs to choose.')).toMatchObject({ kind: 'sentence' });
    expect(check(EN, 'None of the 3 candidates stands out for 4,500,000 dong, so a person needs to look at this line.')).toMatchObject({ kind: 'sentence' });
    expect(check(FACTS, 'Tiền vào ngày 05/11/2026 khớp với nhiều ứng viên, cần một người xem lại.')).toMatchObject({ kind: 'sentence' });
    expect(check(FACTS, 'Có ba ứng viên cho khoản 4.500.000 đồng, cần một người xem lại.')).toMatchObject({ kind: 'sentence' });
  });

  it('refuses an empty answer, a long one and more than one sentence', () => {
    expect(checkBankCandidatesLineSentence(EN, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(check(EN, `${'a '.repeat(130)}`)).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(check(EN, 'Several fit. A person chooses.')).toEqual({ kind: 'none', code: 'TOO_LONG' });
  });

  it('refuses a figure the facts do not hold, a date that is not the line date, and a count set against the amount', () => {
    expect(check(EN, 'There are 4 candidates for this line.')).toMatchObject({ kind: 'none' });
    expect(check(EN, 'On 06/11/2026 several candidates fit this line.')).toMatchObject({ kind: 'none' });
    expect(check(EN, 'There are 4,500,000 candidates for this line.')).toEqual({ kind: 'none', code: 'BINDING' });
    expect(check(EN, 'The amount is 3 dong and several candidates fit.')).toEqual({ kind: 'none', code: 'BINDING' });
    expect(check(EN, 'Three candidates fit this line.')).toMatchObject({ kind: 'none' });
    expect(check(TWO, 'Có ba ứng viên cho dòng này.')).toMatchObject({ kind: 'none' });
    expect(check(EN, 'About 4.5 million dong came in, several candidates fit.')).toMatchObject({ kind: 'none' });
  });

  it('refuses a link, a pick of one candidate, a ranking, a claim that a step was done, and advice', () => {
    expect(check(EN, 'See https://example.com for the candidates of this line.')).toMatchObject({ kind: 'none' });
    expect(check(EN, 'The first candidate is probably the right one.')).toMatchObject({ kind: 'none' });
    expect(check(EN, 'Most likely it is the customer with the open balance.')).toEqual({ kind: 'none', code: 'PICK' });
    expect(check(FACTS, 'Khả năng cao là khách hàng đầu tiên.')).toMatchObject({ kind: 'none' });
    expect(check(EN, 'This line was matched and a voucher was posted.')).toEqual({ kind: 'none', code: 'CLAIM' });
    expect(check(FACTS, 'Dòng này đã được khớp với một khách hàng.')).toEqual({ kind: 'none', code: 'CLAIM' });
    expect(check(EN, 'You should pick the customer with the invoice.')).toEqual({ kind: 'none', code: 'ADVICE' });
    expect(check(EN, 'Несколько кандидатов подходят.')).toEqual({ kind: 'none', code: 'SCRIPT' });
  });
});

describe('the text check refuses an ordinal, a ranking, an order, a name, an assertion and a wrong direction', () => {
  const refused: Array<[BankCandidatesLineFacts, string]> = [
    [TWO_EN, 'Candidate 2 fits this line'],
    [TWO_EN, 'The second candidate fits the amount'],
    [TWO, 'Ứng viên số 2 khớp số tiền'],
    [TWO, 'Có 2 ứng viên, chọn ứng viên thứ nhất'],
    [TWO, 'Ứng viên thứ hai phù hợp hơn'],
    [TWO_EN, 'Candidate #2 fits better than the others'],
    [TWO, 'Khách hàng Minh Phát hợp lý nhất'],
    [TWO_EN, 'Pick the second one.'],
    [TWO_EN, 'Choose the newer customer.'],
    [TWO_EN, 'Approve the voucher for this line.'],
    [TWO_EN, 'It is safe to approve this voucher.'],
    [TWO_EN, 'Call your bank about this line.'],
    [TWO, 'Có nhiều ứng viên, chọn công ty Minh Phát.'],
    [TWO, 'Bạn duyệt chứng từ này đi.'],
    [TWO_EN, 'This is fraud, call the police.'],
    [TWO_EN, 'Nguyen Van A fits this line'],
    [TWO, 'Công ty TNHH Minh Phát cần được chọn'],
    [TWO, 'Có hai mươi ứng viên'],
    [TWO, 'Có ba ứng viên cho dòng này'],
    [TWO_EN, 'Money went out on 05/11/2026 and 2 candidates fit'],
  ];
  it.each(refused)('refuses %#: %s', (facts, sentence) => {
    expect(check(facts, sentence).kind).toBe('none');
  });

  it('lets through the count as digits or as its Vietnamese word when it is the real count, beside the candidate word', () => {
    expect(check(TWO, 'Có hai ứng viên cho dòng này, cần một người chọn.')).toMatchObject({ kind: 'sentence' });
    expect(check(TWO, 'Có 2 ứng viên cho dòng này, cần một người chọn.')).toMatchObject({ kind: 'sentence' });
    expect(check(TWO_EN, 'Money in on 05/11/2026 and 2 candidates fit, so a person needs to choose.')).toMatchObject({ kind: 'sentence' });
  });
});

describe('the facts and the call', () => {
  it('has news only when the matcher listed a candidate', () => {
    expect(bankCandidatesLineHasNews({ candidates: 0 })).toBe(false);
    expect(bankCandidatesLineHasNews({ candidates: 2 })).toBe(true);
  });

  it('is the instructions and the facts on the wire, with no planted name, and is metered under finance.bank_match_explain', async () => {
    const booked: string[] = [];
    const meter: AiMeter = { admit: async (call) => void booked.push(`${call.feature}:${call.module}`), record: async () => {} };
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        const content = JSON.stringify({ sentence: 'Có 3 ứng viên cho khoản 4.500.000 đồng, cần một người chọn.' });
        return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const planted = { ...FACTS, party: 'Công ty Canary', description: 'CK 0123456789' } as BankCandidatesLineFacts;
    const result = await withAiScope({ orgId: 'org', meter }, () => new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 }).bankCandidatesLineSentence(planted));
    expect(result).toMatchObject({ kind: 'sentence' });
    expect(booked).toEqual(['finance.bank_match_explain:finance']);
    const body = bodies[0] as string;
    expect(body).not.toContain('Canary');
    expect(body).not.toContain('0123456789');
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages[0]?.content).toBe(bankCandidatesLineInstructions('vi'));
    expect(messages[1]?.content).toContain(bankCandidatesLineFactsText(FACTS));
  });
});
afterEach(() => vi.unstubAllGlobals());
