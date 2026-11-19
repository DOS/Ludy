// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's notes under the Sàn table (#3711 slice 7): what the model is told (per numbered row: fees, age, past the cycle, and the cycle length; no platform name), and the checks that drop its
// notes. A note is tainted: a row not given or given twice, a number that is not its own row's or stands beside the wrong thing, a number in words, a link, a platform's name, the future tense, a claim that
// something was done, a promise, or "nothing is waiting" is dropped on its own, never repaired.
import { describe, expect, it } from 'vitest';
import {
  checkMarketplaceFeeNotes,
  marketplaceFeeNotesFactsText,
  marketplaceFeeNotesHaveNews,
  marketplaceFeeNotesInstructions,
  marketplaceFeeNotesPrompt,
  type MarketplaceFeeNoteFacts,
} from '../src/index.ts';

const VI: MarketplaceFeeNoteFacts = { language: 'vi', cycleDays: 45, rows: [{ fees: '1200000', ageDays: 51, overdue: true }, { fees: '350000', ageDays: 12, overdue: false }] };
const EN: MarketplaceFeeNoteFacts = { ...VI, language: 'en' };
const one = (facts: MarketplaceFeeNoteFacts, row: number, text: string) => checkMarketplaceFeeNotes(facts, { notes: [{ row, text }] });
const dropped = (facts: MarketplaceFeeNoteFacts, row: number, text: string) => expect(one(facts, row, text)).toEqual({ kind: 'none', code: 'REFUSED' });

describe('what the model is told', () => {
  it('is the cycle length and one line per row, with the amount, the age and past the cycle, and no platform', () => {
    const text = marketplaceFeeNotesFactsText(VI);
    expect(text.split('\n')).toEqual([
      'One settlement cycle: 45 days',
      'Row 1: fees waiting for an invoice: 1.200.000 đồng; the oldest fee is 51 days old; past one settlement cycle: yes',
      'Row 2: fees waiting for an invoice: 350.000 đồng; the oldest fee is 12 days old; past one settlement cycle: no',
    ]);
    expect(marketplaceFeeNotesPrompt(VI)).toBe(`${text}\n\nWrite one note for each row.`);
    expect(marketplaceFeeNotesInstructions('vi')).toContain('Vietnamese');
    expect(marketplaceFeeNotesInstructions('en')).toContain('English');
  });

  it('says there is news only when a platform has fees waiting', () => {
    expect(marketplaceFeeNotesHaveNews({ rows: [] })).toBe(false);
    expect(marketplaceFeeNotesHaveNews(VI)).toBe(true);
  });
});

describe('a note that stands', () => {
  it('is kept per row, in order, in Vietnamese and in English', () => {
    const vi = checkMarketplaceFeeNotes(VI, {
      notes: [
        { row: 2, text: 'Phí 350.000 đồng sàn giữ lại đang chờ hóa đơn phí, hãy nhập hóa đơn khi sàn gửi.' },
        { row: 1, text: 'Phí 1.200.000 đồng đã chờ 51 ngày, quá chu kỳ 45 ngày: hãy xin hóa đơn phí từ sàn hoặc nhập hóa đơn.'.replace('đã chờ', 'chờ') },
      ],
    });
    expect(vi).toMatchObject({ kind: 'notes' });
    if (vi.kind === 'notes') expect(vi.notes.map((n) => n.row)).toEqual([1, 2]);
    const en = one(EN, 1, 'The fees of 1,200,000 dong have waited 51 days, more than one settlement cycle of 45 days: ask the platform for its fee invoice or enter it.');
    expect(en).toMatchObject({ kind: 'notes' });
  });

  it('keeps the good note when another is dropped, each standing on its own', () => {
    const result = checkMarketplaceFeeNotes(VI, { notes: [{ row: 1, text: 'Phí 9.999.000 đồng đang chờ hóa đơn: hãy nhập hóa đơn.' }, { row: 2, text: 'Phí 350.000 đồng đang chờ hóa đơn phí: hãy nhập hóa đơn khi sàn gửi.' }] });
    expect(result).toMatchObject({ kind: 'notes' });
    if (result.kind === 'notes') expect(result.notes.map((n) => n.row)).toEqual([2]);
  });
});

describe('a note that is dropped', () => {
  it('is for a row not given, or a row given twice', () => {
    dropped(VI, 3, 'Phí đang chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi.');
    dropped(VI, 0, 'Phí đang chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi.');
    const twice = checkMarketplaceFeeNotes(VI, { notes: [{ row: 1, text: 'Phí đang chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi.' }, { row: 1, text: 'Phí đang chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi.' }] });
    expect(twice).toEqual({ kind: 'none', code: 'REFUSED' });
  });

  it("has another row's number, a number the facts do not hold, or a number beside the wrong thing", () => {
    // Row 2's amount in row 1's note, an invented number, the age written as an amount, the amount as days.
    dropped(VI, 1, 'Phí 350.000 đồng đang chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi.');
    dropped(VI, 1, 'Phí 1.300.000 đồng đang chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi.');
    dropped(VI, 1, 'Phí 51 đồng đang chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi.');
    dropped(VI, 1, 'Phí đã chờ 1.200.000 ngày: hãy nhập hóa đơn khi sàn gửi.'.replace('đã chờ', 'chờ'));
    dropped(VI, 1, 'Phí chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi 3 lần.');
  });

  it('writes a number in words, also without accents, a Roman numeral or an emoji', () => {
    dropped(VI, 1, 'Phí chờ hai ngày: hãy nhập hóa đơn khi sàn gửi.');
    dropped(VI, 1, 'Phi cho hai ngay: hay nhap hoa don khi san gui.');
    dropped(VI, 1, 'Phí chờ Ⅲ ngày: hãy nhập hóa đơn khi sàn gửi.');
    dropped(VI, 1, 'Phí chờ hóa đơn ⚠️: hãy nhập hóa đơn khi sàn gửi.');
    dropped(EN, 1, 'Two days of fees wait for an invoice: enter the invoice when the platform sends it.');
  });

  it('has a link, another script, a platform name, or more than one sentence', () => {
    dropped(VI, 1, 'Phí chờ hóa đơn, xem https://example.com để biết thêm: hãy nhập hóa đơn.');
    dropped(VI, 1, 'Phí chờ hóa đơn: hãy nhập hóa đơn в Ludy.');
    dropped(VI, 1, 'Phí Shopee chờ hóa đơn: hãy nhập hóa đơn khi sàn gửi.');
    dropped(VI, 1, 'Phí chờ hóa đơn. Hãy nhập hóa đơn khi sàn gửi.');
    dropped(VI, 1, '');
  });

  it('says something was done, uses the future tense, promises, or says nothing is waiting', () => {
    dropped(EN, 1, 'The fee invoice was posted to the platform account: enter the next one when it comes.');
    dropped(EN, 1, 'The fees are paid: enter the invoice when the platform sends it.');
    dropped(EN, 1, 'The fees will clear once you enter the invoice from the platform.');
    dropped(VI, 1, 'Phí đã được ghi sổ: hãy nhập hóa đơn khi sàn gửi.');
    dropped(VI, 1, 'Phí sẽ hết khi bạn nhập hóa đơn khi sàn gửi.');
    dropped(EN, 1, 'Nothing is waiting: enter the invoice when the platform sends it.');
  });

  it('gives no notes at all when the model gives none', () => {
    expect(checkMarketplaceFeeNotes(VI, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(checkMarketplaceFeeNotes(VI, { notes: [] })).toEqual({ kind: 'none', code: 'EMPTY' });
  });
});
