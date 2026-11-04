// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentence on the Kế toán overview (#2631): the model is told the aggregated figures and nothing else, and its text is dropped when it
// states a number the figures do not hold. The generator is a stand-in, so nothing here reaches a model.
import { describe, expect, it } from 'vitest';
import { InboxReader, checkOverviewSentence, overviewFactsText, overviewInstructions, overviewPrompt, overviewQuiet, type OverviewFacts } from '../src/index.ts';

const FACTS: OverviewFacts = {
  language: 'vi',
  figures: [
    { key: 'cash', amount: '11800000', previous: '10000000' },
    { key: 'profit', amount: '1500000', previous: '2500000' },
    { key: 'receivables', amount: '10000000', previous: '5000000' },
    { key: 'payables', amount: '2500000', previous: '2500000' },
  ],
  expenses: [
    { code: '641', amount: '1400000', previous: '1000000' },
    { code: '632', amount: '0', previous: '0' },
  ],
};
const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };
const still: OverviewFacts = { ...FACTS, figures: FACTS.figures.map((f) => ({ ...f, previous: f.amount })), expenses: [] };

describe('overviewFactsText', () => {
  it('gives every figure as the sentence must write it, with its change, and leaves out a group with nothing', () => {
    const text = overviewFactsText(FACTS);
    expect(text).toContain('Lợi nhuận trước thuế của kỳ: 1.500.000 đồng (kỳ trước: 2.500.000 đồng); giảm 40%');
    expect(text).toContain('Chi phí bán hàng (641): 1.400.000 đồng (kỳ trước: 1.000.000 đồng); tăng 40%');
    expect(text).toContain('Phải trả người bán (331) cuối kỳ: 2.500.000 đồng (kỳ trước: 2.500.000 đồng); không đổi');
    expect(text).not.toContain('632');
  });

  it('tells no name, tax code or date: only labels, amounts and percents', () => {
    expect(overviewPrompt(FACTS)).not.toMatch(/\d{4}-\d{2}-\d{2}|MST|@/);
    expect(overviewInstructions('en')).toContain('Write in English');
  });

  it('writes an English figure with its own separators and a rise from zero without a percent', () => {
    const text = overviewFactsText({ ...FACTS, language: 'en', figures: [{ key: 'cash', amount: '1234567', previous: '0' }], expenses: [] });
    expect(text).toContain('1,234,567 dong (period before: 0 dong); up (the earlier figure was zero: no percent)');
  });
});

describe('overviewQuiet', () => {
  it('is true when nothing moved and false when any figure or cost did', () => {
    expect(overviewQuiet(still)).toBe(true);
    expect(overviewQuiet(FACTS)).toBe(false);
  });
});

describe('checkOverviewSentence', () => {
  const sentence = (text: string) => checkOverviewSentence(FACTS, { sentence: text });

  it('keeps a sentence whose every number is one of the figures, as written', () => {
    const text = 'Lợi nhuận trước thuế giảm 40%, còn 1.500.000 đồng, vì chi phí bán hàng (641) tăng 40%.';
    expect(sentence(text)).toEqual({ kind: 'sentence', text });
  });

  it('drops a sentence that states a number the figures do not hold', () => {
    expect(sentence('Lợi nhuận giảm 45% so với kỳ trước.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(sentence('Lợi nhuận còn 1.600.000 đồng.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(sentence('Tiền tăng 1.800.000 đồng.')).toEqual({ kind: 'none', code: 'FIGURES' });
  });

  it('drops a sentence that scales a figure or says a number in words', () => {
    expect(sentence('Lợi nhuận còn khoảng 1,5 triệu đồng, giảm 40%.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(sentence('Lợi nhuận giảm hai mươi phần trăm.')).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(sentence('Profit is down 40% to 1.5 million.')).toEqual({ kind: 'none', code: 'FIGURES' });
  });

  it('drops an empty, a long or a many-sentence text and a link', () => {
    expect(checkOverviewSentence(FACTS, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(sentence('   ')).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(sentence('Lợi nhuận giảm. '.repeat(30))).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(sentence('Lợi nhuận giảm. Chi phí tăng. Tiền tăng.')).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(sentence('Xem thêm tại example.com về lợi nhuận.')).toEqual({ kind: 'none', code: 'LINK' });
  });
});

describe('InboxReader.overviewSentence', () => {
  const readerOf = (answer: { sentence: string } | null) => {
    const asked: Array<{ system: string; prompt: string }> = [];
    const reader = new InboxReader(CONFIG, {
      overview: async (args) => {
        asked.push(args);
        return { output: answer, usage: { inputTokens: 7, outputTokens: 3 } };
      },
    });
    return { asked, reader };
  };

  it('asks the model once with the figures, passes its tokens on and returns the checked sentence', async () => {
    const { asked, reader } = readerOf({ sentence: 'Lợi nhuận giảm 40%.' });
    const used: number[] = [];
    expect(await reader.overviewSentence(FACTS, (u) => used.push(u.inputTokens + u.outputTokens))).toEqual({ kind: 'sentence', text: 'Lợi nhuận giảm 40%.' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain('1.500.000');
    expect(used).toEqual([10]);
  });

  it('does not ask the model when nothing moved', async () => {
    const { asked, reader } = readerOf({ sentence: 'x' });
    expect(await reader.overviewSentence(still)).toEqual({ kind: 'none', code: 'QUIET' });
    expect(asked).toEqual([]);
  });

  it('drops the sentence when the model states a number it was not given', async () => {
    const { reader } = readerOf({ sentence: 'Lợi nhuận giảm 99%.' });
    expect(await reader.overviewSentence(FACTS)).toEqual({ kind: 'none', code: 'FIGURES' });
  });
});
