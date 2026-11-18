// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's one line above the MISA export check (#3848 slice B): what the model is told, and the checks that refuse its text. The sentence is tainted: any number the counts do not hold, a count
// set against the wrong kind, a link, a claim that something was fixed, imported or sent, or a text that is not one short sentence is no line (never repaired).
import { describe, expect, it } from 'vitest';
import { checkMisaCheckLineSentence, misaCheckLineFactsText, misaCheckLineHasNews, misaCheckLineInstructions, misaCheckLinePrompt, type MisaCheckLineFacts } from '../src/index.ts';

const VI: MisaCheckLineFacts = { language: 'vi', rows: 40, codes: 12, required: 0, vat: 3, accounts: 2, tooLong: 5 };
const EN: MisaCheckLineFacts = { ...VI, language: 'en' };
const check = (facts: MisaCheckLineFacts, sentence: string) => checkMisaCheckLineSentence(facts, { sentence });
const refused = (facts: MisaCheckLineFacts, sentence: string, code: string) => expect(check(facts, sentence)).toEqual({ kind: 'none', code });

describe('the counts the model is told', () => {
  it('are six lines of counts and nothing else', () => {
    expect(misaCheckLineFactsText(VI)).toBe(
      [
        'Rows checked: 40',
        'Cells with a catalog code to fill: 12',
        'Required cells that are empty: 0',
        'VAT rate cells that are empty or not a rate MISA takes: 3',
        'Accounts that are not in the chart of accounts: 2',
        'Texts longer than MISA allows: 5',
      ].join('\n'),
    );
    expect(misaCheckLinePrompt(VI)).toBe(`${misaCheckLineFactsText(VI)}\n\nWrite the sentence on what the problems mean and how to fix them.`);
    expect(misaCheckLineInstructions('vi')).toContain('Vietnamese');
    expect(misaCheckLineInstructions('en')).toContain('English');
  });

  it('say there is news only when something is flagged', () => {
    expect(misaCheckLineHasNews({ codes: 0, required: 0, vat: 0, accounts: 0, tooLong: 0 })).toBe(false);
    expect(misaCheckLineHasNews({ codes: 0, required: 0, vat: 0, accounts: 1, tooLong: 0 })).toBe(true);
  });
});

describe('a sentence that explains the counts as given', () => {
  it.each([
    [VI, 'Có 12 ô mã cần điền trong file, và 3 ô thuế suất GTGT trống hoặc sai: hãy điền mã trước khi nhập và sửa thuế suất trong Ludy.'],
    [VI, 'Có 2 tài khoản không có trong hệ thống tài khoản: hãy thêm vào hệ thống hoặc đổi tài khoản trên chứng từ.'],
    [VI, 'Có 5 văn bản dài hơn MISA cho phép, sẽ bị cắt trong file: hãy rút gọn trong Ludy.'],
    [EN, 'Fill in the catalog code of 12 cells before you import, and add 2 accounts to your chart or change the account on the voucher.'],
    [EN, 'Of 40 rows, 3 VAT rate cells are wrong or empty and 5 texts are too long: fix the rate and shorten the text in Ludy.'],
    [EN, 'The 3 VAT rates need to be fixed in Ludy before you export again.'],
  ])('is kept: %#', (facts, sentence) => {
    expect(check(facts, sentence)).toEqual({ kind: 'sentence', text: sentence });
  });
});

describe('a sentence that is refused, not repaired', () => {
  it('has no text, or more than one sentence, or is too long', () => {
    refused(VI, '', 'EMPTY');
    expect(checkMisaCheckLineSentence(VI, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    refused(VI, 'Có 12 ô mã cần điền. Có 2 tài khoản không có trong hệ thống.', 'TOO_LONG');
    refused(EN, `12 cells need a code ${'really '.repeat(60)}filled.`, 'TOO_LONG');
  });

  it('states a number the counts do not hold, in digits or in words', () => {
    refused(VI, 'Có 13 ô mã cần điền trong file.', 'FIGURES');
    refused(VI, 'Có mười hai ô mã cần điền.', 'FIGURES');
    refused(VI, 'Có hai tài khoản không có trong hệ thống.', 'FIGURES');
    refused(EN, 'Twelve cells need a catalog code.', 'FIGURES');
    refused(EN, 'About 12k cells need a code.', 'FIGURES');
    refused(EN, '12 cells need a code, 100 in all.', 'FIGURES');
  });

  it('sets a count against the wrong kind', () => {
    // 12 is the codes, not the accounts; 2 is the accounts, not the VAT cells; 5 is the long texts.
    refused(EN, '12 accounts are not in your chart.', 'BINDING');
    refused(EN, '2 VAT rate cells are wrong.', 'BINDING');
    refused(VI, 'Có 2 ô mã cần điền và 12 tài khoản không có trong hệ thống.', 'BINDING');
    refused(VI, 'Có 5 ô thuế suất GTGT sai.', 'BINDING');
    // A number with no word beside it names nothing.
    refused(EN, 'Check 12 now.', 'BINDING');
  });

  it('carries a link, says something was done, or uses a script of another alphabet', () => {
    refused(EN, '12 codes to fill, see https://example.com for the list.', 'LINK');
    refused(VI, 'Có 12 ô mã cần điền, xem https://example.com để biết thêm.', 'LINK');
    refused(EN, 'The 12 codes were filled in.', 'CLAIM');
    // Safe over lively: "need ... filled" reads as a claim, so the line is dropped and the list stands alone.
    refused(EN, '12 cells need a catalog code filled in.', 'CLAIM');
    refused(EN, 'I have fixed the 3 VAT rates.', 'CLAIM');
    refused(EN, 'The file was imported with 2 accounts missing.', 'CLAIM');
    refused(EN, '5 texts were shortened and the file downloaded.', 'CLAIM');
    refused(VI, 'Đã sửa 3 ô thuế suất GTGT.', 'CLAIM');
    refused(VI, 'Có 12 ô mã cần điền, mình ѕẽ điền giúp.', 'SCRIPT');
  });

  it('allows "to be fixed", which is a fact, not a claim', () => {
    expect(check(EN, '3 VAT rate cells are still to be fixed in Ludy.').kind).toBe('sentence');
  });
});
