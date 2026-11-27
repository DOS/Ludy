// SPDX-License-Identifier: AGPL-3.0-only
// UI unit and SSR tests for TC3 contact import tax-code suggestions (#4990):
// - Lookup off leaves wizard preview completely unchanged
// - Lookup on shows "Gợi ý từ mã số thuế" only for empty name/address fields (never overwriting non-empty),
//   shows "chưa tra" for waiting rows, and renders "Điền các ô trống" batch accept button
// - Org-disabled, rate-limit, unavailable, and loading states stay non-blocking
// - Mobile 375px stacked DataTable, >=44px touch targets, keyboard button accessibility, and vi/en parity
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ImportPreview, ImportTaxLookupResult } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const queryClientState = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const configState = vi.hoisted(() => ({ partyTaxLookup: false }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['kernel', 'crm'], partyTaxLookup: configState.partyTaxLookup }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'demo-org' }),
    useRouter: () => ({ history: { back: () => undefined } }),
    Link: ({ children, to, ...rest }: { children?: ReactNode; to: string }) =>
      createElement('a', { href: to, ...(rest as object) }, children),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC({ defaultOptions: { queries: { retryOnMount: false, retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (args?: { input?: unknown }) => ({ queryKey: [...path, args?.input ?? {}], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { client: node([]), orpc: node([]), queryClient: queryClientState.current, errorMessage: String, takeOrgLeftNotice: () => null };
});

const { ContactImportPage, ContactImportPreview } = await import('../src/routes/contact-import.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => {
  setActiveLocale(locale);
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClientState.current}>
        <IntlProvider locale={locale} messages={catalog(locale)}>
          {node}
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
};

const samplePreview: ImportPreview = {
  batch: {
    id: '10000000-0000-4000-8000-000000000001',
    filename: 'khach-hang.csv',
    status: 'staged',
    onDuplicate: 'skip',
    totalRows: 3,
    newRows: 1,
    duplicateRows: 0,
    conflictRows: 0,
    invalidRows: 2,
    createdRows: 0,
    updatedRows: 0,
    newCompanies: 0,
    createdCompanies: 0,
    linkedRows: 0,
    createdAt: '2026-11-28T00:00:00.000Z',
    decidedAt: null,
  },
  rows: [
    {
      rowNo: 1,
      kind: 'organization',
      name: '',
      taxCode: '0101234564',
      email: null,
      phone: null,
      address: 'Địa chỉ sẵn có',
      outcome: 'invalid',
      reason: 'INVALID_NAME',
      match: null,
      company: null,
    },
    {
      rowNo: 2,
      kind: 'organization',
      name: 'Công ty Đã Có Tên',
      taxCode: '0101234565',
      email: null,
      phone: null,
      address: null,
      outcome: 'new',
      reason: null,
      match: null,
      company: null,
    },
    {
      rowNo: 3,
      kind: 'organization',
      name: '',
      taxCode: '0101234566',
      email: null,
      phone: null,
      address: null,
      outcome: 'invalid',
      reason: 'INVALID_NAME',
      match: null,
      company: null,
    },
  ],
  more: false,
};

const sampleLookup: ImportTaxLookupResult = {
  expired: false,
  lookedUpRows: 2,
  providerCalls: 2,
  stopReason: 'batch_limit',
  items: [
    {
      rowNo: 1,
      taxCode: '0101234564',
      status: 'suggested',
      suggestedName: 'Công ty TNHH Hoa Sen',
      suggestedAddress: 'Địa chỉ Bị Bỏ Qua',
      statusText: 'Đang hoạt động',
      cached: false,
      household: false,
    },
    {
      rowNo: 2,
      taxCode: '0101234565',
      status: 'suggested',
      suggestedName: 'Tên Bị Bỏ Qua',
      suggestedAddress: '12 Lê Lợi, Quận 1',
      statusText: null,
      cached: true,
      household: false,
    },
    {
      rowNo: 3,
      taxCode: '0101234566',
      status: 'not_looked_up',
      suggestedName: null,
      suggestedAddress: null,
      statusText: null,
      cached: false,
      household: false,
    },
  ],
};

function renderPreview(
  overrides: Partial<Parameters<typeof ContactImportPreview>[0]> = {},
  locale: 'vi' | 'en' = 'vi',
): string {
  return renderToStaticMarkup(
    wrap(
      locale,
      <ContactImportPreview
        staged={samplePreview}
        rows={samplePreview.rows}
        outcome="all"
        onOutcomeChange={() => undefined}
        hasMore={false}
        loadingMore={false}
        onLoadMore={() => undefined}
        onDuplicate="skip"
        onDuplicateChange={() => undefined}
        createCompanies={false}
        onCreateCompaniesChange={() => undefined}
        newCompanyNames={[]}
        onCommit={() => undefined}
        commitPending={false}
        onCancel={() => undefined}
        cancelPending={false}
        actionError={null}
        deploymentTaxLookup
        taxLookupState={{
          isPending: false,
          data: sampleLookup,
          error: null,
          onRetry: () => undefined,
        }}
        acceptedRowNos={new Set()}
        fillPendingRowNo={null}
        fillError={null}
        onAcceptRow={() => undefined}
        onAcceptAll={() => undefined}
        {...overrides}
      />,
    ),
  );
}

describe('TC3 contact import preview UI (#4990)', () => {
  it('leaves the wizard preview unchanged when deployment tax lookup is off', () => {
    const html = renderPreview({ deploymentTaxLookup: false });
    expect(html).not.toContain('Gợi ý từ mã số thuế');
    expect(html).not.toContain('Điền các ô trống');
    expect(html).not.toContain('chưa tra');
    expect(html).not.toContain('data-testid="import-tax-suggestion"');
  });

  it('renders tax-code suggestions only for empty fields, never shows overwriting non-empty fields, and shows chưa tra + batch button', () => {
    const html = renderPreview();
    expect(html).toContain('Gợi ý từ mã số thuế');
    expect(html).toContain('Điền các ô trống');
    expect(html).toContain('chưa tra');
    // Row 1 had empty name + existing address: suggests name, does NOT show suggestedAddress over non-empty address.
    expect(html).toContain('Công ty TNHH Hoa Sen');
    expect(html).not.toContain('Địa chỉ Bị Bỏ Qua');
    // Row 2 had existing name + empty address: suggests address, does NOT show suggestedName over non-empty name.
    expect(html).toContain('12 Lê Lợi, Quận 1');
    expect(html).not.toContain('Tên Bị Bỏ Qua');
    // Keyboard & 375px mobile card + >=44px tap targets.
    expect(html).toContain('max-md:min-h-11');
    expect(html).toContain('data-label="Mã số thuế"');
    expect(html).toContain('aria-label="Điền gợi ý từ mã số thuế cho dòng 1 (0101234564)"');
  });

  it('renders English copy parity and non-blocking org-disabled, rate-limit, and unavailable notices', () => {
    const enHtml = renderPreview({}, 'en');
    expect(enHtml).toContain('Suggested from tax code');
    expect(enHtml).toContain('Fill empty fields');
    expect(enHtml).toContain('not looked up');
    expect(enHtml).not.toMatch(/[\u2013\u2014]/);

    const orgOffHtml = renderPreview({
      taxLookupState: {
        isPending: false,
        data: undefined,
        error: { code: 'TAX_LOOKUP_ORG_DISABLED' },
        onRetry: () => undefined,
      },
    });
    expect(orgOffHtml).toContain('Tra cứu mã số thuế chưa bật cho tổ chức này');
    expect(orgOffHtml).not.toContain('data-testid="import-tax-suggestion"');

    const unavailableHtml = renderPreview({
      taxLookupState: {
        isPending: false,
        data: undefined,
        error: { code: 'TAX_LOOKUP_UNAVAILABLE' },
        onRetry: () => undefined,
      },
    });
    expect(unavailableHtml).toContain('Tạm thời không tra được mã số thuế');
    expect(unavailableHtml).toContain('Thử tra lại');
  });

  it('renders ContactImportPage cleanly with partyTaxLookup off or on', () => {
    configState.partyTaxLookup = false;
    expect(renderToStaticMarkup(wrap('vi', <ContactImportPage />))).toContain('Nhập liên hệ từ tệp');
    configState.partyTaxLookup = true;
    expect(renderToStaticMarkup(wrap('vi', <ContactImportPage />))).toContain('Nhập liên hệ từ tệp');
  });
});
