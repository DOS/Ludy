// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's note on the 30/60/90-day cash forecast (#4391): the model is told the computed figures and dates and no name, and its text is refused when it states a number or date the
// facts do not hold, a link, advice about money or a promise. The generator is a stand-in, so nothing here reaches a model.
import { describe, expect, it } from 'vitest';
import { InboxReader, checkCashForecastSentence, cashForecastFactsText, cashForecastInstructions, cashForecastPrompt, cashForecastQuiet, type CashForecastFacts } from '../src/index.ts';

const FACTS: CashForecastFacts = {
  language: 'vi',
  asOf: '2026-12-01',
  openingCash: '10000000',
  low: { date: '2026-12-18', balance: '2500000' },
  checkpoints: [
    { days: 30, date: '2026-12-31', balance: '4000000', receipts: '9000000', payments: '15000000' },
    { days: 60, date: '2027-01-30', balance: '6000000', receipts: '14000000', payments: '18000000' },
    { days: 90, date: '2027-03-01', balance: '7000000', receipts: '20000000', payments: '23000000' },
  ],
  topItems: [
    { kind: 'payable', date: '2026-12-18', amount: '8000000' },
    { kind: 'approved_payment', date: '2026-12-03', amount: '3000000' },
    { kind: 'receipt', date: '2026-12-10', amount: '1500000' },
  ],
  overdueReceiptsNotCounted: '4000000',
  unlinkedReceivablesNotCounted: '0',
  notIncluded: ['payroll', 'insurance', 'tax', 'rent', 'loans', 'recurring'],
  truncated: false,
};
const EN: CashForecastFacts = { ...FACTS, language: 'en' };
const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };
const empty: CashForecastFacts = { ...FACTS, checkpoints: FACTS.checkpoints.map((c) => ({ ...c, receipts: '0', payments: '0' })), topItems: [] };

describe('cashForecastFactsText', () => {
  it('gives every figure and date as the note must write it, in Vietnamese', () => {
    const text = cashForecastFactsText(FACTS);
    expect(text).toContain('Tiền mặt và tiền gửi (111, 112) ngày 2026-12-01: 10.000.000 đồng');
    expect(text).toContain('Số dư thấp nhất ngày 2026-12-18: 2.500.000 đồng');
    expect(text).toContain('Sau 30 ngày (2026-12-31): số dư 4.000.000 đồng, tổng thu 9.000.000 đồng, tổng chi 15.000.000 đồng');
    expect(text).toContain('2026-12-18: khoản phải trả người bán (hạn ước tính), 8.000.000 đồng');
    expect(text).toContain('Hóa đơn bán đã quá hạn, không tính vào dự báo: 4.000.000 đồng');
    expect(text).toContain('Không có trong dự báo: lương, bảo hiểm xã hội, thuế phải nộp, tiền thuê, khoản vay, chi phí định kỳ khác.');
    expect(text).not.toContain('Phải thu (131) chưa gắn');
  });

  it('writes English with its own separators, a negative balance as "minus", and the partial warning', () => {
    const text = cashForecastFactsText({ ...EN, low: { date: '2026-12-18', balance: '-1234567' }, truncated: true });
    expect(text).toContain('Lowest balance on 2026-12-18: minus 1,234,567 dong');
    expect(text).toContain('The forecast is partial');
    expect(text).toContain('Not in the forecast: payroll, social insurance, tax payments, rent, loans, other recurring costs.');
  });

  it('tells no name: only labels, amounts and dates', () => {
    expect(cashForecastPrompt(FACTS)).not.toMatch(/MST|@|http/);
    expect(cashForecastInstructions('en')).toContain('Write in English');
    expect(cashForecastInstructions('vi')).toContain('never "will" or "sẽ"');
  });
});

describe('cashForecastQuiet', () => {
  it('is true when nothing comes in or goes out in the 90 days, and false when anything does', () => {
    expect(cashForecastQuiet(empty)).toBe(true);
    expect(cashForecastQuiet(FACTS)).toBe(false);
    expect(cashForecastQuiet({ ...empty, checkpoints: [{ days: 90, date: '2027-03-01', balance: '0', receipts: '0', payments: '1' }] })).toBe(false);
  });
});

describe('checkCashForecastSentence', () => {
  const vi = (text: string) => checkCashForecastSentence(FACTS, { sentence: text });
  const en = (text: string) => checkCashForecastSentence(EN, { sentence: text });

  it('keeps a sentence that says what drives the low point in words only', () => {
    const text = 'Số dư thấp nhất dự kiến đến sau khoản phải trả người bán lớn nhất, trước khi các khoản thu tiếp theo về; dự báo chưa gồm lương và thuế phải nộp.';
    expect(vi(text)).toEqual({ kind: 'sentence', text });
    const english = 'The lowest balance is expected after the largest payment to a supplier, before the receipts that follow; the forecast leaves out payroll and tax payments.';
    expect(en(english)).toEqual({ kind: 'sentence', text: english });
  });

  // A figure cannot be swapped on the wrong label because none can be written: any digit refuses the text, even one the facts hold (the balance of day 90 put beside "the lowest balance" would pass a check
  // that only asks whether the number is among the given ones).
  it('refuses any digit, a figure of the facts included, so a given figure cannot sit on the wrong label', () => {
    expect(vi('Số dư thấp nhất dự kiến là 7.000.000 đồng.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(en('The lowest balance is expected to be 7,000,000 dong.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(en('The lowest balance is expected to be 2,500,000 dong.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(en('The lowest balance is expected on 2026-12-18.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(en('The lowest balance comes after 30 days.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(vi('Số dư thấp nhất dự kiến vào ngày 2026-12-19.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(vi('Số dư thấp nhất dự kiến còn 2,5 triệu đồng.')).toEqual({ kind: 'none', code: 'FIGURES' });
  });

  it('refuses a number in words, a scaled number, a month or day by name, and an invisible character', () => {
    expect(vi('Số dư thấp nhất dự kiến giảm hai mươi phần trăm.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(en('The lowest balance is expected to be about two million.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(en('The lowest balance is expected in December.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(en('The lowest balance is expected on Friday, after a payment.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(vi('Số dư thấp nhất dự kiến vào chủ nhật.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(en('The lowest balance is expected after a pay\u200bment.')).toEqual({ kind: 'none', code: 'FIGURES' });
    // "may" is a word of the language, not a month.
    const may = 'The lowest balance may come after the largest payment to a supplier.';
    expect(en(may)).toEqual({ kind: 'sentence', text: may });
  });

  it('refuses a link', () => {
    expect(en('The lowest balance is expected after a payment, see example.com for the details.')).toEqual({ kind: 'none', code: 'LINK' });
  });

  it('refuses advice to move, borrow, delay or chase money, in both languages', () => {
    for (const text of [
      'Số dư thấp nhất dự kiến đến sau một khoản phải trả; nên hoãn khoản phải trả đó.',
      'Số dư thấp nhất dự kiến đến sau một khoản phải trả, hãy đòi nợ khách hàng.',
      'Số dư thấp nhất dự kiến đến sau một khoản phải trả; có thể vay thêm để bù.',
      'Số dư thấp nhất dự kiến đến sau một khoản phải trả, cần phải chuyển tiền vào tài khoản.',
    ]) {
      expect(vi(text), text).toEqual({ kind: 'none', code: 'ADVICE' });
    }
    for (const text of [
      'The lowest balance is expected after a payment to a supplier; you should delay that payment.',
      'The lowest balance is expected after a payment to a supplier, so consider a loan.',
      'The lowest balance is expected after a payment to a supplier; try to collect the receipts earlier.',
      'The lowest balance is expected after a payment to a supplier and you may need to transfer money.',
      'The lowest balance is expected after a payment to a supplier; it is better to pay later.',
    ]) {
      expect(en(text), text).toEqual({ kind: 'none', code: 'ADVICE' });
    }
  });

  it('refuses a promise or a certainty, in both languages', () => {
    for (const text of ['Số dư thấp nhất sẽ đến sau khoản phải trả người bán lớn nhất.', 'Chắc chắn số dư thấp nhất đến sau một khoản phải trả.', 'Tôi đảm bảo số dư thấp nhất đến sau một khoản phải trả.']) {
      expect(vi(text), text).toEqual({ kind: 'none', code: 'PROMISE' });
    }
    for (const text of ['The balance will be lowest after a payment to a supplier.', 'The lowest balance is certainly after a payment to a supplier.', 'It is guaranteed that the balance stays above the lowest point.']) {
      expect(en(text), text).toEqual({ kind: 'none', code: 'PROMISE' });
    }
  });

  it('refuses an empty answer, a missing answer, more than three sentences and a text that is too long', () => {
    expect(vi('   ')).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkCashForecastSentence(FACTS, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(en('Expected low. Expected low. Expected low. Expected low.')).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(en(`The lowest balance is expected after a payment. ${'x'.repeat(500)}`)).toEqual({ kind: 'none', code: 'TOO_LONG' });
  });
});

describe('InboxReader.cashForecastSentence', () => {
  const reader = (sentence: string | null, seen: string[] = []) =>
    new InboxReader(CONFIG, {
      cashForecast: async ({ system, prompt }) => {
        seen.push(system, prompt);
        return { output: sentence === null ? null : { sentence }, usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });

  it('does not ask the model when nothing is expected in the 90 days', async () => {
    const seen: string[] = [];
    expect(await reader('x', seen).cashForecastSentence(empty)).toEqual({ kind: 'none', code: 'QUIET' });
    expect(seen).toEqual([]);
  });

  it('gives the model the facts and the rules, checks its text and reports the tokens it used', async () => {
    const seen: string[] = [];
    const used: Array<{ inputTokens: number; outputTokens: number }> = [];
    const text = 'Số dư thấp nhất dự kiến đến sau khoản phải trả người bán lớn nhất.';
    expect(await reader(text, seen).cashForecastSentence(FACTS, (u) => used.push(u))).toEqual({ kind: 'sentence', text });
    expect(seen[0]).toContain('Write in Vietnamese');
    expect(seen[1]).toContain('Số dư thấp nhất ngày 2026-12-18: 2.500.000 đồng');
    expect(used).toEqual([{ inputTokens: 10, outputTokens: 5 }]);
  });

  it('refuses a model text that holds advice, and a missing answer', async () => {
    expect(await reader('Số dư thấp nhất dự kiến đến sau một khoản phải trả; nên hoãn khoản đó.').cashForecastSentence(FACTS)).toEqual({ kind: 'none', code: 'ADVICE' });
    expect(await reader(null).cashForecastSentence(FACTS)).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});
