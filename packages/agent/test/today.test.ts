// SPDX-License-Identifier: AGPL-3.0-only
// Vy's daily brief (#2383): the numbers rule per sentence, the template, and the writer with a stubbed model.
import { describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError, TodayWriter, briefAllowed, briefAsk, checkedSentences, sentencesOf, templateBrief, type BriefFacts } from '../src/index.ts';

const facts = (over: Partial<BriefFacts> = {}): BriefFacts => ({
  language: 'vi',
  today: '2026-11-02',
  dueDates: ['2026-11-20', '2026-11-30'],
  flags: 2,
  blocking: 1,
  proposals: 12,
  messages: 3,
  deadlines: 2,
  proposalAmounts: [{ currency: 'VND', amount: '148500000' }],
  ...over,
});
const none = { flags: 0, blocking: 0, proposals: 0, messages: 0, deadlines: 0, dueDates: [] };
const writer = (answer: string[] | null | Error) =>
  new TodayWriter({ baseURL: 'http://model.invalid', model: 'stub', apiKey: 'unit-test' }, async () => {
    if (answer instanceof Error) throw answer;
    return answer === null ? null : { sentences: answer };
  });

describe('the numbers a brief may write', () => {
  it('are its figures in the language and the dates, with and without the zero', () => {
    const vi = briefAllowed(facts());
    for (const n of ['19', '2', '12', '3', '148.500.000', '148500000', '2026', '11', '20', '30', '02']) expect(vi.has(n), n).toBe(true);
    expect(vi.has('148,500,000')).toBe(false);
    const en = briefAllowed(facts({ language: 'en' }));
    expect(en.has('148,500,000')).toBe(true);
    expect(en.has('148.500.000')).toBe(false);
  });
});

describe('sentences', () => {
  it('split after a stop and at a line break', () => {
    expect(sentencesOf('Có 3 tin nhắn. Có 2 hạn!\nXong?')).toEqual(['Có 3 tin nhắn.', 'Có 2 hạn!', 'Xong?']);
  });

  it('are kept one by one: a sentence with a number that is not a figure is dropped, the others stay', () => {
    const { kept, dropped } = checkedSentences(['Có 12 đề xuất chờ duyệt.', 'Tổng cộng 99 việc.', 'Hạn gần nhất là 20/11/2026.'], facts());
    expect(kept).toEqual(['Có 12 đề xuất chờ duyệt.', 'Hạn gần nhất là 20/11/2026.']);
    expect(dropped).toBe(1);
  });

  it('are cut at four, and a very long one is dropped', () => {
    const many = ['Một.', 'Hai.', 'Ba.', 'Bốn.', 'Năm.', 'Sáu.'];
    expect(checkedSentences(many, facts()).kept).toHaveLength(4);
    expect(checkedSentences([`${'a'.repeat(300)}.`], facts()).kept).toEqual([]);
  });
});

describe('templateBrief', () => {
  it('says the counts in plain words in both languages, and passes its own numbers check', () => {
    const vi = templateBrief(facts());
    expect(vi[0]).toBe('Hôm nay có 19 việc cần bạn: 2 cảnh báo, 12 đề xuất chờ duyệt, 3 tin nhắn chưa trả lời, 2 hạn sắp đến.');
    expect(vi).toContain('1 cảnh báo đang chặn công việc.');
    expect(vi).toContain('Hạn gần nhất là 20/11/2026.');
    expect(checkedSentences(vi, facts()).dropped).toBe(0);
    const en = templateBrief(facts({ language: 'en', flags: 1, blocking: 0, deadlines: 0, messages: 1, proposals: 0, dueDates: [] }));
    expect(en).toEqual(['2 items need you today: 1 warning, 1 unanswered message.']);
  });

  it('says nothing needs the member when nothing does', () => {
    expect(templateBrief(facts(none))).toEqual(['Hôm nay chưa có việc nào cần bạn.']);
  });
});

describe('briefAsk', () => {
  it('tells the model the figures and no free text', () => {
    const { system, prompt } = briefAsk(facts());
    expect(prompt).toContain('Warnings (flags): 2');
    expect(prompt).toContain('148.500.000');
    expect(prompt).toContain('02/11/2026');
    expect(system).toMatch(/Never compute/);
    expect(system).toMatch(/Name no person/);
  });
});

describe('TodayWriter', () => {
  it('returns the model sentences that pass, as written by Vy', async () => {
    const result = await writer(['Hôm nay có 12 đề xuất chờ bạn duyệt.', 'Hạn gần nhất là 20/11/2026.']).brief(facts());
    expect(result).toEqual({ sentences: ['Hôm nay có 12 đề xuất chờ bạn duyệt.', 'Hạn gần nhất là 20/11/2026.'], writtenBy: 'vy' });
  });

  it('drops a sentence that invents a figure, and keeps the rest', async () => {
    const result = await writer(['Có 40 đề xuất chờ duyệt.', 'Có 3 tin nhắn chưa trả lời.']).brief(facts());
    expect(result).toEqual({ sentences: ['Có 3 tin nhắn chưa trả lời.'], writtenBy: 'vy' });
  });

  it('falls back to the template when every sentence is dropped, the model answers nothing or fails', async () => {
    const answers: Array<string[] | null | Error> = [['Có 40 đề xuất.', 'Còn 7 hạn.'], [], null, new Error('boom')];
    for (const answer of answers) {
      const result = await writer(answer).brief(facts());
      expect(result.writtenBy).toBe('template');
      expect(result.sentences).toEqual(templateBrief(facts()));
    }
  });

  it('lets a spent budget through, so Home shows the list without a brief', async () => {
    await expect(writer(new AiBudgetExhaustedError('org', null)).brief(facts())).rejects.toBeInstanceOf(AiBudgetExhaustedError);
  });

  it('does not ask the model when nothing needs the member', async () => {
    const result = await writer(new Error('must not be called')).brief(facts(none));
    expect(result.writtenBy).toBe('template');
  });
});
