// SPDX-License-Identifier: AGPL-3.0-only
// The approved supplier payment an open money-out bank line may be (#3113 S3c, #3700), rendered on the server with the answer of bank.supplierMatch seeded in the cache: a candidate names the supplier,
// the invoice and the amount (never a bank number) and offers one button, a line that equals no payment shows nothing, and rendering makes no call. The press, the confirmation and the request itself
// are covered where the stack allows (the kernel tests of the settlement); the browser run needs an approved and exported payment on real data.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankLine, BankSupplierMatch } from '@ludy/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_t, prop: string) => () => cache.calls.push(prop) }) });
  return { orpc: node([]), client, queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});

const { BankSupplierLine } = await import('../src/components/bank-supplier-line.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const line: BankLine = { id: '00000000-0000-4000-8000-0000000000a1', date: '2026-11-05', description: 'Chuyen khoan NCC', amount: '-110000', balance: null, reference: null, ambiguous: false, importId: '00000000-0000-4000-8000-0000000000b1', state: { status: 'open' } };
const candidate = { paymentId: '00000000-0000-4000-8000-0000000000d1', partyId: '00000000-0000-4000-8000-0000000000e1', partyName: 'Cong ty Anh Duong', invoiceNumber: 'HD-0042', amount: '110000', exportedAt: '2026-11-04T03:00:00.000Z', reason: 'amount_note' as const };
const secondCandidate = { paymentId: '00000000-0000-4000-8000-0000000000d2', partyId: '00000000-0000-4000-8000-0000000000e2', partyName: 'Cong ty Binh Minh', invoiceNumber: 'HD-0088', amount: '110000', exportedAt: '2026-11-04T04:00:00.000Z', reason: 'amount' as const };

function render(match: BankSupplierMatch, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  cache.current.setQueryData(['bank', 'supplierMatch'], match);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <BankSupplierLine slug="acme" line={line} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the supplier payment an open money-out line may be (#3700 S3c)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows the candidate with its supplier, invoice and amount and the one button, and calls nothing', () => {
    const html = render({ bankLineId: line.id, date: line.date, candidates: [candidate], ambiguous: false, matchCount: 1 });
    expect(html).toContain('data-testid="bank-supplier-candidate"');
    expect(html).toContain('Cong ty Anh Duong');
    expect(html).toContain('HD-0042');
    expect(html).toContain('data-testid="bank-supplier-open"');
    expect(html).toContain('max-md:min-h-11');
    // Single match omits the multi-payment ambiguity warning.
    expect(html).not.toContain('bank-supplier-ambiguous');
    expect(html).not.toContain('bank-supplier-candidate-ambiguous');
    // The confirmation and the request come only after the button.
    expect(html).not.toContain('bank-supplier-form');
    expect(html).not.toContain('bank-supplier-asked');
    expect(cache.calls).toEqual([]);
  });

  it('shows an explicit ambiguity warning with icon and reason for multi-payment keyless match in en and vi (#3788)', () => {
    const enHtml = render({ bankLineId: line.id, date: line.date, candidates: [candidate, secondCandidate], ambiguous: true, matchCount: 2 }, 'en');
    expect(enHtml).toContain('data-testid="bank-supplier-ambiguous"');
    expect(enHtml).toContain('role="note"');
    expect(enHtml).toContain('aria-hidden="true"');
    expect(enHtml).toContain('Ambiguous match');
    expect(enHtml).toContain('This bank line carries no beneficiary account number, and 2 approved, exported supplier payments match the exact same amount.');
    expect(enHtml).toContain('Verify before settling');
    expect(enHtml.match(/data-testid="bank-supplier-candidate-ambiguous"/g)).toHaveLength(2);
    expect(enHtml).toContain('Cong ty Anh Duong');
    expect(enHtml).toContain('Cong ty Binh Minh');

    cache.current.clear();
    const viHtml = render({ bankLineId: line.id, date: line.date, candidates: [candidate, secondCandidate], ambiguous: true, matchCount: 2 }, 'vi');
    expect(viHtml).toContain('data-testid="bank-supplier-ambiguous"');
    expect(viHtml).toContain('Khớp mơ hồ');
    expect(viHtml).toContain('Dòng sao kê này không có số tài khoản người nhận, trong khi có 2 khoản chi nhà cung cấp đã duyệt và đã xuất file khớp đúng số tiền này.');
    expect(viHtml).toContain('Cần tự đối chiếu');
    expect(viHtml.match(/data-testid="bank-supplier-candidate-ambiguous"/g)).toHaveLength(2);
  });

  it('omits the multi-payment ambiguity warning when the line carries a beneficiary account number', () => {
    const html = render({ bankLineId: line.id, date: line.date, candidates: [candidate, secondCandidate], ambiguous: false, matchCount: 2 }, 'en');
    expect(html).toContain('Cong ty Anh Duong');
    expect(html).toContain('Cong ty Binh Minh');
    expect(html).not.toContain('bank-supplier-ambiguous');
    expect(html).not.toContain('bank-supplier-candidate-ambiguous');
  });

  it('shows nothing for a line that equals no supplier payment', () => {
    expect(render({ bankLineId: line.id, date: line.date, candidates: [], ambiguous: false, matchCount: 0 })).toBe('');
  });
});
