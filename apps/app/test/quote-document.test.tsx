// SPDX-License-Identifier: AGPL-3.0-only
// A sent quote's public page (#2694): rendered on the server from a seeded cache in Vietnamese and English, it shows the seller's letterhead, the buyer as they were, the
// lines and the totals as the server sent them (decimal strings, never recomputed), the notes and terms as plain text, the bank note only when set, and one refusal for a
// link that does not open.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuoteDocument } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  return { errorMessage: (e: unknown) => String(e), queryClient: client.current };
});

const { QuoteDocumentPage } = await import('../src/routes/quote-document.tsx');

const TOKEN = 'q'.repeat(43);
const doc = (over: Partial<QuoteDocument> = {}): QuoteDocument => ({
  number: 'BG-2026-0007',
  revision: 1,
  status: 'sent',
  expired: false,
  validUntil: '2026-12-01',
  sentAt: '2026-11-08T03:00:00.000Z',
  notes: 'Giao trong 3 ngày <b>làm việc</b>',
  terms: 'Thanh toán trong 7 ngày',
  subtotal: '3000000',
  vatAmount: '300000',
  total: '3300000',
  seller: { name: 'Công ty TNHH Hoa Mai', taxCode: '0312345678', address: '12 Lê Lợi, Quận 1', phone: '028 3829 1234', email: 'ban-hang@hoamai.test', bankNote: null },
  buyer: { name: 'Công ty ABC', taxCode: '0109876543', address: '5 Trần Phú, Hà Nội' },
  lines: [
    { lineNo: 1, kind: 'item', description: 'Gói kế toán năm', unit: 'gói', quantity: '2', unitPrice: '1500000', discountPercent: '0', vatRate: '10%', amount: '3000000', vatAmount: '300000' },
    { lineNo: 2, kind: 'text', description: 'Giá chưa gồm phí đi lại', unit: null, quantity: null, unitPrice: null, discountPercent: '0', vatRate: null, amount: '0', vatAmount: '0' },
  ],
  ...over,
});

function render(locale: 'vi' | 'en', data: QuoteDocument | null | undefined): string {
  const qc = client.current;
  qc.clear();
  if (data !== undefined) qc.setQueryData(['quote-document', TOKEN], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <QuoteDocumentPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe("a sent quote's public page (#2694)", () => {
  const saved = (globalThis as { window?: unknown }).window;
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = { location: { hash: `#${TOKEN}` }, localStorage: { getItem: () => null, setItem: () => undefined } };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved;
  });
  beforeEach(() => client.current.clear());

  it('shows the letterhead, the buyer, the lines and the totals in Vietnamese', () => {
    const html = render('vi', doc());
    expect(html).toContain('Công ty TNHH Hoa Mai');
    expect(html).toContain('Mã số thuế: 0312345678');
    expect(html).toContain('Điện thoại: 028 3829 1234');
    expect(html).toContain('Số BG-2026-0007');
    expect(html).toContain('Công ty ABC');
    expect(html).toContain('Gói kế toán năm');
    expect(html).toContain('Giá chưa gồm phí đi lại');
    // The totals as the server sent them, in the grouping of the reader.
    expect(html).toMatch(/3[.,]300[.,]000/);
    expect(html).toContain('Tổng cộng');
    expect(html).toContain('Thanh toán trong 7 ngày');
    // No bank note was set, so none is printed.
    expect(html).not.toContain('Thanh toán</h3>');
  });

  it('shows the notes as text, never as markup', () => {
    const html = render('vi', doc());
    expect(html).not.toContain('<b>làm việc</b>');
    expect(html).toContain('&lt;b&gt;làm việc&lt;/b&gt;');
  });

  it('names a revision, an expired quote and the bank note when there is one', () => {
    const html = render('vi', doc({ revision: 2, expired: true, seller: { ...doc().seller, bankNote: 'Vietcombank 0071000123456' } }));
    expect(html).toContain('BG-2026-0007-R2');
    expect(html).toContain('Đã hết hạn từ');
    expect(html).toContain('Vietcombank 0071000123456');
  });

  it('shows the one refusal for a link that does not open', () => {
    expect(render('vi', null)).toContain(catalog('vi').quoteDocument.invalid);
    expect(render('en', null)).toContain(catalog('en').quoteDocument.invalid);
  });

  it('speaks English too', () => {
    const html = render('en', doc());
    expect(html).toContain('No. BG-2026-0007');
    expect(html).toContain('Total');
    expect(html).toContain('Print or save as PDF');
  });
});
