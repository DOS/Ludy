// SPDX-License-Identifier: AGPL-3.0-only
// Amounts on the VAT screen (DESIGN.md §4.3, #2001): a money column is right-aligned with tabular figures, its header
// included, so the digits of a column line up under it.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));

const { InvoiceTable, LateSales, ResultStrip, SupplementaryItems } = await import('../src/routes/vat.tsx');

const invoice = {
  id: '0192f0aa-1111-7222-8333-944445555666',
  issueDate: '2026-10-05',
  series: 'C26TAA',
  number: '123',
  partyName: 'Công ty An Phát',
  partyTaxCode: '0101234564',
  rates: [{ rate: '10' as const, taxable: '12500000', vat: '1250000' }],
  warnings: [],
};

describe('VAT invoice table', () => {
  it('right-aligns the taxable and VAT columns, header and cells, with tabular figures', () => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="vi" messages={catalog('vi')}>
        <InvoiceTable invoices={[invoice]} partyLabel="Người bán" />
      </IntlProvider>,
    );
    const heads = [...html.matchAll(/<th[^>]*class="([^"]*)"[^>]*>([^<]*)<\/th>/g)].map((m) => ({ cls: m[1] ?? '', text: m[2] ?? '' }));
    const cells = [...html.matchAll(/<td[^>]*class="([^"]*)"[^>]*>/g)].map((m) => m[1] ?? '');
    expect(heads).toHaveLength(7);
    expect(cells).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      const money = i === 4 || i === 5;
      expect(heads[i]?.cls.includes('text-right'), `header ${heads[i]?.text}`).toBe(money);
      expect(cells[i]?.includes('text-right'), `cell ${i}`).toBe(money);
      if (money) expect(cells[i]).toContain('tabular-nums');
    }
  });
});

// #3535: a sale invoiced after its period is declared in the period of the sale; when that period is locked or filed it is a supplementary item.
const lateInvoice = {
  ...invoice,
  id: '0192f0aa-1111-7222-8333-944445555777',
  issueDate: '2026-11-03',
  postingDate: '2026-11-03',
  saleDate: '2026-10-28',
  number: '124',
  subtotal: '12500000',
  vatAmount: '1250000',
  total: '13750000',
  warnings: ['late_sale' as const],
  correction: null,
};
const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      {node}
    </IntlProvider>,
  );

describe('late sales on the VAT screen', () => {
  it('shows the sale date under the issue date and the late-sale note on the invoice', () => {
    const html = render(<InvoiceTable invoices={[lateInvoice]} partyLabel="Người mua" />);
    expect(html).toContain('bán ngày');
    expect(html).toContain('28/10/2026');
    expect(html).toContain('Hóa đơn lập sau kỳ của ngày bán');
  });

  it('lists the supplementary items of a declared period with the VAT to declare, and nothing when there are none', () => {
    const data = { supplementary: { documents: [lateInvoice], totals: { byRate: [], taxable: '12500000', vat: '1250000', documents: 1 } } };
    const html = render(<SupplementaryItems data={data} />);
    expect(html).toContain('data-testid="vat-supplementary"');
    expect(html).toContain('Cần kê khai bổ sung (1)');
    expect(html).toContain('123');
    expect(render(<SupplementaryItems data={{ supplementary: { documents: [], totals: { byRate: [], taxable: '0', vat: '0', documents: 0 } } }} />)).toBe('');
  });

  it('names each late invoice of this period with its original period and whether it needs a supplementary return', () => {
    const sale = { documentId: lateInvoice.id, series: 'C26TAA', number: '124', partyName: 'Công ty An Phát', issueDate: '2026-11-03', saleDate: '2026-10-28', originalPeriod: '2026-10', total: '13750000', vatAmount: '1250000', supplementary: true };
    const html = render(<LateSales data={{ lateSales: [sale, { ...sale, documentId: 'x', number: '125', supplementary: false }] }} />);
    expect(html).toContain('2026-10');
    expect(html).toContain('Cần kê khai bổ sung');
    expect(html).toContain('Đã tính vào kỳ đó');
    expect(render(<LateSales data={{ lateSales: [] }} />)).toBe('');
    expect(render(<LateSales data={{ lateSales: [sale] }} />, 'en')).toContain('Supplementary return needed');
  });
});

// #3600: the result strip above the table.
describe('VAT result strip', () => {
  const data = {
    period: { period: '2026-10', kind: 'month' as const, from: '2026-10-01', to: '2026-10-31' },
    indicators: [
      { code: '24', label: 'x', amount: '710000' },
      { code: '35', label: 'x', amount: '0' },
    ],
    filed: null,
    paymentChecks: { suggested25: '710000' } as never,
  };
  it('shows input and output VAT, the deadline, the status and the action, and the result carried forward', () => {
    const html = render(<ResultStrip data={data} carried="0" fileDeduct25="710000" action={<button>Xuất XML cho HTKK</button>} />);
    expect(html).toMatch(/710[.,]000/);
    expect(html).toContain('20/11/2026');
    expect(html).toContain('Chưa nộp');
    expect(html).toContain('Xuất XML cho HTKK');
    expect(html).toContain('data-kind="carried"');
    expect(html).toContain('[36] đến [43]');
  });
  it('uses the filed return\'s own [22] and [25], and says when the XML file writes another [25]', () => {
    const filed = { markedAt: '2026-11-18T03:00:00.000Z', carriedIn: '0', deductible: '0', carriedOut: '710000', source: 'marked' } as never;
    expect(render(<ResultStrip data={{ ...data, filed }} carried="5" fileDeduct25="0" action={null} />)).toContain('data-kind="carried"');
    const open = render(<ResultStrip data={data} carried="0" fileDeduct25="0" action={null} />);
    expect(open).toContain('File XML đang ghi [25]');
    expect(render(<ResultStrip data={data} carried={null} fileDeduct25="710000" action={null} />)).toContain('data-kind="unknown"');
  });
  it('says in English that it is an estimate and shows the filed date', () => {
    const filed = { markedAt: '2026-11-18T03:00:00.000Z', carriedIn: '0', deductible: '0', carriedOut: '0', source: 'marked' } as never;
    const html = render(<ResultStrip data={{ ...data, filed }} carried="0" fileDeduct25="710000" action={null} />, 'en');
    expect(html).toContain('Filed on');
    expect(html).toContain('estimate');
  });
});

// #916: a replacement or an adjustment invoice says what it corrects, and an adjustment says which date its period follows.
describe('VAT correction note (#916)', () => {
  const adjusting = { ...invoice, id: '0192f0aa-1111-7222-8333-944445555888', number: '130', postingDate: '2026-10-05', correction: { kind: 'adjustment' as const, series: 'C26TAA', number: '100', basis: 'issue_date' as const } };

  it('says an adjustment counts in the period of the adjustment invoice date, and which invoice it adjusts', () => {
    const html = render(<InvoiceTable invoices={[adjusting]} partyLabel="Người bán" />);
    expect(html).toContain('data-testid="vat-correction-note"');
    expect(html).toContain('Điều chỉnh hóa đơn C26TAA-100');
    expect(html).toContain('theo kỳ lập hóa đơn điều chỉnh');
    expect(html).not.toContain('theo ngày ghi sổ');
  });

  it('says a purchase adjustment counts by its posting date, with that date (as every purchase does)', () => {
    const html = render(<InvoiceTable invoices={[{ ...adjusting, postingDate: '2026-11-04', correction: { ...adjusting.correction, basis: 'posting_date' as const } }]} partyLabel="Người mua" />);
    expect(html).toContain('theo ngày ghi sổ 04/11/2026');
    expect(html).not.toContain('theo kỳ lập hóa đơn điều chỉnh');
  });

  it('names the invoice a replacement replaces, with no period note, and shows nothing on an ordinary invoice', () => {
    const replacing = { ...invoice, correction: { kind: 'replacement' as const, series: 'C26TAA', number: '99', basis: 'issue_date' as const } };
    const html = render(<InvoiceTable invoices={[replacing]} partyLabel="Người bán" />);
    expect(html).toContain('Thay thế hóa đơn C26TAA-99');
    expect(html).not.toContain('theo kỳ');
    expect(render(<InvoiceTable invoices={[invoice]} partyLabel="Người bán" />)).not.toContain('vat-correction-note');
  });

  it('reads in English', () => {
    const html = render(<InvoiceTable invoices={[adjusting]} partyLabel="Seller" />, 'en');
    expect(html).toContain('Adjusts invoice C26TAA-100');
    expect(html).toContain('by the period of the adjustment invoice date');
  });
});
