// SPDX-License-Identifier: AGPL-3.0-only
// The screens of an adjusting or a replacing invoice (#2504), rendered on the server with the reason codes seeded in the cache: an issued invoice offers "Điều chỉnh" and "Thay thế", only the
// method of an earlier correction is offered again, an invoice that was replaced and an adjusting invoice offer none, there is no cancel button anywhere, and the form of a correction says which
// invoice it corrects, how and why.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EInvoiceCorrection, EInvoiceDraftSummary } from '@crove/kernel-contract';

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

const { CorrectionAction, CorrectionBanner } = await import('../src/routes/sales-invoices.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const ORIGINAL = '00000000-0000-4000-8000-0000000000a1';
const summary = (over: Partial<EInvoiceDraftSummary> = {}): EInvoiceDraftSummary => ({
  id: ORIGINAL,
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
  correction: null,
  correctedBy: null,
  replaced: false,
  ...over,
});

function render(node: React.ReactNode, locale: 'vi' | 'en' = 'vi', reasons: Array<{ code: string; label: string }> = [{ code: '1', label: 'Sai thông tin người mua' }]): string {
  setActiveLocale(locale);
  cache.current.setQueryData(['einvoice', 'drafts', 'correctionOptions', {}], { reasonCodes: reasons });
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the correction buttons of an issued invoice', () => {
  it('offers both methods on an invoice nobody has corrected, and never a cancel', () => {
    const html = render(<CorrectionAction draft={summary()} onStarted={() => undefined} />);
    expect(html).toContain('data-testid="invoice-correct-adjustment"');
    expect(html).toContain('data-testid="invoice-correct-replacement"');
    expect(html).toContain('Điều chỉnh');
    expect(html).toContain('Thay thế');
    expect(html).not.toMatch(/Hủy|Cancel/);
  });

  it('keeps the method of the first correction: adjust stays adjust, replace stays replace', () => {
    const adjusted = render(<CorrectionAction draft={summary({ correctedBy: 'adjustment' })} onStarted={() => undefined} />);
    expect(adjusted).toContain('invoice-correct-adjustment');
    expect(adjusted).not.toContain('invoice-correct-replacement');
    const replacing = render(<CorrectionAction draft={summary({ correctedBy: 'replacement' })} onStarted={() => undefined} />);
    expect(replacing).toContain('invoice-correct-replacement');
    expect(replacing).not.toContain('invoice-correct-adjustment');
  });

  it('offers nothing on an invoice that was replaced, nor on an adjusting invoice', () => {
    expect(render(<CorrectionAction draft={summary({ replaced: true })} onStarted={() => undefined} />)).not.toContain('invoice-correction');
    expect(render(<CorrectionAction draft={summary({ correction: { kind: 'adjustment', originalDraftId: ORIGINAL } })} onStarted={() => undefined} />)).not.toContain('invoice-correction');
  });

  it('is in English too', () => {
    const html = render(<CorrectionAction draft={summary()} onStarted={() => undefined} />, 'en');
    expect(html).toContain('Adjust');
    expect(html).toContain('Replace');
  });
});

describe('the panel that starts a correction', () => {
  it('asks a business buyer for the signed agreement and an individual for none, and names the method kept', () => {
    const business = render(<CorrectionAction draft={summary({ correctedBy: 'adjustment' })} onStarted={() => undefined} openWith="adjustment" />);
    expect(business).toContain('Điều chỉnh hóa đơn số 0000007');
    expect(business).toContain('type="file"');
    expect(business).toContain('biên bản thỏa thuận đã ký của hai bên');
    expect(business).toContain('Các lần sửa trước hóa đơn này đã dùng cách điều chỉnh');
    expect(business).toContain('Sai thông tin người mua');
    expect(business).toContain('Hóa đơn đã phát hành không hủy được');
    const individual = render(<CorrectionAction draft={summary({ buyerKind: 'individual' })} onStarted={() => undefined} openWith="replacement" />);
    expect(individual).toContain('Thay thế hóa đơn số 0000007');
    expect(individual).not.toContain('type="file"');
    expect(individual).toContain('không cần biên bản thỏa thuận');
  });

  it('asks what the error is before it proposes a rate, and starts nothing until the proposal is confirmed (#3709)', () => {
    const html = render(<CorrectionAction draft={summary()} onStarted={() => undefined} openWith="adjustment" />);
    expect(html).toContain('data-testid="invoice-correction-nature"');
    expect(html).toContain('Chọn loại sai sót');
    for (const text of ['Người mua trả lại hàng', 'Chiết khấu thương mại lập sau', 'Sai số lượng hoặc đơn giá, làm đổi số tiền và tiền thuế']) expect(html).toContain(text);
    // The coworker's proposal of the reason (#3690): the person describes the error, and the button stays off until they do.
    expect(html).toContain('data-testid="invoice-correction-error-note"');
    expect(html).toMatch(/data-testid="invoice-correction-reason-suggest"[^>]*disabled|disabled[^>]*data-testid="invoice-correction-reason-suggest"/);
    expect(html).toContain('Gợi ý lý do');
    expect(html).not.toContain('invoice-correction-reason-why');
    // No nature picked: no proposal, no confirmation, and the start button is disabled.
    expect(html).not.toContain('invoice-correction-rate-proposal');
    expect(html).toMatch(/data-testid="invoice-correction-start"[^>]*disabled|disabled[^>]*data-testid="invoice-correction-start"/);
  });

  it('says why nothing can start while the list of reason codes is empty, and offers no reason to pick', () => {
    const html = render(<CorrectionAction draft={summary()} onStarted={() => undefined} openWith="adjustment" />, 'vi', []);
    expect(html).toContain('data-testid="invoice-correction-no-reasons"');
    expect(html).toContain('Phụ lục XVII');
    expect(html).not.toContain('invoice-correction-reason');
    // Nothing to propose from an empty list: no note and no button either.
    expect(html).not.toContain('invoice-correction-reason-suggest');
    // The start button is there but disabled: no reason, no draft.
    expect(html).toMatch(/data-testid="invoice-correction-start"[^>]*disabled|disabled[^>]*data-testid="invoice-correction-start"/);
  });
});

describe('the panel when the reason codes cannot be loaded', () => {
  it('says what happened and offers a retry, apart from the notice of an empty list', () => {
    setActiveLocale('vi');
    const key = ['einvoice', 'drafts', 'correctionOptions', {}];
    // A query in error is tried again on mount by default, which would hide the error from a render; the screen is looked at as it is once the try has failed.
    cache.current.setDefaultOptions({ queries: { retryOnMount: false } });
    cache.current.removeQueries({ queryKey: key });
    const query = cache.current.getQueryCache().build(cache.current, { queryKey: key });
    query.setState({ ...query.state, status: 'error', fetchStatus: 'idle', error: new Error('boom'), data: undefined, errorUpdateCount: 1 } as never);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={cache.current}>
        <I18nProvider>
          <CorrectionAction draft={summary()} onStarted={() => undefined} openWith="adjustment" />
        </I18nProvider>
      </QueryClientProvider>,
    );
    cache.current.removeQueries({ queryKey: key });
    cache.current.setDefaultOptions({});
    expect(html).toContain('data-testid="invoice-correction-options-error"');
    expect(html).toContain('data-testid="invoice-correction-options-retry"');
    expect(html).toContain('Chưa tải được danh sách mã lý do');
    expect(html).not.toContain('invoice-correction-no-reasons');
  });
});

describe('the form of a correcting invoice', () => {
  const correction = (kind: EInvoiceCorrection['kind']): EInvoiceCorrection => ({ kind, originalDraftId: ORIGINAL, reasonCode: '1', agreementFileId: null, rateBasis: null });

  it('says an adjusting invoice carries the difference with its sign and leaves the original in force', () => {
    const html = render(<CorrectionBanner correction={correction('adjustment')} originalNumber="0000007" />);
    expect(html).toContain('Hóa đơn điều chỉnh cho hóa đơn số 0000007');
    expect(html).toContain('số âm');
    expect(html).toContain('Hóa đơn gốc vẫn còn hiệu lực');
    expect(html).toContain('Lý do: Sai thông tin người mua');
  });

  it('says a replacing invoice takes the place of the original once posted', () => {
    const html = render(<CorrectionBanner correction={correction('replacement')} originalNumber="0000007" />);
    expect(html).toContain('Hóa đơn thay thế cho hóa đơn số 0000007');
    expect(html).toContain('không còn hiệu lực');
  });

  it('says which day the VAT rate of the lines follows, the original\'s unless the person confirmed the correction\'s own (#3709)', () => {
    const original = render(<CorrectionBanner correction={correction('adjustment')} originalNumber="0000007" />);
    expect(original).toContain('Thuế suất các dòng tính theo ngày hóa đơn gốc.');
    const own = render(<CorrectionBanner correction={{ ...correction('adjustment'), rateBasis: 'correction_date' }} originalNumber="0000007" />);
    expect(own).toContain('Thuế suất các dòng tính theo ngày lập hóa đơn điều chỉnh này.');
    expect(render(<CorrectionBanner correction={{ ...correction('adjustment'), rateBasis: 'correction_date' }} originalNumber="0000007" />, 'en')).toContain('follow the date of this correcting invoice');
  });

  it('falls back to the code when the list no longer holds it, and speaks English', () => {
    const html = render(<CorrectionBanner correction={correction('replacement')} originalNumber={null} />, 'en', []);
    expect(html).toContain('Replacing invoice for invoice no. -');
    expect(html).toContain('Reason: 1');
  });
});
