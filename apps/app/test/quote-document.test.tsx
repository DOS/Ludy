// SPDX-License-Identifier: AGPL-3.0-only
// A sent quote's public page (#2694): rendered on the server from a seeded cache in Vietnamese and English, it shows the seller's letterhead, the buyer as they were, the
// lines and the totals as the server sent them (decimal strings, never recomputed), the notes and terms as plain text, the bank note only when set, and one refusal for a
// link that does not open.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuoteDocument } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  return { errorMessage: (e: unknown) => String(e), queryClient: client.current };
});

// The tab title the page asks for, kept so a test can read it (the effect that sets document.title does not run in a server render).
const titles = vi.hoisted(() => [] as (string | null | undefined)[]);
vi.mock('../src/lib/screen-title.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useScreenTitle: (name: string | null | undefined) => void titles.push(name),
}));

const { QuoteDocumentPage } = await import('../src/routes/quote-document.tsx');

// A text as React writes it into markup: every character with a meaning in HTML escaped, the ampersand first.
const htmlEscaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

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
  hasLogo: false,
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
    expect(html).toContain('Điện thoại:');
    expect(html).toContain('028 3829 1234');
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

  it('makes the seller\'s phone and email links that dial and write (#3644), and leaves text that is neither as text', () => {
    const html = render('vi', doc());
    expect(html).toContain('href="tel:02838291234"');
    expect(html).toContain('href="mailto:ban-hang@hoamai.test"');
    const odd = render('vi', doc({ seller: { ...doc().seller, phone: 'gọi cửa hàng', email: 'ban hang?cc=x' } }));
    expect(odd).not.toContain('tel:');
    expect(odd).not.toContain('mailto:');
    expect(odd).toContain('gọi cửa hàng');
  });

  it('links only a phone that is wholly a number, and only an email with nothing a mail client would read as more (#3644)', () => {
    const seller = (phone: string, email: string) => render('vi', doc({ seller: { ...doc().seller, phone, email } }));
    // "ext 12" must not become one long number.
    const ext = seller('028 3829 1234 ext 12', 'ban-hang@hoamai.test');
    expect(ext).not.toContain('tel:');
    expect(ext).toContain('028 3829 1234 ext 12');
    expect(seller('1900 1234 (8h-17h)', 'a@b.test')).not.toContain('tel:');
    expect(seller('(028) 3829-1234', 'a@b.test')).toContain('href="tel:02838291234"');
    expect(seller('+84 912 345 678', 'a@b.test')).toContain('href="tel:+84912345678"');
    // An address with a query or fragment of its own is shown, never linked.
    for (const email of ['info?bcc=evil@x.test', 'sales#vn@example.com', 'a%40b@c.test', 'a/b@c.test']) {
      const html = seller('028 3829 1234', email);
      expect(html).not.toContain('mailto:');
      expect(html).toContain(htmlEscaped(email));
    }
  });

  it('tells a customer how to answer: the seller\'s phone, Zalo for a mobile number, and email (#3644)', () => {
    const html = render('vi', doc({ seller: { ...doc().seller, phone: '0912 345 678' } }));
    const answer = html.slice(html.indexOf('data-testid="quote-answer"'));
    expect(answer).toContain('Trả lời báo giá này');
    expect(answer).toContain('Công ty TNHH Hoa Mai');
    expect(answer).toContain('href="tel:0912345678"');
    expect(answer).toContain('>Gọi 0912 345 678<');
    expect(answer).toContain('href="https://zalo.me/0912345678"');
    expect(answer).toContain('rel="noopener noreferrer"');
    expect(answer).toContain('href="mailto:ban-hang@hoamai.test?subject=B%C3%A1o%20gi%C3%A1%20BG-2026-0007"');
    // A landline can be dialed but has no Zalo; an expired quote says to ask for a new one; an answered one has no block.
    const landline = render('vi', doc());
    expect(landline).toContain('href="tel:02838291234"');
    expect(landline).not.toContain('zalo.me');
    expect(render('vi', doc({ expired: true }))).toContain('Báo giá này đã hết hạn. Hãy liên hệ Công ty TNHH Hoa Mai để nhận báo giá mới.');
    expect(render('vi', doc({ status: 'accepted' }))).not.toContain('data-testid="quote-answer"');
    expect(render('vi', doc({ seller: { ...doc().seller, phone: null, email: null } }))).not.toContain('data-testid="quote-answer"');
    // Not on paper.
    expect(html.slice(html.lastIndexOf('<section', html.indexOf('data-testid="quote-answer"')), html.indexOf('data-testid="quote-answer"'))).toContain('print:hidden');
  });

  it('stacks each line as a card below the sm breakpoint and keeps the table from sm up and in print (#3644)', () => {
    const html = render('vi', doc());
    // The table: hidden on a phone, shown from sm and in print, ahead of the cards in the page.
    const table = html.indexOf('<table');
    const cards = html.indexOf('data-testid="quote-line-cards"');
    expect(table).toBeGreaterThan(-1);
    expect(cards).toBeGreaterThan(table);
    expect(html.slice(html.lastIndexOf('<div', table), table)).toContain('class="hidden overflow-x-auto sm:block print:block"');
    expect(html.slice(html.lastIndexOf('<ol', cards), cards + 40)).toContain('sm:hidden print:hidden');
    // A card: the name with its number, the amount, and "quantity unit x price".
    const card = html.slice(html.indexOf('data-testid="quote-line-card"'));
    expect(card).toContain('Gói kế toán năm');
    expect(card).toMatch(/3[.,]000[.,]000/);
    expect(card).toMatch(/2 gói × 1[.,]500[.,]000/);
    expect(card).toContain('Thuế 10%');
    // A text line is a note in the cards, not a card with an amount.
    expect(html.match(/data-testid="quote-line-card"/g)).toHaveLength(1);
    expect(html.slice(cards)).toContain('Giá chưa gồm phí đi lại');
  });

  it('shows the discount and tax columns only when a line has one (#3644)', () => {
    const plainLine = { ...doc().lines[0]!, discountPercent: '0', vatRate: null };
    // The server sends the percent as numeric text: "0.00" is no discount either.
    const zeroes = render('vi', doc({ lines: [{ ...plainLine, discountPercent: '0.00' }] }));
    expect(zeroes).not.toContain('>Giảm<');
    expect(zeroes).not.toContain('Giảm 0');
    const bare = render('vi', doc({ lines: [plainLine] }));
    expect(bare).not.toContain('>Giảm<');
    expect(bare).not.toContain('>Thuế<');
    expect(bare).not.toContain('Thuế 10%');
    const taxed = render('vi', doc());
    expect(taxed).toContain('>Thuế<');
    expect(taxed).not.toContain('>Giảm<');
    const discounted = render('vi', doc({ lines: [{ ...plainLine, discountPercent: '5' }] }));
    expect(discounted).toContain('>Giảm<');
    expect(discounted).toContain('Giảm 5%');
    // A text line spans the columns that are there: 6 here (no, description, quantity, unit, price, amount), 8 with both.
    expect(render('vi', doc({ lines: [plainLine, doc().lines[1]!] }))).toContain('colSpan="5"');
    expect(render('vi', doc({ lines: [{ ...plainLine, discountPercent: '5', vatRate: '10%' }, doc().lines[1]!] }))).toContain('colSpan="7"');
  });

  it('puts the seller\'s letterhead first and the app\'s mark in a small footer, and names the tab (#3644)', () => {
    titles.length = 0;
    const html = render('vi', doc());
    expect(html.indexOf('Công ty TNHH Hoa Mai')).toBeLessThan(html.indexOf('<footer'));
    expect(html.indexOf('<footer')).toBeGreaterThan(html.indexOf('</article>'));
    expect(html).toContain('<footer class="flex justify-center pt-2 text-xs text-subtle-foreground print:hidden">');
    expect(titles).toContain('Báo giá BG-2026-0007');
    titles.length = 0;
    render('vi', null);
    expect(titles).toEqual(['Báo giá']);
  });

  it('does not wait for the logo (#2814): with one on the letterhead the page still shows the quote, and an image only once it has been fetched', () => {
    // The logo is asked for apart, in the browser, by the same token: the server render has none yet, so there is no image and nothing of the quote is missing.
    const html = render('vi', doc({ hasLogo: true }));
    expect(html).not.toContain('data-testid="quote-logo"');
    expect(html).not.toContain('<img');
    expect(html).toContain('Công ty TNHH Hoa Mai');
    expect(html).toContain('Gói kế toán năm');
    expect(render('vi', doc({ hasLogo: false }))).not.toContain('data-testid="quote-logo"');
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

  it('shows the day the quote was sent in Vietnam time, as the PDF does (#2827)', () => {
    // 18:30 UTC on 8 November is 01:30 on 9 November in Vietnam.
    expect(render('vi', doc({ sentAt: '2026-11-08T18:30:00.000Z' }))).toContain('Ngày gửi: 09/11/2026');
    expect(render('vi', doc({ sentAt: '2026-11-08T03:00:00.000Z' }))).toContain('Ngày gửi: 08/11/2026');
  });

  it('shows the one refusal for a link that does not open', () => {
    expect(render('vi', null)).toContain(catalog('vi').quoteDocument.invalid);
    expect(render('en', null)).toContain(catalog('en').quoteDocument.invalid);
    // ...with what to do next, in the same frame (#3644).
    const invalid = render('vi', null);
    expect(invalid).toContain('Hãy nhờ người gửi cho bạn liên kết mới.');
    expect(invalid.slice(invalid.indexOf('data-testid="quote-invalid"'))).toContain(catalog('vi').quoteDocument.invalidNext);
    expect(render('en', null)).toContain(catalog('en').quoteDocument.invalidNext);
  });

  it('speaks English too', () => {
    const html = render('en', doc());
    expect(html).toContain('No. BG-2026-0007');
    expect(html).toContain('Total');
    expect(html).toContain('Print or save as PDF');
  });
});
