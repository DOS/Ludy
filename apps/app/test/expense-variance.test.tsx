// SPDX-License-Identifier: AGPL-3.0-only
// The expense variance card of the Kế toán Tổng quan (#4392): the pure parts (the months the picker offers and how a change reads) and the table of flagged lines in Vietnamese and in English: every figure is on the
// screen, the coworker's note appears only when it came back and is labelled as a possibility, with AI off the table is the same with no gap, and the controls keep a 44 px target on a phone.
import { renderToString } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ExpenseVarianceLine, FinanceExpenseVariance } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { changeKind, defaultMonth, monthText, pickerMonths, sizeOf, startsAfterBasis } from '../src/lib/expense-variance.ts';

vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));

const { VarianceTable } = await import('../src/routes/expense-variance-card.tsx');

const compare = (basis: string | null, change: string | null, percent: string | null, flagged: boolean) => ({ basis, change, percent, flagged });
const staff: ExpenseVarianceLine = {
  code: '6421',
  name: 'Chi phí quản lý doanh nghiệp',
  amount: '30000000',
  previous: compare('10000000', '20000000', '200.0', true),
  average: compare('10000000', '20000000', '200.0', true),
  direction: 'up',
  against: 'previous',
  isNew: false,
  vouchers: 2,
  contributors: [
    { kind: 'supplier', partyId: 'p-1', name: 'Công ty B', entryId: null, entryDate: null, description: null, sourceKind: 'invoice', vouchers: 1, amount: '20000000', basis: '0', change: '20000000' },
    { kind: 'voucher', partyId: null, name: null, entryId: 'e-1', entryDate: '2026-07-15', description: 'Chi phí mới', sourceKind: 'other', vouchers: 1, amount: '9000000', basis: '0', change: '9000000' },
  ],
};
const fresh: ExpenseVarianceLine = { ...staff, code: '6417', name: null, amount: '9000000', previous: compare('0', '9000000', null, true), average: compare('0', '9000000', null, true), isNew: true, contributors: [] };
const fell: ExpenseVarianceLine = { ...staff, code: '632', name: 'Giá vốn hàng bán', amount: '10000000', previous: compare('40000000', '-30000000', '75.0', true), average: compare(null, null, null, false), direction: 'down', contributors: [] };
const DATA: FinanceExpenseVariance = {
  month: '2026-07',
  legalEntityId: 'le-1',
  regime: 'tt133',
  chartVersion: '2026.1',
  thresholds: { amount: '5000000', percent: '30' },
  previousMonth: '2026-06',
  booksStart: null,
  averageMonths: ['2026-04', '2026-05', '2026-06'],
  missing: { previous: false, average: true },
  empty: false,
  lines: [fell, staff, fresh],
  moreFlagged: 0,
};

const render = (locale: 'vi' | 'en', data: FinanceExpenseVariance, notes: ReadonlyArray<{ code: string; text: string }> = []) =>
  renderToString(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <VarianceTable data={data} notes={notes} />
    </IntlProvider>,
  );

describe('the months of the picker', () => {
  it('offers the last 12 months that have ended, newest first, never the running month', () => {
    const months = pickerMonths('2026-11-22');
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2026-10');
    expect(months[11]).toBe('2025-11');
    expect(months).not.toContain('2026-11');
    expect(defaultMonth('2026-11-22')).toBe('2026-10');
  });

  it('crosses a year end', () => {
    expect(pickerMonths('2026-01-01').slice(0, 2)).toEqual(['2025-12', '2025-11']);
    expect(defaultMonth('2026-03-31')).toBe('2026-02');
    expect(monthText('2026-07')).toBe('07/2026');
  });
});

describe('where the books begin', () => {
  it('tells a basis month that is not there from a comparison in another chart', () => {
    const months = ['2026-04', '2026-05', '2026-06'] as const;
    expect(startsAfterBasis({ booksStart: null, averageMonths: [...months] })).toBe(false);
    expect(startsAfterBasis({ booksStart: '2026-04-01', averageMonths: [...months] })).toBe(false);
    expect(startsAfterBasis({ booksStart: '2026-04-02', averageMonths: [...months] })).toBe(true);
    expect(startsAfterBasis({ booksStart: '2026-06-10', averageMonths: [...months] })).toBe(true);
  });
});

describe('how a change reads', () => {
  it('reads the direction from the exact decimal, whatever decimals the server sends', () => {
    expect(changeKind({ change: '20000000' })).toBe('up');
    expect(changeKind({ change: '-0.5' })).toBe('down');
    expect(changeKind({ change: '0.0000' })).toBe('flat');
    expect(changeKind({ change: '-0' })).toBe('flat');
    expect(changeKind({ change: null })).toBe('none');
    expect(sizeOf('-30000000')).toBe('30000000');
    expect(sizeOf('30000000')).toBe('30000000');
  });
});

describe('the table of flagged lines', () => {
  it('shows every flagged line with its figures, the direction in words, the thresholds and the books it follows (vi)', () => {
    const html = render('vi', DATA);
    for (const text of ['6421 Chi phí quản lý doanh nghiệp', '632 Giá vốn hàng bán', 'Tăng', 'Giảm', 'Mới', 'Quá ngưỡng', 'Thông tư 133', 'Chưa so sánh', 'mặc định']) expect(html, text).toContain(text);
    // A line with no name shows its code alone.
    expect(html).toContain('>6417<');
    // The direction is also in words, not colour alone; a fall of 30,000,000 reads 75.0 percent.
    expect(html).toMatch(/Giảm[^<]*30[.,]000[.,]000/);
    expect(html).toContain('data-flagged="true"');
    expect(html).toContain('Chưa so sánh được với mức trung bình');
    expect(html).not.toContain('Chưa so sánh được với tháng trước');
  });

  it('names the supplier or the voucher behind a line, with the kind of voucher', () => {
    const html = render('vi', DATA);
    for (const text of ['Nhà cung cấp Công ty B', 'Chứng từ ngày', 'Chi phí mới', 'Hóa đơn', 'Chứng từ khác']) expect(html, text).toContain(text);
  });

  it('shows the coworker\'s note only when it came back, labelled as a possibility (vi and en)', () => {
    const noted = render('vi', DATA, [{ code: '6421', text: 'Một hóa đơn lớn có thể giải thích khoản này.' }]);
    expect(noted).toContain('data-testid="variance-note-6421"');
    expect(noted).toContain('Một hóa đơn lớn có thể giải thích khoản này.');
    expect(noted).toContain('gợi ý một lý do có thể');
    expect(noted).toContain('chưa phải kết luận');
    // The name of the coworker comes from the catalog, never typed in the copy.
    expect(noted).not.toContain('{finance}');
    const en = render('en', DATA, [{ code: '632', text: 'Fewer purchases may explain the drop.' }]);
    expect(en).toContain('data-testid="variance-note-632"');
    expect(en).toContain('suggests a possible reason');
    expect(en).toContain('not a finding');
    expect(en).not.toContain('{finance}');
    expect(en).not.toContain('variance-note-6421');
  });

  it('is the same table with no note, no gap and no notice when the AI is off', () => {
    const off = render('vi', DATA, []);
    expect(off).not.toContain('variance-note-');
    expect(off).not.toContain('gợi ý');
    expect(off).toContain('variance-line-6421');
    expect(off).toContain('variance-line-632');
    expect(off).toContain('variance-line-6417');
  });

  it('gives every control of the card a 44 px target on a phone and labels the table', () => {
    const html = render('vi', DATA);
    expect(html).toContain('min-h-11');
    expect(html).toContain('<caption class="sr-only">Biến động chi phí</caption>');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
  });

  it('says so when there are no entries, when nothing moved, when a comparison is missing and when more lines moved than are shown', () => {
    expect(render('vi', { ...DATA, empty: true, lines: [] })).toContain('Chưa có bút toán nào trong 4 tháng này');
    expect(render('en', { ...DATA, empty: true, lines: [] })).toContain('There are no entries in these 4 months');
    expect(render('vi', { ...DATA, lines: [] })).toContain('Không có dòng chi phí nào lệch quá ngưỡng');
    expect(render('en', { ...DATA, lines: [] })).toContain('No expense line moved past the threshold');
    expect(render('en', { ...DATA, missing: { previous: true, average: true } })).toContain('Not compared with the month before');
    expect(render('vi', { ...DATA, moreFlagged: 2 })).toContain('2 dòng khác');
    expect(render('vi', { ...DATA, moreFlagged: 2 })).not.toContain('Sổ sách');
    expect(render('en', { ...DATA, moreFlagged: 2 })).not.toContain('ledger');
    // The books begin after the months compared with: one message about it, not the one about another chart of accounts.
    const young = render('en', { ...DATA, booksStart: '2026-05-10', missing: { previous: false, average: true } });
    expect(young).toContain('hold entries only from');
    expect(young).not.toContain('another chart of accounts');
    expect(render('vi', { ...DATA, booksStart: '2026-05-10', missing: { previous: false, average: true } })).toContain('chỉ có bút toán từ ngày');
    expect(render('en', { ...DATA, regime: 'tt99' })).toContain('Circular 99');
  });
});
