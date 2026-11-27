// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's possible things to look at on the monthly review of unusual entries (#5182): what the model is told (fixed labels only: no figure, date, account code, voucher number or name) and every
// refusal of a note: a digit, a number in words, a date, a name that was not given, invisible marks, a link, certainty, a done-claim, a promise, advice (also to move money), a word that says the entry is wrong, no
// hedge, a contradicting direction, a repeated row. A refused note never stands and nothing is repaired.
import { describe, expect, it } from 'vitest';
import {
  UNUSUAL_ENTRIES_NOTE_MAX,
  checkUnusualEntriesNotes,
  unusualEntriesFactsText,
  unusualEntriesInstructions,
  unusualEntriesNotesHaveNews,
  unusualEntriesPrompt,
  type UnusualEntriesNoteFacts,
} from '../src/unusual-entries.ts';
import { UnusualEntriesCoworker } from '../src/unusual-entries-coworker.ts';
import { AI_FEATURES, type AiConfig } from '../src/index.ts';

// Row 1 a repeat of an invoice, 2 an amount far above the usual, 3 one far below, 4 an account new for a supplier, 5 a day off, 6 a manual voucher on a payable.
const facts = (language: 'vi' | 'en' = 'en'): UnusualEntriesNoteFacts => ({
  language,
  hits: [
    { rule: 'duplicate_invoice', sourceKind: 'invoice' },
    { rule: 'amount_outlier', sourceKind: 'invoice', direction: 'high' },
    { rule: 'amount_outlier', sourceKind: 'cash_bank', direction: 'low' },
    { rule: 'new_account', sourceKind: 'invoice', basis: 'party' },
    { rule: 'off_day', sourceKind: 'manual', day: 'weekend' },
    { rule: 'control_manual', sourceKind: 'manual', control: 'payable' },
  ],
});

const verdict = (row: number, text: string, f = facts()) => {
  const r = checkUnusualEntriesNotes(f, { notes: [{ row, text }] });
  return r.kind === 'notes' ? r.notes : null;
};
const stands = (row: number, text: string, f = facts()) => verdict(row, text, f) !== null;

describe('the metering key', () => {
  it('is one new AI_FEATURES key under the finance budget', () => {
    expect(AI_FEATURES['finance.unusual_entries_note']).toBe('finance');
  });
});

describe('what the model is told', () => {
  it('holds no digit, no figure, no date, no code and no name of any kind', () => {
    for (const language of ['vi', 'en'] as const) {
      const text = unusualEntriesFactsText(facts(language));
      // The only numbers are the row numbers, which sit after the word Row.
      expect(text.replace(/Row \d+:/g, '')).not.toMatch(/\d/);
      expect(unusualEntriesPrompt(facts(language))).toContain('Write one sentence for each row.');
    }
    expect(unusualEntriesInstructions('vi')).toContain('Vietnamese');
    expect(unusualEntriesInstructions('en')).toContain('English');
    expect(unusualEntriesInstructions('en')).toContain('Write NO number');
    expect(unusualEntriesInstructions('en')).toContain('Write no name at all');
    expect(unusualEntriesInstructions('en')).toContain('wrong');
  });

  it('tells the rule, the kind of voucher and one fixed detail, and never says which kind of day off', () => {
    const text = unusualEntriesFactsText(facts());
    expect(text).toContain('Row 1: a purchase invoice with the same supplier, invoice number and amount as one booked before; invoice');
    expect(text).toContain('the amount is far above the usual range');
    expect(text).toContain('the amount is far below the usual range');
    expect(text).toContain('new for this supplier');
    expect(text).toContain('a day off');
    expect(text).not.toMatch(/weekend|holiday/);
    expect(text).toContain('it touches a supplier payable account');
    const holiday = unusualEntriesFactsText({ language: 'en', hits: [{ rule: 'off_day', sourceKind: 'cash_bank', day: 'holiday' }] });
    expect(holiday).not.toMatch(/weekend|holiday/);
  });

  it('has nothing to say without a hit', () => {
    expect(unusualEntriesNotesHaveNews({ hits: [] })).toBe(false);
    expect(unusualEntriesNotesHaveNews(facts())).toBe(true);
  });
});

describe('a note that stands', () => {
  it('is one hedged sentence that opens with the hedge, from the facts of its row, in English and in Vietnamese', () => {
    expect(verdict(1, 'Possibly the same invoice shows up as a repeat of an earlier one.')).toEqual([{ row: 1, text: 'Possibly the same invoice shows up as a repeat of an earlier one.' }]);
    expect(stands(2, 'Perhaps a larger purchase than usual from a supplier explains this.')).toBe(true);
    expect(stands(3, 'Maybe a smaller purchase than usual from a supplier explains this.')).toBe(true);
    expect(stands(4, 'Possibly a supplier is being used for something new.')).toBe(true);
    expect(stands(5, 'Could be an entry keyed outside the usual working days.')).toBe(true);
    expect(stands(6, 'Might be a manual voucher that touches a balance owed to suppliers.')).toBe(true);
    const vi = facts('vi');
    expect(stands(1, 'Có thể hóa đơn này lặp lại một hóa đơn có cùng số trước đó.', vi)).toBe(true);
    expect(stands(2, 'Nhiều khả năng khoản mua này lớn hơn mức thường từ một nhà cung cấp.', vi)).toBe(true);
    expect(stands(3, 'Có lẽ khoản mua này nhỏ hơn mức thường từ một nhà cung cấp.', vi)).toBe(true);
  });

  it('keeps each note on its own and drops only the ones that fail', () => {
    const r = checkUnusualEntriesNotes(facts(), {
      notes: [
        { row: 1, text: 'Possibly the same invoice shows up as a repeat of an earlier one.' },
        { row: 2, text: 'This is clearly because of a larger purchase.' },
        { row: 4, text: 'Possibly a supplier is being used for something new.' },
      ],
    });
    expect(r).toEqual({
      kind: 'notes',
      notes: [
        { row: 1, text: 'Possibly the same invoice shows up as a repeat of an earlier one.' },
        { row: 4, text: 'Possibly a supplier is being used for something new.' },
      ],
    });
  });

  it('checks the direction only on an amount row', () => {
    expect(stands(1, 'Possibly a larger invoice than usual.')).toBe(true);
    expect(stands(2, 'Possibly a larger purchase than usual.')).toBe(true);
    expect(stands(3, 'Possibly a smaller purchase than usual.')).toBe(true);
  });
});

describe('a note that is refused', () => {
  const refused = (text: string, row = 1, f = facts()) => expect(stands(row, text, f), text).toBe(false);

  it('refuses ANY digit, a number in words, an ordinal and a size', () => {
    refused('Possibly a repeat of an invoice from 2026.');
    refused('Possibly 2 invoices explain it.');
    refused('Possibly a second copy of an invoice.');
    refused('Possibly twice the usual amount.', 2);
    refused('Possibly two invoices explain it.');
    refused('Possibly an amount of fifty million explains it.', 2);
    refused('Possibly hundreds of dong more explain it.', 2);
    refused('Possibly a repeat ① of an invoice.');
    refused('Có thể hai hóa đơn.', 1, facts('vi'));
    refused('Có thể gấp nhiều lần mức thường.', 2, facts('vi'));
    refused('Có thể khoản này hàng chục triệu đồng.', 2, facts('vi'));
  });

  it('refuses a date, a day of the week, a weekend and a month', () => {
    refused('Possibly keyed at the weekend.', 5);
    refused('Possibly keyed on a Saturday.', 5);
    refused('Possibly keyed in March.', 5);
    refused('Possibly keyed last week.', 5);
    refused('Possibly keyed today.', 5);
    refused('Có thể nhập vào cuối tuần này.', 5, facts('vi'));
  });

  it('refuses invisible marks, combining marks, links, emoji, markup, a look-alike script and a name', () => {
    refused('Possibly a repeat​ of an invoice.');
    refused('Possibly a repeat of an invoice͡.');
    refused('Possibly a repeat, see https://example.com for it.');
    refused('Possibly a repeat \u{1F642}.');
    refused('Possibly *a repeat* of an invoice.');
    refused('Possibly а repeat of an invoice.');
    refused('Possibly a repeat from Acme.');
    refused('Possibly a repeat of an invoice.⁣');
  });

  it('refuses certainty, a done-claim, a promise and the future', () => {
    refused('Possibly a repeat, which is certainly the cause.');
    refused('Possibly a repeat, and it is proven.');
    refused('Possibly a repeat that was posted.');
    refused('Possibly a repeat that was paid.');
    refused('Possibly a repeat that will be cleared soon.');
    refused('Possibly a repeat that is already known.');
    refused('Có thể hóa đơn này đã được nhập hai lần.', 1, facts('vi'));
    refused('Chắc chắn là hóa đơn lặp lại.', 1, facts('vi'));
  });

  it('refuses advice, advice to move money and an order to undo the entry', () => {
    refused('Possibly a repeat, so check the voucher.');
    refused('Possibly a repeat, so please review it.');
    refused('Possibly a repeat, so contact the supplier.');
    refused('Possibly a repeat, so refund it.');
    refused('Possibly a repeat, so recover the money.');
    refused('Possibly a repeat, so cancel it.');
    refused('Possibly a repeat, so reverse the entry.');
    refused('Possibly a repeat, so transfer the money back.');
    refused('Possibly a repeat that should be looked at.');
    refused('Có thể là bản lặp, hãy kiểm tra.', 1, facts('vi'));
    refused('Có thể là bản lặp nên hoàn tiền.', 1, facts('vi'));
    refused('Có thể là bản lặp, cần xem lại.', 1, facts('vi'));
  });

  it('refuses a word that says the entry is wrong', () => {
    refused('Possibly an error in how it was entered.');
    refused('Possibly a mistake by a supplier.');
    refused('Possibly fraud by a supplier.');
    refused('Possibly a fake invoice.');
    refused('Possibly a wrong amount.', 2);
    refused('Possibly an incorrect account.', 4);
    refused('Possibly an invalid voucher.', 6);
    refused('Possibly an entry that must not be there.', 5);
    refused('Có thể bút toán này sai.', 1, facts('vi'));
    refused('Có thể nhập nhầm tài khoản.', 4, facts('vi'));
    refused('Có thể có gian lận.', 1, facts('vi'));
    refused('Có thể hóa đơn giả.', 1, facts('vi'));
  });

  it('refuses a sentence with no hedge at the start, several sentences, a long one and an empty one', () => {
    refused('A repeat of an invoice.');
    refused('It looks like a repeat of an invoice.');
    refused('Possibly a repeat of an invoice. Perhaps not.');
    refused(`Possibly ${'a repeat of an invoice '.repeat(20)}.`);
    refused('   ');
    expect(Array.from(`Possibly ${'a repeat of an invoice '.repeat(20)}.`).length).toBeGreaterThan(UNUSUAL_ENTRIES_NOTE_MAX);
  });

  it('refuses an amount note that contradicts the direction of its row', () => {
    refused('Possibly a smaller purchase than usual.', 2);
    refused('Possibly a lower amount than usual.', 2);
    refused('Possibly a larger purchase than usual.', 3);
    refused('Possibly a higher amount than usual.', 3);
    refused('Có thể khoản này nhỏ hơn mức thường.', 2, facts('vi'));
    refused('Có thể khoản này lớn hơn mức thường.', 3, facts('vi'));
  });

  it('refuses a row that was not given and drops a row given twice', () => {
    expect(stands(9, 'Possibly the same invoice shows up as a repeat of an earlier one.')).toBe(false);
    expect(stands(0, 'Possibly the same invoice shows up as a repeat of an earlier one.')).toBe(false);
    const twice = checkUnusualEntriesNotes(facts(), {
      notes: [
        { row: 1, text: 'Possibly the same invoice shows up as a repeat of an earlier one.' },
        { row: 1, text: 'Possibly a repeat of an earlier invoice.' },
        { row: 4, text: 'Possibly a supplier is being used for something new.' },
      ],
    });
    expect(twice).toEqual({ kind: 'notes', notes: [{ row: 4, text: 'Possibly a supplier is being used for something new.' }] });
  });

  it('says why no note stands', () => {
    expect(checkUnusualEntriesNotes(facts(), null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkUnusualEntriesNotes(facts(), { notes: [] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkUnusualEntriesNotes(facts(), { notes: [{ row: 1, text: 'This is an error.' }] })).toEqual({ kind: 'none', code: 'REFUSED' });
  });
});

describe('UnusualEntriesCoworker', () => {
  const config = { baseUrl: 'http://unused.invalid', apiKey: 'x', model: 'm' } as unknown as AiConfig;

  it('asks the model nothing when no hit is given, and checks the answer when one is', async () => {
    let asked = 0;
    const coworker = new UnusualEntriesCoworker(config, async ({ system, prompt }) => {
      asked += 1;
      expect(system).toContain('Write NO number');
      expect(prompt).not.toMatch(/[0-9]{2}/);
      return {
        output: { notes: [{ row: 1, text: 'Possibly the same invoice shows up as a repeat of an earlier one.' }, { row: 2, text: 'It is 40 percent above the usual.' }] },
        usage: { inputTokens: 3, outputTokens: 4 },
      };
    });
    expect(await coworker.notes({ language: 'en', hits: [] })).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(asked).toBe(0);
    const used: number[] = [];
    const result = await coworker.notes(facts(), (u) => used.push(u.inputTokens + u.outputTokens));
    expect(asked).toBe(1);
    expect(used).toEqual([7]);
    expect(result).toEqual({ kind: 'notes', notes: [{ row: 1, text: 'Possibly the same invoice shows up as a repeat of an earlier one.' }] });
  });

  it('says why when the model gave nothing', async () => {
    const coworker = new UnusualEntriesCoworker(config, async () => ({ output: null }));
    expect(await coworker.notes(facts())).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});
