// SPDX-License-Identifier: AGPL-3.0-only
// The payroll payment an open money-out bank line may be (#2933), rendered on the server with the answer of bank.payrollMatch seeded in the cache: a candidate names the kind, the month and the amount
// and offers the two buttons, a line that equals nothing shows nothing, and no model call is made until a person presses "Why this one?". The press, the coworker's sentence and the request are
// covered where the stack allows (the kernel tests of #2919 for the answer, the settlement card test for the request): an approved month needs the accountant's confirmed rows (#2535), so a browser
// run on real data is not possible here.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankLine, BankPayrollMatch } from '@crove/kernel-contract';

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
  // Any call of the client is recorded: rendering must make none (a model call costs).
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_t, prop: string) => () => cache.calls.push(prop) }) });
  return { orpc: node([]), client, queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});

const { BankPayrollLine } = await import('../src/components/bank-payroll-line.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const line: BankLine = { id: '00000000-0000-4000-8000-0000000000a1', date: '2026-11-05', description: 'Tra luong thang 10', amount: '-45000000', balance: null, reference: null, ambiguous: false, importId: '00000000-0000-4000-8000-0000000000b1', state: { status: 'open' } };
const runId = '00000000-0000-4000-8000-0000000000c1';

function render(match: BankPayrollMatch | null, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  if (match) cache.current.setQueryData(['bank', 'payrollMatch'], match);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <BankPayrollLine slug="acme" line={line} bankAccount="1121" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the payroll payment an open money-out line may be (#2933)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows the candidate with its kind, month, amount, reason and the two buttons, and calls nothing', () => {
    const html = render({ bankLineId: line.id, date: line.date, candidates: [{ runId, month: '2026-10', kind: 'net_pay', amount: '45000000', reason: 'amount_note' }] });
    expect(html).toContain('data-testid="bank-payroll-net_pay"');
    expect(html).toContain('Net pay to employees');
    expect(html).toContain('month 2026-10');
    expect(html).toContain('Amount and description match');
    expect(html).toContain('data-testid="bank-payroll-why"');
    expect(html).toContain('data-testid="bank-payroll-open"');
    // The coworker's sentence and its notice come only after the button; the request form only after "Ask for this payment".
    expect(html).not.toContain('bank-payroll-sentence');
    expect(html).not.toContain('bank-payroll-ai-state');
    expect(html).not.toContain('bank-payroll-form');
    expect(cache.calls).toEqual([]);
  });

  it('shows each of several candidates, by amount alone when the description names nothing', () => {
    const html = render({
      bankLineId: line.id,
      date: line.date,
      candidates: [
        { runId, month: '2026-10', kind: 'net_pay', amount: '45000000', reason: 'amount' },
        { runId, month: '2026-10', kind: 'insurance', amount: '45000000', reason: 'amount' },
      ],
    });
    expect(html).toContain('data-testid="bank-payroll-net_pay"');
    expect(html).toContain('data-testid="bank-payroll-insurance"');
    expect(html.match(/Amount matches/g)).toHaveLength(2);
  });

  it('shows nothing for a line that equals no payroll payment, and in Vietnamese words the candidate', () => {
    expect(render({ bankLineId: line.id, date: line.date, candidates: [] })).toBe('');
    cache.current.clear();
    const html = render({ bankLineId: line.id, date: line.date, candidates: [{ runId, month: '2026-10', kind: 'tax', amount: '45000000', reason: 'amount' }] }, 'vi');
    expect(html).toContain('Thuế thu nhập cá nhân nộp cho cơ quan thuế');
    expect(html).toContain('Khớp số tiền');
    expect(html).toContain('Xin ghi chi khoản này');
  });

  it('shows nothing while the answer is not there yet', () => {
    expect(render(null)).toBe('');
  });
});
