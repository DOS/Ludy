// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentence naming the late sales invoices of a VAT working (#3540): the model is told invoice numbers and periods and nothing else, and its text is dropped when
// it names an invoice or period the lists do not hold, leaves one out, states another figure, holds a link or claims a declaration. The generator is a stand-in, so nothing reaches a model.
import { describe, expect, it } from 'vitest';
import { InboxReader, VAT_LATE_ASK_MAX, checkVatLateSentence, vatLateFactsText, vatLateInstructions, vatLatePrompt, vatLateQuiet, type VatLateFacts } from '../src/index.ts';

const FACTS: VatLateFacts = {
  language: 'vi',
  items: [
    { number: 'C26TAA-0000123', period: '2026-09', supplementary: true, issuedHere: true },
    { number: 'C26TAA-0000130', period: '2026-Q3', supplementary: false, issuedHere: true },
  ],
};
const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };
const check = (text: string) => checkVatLateSentence(FACTS, { sentence: text });
const GOOD = 'Hóa đơn C26TAA-0000123 bán trong kỳ 2026-09 cần kê khai bổ sung; hóa đơn C26TAA-0000130 thuộc kỳ 2026-Q3 đã được tính vào kỳ đó.';

describe('vatLateFactsText and the prompt', () => {
  it('gives each invoice with its period and two facts, and tells no name, tax code, amount or date', () => {
    const text = vatLateFactsText(FACTS);
    expect(text).toContain('Invoice C26TAA-0000123: sale belongs to period 2026-09; issued in this period for that earlier period; needs a supplementary declaration');
    expect(text).toContain('already counted in that period');
    expect(vatLatePrompt(FACTS)).not.toMatch(/\d{4}-\d{2}-\d{2}|MST|@|đồng/);
    expect(vatLateInstructions('en')).toContain('Write in English');
    expect(vatLateInstructions('vi')).toContain('A person decides the supplementary declaration');
  });
});

describe('vatLateQuiet', () => {
  it('is true with nothing to name and with more than the model is asked about', () => {
    expect(vatLateQuiet({ language: 'vi', items: [] })).toBe(true);
    const many = Array.from({ length: VAT_LATE_ASK_MAX + 1 }, (_, i) => ({ number: `A-${i}`, period: '2026-09', supplementary: false, issuedHere: true }));
    expect(vatLateQuiet({ language: 'vi', items: many })).toBe(true);
    expect(vatLateQuiet(FACTS)).toBe(false);
  });
});

describe('checkVatLateSentence', () => {
  it('keeps a sentence that names every invoice and period as given', () => {
    expect(check(GOOD)).toEqual({ kind: 'sentence', text: GOOD });
  });

  it('drops a sentence that names an invoice not in the lists', () => {
    expect(check(`${GOOD} Hóa đơn C26TAA-0000999 cũng muộn.`)).toEqual({ kind: 'none', code: 'FIGURES' });
  });

  it('drops a sentence that leaves a listed invoice out', () => {
    expect(check('Hóa đơn C26TAA-0000123 bán trong kỳ 2026-09 cần kê khai bổ sung.')).toEqual({ kind: 'none', code: 'NAMES' });
  });

  it('drops a sentence that writes a period the lists do not hold', () => {
    expect(check(GOOD.replace('2026-Q3', '2026-Q2'))).toEqual({ kind: 'none', code: 'PERIODS' });
    expect(check(GOOD.replace('2026-09', '2026-08'))).toEqual({ kind: 'none', code: 'PERIODS' });
  });

  it('drops a sentence that states another figure, scales one or says a number in words', () => {
    expect(check(`${GOOD} Tổng 3 hóa đơn.`)).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(check(`${GOOD} Thuế khoảng 5 triệu.`)).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(check(`${GOOD} Có hai mươi phần trăm.`)).toEqual({ kind: 'none', code: 'FIGURES' });
  });

  it('drops a sentence that claims a declaration, a posting or a sending (needing one is no claim)', () => {
    expect(check(`${GOOD} Đã kê khai bổ sung.`)).toEqual({ kind: 'none', code: 'CLAIM' });
    expect(check(`${GOOD} Tôi đã nộp tờ khai.`)).toEqual({ kind: 'none', code: 'CLAIM' });
    expect(check(`${GOOD} It has been declared.`)).toEqual({ kind: 'none', code: 'CLAIM' });
    expect(check(`${GOOD} I filed them for you.`)).toEqual({ kind: 'none', code: 'CLAIM' });
  });

  it('drops an empty, a long or a many-sentence text and a link', () => {
    expect(checkVatLateSentence(FACTS, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(check('   ')).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(check(`${GOOD} ${'Muộn. '.repeat(120)}`)).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(check(`${GOOD} A. B. C.`)).toEqual({ kind: 'none', code: 'TOO_LONG' });
    expect(check(`${GOOD} Xem example.com.`)).toEqual({ kind: 'none', code: 'LINK' });
  });

  it('drops a number word hidden by an invisible character', () => {
    expect(check(`${GOOD} Có hai tr​iệu.`)).toEqual({ kind: 'none', code: 'FIGURES' });
  });
});

describe('InboxReader.vatLateSentence', () => {
  const readerOf = (answer: { sentence: string } | null) => {
    const asked: Array<{ system: string; prompt: string }> = [];
    const reader = new InboxReader(CONFIG, {
      vatLate: async (args) => {
        asked.push(args);
        return { output: answer, usage: { inputTokens: 7, outputTokens: 3 } };
      },
    });
    return { asked, reader };
  };

  it('asks the model once with the invoices, passes its tokens on and returns the checked sentence', async () => {
    const { asked, reader } = readerOf({ sentence: GOOD });
    const used: number[] = [];
    expect(await reader.vatLateSentence(FACTS, (u) => used.push(u.inputTokens + u.outputTokens))).toEqual({ kind: 'sentence', text: GOOD });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain('C26TAA-0000123');
    expect(used).toEqual([10]);
  });

  it('does not ask the model when there is no late invoice', async () => {
    const { asked, reader } = readerOf({ sentence: 'x' });
    expect(await reader.vatLateSentence({ language: 'vi', items: [] })).toEqual({ kind: 'none', code: 'QUIET' });
    expect(asked).toEqual([]);
  });

  it('returns the reason, never the model text, when the sentence is refused', async () => {
    const { reader } = readerOf({ sentence: 'Hóa đơn C26TAA-0000123.' });
    expect(await reader.vatLateSentence(FACTS)).toEqual({ kind: 'none', code: 'NAMES' });
  });
});
