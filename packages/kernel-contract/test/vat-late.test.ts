// SPDX-License-Identifier: AGPL-3.0-only
// The late sales of a VAT working as facts and as the template sentence (#3540): built from the working's own lists, no model, so it says the same facts with AI off.
import { describe, expect, it } from 'vitest';
import { VAT_LATE_NAMED_MAX, vatLateFacts, vatLateTemplate, zVatLateExplainAsk, type VatLateSource } from '../src/index.ts';

const REPORT: VatLateSource = {
  period: { period: '2026-10' },
  lateSales: [
    { series: 'C26TAA', number: '0000123', originalPeriod: '2026-09', supplementary: true },
    { series: '', number: '77', originalPeriod: '2026-Q3', supplementary: false },
  ],
  supplementary: { documents: [{ series: 'C26TAA', number: '0000140' }] },
};

describe('vatLateFacts', () => {
  it('lists the sales issued here for an earlier period, then this period\'s sales issued after it closed, written as the screen writes them', () => {
    expect(vatLateFacts(REPORT)).toEqual([
      { number: 'C26TAA-0000123', period: '2026-09', supplementary: true, issuedHere: true },
      { number: '77', period: '2026-Q3', supplementary: false, issuedHere: true },
      { number: 'C26TAA-0000140', period: '2026-10', supplementary: true, issuedHere: false },
    ]);
  });
  it('is empty when nothing is late', () => {
    expect(vatLateFacts({ period: { period: '2026-10' }, lateSales: [], supplementary: { documents: [] } })).toEqual([]);
  });
});

describe('vatLateTemplate', () => {
  it('names each late invoice with its original period and which need a supplementary declaration, in Vietnamese', () => {
    const text = vatLateTemplate(vatLateFacts(REPORT), 'vi');
    expect(text).toContain('Kỳ này có 2 hóa đơn bán ra lập muộn cho hàng bán ở kỳ trước: C26TAA-0000123 (kỳ 2026-09, cần kê khai bổ sung), 77 (kỳ 2026-Q3, đã tính vào kỳ đó).');
    expect(text).toContain('1 hóa đơn bán ra của kỳ này được ghi nhận sau khi kỳ đã khóa hoặc đã nộp tờ khai, cần kê khai bổ sung: C26TAA-0000140.');
  });
  it('says the same in English', () => {
    const text = vatLateTemplate(vatLateFacts(REPORT), 'en');
    expect(text).toContain('This period has 2 sales invoices issued late for sales of an earlier period: C26TAA-0000123 (period 2026-09, needs a supplementary declaration), 77 (period 2026-Q3, counted in that period).');
    expect(text).toContain('1 sales invoice of this period was recorded after the period was locked');
  });
  it('is null with nothing late and counts the invoices beyond the named maximum', () => {
    expect(vatLateTemplate([], 'vi')).toBeNull();
    const many = Array.from({ length: VAT_LATE_NAMED_MAX + 3 }, (_, i) => ({ number: `A-${i}`, period: '2026-09', supplementary: false, issuedHere: true }));
    const text = vatLateTemplate(many, 'vi') ?? '';
    expect(text).toContain(`A-${VAT_LATE_NAMED_MAX - 1}`);
    expect(text).not.toContain(`A-${VAT_LATE_NAMED_MAX},`);
    expect(text).toContain('và 3 hóa đơn khác');
  });
});

describe('zVatLateExplainAsk', () => {
  it('takes a month or quarter, an optional entity and language, and nothing else', () => {
    expect(zVatLateExplainAsk.safeParse({ period: '2026-09', lang: 'en' }).success).toBe(true);
    expect(zVatLateExplainAsk.safeParse({ period: '2026-Q3' }).success).toBe(true);
    expect(zVatLateExplainAsk.safeParse({ period: '2026-13' }).success).toBe(false);
  });
});
