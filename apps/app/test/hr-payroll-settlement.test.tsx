// SPDX-License-Identifier: AGPL-3.0-only
// The settlement card of an approved pay month (#2532, #3095): recorded or pending payment steps stay visible across every posting status (including while a repost proposal waits in the Inbox),
// asking for a new payment is offered only when the posting is posted, and the reversed-entry note states that payment vouchers cannot be recorded until the entry is posted again.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PayrollSettlement } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts?.input !== undefined ? [...path, opts.input] : path,
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_t, prop: string) => () => cache.calls.push(prop) }) });
  return {
    apiFetch: vi.fn(),
    client,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    orpc: node([]),
    queryClient: cache.current,
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; [key: string]: unknown }) =>
      createElement('a', { ...rest, href: to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '') }, children),
  };
});

const { Settlement } = await import('../src/routes/hr-payroll.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const RUN_ID = '00000000-0000-4000-8000-0000000000c1';
const REPOST_PROPOSAL_ID = '00000000-0000-4000-8000-0000000000d1';
const NONE = { status: 'none' as const, proposalId: null };

function baseSettlement(overrides?: Partial<PayrollSettlement>): PayrollSettlement {
  return {
    runId: RUN_ID,
    posting: NONE,
    payments: {
      net_pay: NONE,
      insurance: NONE,
      union: NONE,
      tax: NONE,
    },
    ...overrides,
  };
}

function renderSettlement(settlement: PayrollSettlement, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  cache.current.setQueryData(['hr', 'payroll', 'settlement', { runId: settlement.runId }], settlement);
  cache.current.setQueryData(['accounts', 'list'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <Settlement runId={settlement.runId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Payroll settlement card (#3095)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('keeps recorded payments visible while a repost proposal is pending, without offering new payment requests', () => {
    const html = renderSettlement(
      baseSettlement({
        posting: { status: 'pending', proposalId: REPOST_PROPOSAL_ID },
        payments: {
          net_pay: { status: 'recorded', proposalId: null },
          insurance: NONE,
          union: NONE,
          tax: NONE,
        },
      }),
      'en',
    );
    expect(html).toContain('data-testid="hr-settle-posting-state"');
    expect(html).toContain(`/o/acme/inbox/${REPOST_PROPOSAL_ID}`);
    expect(html).not.toContain('data-testid="hr-settle-post"');
    expect(html).toContain('data-testid="hr-settle-payments"');
    expect(html).toContain('data-testid="hr-settle-pay-net_pay-state"');
    expect(html).toContain('Recorded');
    // Unrecorded payment kinds must not offer "Ask for the payment" until the repost is approved.
    expect(html).not.toContain('data-testid="hr-settle-pay-net_pay-open"');
    expect(html).not.toContain('data-testid="hr-settle-pay-insurance-open"');
    expect(html).not.toContain('data-testid="hr-settle-pay-union-open"');
    expect(html).not.toContain('data-testid="hr-settle-pay-tax-open"');
    expect(cache.calls).toEqual([]);
  });

  it('hides the payment list while a first posting is pending and no payment step has been recorded or requested', () => {
    const html = renderSettlement(
      baseSettlement({
        posting: { status: 'pending', proposalId: REPOST_PROPOSAL_ID },
      }),
      'en',
    );
    expect(html).not.toContain('data-testid="hr-settle-payments"');
    expect(html).toContain(en.hrPayroll.settlePayAfterPosting);
  });

  it('offers new payment requests for unrecorded kinds only when the posting is posted', () => {
    const html = renderSettlement(
      baseSettlement({
        posting: { status: 'posted', proposalId: null },
        payments: {
          net_pay: { status: 'recorded', proposalId: null },
          insurance: NONE,
          union: NONE,
          tax: NONE,
        },
      }),
      'en',
    );
    expect(html).toContain('data-testid="hr-settle-payments"');
    expect(html).toContain('data-testid="hr-settle-pay-net_pay-state"');
    expect(html).not.toContain('data-testid="hr-settle-pay-net_pay-open"');
    expect(html).toContain('data-testid="hr-settle-pay-insurance-open"');
    expect(html).toContain('data-testid="hr-settle-pay-union-open"');
    expect(html).toContain('data-testid="hr-settle-pay-tax-open"');
  });

  it('renders settleReversedNote as recording payment vouchers (not making transfers) in both English and Vietnamese', () => {
    const reversed = baseSettlement({
      posting: { status: 'reversed', proposalId: null },
      payments: {
        net_pay: { status: 'recorded', proposalId: null },
        insurance: NONE,
        union: NONE,
        tax: NONE,
      },
    });

    const htmlEn = renderSettlement(reversed, 'en');
    expect(en.hrPayroll.settleReversedNote).toContain('payment vouchers cannot be recorded yet');
    expect(en.hrPayroll.settleReversedNote).not.toContain('nothing can be paid');
    expect(htmlEn).toContain('payment vouchers cannot be recorded yet');
    expect(htmlEn).toContain('data-testid="hr-settle-post"');
    expect(htmlEn).toContain('data-testid="hr-settle-payments"');
    expect(htmlEn).not.toContain('data-testid="hr-settle-pay-insurance-open"');

    cache.current.clear();
    const htmlVi = renderSettlement(reversed, 'vi');
    expect(viMessages.hrPayroll.settleReversedNote).toContain('chưa ghi chứng từ chi được');
    expect(htmlVi).toContain(viMessages.hrPayroll.settleReversedNote);
    expect(htmlVi).toContain('data-testid="hr-settle-payments"');
    expect(htmlVi).not.toContain('data-testid="hr-settle-pay-insurance-open"');
  });
});
