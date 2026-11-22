// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's possible reasons on the expense variance card (#4392): what the model is told (no figure of any kind, a name only when it may be told) and every refusal of a note: a digit, a number in
// words, a date, a name that was not given, certainty, a done-claim, advice, the future, no hedge, a contradicting direction, a repeated row. A refused note never stands and nothing is repaired.
import { describe, expect, it } from 'vitest';
import {
  checkExpenseVarianceNotes,
  expenseVarianceFactsText,
  expenseVarianceInstructions,
  expenseVarianceNotesHaveNews,
  expenseVariancePrompt,
  type ExpenseVarianceNoteFacts,
} from '../src/expense-variance.ts';
import { ExpenseVarianceCoworker } from '../src/expense-variance-coworker.ts';
import type { AiConfig } from '../src/index.ts';

const facts = (language: 'vi' | 'en' = 'en'): ExpenseVarianceNoteFacts => ({
  language,
  lines: [
    {
      group: '641',
      direction: 'up',
      against: 'previous',
      isNew: false,
      contributors: [
        { kind: 'supplier', sourceKind: 'invoice', vouchers: 'single' },
        { kind: 'voucher', sourceKind: 'cash_bank', vouchers: 'several' },
      ],
    },
    { group: '632', direction: 'down', against: 'average', isNew: false, contributors: [{ kind: 'supplier', sourceKind: 'invoice', vouchers: 'several' }] },
    { group: '627', direction: 'up', against: 'previous', isNew: true, contributors: [{ kind: 'supplier', sourceKind: 'manual', vouchers: 'single' }] },
  ],
});

const verdict = (row: number, text: string, f = facts()) => {
  const r = checkExpenseVarianceNotes(f, { notes: [{ row, text }] });
  return r.kind === 'notes' ? r.notes : null;
};
const stands = (row: number, text: string, f = facts()) => verdict(row, text, f) !== null;

describe('what the model is told', () => {
  it('holds no digit, no figure and no name of any kind', () => {
    for (const language of ['vi', 'en'] as const) {
      const text = expenseVarianceFactsText(facts(language));
      // The only numbers are the row numbers, which sit after the word Row.
      expect(text.replace(/Row \d+:/g, '')).not.toMatch(/\d/);
      expect(expenseVariancePrompt(facts(language))).toContain('Write one sentence for each row.');
    }
    expect(expenseVarianceInstructions('vi')).toContain('Vietnamese');
    expect(expenseVarianceInstructions('en')).toContain('English');
    expect(expenseVarianceInstructions('en')).toContain('Write no name at all');
  });

  it('tells a supplier only as a supplier, a voucher as a voucher, and how many vouchers only as a word', () => {
    const text = expenseVarianceFactsText(facts());
    expect(text).toContain('a supplier (name not given)');
    expect(text).toContain('a voucher with no supplier');
    expect(text).toContain('a single voucher');
    expect(text).toContain('several vouchers');
    expect(text).toContain('a cost that was not there before');
    const none = expenseVarianceFactsText({ language: 'en', lines: [{ group: '632', direction: 'down', against: 'previous', isNew: false, contributors: [{ kind: 'supplier', sourceKind: 'invoice', vouchers: 'none' }] }] });
    expect(none).toContain('no voucher this month');
    expect(none).not.toContain('a single voucher');
  });

  it('has nothing to say without a flagged line', () => {
    expect(expenseVarianceNotesHaveNews({ lines: [] })).toBe(false);
    expect(expenseVarianceNotesHaveNews(facts())).toBe(true);
  });
});

describe('a note that stands', () => {
  it('is one hedged sentence that opens with the hedge, from the facts of its row, in English and in Vietnamese', () => {
    expect(verdict(1, 'Possibly a single invoice explains why this cost went up.')).toEqual([{ row: 1, text: 'Possibly a single invoice explains why this cost went up.' }]);
    expect(stands(2, 'Perhaps fewer purchases from a supplier explain the drop.')).toBe(true);
    expect(stands(3, 'Maybe an extra purchase from a supplier explains the new cost.')).toBe(true);
    expect(stands(1, 'May be a larger invoice.')).toBe(true);
    const vi = facts('vi');
    expect(stands(1, 'Có thể một hóa đơn từ một nhà cung cấp giải thích vì sao khoản này tăng.', vi)).toBe(true);
    expect(stands(2, 'Có lẽ lượng hàng mua từ một nhà cung cấp ít hơn, khoản này giảm.', vi)).toBe(true);
    expect(stands(1, 'Nhiều khả năng có thêm một hóa đơn từ một nhà cung cấp.', vi)).toBe(true);
  });

  it('keeps each note on its own and drops only the ones that fail', () => {
    const r = checkExpenseVarianceNotes(facts(), {
      notes: [
        { row: 1, text: 'Possibly a single invoice explains it.' },
        { row: 2, text: 'This is clearly because of fewer purchases.' },
        { row: 3, text: 'Possibly an extra purchase from a supplier explains it.' },
      ],
    });
    expect(r).toEqual({
      kind: 'notes',
      notes: [
        { row: 1, text: 'Possibly a single invoice explains it.' },
        { row: 3, text: 'Possibly an extra purchase from a supplier explains it.' },
      ],
    });
  });
});

describe('a note that is refused', () => {
  const refused = (text: string, row = 1, f = facts()) => expect(stands(row, text, f), text).toBe(false);

  it('refuses ANY digit, a number in words, a size and a scaled number', () => {
    refused('Possibly an invoice explains the 30 percent rise.');
    refused('Possibly 2 vouchers explain it.');
    refused('Possibly an invoice explains a rise of about 5m.');
    refused('Possibly two invoices explain it.');
    refused('Possibly three vouchers explain it.');
    refused('Có thể hai hóa đơn từ một nhà cung cấp giải thích điều này.', 1, facts('vi'));
    refused('Có thể do hai chứng từ.', 1, facts('vi'));
    refused('Possibly a voucher worth fifty million explains it.');
    refused('Possibly an invoice explains it ① .');
    refused('Possibly an invoice explains it ½ more.');
    refused('Possibly an invoice explains it​.');
    // Sizes the digit check cannot see: plurals, "twice", Vietnamese scale words.
    refused('Có thể chi phí bán hàng tăng thêm hàng chục triệu đồng từ hóa đơn của một nhà cung cấp.', 1, facts('vi'));
    refused('Possibly selling expenses are up by millions of dong.');
    refused('Possibly hundreds of dong more explain it.');
    refused('Possibly thousands explain it.');
    refused('Possibly dozens of invoices explain it.');
    refused('Possibly the cost doubled with an extra invoice.');
    refused('Possibly the cost went up twice as much.');
    refused('Có thể khoản này gấp đôi vì hóa đơn mới.', 1, facts('vi'));
    refused('Có thể hóa đơn nhân đôi khoản này.', 1, facts('vi'));
    refused('Possibly half of it is one invoice.');
    refused('Possibly zero invoices explain it.');
    refused('Possibly thrice the usual purchases explain it.');
    refused('Có thể hàng triệu đồng từ một hóa đơn.', 1, facts('vi'));
    refused('Có thể hàng chục hóa đơn nhỏ.', 1, facts('vi'));
    refused('Có thể một tá hóa đơn nhỏ.', 1, facts('vi'));
    refused('Có thể năm hóa đơn nhỏ.', 1, facts('vi'));
  });

  it('refuses a date, a month, a weekday, a week, a quarter and a year', () => {
    refused('Possibly an invoice explains it in November.');
    refused('Possibly an invoice explains it on Monday.');
    refused('Possibly a quarter end invoice explains it.');
    refused('Possibly last year an invoice explains it.');
    refused('Possibly an invoice came last week.');
    refused('Possibly an invoice came today.');
    refused('Có thể do hóa đơn từ một nhà cung cấp hồi tháng ba.', 1, facts('vi'));
    refused('Có thể do hóa đơn từ một nhà cung cấp năm ngoái.', 1, facts('vi'));
    refused('Có thể giảm vì ít hóa đơn hơn so với quý hai.', 2, facts('vi'));
    refused('Có thể giảm vì tuần trước ít hóa đơn hơn.', 2, facts('vi'));
    refused('Có thể do hóa đơn hôm qua.', 1, facts('vi'));
    // "last month" and "the months before" are not dates.
    expect(stands(1, 'Possibly an invoice explains it, more than last month.')).toBe(true);
  });

  it('refuses any name, in the first place of the sentence and anywhere else: none is given', () => {
    refused('Possibly an invoice from Gamma Trading explains it.');
    refused('Possibly an invoice from Acme explains it.');
    refused('Possibly a payment to Shopee explains it.');
    refused('Possibly an invoice from Nguyen Van A explains it.', 3);
    refused('Possibly a larger Invoice explains it.');
    refused('Có thể hóa đơn từ Công ty Sao Mai giải thích.', 1, facts('vi'));
    refused('Possibly a charge from VAT explains it.');
    // The first word is the hedge, so a name cannot open the sentence.
    refused('Viettel may charge more on these invoices.');
    refused('Shopee might be charging higher fees on these invoices.');
    refused('Acme Logistics Co may explain it.');
    // A supplier is "a supplier", not a name.
    expect(stands(3, 'Possibly a larger purchase from a supplier explains it.')).toBe(true);
  });

  it('refuses a hidden character that splits a word, and any combining mark that is left', () => {
    refused('Possibly fi\u034Fve invoices explain it.');
    refused('Possibly c\u034Flearly an extra invoice explains it.');
    refused('Possibly an invoice expla\u200Bins it.');
    refused('Possibly an invoice\u00ADs explain it.');
    refused('Possibly an invoice\u2060 explains it.');
    refused('Possibly an invoice explains it\uFE0F.');
  });

  it('does not refuse plain words that only look like a rule: nằm ngoài, phải trả, trở nên, cần thiết, một lần, quà tặng, may be due to', () => {
    const vi = facts('vi');
    expect(stands(1, 'Có thể khoản này nằm ngoài các tháng trước vì có thêm một hóa đơn lớn.', vi)).toBe(true);
    expect(stands(1, 'Có thể khoản phải trả cho một nhà cung cấp lớn hơn.', vi)).toBe(true);
    expect(stands(1, 'Có thể chi phí trở nên lớn hơn vì có thêm hóa đơn.', vi)).toBe(true);
    expect(stands(1, 'Có thể có thêm một khoản chi cần thiết cho cửa hàng.', vi)).toBe(true);
    expect(stands(1, 'Có thể một lần mua lớn làm khoản này lớn hơn.', vi)).toBe(true);
    expect(stands(2, 'Có thể ít hóa đơn hơn, và có quà tặng cho khách, chi phí giảm.', vi)).toBe(true);
    expect(stands(2, 'Có thể thiếu một hóa đơn lớn, kèm quà tặng cho khách.', vi)).toBe(true);
    expect(stands(2, 'Có thể giám đốc đổi nhà cung cấp, khoản này nhỏ hơn.', vi)).toBe(true);
    // But a plain "nên" (should) is still an order, and "tăng" on a falling line a contradiction.
    expect(stands(2, 'Có thể nên đổi nhà cung cấp, khoản này nhỏ hơn.', vi)).toBe(false);
    expect(stands(2, 'Có thể quà tặng làm khoản này tăng.', vi)).toBe(false);
    expect(stands(1, 'Maybe it may be due to a larger purchase from a supplier.')).toBe(true);
    expect(stands(1, 'Possibly owing to an extra invoice, since a single purchase is larger.')).toBe(true);
  });

  it('refuses certainty and cause words, also behind a hedge, and done-claims, promises, advice and the future', () => {
    refused('Possibly this is certainly an invoice.');
    refused('Possibly it was clearly a single invoice.');
    refused('Possibly the rise is caused by an invoice.');
    refused('Possibly the reason is a single invoice.');
    refused('Possibly, but in fact this rise is the result of the extra invoices.');
    refused('Possibly the rise stems from the extra invoices.');
    refused('Possibly the rise is attributable to the extra invoices.');
    refused('Possibly it could only be the extra invoices.');
    refused('Có thể chắc chắn là do hóa đơn từ một nhà cung cấp.', 1, facts('vi'));
    refused('Có thể tăng, hẳn là vì hóa đơn mới.', 1, facts('vi'));
    refused('Có thể tăng, chắc hẳn do hóa đơn mới.', 1, facts('vi'));
    refused('Có thể nguyên nhân là hóa đơn từ một nhà cung cấp.', 1, facts('vi'));
    refused('Possibly an invoice was posted.');
    refused('Possibly an invoice has been paid.');
    refused('Có thể hóa đơn từ một nhà cung cấp đã ghi sổ.', 1, facts('vi'));
    refused('Possibly a supplier billed an extra invoice.');
    refused('Possibly an extra invoice was charged.');
    refused('Possibly an invoice will explain it.');
    refused('Possibly you should check the invoice.');
    refused('Có thể hãy kiểm tra hóa đơn từ một nhà cung cấp.', 1, facts('vi'));
    refused('Possibly a larger invoice; consider contacting them.');
    refused('Possibly a larger invoice, worth a look into the supplier.');
    refused('Possibly a larger invoice, please verify.');
    refused('Có thể do hóa đơn lớn hơn của một nhà cung cấp, bạn thử liên hệ họ.', 1, facts('vi'));
    refused('Có thể do hóa đơn lớn hơn, nên xác minh với nhà cung cấp.', 1, facts('vi'));
  });

  it('refuses a text that is not marked as a possibility, or that does not open with the hedge', () => {
    refused('A single invoice raised this cost.');
    refused('A single invoice may explain it.');
    refused('Một hóa đơn từ một nhà cung cấp làm khoản này tăng.', 1, facts('vi'));
    refused('Một hóa đơn từ một nhà cung cấp có thể giải thích.', 1, facts('vi'));
  });

  it('refuses a direction that contradicts the row, in either language', () => {
    refused('Possibly a single invoice explains why this cost fell.');
    refused('Possibly a single invoice explains a lower cost.');
    refused('Possibly the cost shrunk.');
    refused('Possibly fewer invoices explain it.');
    refused('Có thể do ít đơn mua hơn.', 1, facts('vi'));
    refused('Possibly fewer purchases from a supplier explain why the cost rose.', 2);
    refused('Possibly lower purchases explain why the cost went up.', 2);
    refused('Possibly a larger invoice explains it.', 2);
    refused('Có thể do phát sinh thêm hóa đơn.', 2, facts('vi'));
    refused('Có thể do bớt hóa đơn.', 1, facts('vi'));
    // A discount is not a fall of the cost.
    expect(stands(1, 'Possibly a supplier discount with an invoice explains it.')).toBe(true);
  });

  it('refuses links, markup, emoji, another script, an empty text and more than one sentence', () => {
    refused('Possibly an invoice explains it, see example.com.');
    refused('Possibly an invoice explains it, write to a@b.vn.');
    refused('Possibly an **invoice** explains it.');
    refused('Possibly an invoice explains it 🙂.');
    refused('Possibly an invoice exрlains it.');
    refused('');
    refused('   ');
    refused('Possibly an invoice explains it. A second sentence may too.');
    refused(`Possibly an invoice explains it${' and so on'.repeat(30)}.`);
  });

  it('drops a row that is not given or is given twice, and says why when nothing stands', () => {
    expect(checkExpenseVarianceNotes(facts(), { notes: [{ row: 9, text: 'Possibly an invoice explains it.' }] })).toEqual({ kind: 'none', code: 'REFUSED' });
    expect(checkExpenseVarianceNotes(facts(), { notes: [{ row: 0, text: 'Possibly an invoice explains it.' }] })).toEqual({ kind: 'none', code: 'REFUSED' });
    expect(checkExpenseVarianceNotes(facts(), { notes: [{ row: 1.5, text: 'Possibly an invoice explains it.' }] })).toEqual({ kind: 'none', code: 'REFUSED' });
    const twice = checkExpenseVarianceNotes(facts(), {
      notes: [
        { row: 3, text: 'Possibly an extra purchase explains it.' },
        { row: 1, text: 'Possibly a single invoice explains it.' },
        { row: 3, text: 'Possibly a larger purchase explains it.' },
      ],
    });
    expect(twice).toEqual({ kind: 'notes', notes: [{ row: 1, text: 'Possibly a single invoice explains it.' }] });
    expect(checkExpenseVarianceNotes(facts(), null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkExpenseVarianceNotes(facts(), { notes: [] })).toEqual({ kind: 'none', code: 'EMPTY' });
  });

  it('never lets a text with a digit through, whatever else it holds (property over many shapes)', () => {
    const bases = ['Possibly a single invoice explains it', 'Maybe several vouchers explain it', 'Perhaps an extra purchase explains the cost'];
    const digits = ['0', '1', '7', '٣', '²', '１'];
    for (const base of bases) {
      for (const d of digits) {
        for (const text of [`${base} ${d}.`, `${d} ${base}.`, `${base.replace(' ', ` ${d} `)}.`, `${base}, ${d}%.`]) {
          for (const row of [1, 2, 3]) expect(stands(row, text), `${row}: ${text}`).toBe(false);
        }
      }
    }
  });
});

describe('ExpenseVarianceCoworker', () => {
  const config = { baseUrl: 'http://unused.invalid', apiKey: 'x', model: 'm' } as unknown as AiConfig;

  it('asks the model nothing when no line is flagged, and checks the answer when one is', async () => {
    let asked = 0;
    const coworker = new ExpenseVarianceCoworker(config, async ({ system, prompt }) => {
      asked += 1;
      expect(system).toContain('Write NO number');
      expect(prompt).not.toMatch(/[0-9]{2}/);
      return { output: { notes: [{ row: 1, text: 'Possibly a single invoice explains it.' }, { row: 2, text: 'It fell by 40 percent.' }] }, usage: { inputTokens: 3, outputTokens: 4 } };
    });
    expect(await coworker.notes({ language: 'en', lines: [] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(asked).toBe(0);
    const used: number[] = [];
    const result = await coworker.notes(facts(), (u) => used.push(u.inputTokens + u.outputTokens));
    expect(asked).toBe(1);
    expect(used).toEqual([7]);
    expect(result).toEqual({ kind: 'notes', notes: [{ row: 1, text: 'Possibly a single invoice explains it.' }] });
  });

  it('says why when the model gave nothing', async () => {
    const coworker = new ExpenseVarianceCoworker(config, async () => ({ output: null }));
    expect(await coworker.notes(facts())).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});
