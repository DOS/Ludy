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
const GOOD = 'Hóa đơn C26TAA-0000123 lập muộn cho kỳ 2026-09; hóa đơn C26TAA-0000130 lập muộn cho kỳ 2026-Q3.';

describe('vatLateFactsText and the prompt', () => {
  it('gives each invoice with its period only: no status, name, tax code, amount or date', () => {
    const text = vatLateFactsText(FACTS);
    expect(text).toContain('Invoice C26TAA-0000123: sale belongs to period 2026-09');
    expect(text).not.toMatch(/supplementary|counted/);
    expect(vatLatePrompt(FACTS)).not.toMatch(/\d{4}-\d{2}-\d{2}|MST|@|đồng/);
    expect(vatLateInstructions('en')).toContain('Write in English');
    expect(vatLateInstructions('vi')).toContain('A person decides the supplementary declaration');
    expect(vatLateInstructions('vi')).toContain('Say nothing of whether any invoice needs a declaration');
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
    expect(check('Hóa đơn C26TAA-0000123 lập muộn cho kỳ 2026-09.')).toEqual({ kind: 'none', code: 'NAMES' });
  });

  it('drops a sentence that writes a period the lists do not hold', () => {
    expect(check(GOOD.replace('2026-Q3', '2026-Q2'))).toEqual({ kind: 'none', code: 'PERIODS' });
    expect(check(GOOD.replace('2026-09', '2026-08'))).toEqual({ kind: 'none', code: 'PERIODS' });
  });

  it('drops a sentence that gives a period to the wrong invoice', () => {
    const two: VatLateFacts = { language: 'vi', items: [{ number: 'AA-0001', period: '2026-08', supplementary: true, issuedHere: true }, { number: 'AA-0002', period: '2026-09', supplementary: false, issuedHere: true }] };
    const run = (t: string) => checkVatLateSentence(two, { sentence: t });
    expect(run('Hóa đơn AA-0001 thuộc kỳ 2026-08 và AA-0002 thuộc kỳ 2026-09.').kind).toBe('sentence');
    expect(run('Hóa đơn AA-0001 thuộc kỳ 2026-09 và AA-0002 thuộc kỳ 2026-08.')).toEqual({ kind: 'none', code: 'PERIODS' });
    expect(run('Hóa đơn AA-0001 và AA-0002 thuộc kỳ 2026-08.')).toEqual({ kind: 'none', code: 'PERIODS' });
  });

  it('refuses a period written before its invoice, or none after it, and a listed number hidden inside an unlisted one', () => {
    const two: VatLateFacts = { language: 'vi', items: [{ number: 'AA-0001', period: '2026-08', supplementary: true, issuedHere: true }, { number: 'AA-0002', period: '2026-09', supplementary: false, issuedHere: true }] };
    const run = (t: string) => checkVatLateSentence(two, { sentence: t });
    expect(run('Kỳ 2026-09 có hóa đơn AA-0001; kỳ 2026-08 có hóa đơn AA-0002.')).toEqual({ kind: 'none', code: 'PERIODS' });
    expect(run('Hóa đơn AA-0001 thuộc kỳ 2026-08; hóa đơn AA-0002.')).toEqual({ kind: 'none', code: 'PERIODS' });
    const one: VatLateFacts = { language: 'vi', items: [{ number: 'AA-0001', period: '2026-08', supplementary: true, issuedHere: true }] };
    expect(checkVatLateSentence(one, { sentence: 'Hóa đơn AA-0001 thuộc kỳ 2026-08 và XAA-0001 cũng vậy.' }).kind).toBe('none');
  });

  it('matches an invoice whole: a listed number is not a longer number that holds it', () => {
    const bare: VatLateFacts = { language: 'vi', items: [{ number: '0001', period: '2026-08', supplementary: true, issuedHere: true }] };
    expect(checkVatLateSentence(bare, { sentence: 'Hóa đơn 0001 thuộc kỳ 2026-08.' }).kind).toBe('sentence');
    expect(checkVatLateSentence(bare, { sentence: 'Hóa đơn AA-0001 thuộc kỳ 2026-08.' })).toEqual({ kind: 'none', code: 'NAMES' });
    const c5: VatLateFacts = { language: 'vi', items: [{ number: 'C-5', period: '2026-08', supplementary: true, issuedHere: true }] };
    expect(checkVatLateSentence(c5, { sentence: 'Hóa đơn AC-5 thuộc kỳ 2026-08.' })).toEqual({ kind: 'none', code: 'NAMES' });
  });

  it('drops any sentence that states an invoice\'s status, so a swapped yes/no cannot pass (both ways, both languages)', () => {
    const two: VatLateFacts = {
      language: 'vi',
      items: [
        { number: 'AA-0001', period: '2026-08', supplementary: true, issuedHere: true },
        { number: 'AA-0002', period: '2026-09', supplementary: false, issuedHere: true },
      ],
    };
    const run = (t: string) => checkVatLateSentence(two, { sentence: t });
    expect(run('Hóa đơn AA-0001 thuộc kỳ 2026-08 và AA-0002 thuộc kỳ 2026-09.').kind).toBe('sentence');
    for (const t of [
      'AA-0001 (kỳ 2026-08) cần kê khai bổ sung; AA-0002 (kỳ 2026-09) đã tính vào kỳ đó.',
      'AA-0001 (kỳ 2026-08) đã tính vào kỳ đó; AA-0002 (kỳ 2026-09) cần kê khai bổ sung.',
      'AA-0001 (2026-08) needs a supplementary declaration; AA-0002 (2026-09) is counted in that period.',
      'AA-0001 (2026-08) is counted in that period; AA-0002 (2026-09) needs a supplementary declaration.',
      'AA-0001 (2026-08) and AA-0002 (2026-09) must be amended.',
    ]) {
      expect(run(t).kind, t).toBe('none');
    }
  });

  it('allows only a closed vocabulary around the invoices and periods, so a status cannot be said in other words', () => {
    const two: VatLateFacts = { language: 'en', items: [{ number: 'AA-0001', period: '2026-08', supplementary: true, issuedHere: true }, { number: 'AA-0002', period: '2026-09', supplementary: false, issuedHere: true }] };
    const run = (t: string) => checkVatLateSentence(two, { sentence: t });
    expect(run('Invoices AA-0001 (2026-08) and AA-0002 (2026-09) were issued late.').kind).toBe('sentence');
    for (const t of [
      'AA-0001 (2026-08) was included in that period; AA-0002 (2026-09) requires an additional VAT return.',
      'AA-0001 (2026-08) is settled; AA-0002 (2026-09) is outstanding.',
      'AA-0001 (2026-08) đã được ghi nhận; AA-0002 (2026-09) còn thiếu tờ khai.',
    ]) {
      expect(run(t), t).toEqual({ kind: 'none', code: 'STATUS' });
    }
  });

  it('drops a sentence that states another figure, scales one or says a number in words', () => {
    expect(check(`${GOOD} Tổng 3 hóa đơn.`)).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(check(`${GOOD} Thuế khoảng 5 triệu.`)).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(check(`${GOOD} Có hai mươi phần trăm.`)).toEqual({ kind: 'none', code: 'FIGURES' });
  });

  it('drops a sentence that claims a declaration, a posting or a sending', () => {
    expect(check(`${GOOD} Đã kê khai bổ sung.`)).toEqual({ kind: 'none', code: 'CLAIM' });
    expect(check(`${GOOD} Tôi đã nộp tờ khai.`)).toEqual({ kind: 'none', code: 'CLAIM' });
    for (const t of ["I've declared it.", 'Sent for you.', 'được kê khai bổ sung']) expect(check(`${GOOD} ${t}`).kind, t).toBe('none');
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
