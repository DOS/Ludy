// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's notes on what MISA AMIS will refuse (#3904, S5 of #3854): what the model is told (the set of blocker kinds and their meaning, no count, voucher or name), and the checks that drop its
// notes. A note is tainted: one for a kind not on the list, a kind given twice, a digit or a number in words, a link, a claim that something was done, a promise, another script or more than one sentence is
// dropped on its own, never repaired, and the notes that stand never change the list of blockers.
import { describe, expect, it } from 'vitest';
import {
  MISA_AMIS_BLOCKER_KINDS,
  checkMisaAmisBlockerNotes,
  misaAmisBlockerNotesFactsText,
  misaAmisBlockerNotesHaveNews,
  misaAmisBlockerNotesInstructions,
  misaAmisBlockerNotesPrompt,
  type MisaAmisBlockerNotesFacts,
} from '../src/index.ts';

const FACTS: MisaAmisBlockerNotesFacts = { language: 'vi', kinds: ['item_code_unknown', 'vat_rate_unmapped'] };
const check = (notes: Array<{ kind?: string; text?: string }>, facts = FACTS) => checkMisaAmisBlockerNotes(facts, { notes });
const GOOD_ITEM = 'Dòng chứng từ chưa có mã hàng AMIS: hãy nhập mã hàng AMIS trong phần xem trước hoặc đặt mã AMIS cho mặt hàng trong Ludy.';
const GOOD_VAT = 'Thuế suất của dòng hóa đơn không nằm trong số AMIS nhận: hãy sửa thuế suất của dòng đó trong Ludy.';

describe('what the model is told', () => {
  it('is the kinds on the list with their meaning, and nothing else', () => {
    const text = misaAmisBlockerNotesFactsText(FACTS);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toMatch(/^item_code_unknown: /);
    expect(text).toContain('\nvat_rate_unmapped: ');
    expect(text).not.toContain('branch_missing');
    expect(/\d/.test(text)).toBe(false);
    expect(misaAmisBlockerNotesPrompt(FACTS)).toBe(`Kinds of problem and their meaning:\n${text}\n\nWrite one note for each kind.`);
    expect(misaAmisBlockerNotesInstructions('vi')).toContain('Vietnamese');
    expect(misaAmisBlockerNotesInstructions('en')).toContain('English');
  });

  it('says there is news only when a kind is on the list', () => {
    expect(misaAmisBlockerNotesHaveNews({ kinds: [] })).toBe(false);
    expect(misaAmisBlockerNotesHaveNews({ kinds: ['no_lines'] })).toBe(true);
  });

  it('has a meaning for every kind the preview can name', () => {
    for (const kind of MISA_AMIS_BLOCKER_KINDS) expect(misaAmisBlockerNotesFactsText({ language: 'en', kinds: [kind] }).startsWith(`${kind}: `)).toBe(true);
  });
});

describe('the notes that stand', () => {
  it('are kept, one per kind on the list, in the order of the kinds', () => {
    const result = check([{ kind: 'vat_rate_unmapped', text: GOOD_VAT }, { kind: 'item_code_unknown', text: GOOD_ITEM }]);
    expect(result).toEqual({ kind: 'notes', notes: [{ kind: 'item_code_unknown', text: GOOD_ITEM }, { kind: 'vat_rate_unmapped', text: GOOD_VAT }] });
  });

  it('keep the good note when another is refused, each standing on its own', () => {
    const result = check([{ kind: 'item_code_unknown', text: 'Có 3 dòng thiếu mã.' }, { kind: 'vat_rate_unmapped', text: GOOD_VAT }]);
    expect(result).toEqual({ kind: 'notes', notes: [{ kind: 'vat_rate_unmapped', text: GOOD_VAT }] });
  });

  it('are in English too', () => {
    const facts: MisaAmisBlockerNotesFacts = { language: 'en', kinds: ['stock_missing'] };
    const result = check([{ kind: 'stock_missing', text: 'A goods line has no AMIS warehouse code: set the warehouse code of the item in Ludy.' }], facts);
    expect(result).toMatchObject({ kind: 'notes' });
  });
});

describe('a note that is dropped', () => {
  const dropped = (text: string) => expect(check([{ kind: 'item_code_unknown', text }])).toEqual({ kind: 'none', code: 'REFUSED' });

  it('names a kind that is not on the list, or a kind given twice', () => {
    expect(check([{ kind: 'branch_missing', text: GOOD_ITEM }])).toEqual({ kind: 'none', code: 'REFUSED' });
    expect(check([{ kind: 'item_code_unknown', text: GOOD_ITEM }, { kind: 'item_code_unknown', text: GOOD_ITEM }])).toEqual({ kind: 'none', code: 'REFUSED' });
    expect(check([{ kind: 'nonsense', text: GOOD_ITEM }])).toEqual({ kind: 'none', code: 'REFUSED' });
  });

  it('has a digit, an amount or a number said in words', () => {
    dropped('Có 3 dòng chưa có mã hàng AMIS: hãy nhập mã hàng trong Ludy.');
    dropped('Dòng chưa có mã hàng AMIS 100% cần mã: hãy nhập mã trong Ludy.');
    dropped('Hai dòng chưa có mã hàng AMIS: hãy nhập mã hàng trong Ludy.');
    dropped('Two lines have no AMIS item code: type the code in Ludy.');
  });

  it('has a link', () => {
    dropped('Dòng chưa có mã hàng AMIS, xem https://example.com để biết cách sửa trong Ludy.');
  });

  it('says something was done, or promises a result', () => {
    dropped('Mã hàng AMIS đã được thêm vào dòng trong Ludy.');
    dropped('The item code was added to the line in Ludy.');
    dropped('Hãy nhập mã hàng AMIS trong Ludy, AMIS sẽ nhận chứng từ.');
    dropped('Type the AMIS item code in Ludy and the push will work.');
  });

  it('is empty, longer than one sentence or too long, or in another script', () => {
    dropped('');
    dropped('Dòng chưa có mã hàng AMIS. Hãy nhập mã hàng AMIS trong Ludy.');
    dropped(`Dòng chưa có mã hàng AMIS: ${'hãy nhập mã hàng AMIS trong Ludy '.repeat(10)}.`);
    dropped('Dòng chưa có mã hàng AMIS: hãy nhập mã hàng в Ludy.');
  });

  it('gives no notes at all when the model gives none', () => {
    expect(checkMisaAmisBlockerNotes(FACTS, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(check([])).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});
