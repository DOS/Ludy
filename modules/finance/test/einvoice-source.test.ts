// SPDX-License-Identifier: AGPL-3.0-only
// The previous invoice written as text for the finance coworker (#2721): its lines, in a form the figure checks of packages/agent read, with a VAT rate only when the new invoice's date allows it.
import { describe, expect, it } from 'vitest';
import { SOURCE_LINES_MAX, invoiceSourceText, type SourceLine } from '../src/domain/einvoice-source.ts';

const line = (patch: Partial<SourceLine> = {}): SourceLine => ({ description: 'Bánh A', unit: 'hộp', quantity: '10', unitPrice: '120000', vatRate: '10%', ...patch });
const ALLOWED = ['0%', '5%', '10%', 'KCT', 'KKKNT'];

describe('invoiceSourceText', () => {
  it('writes each line with its unit, quantity, price and a rate the date allows, and no number, date or buyer', () => {
    expect(invoiceSourceText([line(), line({ description: 'Trà  B\n', unit: null, quantity: '2.5', unitPrice: '1200000', vatRate: '5%' })], ALLOWED)).toBe(
      'Hóa đơn trước gửi cùng khách:\n- Bánh A, đơn vị hộp, số lượng 10, đơn giá 120000, VAT 10%\n- Trà B, số lượng 2.5, đơn giá 1200000, VAT 5%',
    );
  });

  it('leaves out a rate the date does not allow, so the text does not state it', () => {
    const text = invoiceSourceText([line({ vatRate: '8%' })], ALLOWED);
    expect(text).toContain('đơn giá 120000');
    expect(text).not.toContain('VAT');
  });

  it('is empty for no lines and takes at most the lines the model can read', () => {
    expect(invoiceSourceText([], ALLOWED)).toBe('');
    const many = Array.from({ length: SOURCE_LINES_MAX + 5 }, (_, i) => line({ description: `Hàng ${i + 1}` }));
    expect(invoiceSourceText(many, ALLOWED).split('\n').length).toBe(SOURCE_LINES_MAX + 1);
  });
});
