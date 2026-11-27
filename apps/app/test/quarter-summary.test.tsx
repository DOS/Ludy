// SPDX-License-Identifier: AGPL-3.0-only
// The quarter card of the Kế toán Tổng quan (#5183): the pure parts (the quarters the picker offers) and the table in Vietnamese and in English: every figure and label comes from the server, the coworker's sentences
// appear only when they came back and sit beside the name of their row, with AI off the figures are the same with no gap and no notice, the fixed footnote shows only when costs outside the income statement are in,
// and the state of the books is shown whatever it is.
import { renderToString } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceQuarterSummary, QuarterSummaryFigure } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { defaultQuarter, hasComparison, pickerQuarters, quarterParts } from '../src/lib/quarter-summary.ts';

vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));

const { QuarterSummaryTable } = await import('../src/routes/quarter-summary-card.tsx');

const figure = (key: QuarterSummaryFigure['key'], amount: string, previous: string | null, lastYear: string | null, vsPrevious: QuarterSummaryFigure['vsPrevious'], vsLastYear: QuarterSummaryFigure['vsLastYear']): QuarterSummaryFigure => ({
  key,
  amount,
  previous,
  lastYear,
  vsPrevious,
  vsLastYear,
});
const DATA: FinanceQuarterSummary = {
  quarter: '2026-Q3',
  from: '2026-07-01',
  to: '2026-09-30',
  legalEntityId: 'le-1',
  kind: 'company',
  regime: 'tt99',
  booksStart: '2025-08-10',
  previousQuarter: '2026-Q2',
  lastYearQuarter: '2025-Q3',
  steadyPercent: '5',
  empty: false,
  includesUnmapped: true,
  figures: [
    figure('revenue', '100000000', '50000000', '100000000', 'rose', 'steady'),
    figure('other_income', '0', '0', '0', 'none', 'none'),
    figure('costs', '40000000', '20000000', '0', 'rose', 'first_time'),
    figure('profit', '60000000', '30000000', '100000000', 'rose', 'fell'),
    figure('cash', '40000000', '12345678', '0', 'rose', 'first_time'),
    figure('receivables', '210000000', '150000000', '100000000', 'rose', 'rose'),
    figure('payables', '60000000', '20000000', null, 'rose', 'none'),
  ],
  overdue: { oldestDueOn: '2026-08-09', amount: '100000000', count: 2, truncated: false },
  vat: { output: '10000000', input: '4000000', difference: '6000000', filed: false },
  householdTax: null,
  stockProvisional: null,
  lock: { state: 'partly', lockedThrough: '2026-07-31' },
};

const render = (locale: 'vi' | 'en', data: FinanceQuarterSummary, notes: ReadonlyArray<{ row: QuarterSummaryFigure['key']; text: string }> = []) =>
  renderToString(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <QuarterSummaryTable data={data} notes={notes} />
    </IntlProvider>,
  );

describe('the quarters of the picker', () => {
  it('offers the last 8 quarters that have ended, newest first, never the running one', () => {
    const quarters = pickerQuarters('2026-11-27');
    expect(quarters).toHaveLength(8);
    expect(quarters[0]).toBe('2026-Q3');
    expect(quarters[7]).toBe('2024-Q4');
    expect(quarters).not.toContain('2026-Q4');
    expect(defaultQuarter('2026-11-27')).toBe('2026-Q3');
  });

  it('crosses a year end and counts the first day of a quarter as inside it', () => {
    expect(pickerQuarters('2026-01-05').slice(0, 2)).toEqual(['2025-Q4', '2025-Q3']);
    expect(defaultQuarter('2026-04-01')).toBe('2026-Q1');
    expect(defaultQuarter('2026-03-31')).toBe('2025-Q4');
    expect(quarterParts('2026-Q3')).toEqual({ year: '2026', n: '3' });
  });

  it('tells a row with a comparison from one with none', () => {
    expect(hasComparison({ vsPrevious: 'none', vsLastYear: 'none' })).toBe(false);
    expect(hasComparison({ vsPrevious: 'steady', vsLastYear: 'none' })).toBe(true);
  });
});

describe('the table of figures', () => {
  it('shows every row with its figures and its labels in words, and the quarters compared (vi)', () => {
    const html = render('vi', DATA);
    for (const text of ['Doanh thu bán hàng', 'Chi phí', 'Lợi nhuận trước thuế', 'Tiền cuối quý', 'Khách còn nợ', 'Tăng', 'Giảm', 'Đi ngang', 'Lần đầu', 'Chưa so sánh', 'Quý 2/2026', 'Quý 3/2025', 'Thông tư 99']) {
      expect(html, text).toContain(text);
    }
    // The cash at the start is the previous quarter's balance, said in words.
    expect(html).toMatch(/Tiền đầu quý: [^<]*12[.,]345[.,]678/);
    // The labels are in words as well as a mark.
    expect(html).toContain('data-trend="rose"');
    expect(html).toContain('<caption class="sr-only">Quý này nói gì</caption>');
  });

  it('is in English too, with the name of the coworker never typed in the copy', () => {
    const html = render('en', DATA, [{ row: 'revenue', text: 'Sales revenue rose against the previous quarter.' }]);
    for (const text of ['Sales revenue', 'Cash at the end', 'Rose', 'First time', 'The quarter before (Quarter 2/2026)']) expect(html, text).toContain(text);
    expect(html).not.toContain('{finance}');
  });

  it('shows the coworker\'s sentences only when they came back, each beside the name of its row (vi and en)', () => {
    const noted = render('vi', DATA, [
      { row: 'revenue', text: 'Doanh thu tăng so với quý trước.' },
      { row: 'profit', text: 'Lợi nhuận giảm so với cùng kỳ năm trước.' },
    ]);
    expect(noted).toContain('data-testid="quarter-notes"');
    expect(noted).toContain('data-testid="quarter-note-revenue"');
    expect(noted).toContain('Doanh thu bán hàng: </span>Doanh thu tăng so với quý trước.');
    expect(noted).toContain('tóm tắt quý bằng lời');
    expect(noted).toContain('Số liệu nằm trong bảng');
    // The row a sentence is about is marked and points at it.
    expect(noted).toContain('aria-describedby="quarter-note-revenue"');
    expect(noted).toContain('data-has-note="true"');
    expect(noted).not.toContain('aria-describedby="quarter-note-costs"');
    const en = render('en', DATA, [{ row: 'cash', text: 'Cash rose against the previous quarter.' }]);
    expect(en).toContain('data-testid="quarter-note-cash"');
    expect(en).toContain('sums up the quarter in words');
    expect(en).not.toContain('quarter-note-revenue');
  });

  it('is the same figures with no sentence, no gap and no notice when the AI is off', () => {
    const off = render('vi', DATA, []);
    expect(off).not.toContain('quarter-note');
    expect(off).not.toContain('tóm tắt quý bằng lời');
    expect(off).toContain('quarter-row-revenue');
    expect(off).toContain('quarter-row-payables');
    expect(off).toContain('data-has-note="false"');
  });

  it('says the profit includes costs the income statement does not map, only when it does', () => {
    expect(render('vi', DATA)).toContain('data-testid="quarter-unmapped"');
    expect(render('vi', DATA)).toContain('chưa ánh xạ');
    expect(render('en', DATA)).toContain('does not yet map');
    expect(render('vi', { ...DATA, includesUnmapped: false })).not.toContain('quarter-unmapped');
  });

  it('shows the state of the books, whatever it is (open, partly locked, locked)', () => {
    expect(render('vi', { ...DATA, lock: { state: 'open', lockedThrough: null } })).toContain('Sổ của quý này còn mở');
    expect(render('vi', DATA)).toContain('khóa đến ngày');
    expect(render('vi', { ...DATA, lock: { state: 'locked', lockedThrough: '2026-09-30' } })).toContain('Sổ của quý này đã khóa');
    expect(render('en', DATA)).toContain('The VAT return of this quarter is not marked as filed.');
    expect(render('en', { ...DATA, vat: { ...DATA.vat!, filed: true } })).toContain('is marked as filed');
  });

  it('shows the oldest overdue invoice, or says none', () => {
    expect(render('vi', DATA)).toContain('quá hạn');
    expect(render('en', { ...DATA, overdue: { oldestDueOn: null, amount: '0', count: 0, truncated: false } })).toContain('No sales invoice was overdue');
    expect(render('en', { ...DATA, overdue: { ...DATA.overdue, truncated: true } })).toContain('so these figures are partial');
  });

  it('shows a household\'s tax in place of the VAT, with the provisional label', () => {
    const household: FinanceQuarterSummary = { ...DATA, kind: 'household', vat: null, householdTax: { state: 'ready', tax: '12000', due: '9000', overpaid: '0', commentary: true } };
    const html = render('vi', household);
    expect(html).toContain('Thuế của quý (mẫu 01/CNKD)');
    expect(html).toContain('Còn phải nộp');
    expect(html).toContain('kế toán chưa xác nhận');
    expect(html).not.toContain('Thuế GTGT của quý');
    expect(render('vi', { ...household, householdTax: { state: 'held', tax: null, due: null, overpaid: null, commentary: false } })).toContain('chưa được chia theo ngành nghề');
    expect(render('en', { ...household, householdTax: { state: 'not_required', tax: null, due: null, overpaid: null, commentary: false } })).toContain('No quarterly return is made');
  });

  it('shows the stock row with its fixed words: provisional, compared with the quarter before only', () => {
    const stock = figure('stock', '5000000', '4000000', null, 'rose', 'none');
    const html = render('en', { ...DATA, figures: [...DATA.figures, stock], stockProvisional: true });
    expect(html).toContain('Value of the stock at the end');
    expect(html).toContain('Provisional until the month is closed in the stock.');
    expect(html).toContain('compared with the quarter before only');
  });

  it('says there is nothing to sum up for an entity with no entry', () => {
    const empty = render('vi', { ...DATA, empty: true, includesUnmapped: false });
    expect(empty).toContain('Chưa có bút toán nào đến hết quý này');
    expect(empty).not.toContain('quarter-row-revenue');
  });

  it('states the steady threshold on the card', () => {
    expect(render('en', DATA)).toContain('less than 5%');
    expect(render('vi', DATA)).toContain('dưới 5%');
  });
});
