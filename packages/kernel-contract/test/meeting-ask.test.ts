// SPDX-License-Identifier: AGPL-3.0-only
// The words of a question across meetings (Meetings A3, #3161): the L2 search wants every word, so the question is cut to its significant words in code and asked in a few passes.
import { describe, expect, it } from 'vitest';
import { ASK_LINES_MAX, ASK_QUESTION_MAX, ASK_QUESTION_MIN, askKeywords, askQueries, askRank, zAskAnswer, zAskInput } from '../src/index.ts';

describe('askKeywords', () => {
  it('drops stop words and short words, keeps the spelling, puts a figure first and then the longer word', () => {
    expect(askKeywords('Khách A đã đồng ý chiết khấu bao nhiêu?')).toEqual(['Khách', 'chiết', 'đồng', 'khấu']);
    expect(askKeywords('What did we agree with Acme about the 15 percent discount?')).toEqual(['15', 'discount', 'percent', 'agree', 'Acme']);
  });

  it('keeps each word once, at most six, and finds nothing in a question of stop words', () => {
    expect(askKeywords('giá giá GIÁ Giá')).toEqual(['giá']);
    expect(askKeywords('alpha bravo charlie delta echo foxtrot golf hotel india')).toHaveLength(6);
    expect(askKeywords('là gì? ở đâu? và cho?')).toEqual([]);
    expect(askKeywords('')).toEqual([]);
  });

  it('is linear on a long run of separators or one long word', () => {
    const started = performance.now();
    askKeywords('-'.repeat(300_000));
    askKeywords(`${'a'.repeat(300_000)} ${'b '.repeat(100_000)}`);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('askQueries', () => {
  it('asks all the words together first, then the three strongest together, then each of those alone, never the same pass twice', () => {
    expect(askQueries(['Khách', 'chiết', 'đồng', 'khấu'])).toEqual(['Khách chiết đồng khấu', 'Khách chiết đồng', 'Khách', 'chiết', 'đồng']);
    expect(askQueries(['Khách', 'chiết', 'đồng'])).toEqual(['Khách chiết đồng', 'Khách', 'chiết', 'đồng']);
    expect(askQueries(['discount'])).toEqual(['discount']);
    expect(askQueries([])).toEqual([]);
    expect(askQueries(['5', 'giá'])).toEqual(['5 giá', 'giá']);
  });

  it('never exceeds the length the search accepts', () => {
    expect(askQueries(Array.from({ length: 6 }, () => 'x'.repeat(100)))[0]?.length).toBeLessThanOrEqual(200);
  });
});

describe('the ask shapes', () => {
  it('bounds the question and the answer', () => {
    expect(zAskInput.safeParse({ question: 'x'.repeat(ASK_QUESTION_MIN - 1) }).success).toBe(false);
    expect(zAskInput.safeParse({ question: 'x'.repeat(ASK_QUESTION_MAX + 1) }).success).toBe(false);
    expect(zAskInput.safeParse({ question: '  Giá bao nhiêu?  ' })).toMatchObject({ success: true, data: { question: 'Giá bao nhiêu?' } });
    expect(zAskInput.safeParse({ question: 'Giá bao nhiêu?', extra: 1 }).success).toBe(false);
    const empty = { state: 'none', errorCode: null, sentences: [], sources: [], hits: [], dropped: 0 };
    expect(zAskAnswer.safeParse(empty).success).toBe(true);
    expect(zAskAnswer.safeParse({ ...empty, sentences: [{ text: 'x', sources: [ASK_LINES_MAX] }] }).success).toBe(false);
    expect(zAskAnswer.safeParse({ ...empty, sentences: [{ text: 'x', sources: [] }] }).success).toBe(false);
  });
});

describe('askRank', () => {
  it('counts the words a line holds, ignoring case and Vietnamese marks', () => {
    expect(askRank('Khách A đồng ý chiết khấu 8%', ['chiet', 'khau', 'giao'])).toBe(2);
    expect(askRank('Giao hàng ngày 20/11', ['chiết', 'khấu'])).toBe(0);
    expect(askRank('CHIẾT KHẤU', ['chiết', 'khấu'])).toBe(2);
    expect(askRank('', ['a'])).toBe(0);
  });
});
