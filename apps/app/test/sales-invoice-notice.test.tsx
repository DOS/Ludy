// SPDX-License-Identifier: AGPL-3.0-only
// The panel for an error in non-core content (#2504), rendered on the server with the notice list seeded in the cache: the person records the right text, reads the notice the code built (to the
// buyer, by name and invoice), and sees the two steps (tell the buyer, form 04/SS-HĐĐT) as to do until ticked. Nothing says Ludy sent anything, and no screen offers a cancel.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EInvoiceDraftSummary, EInvoiceNoticeList } from '@ludy/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: cache.current, errorMessage: (e: unknown) => String(e), uploadAgreement: async () => 'f' };
});
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => <a>{children as never}</a>, useParams: () => ({ slug: 'acme' }) }));

const { NoticeAction } = await import('../src/routes/sales-invoices.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const DRAFT = '00000000-0000-4000-8000-0000000000a1';
const draft: EInvoiceDraftSummary = {
  id: DRAFT,
  state: 'issued',
  date: '2026-11-17',
  buyerName: 'Công ty Mua Thử',
  buyerIdentity: null,
  total: '110000',
  issueCount: 0,
  issuedNumber: '0000007',
  errorCode: null,
  evidenceStored: true,
  updatedAt: '2026-11-17T10:00:00.000Z',
  buyerKind: 'business',
  buyerHasTaxCode: true,
  correction: null,
  correctedBy: null,
  replaced: false,
};
const list = (over: Partial<EInvoiceNoticeList['notices'][number]> = {}, refOver: Partial<EInvoiceNoticeList['reference']> = {}): EInvoiceNoticeList => ({
  reference: { number: '0000007', templateNo: '1', symbol: 'C26TAA', date: '2026-11-17', buyerName: 'Công ty Mua Thử', buyerEmail: 'ketoan@muathu.example', ...refOver },
  notices: [
    {
      id: '00000000-0000-4000-8000-0000000000b1',
      draftId: DRAFT,
      field: 'buyer_address',
      correctText: '12 Lê Lợi, Quận 1',
      buyerNoticeState: 'todo',
      buyerNotifiedAt: null,
      buyerNoticeMailId: null,
      buyerNoticeMailStatus: null,
      buyerNoticeMailErrorCode: null,
      formState: 'todo',
      formFiledAt: null,
      createdAt: '2026-11-17T10:05:00.000Z',
      reviewHash: 'a'.repeat(64),
      ...over,
    },
  ],
});

function render(node: React.ReactNode, data: EInvoiceNoticeList | null, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  cache.current.clear();
  if (data) cache.current.setQueryData(['einvoice', 'drafts', 'noticeList', { draftId: DRAFT }], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the notice panel of an issued invoice', () => {
  it('starts closed with one button', () => {
    const html = render(<NoticeAction draft={draft} />, null);
    expect(html).toContain('data-testid="invoice-notice-open"');
    expect(html).not.toContain('invoice-notice-panel');
  });

  it('shows the recorded error, the notice text by code, the buyer email and both steps to do', () => {
    const html = render(<NoticeAction draft={draft} openWith />, list());
    expect(html).toContain('invoice-notice-panel');
    expect(html).toContain('12 Lê Lợi, Quận 1');
    expect(html).toContain('data-testid="invoice-notice-text"');
    expect(html).toContain('Công ty Mua Thử');
    expect(html).toContain('0000007');
    expect(html).toContain('ketoan@muathu.example');
    expect(html).toContain('invoice-notice-step-buyer');
    expect(html).toContain('invoice-notice-step-form');
    expect(html).not.toMatch(/Hủy|Cancel/);
  });

  it('shows ticked steps as done, without a button', () => {
    const html = render(<NoticeAction draft={draft} openWith />, list({ buyerNoticeState: 'sent', buyerNotifiedAt: '2026-11-17T11:00:00.000Z', formState: 'filed', formFiledAt: '2026-11-17T12:00:00.000Z' }));
    const step = (id: string) => {
      const part = html.split(`data-testid="${id}"`)[1]?.split('</li>')[0];
      expect(part, `${id} is rendered`).toBeDefined();
      return part as string;
    };
    expect(step('invoice-notice-step-buyer')).toContain('Đã gửi thông báo cho người mua');
    expect(step('invoice-notice-step-buyer')).not.toContain('<button');
    expect(step('invoice-notice-step-form')).toContain('04/SS');
    expect(step('invoice-notice-step-form')).not.toContain('<button');
  });

  it('hints at 04/SS-HĐĐT in the words of Circular 91: promptly, before the VAT return, never with a correction, and no day count (#3709)', () => {
    const vi = render(<NoticeAction draft={draft} openWith />, list());
    expect(vi).toContain('trước khi nộp tờ khai GTGT của kỳ này');
    expect(vi).toContain('không nộp kèm hóa đơn điều chỉnh hay thay thế');
    expect(vi).toContain('không thuộc nội dung chính');
    expect(vi).not.toContain('chưa xác nhận');
    const en = render(<NoticeAction draft={draft} openWith />, list(), 'en');
    expect(en).toContain('before the VAT return of this period');
    expect(en).toContain('never together with an adjusting or replacing invoice');
    // The hint gives no number of days.
    for (const html of [vi, en]) expect(html.split('data-testid="invoice-notice"')[1] ?? html).not.toMatch(/\b\d+\s*(ngày|days?)\b/);
  });

  it('reads in English too', () => {
    const html = render(<NoticeAction draft={draft} openWith />, list(), 'en');
    expect(html).toContain('Any other mistake needs an adjustment or a replacement');
    expect(html).toContain('File form 04/SS-HĐĐT');
    expect(html).not.toContain('Sai sót khác phải điều chỉnh');
  });

  it('shows send-email action only with a buyer email, shows queue/failure statuses for retry, and hides retry once delivered', () => {
    const withEmail = render(<NoticeAction draft={draft} openWith />, list());
    expect(withEmail).toContain('data-testid="invoice-notice-send-open"');
    expect(withEmail).toContain('Gửi email cho người mua');
    expect(withEmail).not.toMatch(/Hủy|Cancel/);

    const noEmail = render(<NoticeAction draft={draft} openWith />, list({}, { buyerEmail: null }));
    expect(noEmail).not.toContain('data-testid="invoice-notice-send-open"');
    expect(noEmail).toContain('hãy gửi bằng cách khác');

    const queued = render(<NoticeAction draft={draft} openWith />, list({ buyerNoticeMailId: '00000000-0000-4000-8000-0000000000c1', buyerNoticeMailStatus: 'queued' }));
    expect(queued).not.toContain('data-testid="invoice-notice-send-open"');
    expect(queued).toContain('data-testid="invoice-notice-mail-status"');
    expect(queued).toContain('hàng đợi');

    const failed = render(<NoticeAction draft={draft} openWith />, list({ buyerNoticeMailId: '00000000-0000-4000-8000-0000000000c2', buyerNoticeMailStatus: 'failed' }));
    expect(failed).toContain('data-testid="invoice-notice-mail-status"');
    expect(failed).toContain('data-testid="invoice-notice-send-open"');
    expect(failed).toContain('Gửi lại email cho người mua');

    const sentViaMail = render(
      <NoticeAction draft={draft} openWith />,
      list({ buyerNoticeState: 'sent', buyerNotifiedAt: '2026-11-17T11:00:00.000Z', buyerNoticeMailId: '00000000-0000-4000-8000-0000000000c3', buyerNoticeMailStatus: 'sent' }),
    );
    expect(sentViaMail).toContain('data-testid="invoice-notice-mail-status"');
    expect(sentViaMail).not.toContain('data-testid="invoice-notice-send-open"');
    for (const html of [withEmail, noEmail, queued, failed, sentViaMail]) {
      expect(html).not.toMatch(/Hủy|Cancel/);
      expect(html.split('data-testid="invoice-notice"')[1] ?? html).not.toMatch(/\b\d+\s*(ngày|days?)\b/);
    }
  });
});
