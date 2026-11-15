// SPDX-License-Identifier: AGPL-3.0-only
// Vy's "Tuần này" (#3257, Vy plan C5): the template with AI off, the numbers rule per sentence, and the writer with a stubbed model.
import { describe, expect, it, vi as vitest } from 'vitest';
import { AI_FEATURES, AiBudgetExhaustedError, WeeklyWriter, checkedWeeklySentences, templateWeekly, weeklyAsk, weeklyEmpty, weeklyFactsText, type WeeklyFacts } from '../src/index.ts';

const facts = (over: Partial<WeeklyFacts> = {}): WeeklyFacts => ({
  language: 'vi',
  deals: { won: { count: 3, amount: '45000000' }, open: 12 },
  money: {
    cash: { amount: '120000000', previous: '100000000' },
    receivables: { amount: '30000000', previous: '35500000' },
    payables: { amount: '8000000', previous: '8000000' },
  },
  tasks: { late: 2 },
  ...over,
});
const none: WeeklyFacts = { language: 'vi', deals: null, money: null, tasks: null };
const writer = (answer: string[] | null | Error) =>
  new WeeklyWriter({ baseURL: 'http://model.invalid', model: 'stub', apiKey: 'unit-test' }, async () => {
    if (answer instanceof Error) throw answer;
    return answer === null ? null : { sentences: answer };
  });

describe('the metered key', () => {
  it('is today.weekly on the kernel budget line', () => {
    expect(AI_FEATURES['today.weekly']).toBe('kernel');
  });
});

describe('the figures text', () => {
  it('writes every figure as the sentence must, with the change worked out by code', () => {
    const text = weeklyFactsText(facts());
    expect(text).toContain('Deal thắng trong 7 ngày qua: 3, tổng giá trị 45.000.000 đồng');
    expect(text).toContain('Deal đang mở hiện nay: 12');
    expect(text).toContain('Tiền mặt và tiền gửi (111, 112) hiện nay: 120.000.000 đồng (7 ngày trước: 100.000.000 đồng); tăng 20.000.000 đồng');
    expect(text).toContain('Phải thu của khách hàng (131) hiện nay: 30.000.000 đồng (7 ngày trước: 35.500.000 đồng); giảm 5.500.000 đồng');
    expect(text).toContain('Phải trả người bán (331) hiện nay: 8.000.000 đồng (7 ngày trước: 8.000.000 đồng); không đổi');
    expect(text).toContain('Việc của người xem đã quá hạn: 2');
  });

  it('leaves a group out entirely when the member cannot open what it reads, and an open count that was cut', () => {
    const text = weeklyFactsText(facts({ deals: { won: { count: 0, amount: '0' }, open: null }, money: null, tasks: null }));
    expect(text).toContain('Deal thắng trong 7 ngày qua: 0');
    expect(text).not.toContain('đang mở');
    expect(text).not.toContain('Tiền mặt');
    expect(text).not.toContain('quá hạn');
  });

  it('uses the English grouping in English', () => {
    expect(weeklyFactsText(facts({ language: 'en' }))).toContain('worth 45,000,000 dong in all');
  });

  it('never gives the model a name, a title or a link', () => {
    const { system, prompt } = weeklyAsk(facts());
    expect(`${system}\n${prompt}`).not.toMatch(/https?:|www\./);
    expect(weeklyEmpty(none)).toBe(true);
    expect(weeklyEmpty(facts())).toBe(false);
  });
});

describe('the template (AI off)', () => {
  it('is built from the figures alone', () => {
    expect(templateWeekly(facts())).toEqual([
      'Trong 7 ngày qua có 3 deal thắng, tổng 45.000.000 đồng.',
      'Hiện có 12 deal đang mở.',
      'So với 7 ngày trước: tiền mặt và tiền gửi 120.000.000 đồng (tăng 20.000.000 đồng); phải thu 30.000.000 đồng (giảm 5.500.000 đồng); phải trả 8.000.000 đồng (không đổi).',
      'Bạn có 2 việc đã quá hạn.',
    ]);
  });

  it('says so when nothing was won or is late, and writes nothing for a group the member cannot see', () => {
    expect(templateWeekly(facts({ deals: { won: { count: 0, amount: '0' }, open: null }, money: null, tasks: { late: 0 } }))).toEqual(['Trong 7 ngày qua chưa có deal nào thắng.', 'Bạn không có việc nào quá hạn.']);
    expect(templateWeekly(none)).toEqual([]);
  });

  it('writes its own numbers only from the figures', () => {
    const f = facts({ language: 'en' });
    const { kept, dropped } = checkedWeeklySentences(templateWeekly(f), f);
    expect(dropped).toBe(0);
    expect(kept).toEqual(templateWeekly(f));
  });
});

describe('sentences', () => {
  it('are kept one by one: a sentence with a number that is not a figure is dropped, the others stay', () => {
    const { kept, dropped } = checkedWeeklySentences(['Có 3 deal thắng, tổng 45.000.000 đồng.', 'Doanh thu đạt 99.000.000 đồng.', 'Có 2 việc đã quá hạn.'], facts());
    expect(kept).toEqual(['Có 3 deal thắng, tổng 45.000.000 đồng.', 'Có 2 việc đã quá hạn.']);
    expect(dropped).toBe(1);
  });

  it('drops a number the model worked out itself, though it adds up', () => {
    // 120.000.000 + 30.000.000 is 150.000.000: a sum the code did not give.
    expect(checkedWeeklySentences(['Tiền mặt và phải thu cộng lại là 150.000.000 đồng.'], facts()).kept).toEqual([]);
  });

  it('drops a figure scaled in words, a number said in words, a date and a link', () => {
    for (const s of ['Có 3 triệu đồng đang chờ.', 'Có 45 triệu đồng thắng.', 'Tiền mặt tăng hai mươi phần trăm.', 'Cash is up twenty percent.', 'Tính đến 15/11 có 3 deal thắng.', 'Xem tại https://example.com thêm.']) {
      expect(checkedWeeklySentences([s], facts()).kept, s).toEqual([]);
    }
  });

  it('drops a number said in words before the units of the week (deal, việc, khách), which the shared check does not know', () => {
    for (const s of ['Tuần qua có chín deal thắng.', 'Bạn có chín việc đã quá hạn.', 'Có ba deal thắng.', 'Có hai mươi lăm khách hàng.', 'Có năm việc quá hạn.', 'Có một đơn hàng mới.', 'Có mười hai deal đang mở.']) {
      expect(checkedWeeklySentences([s], facts()).kept, s).toEqual([]);
    }
  });

  it('keeps ordinary words that look like number words', () => {
    for (const s of ['Năm nay tiền mặt tăng 20.000.000 đồng.', 'Một số việc đã quá hạn.', 'Bạn có 2 việc đã quá hạn.', 'Tuần qua có 3 deal thắng.']) {
      expect(checkedWeeklySentences([s], facts()).kept, s).toEqual([s]);
    }
  });

  it('drops a number hidden by an invisible character, and a sentence that is too long', () => {
    expect(checkedWeeklySentences(['Có 9​9 deal thắng.'], facts()).kept).toEqual([]);
    expect(checkedWeeklySentences([`${'a'.repeat(310)}.`], facts()).kept).toEqual([]);
  });

  it('are cut at five', () => {
    expect(checkedWeeklySentences(['Tuần ổn.', 'Tiền về đều.', 'Khách trả tốt.', 'Chi phí gọn.', 'Việc đúng hạn.', 'Mọi thứ yên.'], facts()).kept).toHaveLength(5);
  });
});

describe('the writer', () => {
  it('shows the sentences by Vy when their numbers all match', async () => {
    const r = await writer(['Tuần qua có 3 deal thắng, tổng 45.000.000 đồng.', 'Tiền mặt tăng 20.000.000 đồng.']).weekly(facts());
    expect(r).toEqual({ sentences: ['Tuần qua có 3 deal thắng, tổng 45.000.000 đồng.', 'Tiền mặt tăng 20.000.000 đồng.'], writtenBy: 'vy', final: true });
  });

  it('keeps the matching sentences and drops the one with a number that is not a figure', async () => {
    const r = await writer(['Tuần qua có 3 deal thắng.', 'Lợi nhuận đạt 77 triệu đồng.']).weekly(facts());
    expect(r).toEqual({ sentences: ['Tuần qua có 3 deal thắng.'], writtenBy: 'vy', final: true });
  });

  it('shows the template, not kept, when every sentence is dropped, the answer is empty or the call fails', async () => {
    const error = vitest.spyOn(console, 'error').mockImplementation(() => {});
    for (const answer of [['Tổng cộng 12345 đồng.'], [], null, new Error('boom')]) {
      const r = await writer(answer).weekly(facts());
      expect(r.writtenBy).toBe('template');
      expect(r.sentences).toEqual(templateWeekly(facts()));
      expect(r.final).toBe(false);
    }
    error.mockRestore();
  });

  it('lets the budget refusal through to the caller', async () => {
    await expect(writer(new AiBudgetExhaustedError('org', null)).weekly(facts())).rejects.toBeInstanceOf(AiBudgetExhaustedError);
  });

  it('does not ask the model when there is no figure', async () => {
    const generate = vitest.fn(async () => ({ sentences: ['x'] }));
    const w = new WeeklyWriter({ baseURL: 'http://model.invalid', model: 'stub', apiKey: 'unit-test' }, generate);
    expect(await w.weekly(none)).toEqual({ sentences: [], writtenBy: null, final: true });
    expect(generate).not.toHaveBeenCalled();
  });
});
