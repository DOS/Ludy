// SPDX-License-Identifier: AGPL-3.0-only
// Queue-first Finance Inbox layout (#4520): collapsible secondary action strip, compact header/dropzone when work
// waits, inline xl (>= 1280px) split preview sharing ProposalDetail without duplicate h1 or PhoneActionBar, and full
// deep-link / mobile compatibility on /o/$slug/inbox/$id.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileStatus } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

type ViewportMode = 'mobile' | 'md' | 'xl' | 'wide-detail';

const state = vi.hoisted(() => ({
  qc: null as unknown as import('@tanstack/react-query').QueryClient,
  viewport: 'xl' as ViewportMode,
  modules: ['finance', 'social'] as string[],
  search: {} as { status?: string },
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useNavigate: () => vi.fn(),
    useParams: () => ({ slug: 'demo', id: 'p1' }),
    useSearch: () => state.search,
    Link: ({
      children,
      to,
      params,
      ...rest
    }: {
      children?: ReactNode;
      to: string;
      params?: Record<string, string>;
      [key: string]: unknown;
    }) => {
      const href = to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '');
      const domProps: Record<string, unknown> = { href };
      for (const [key, value] of Object.entries(rest)) {
        if (key === 'className' || key === 'aria-current' || key.startsWith('data-')) {
          domProps[key] = value;
        }
      }
      return createElement('a', domProps, children);
    },
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.qc = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (options?: { input?: unknown }) => ({
            queryKey: options?.input === undefined ? path : [...path, options.input],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: node([]),
    queryClient: state.qc,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    fetchFile: () => Promise.reject(new Error('not fetched')),
  };
});

vi.mock('../src/lib/media.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/media.ts')>();
  return {
    ...real,
    useMediaQuery: (query: string) => {
      if (state.viewport === 'mobile') return false;
      if (query === real.SM_UP) return true;
      if (query === real.INBOX_SPLIT_UP) return state.viewport === 'xl' || state.viewport === 'wide-detail';
      if (query === real.SPLIT_UP) return state.viewport === 'wide-detail';
      return false;
    },
  };
});

vi.mock('../src/lib/org-modules.ts', () => ({
  installedModules: () => state.modules,
  useModulesVersion: () => 0,
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ aiEnabled: true }),
}));

vi.mock('../src/components/entity-switcher.tsx', () => ({
  UploadEntityPicker: () => null,
  useChosenEntity: () => ({ ready: true, legalEntityId: null }),
  useLegalEntity: () => ({ entities: [{ id: 'le1', name: 'Cty Demo', isDefault: true }], settled: true }),
}));

vi.mock('../src/components/ai-meter.tsx', () => ({
  AiMeter: () => null,
}));

vi.mock('../src/components/two-factor.tsx', () => ({
  TwoFactorOffer: () => null,
  StepUpPrompt: () => null,
  StepUpDialog: () => null,
}));

const { InboxActionStrip, summarizeActionStrip } = await import('../src/components/inbox-action-strip.tsx');
const { ProposalDetail } = await import('../src/components/proposal-detail.tsx');
const { InboxPage } = await import('../src/routes/inbox.tsx');
const { InboxDetailPage } = await import('../src/routes/inbox-detail.tsx');

function renderNode(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const pendingRow = (id: string, sellerName: string, total = '1100000') => ({
  id,
  status: 'pending',
  kind: 'finance.purchase',
  direction: 'purchase',
  revision: 1,
  title: `Hóa đơn ${id}`,
  sellerName,
  buyerName: null,
  total,
  issueDate: '2026-11-20',
  createdAt: '2026-11-23T01:00:00Z',
  legalEntityId: null,
  duplicateOf: null,
  signatureStatus: 'verified',
  failedChecks: 0,
  warnChecks: 0,
  unclassifiedLines: 0,
  requestedByAgent: null,
  extracted: true,
  voided: false,
  expiredAfterDays: null,
});

const pendingDetail = (id: string, sellerName: string) => ({
  id,
  status: 'pending',
  kind: 'finance.purchase',
  revision: 1,
  title: `Hóa đơn ${id}`,
  legalEntityId: null,
  canApprove: true,
  canEdit: true,
  canReject: true,
  canReextract: false,
  canResubmit: false,
  approveReason: null,
  signatureStatus: 'verified',
  voided: false,
  expiredAfterDays: null,
  decidedAt: '2026-11-23T00:00:00Z',
  resubmittedAs: null,
  resubmittedFrom: null,
  requestedByAgent: null,
  requestedByMcp: null,
  coAuthor: false,
  reversal: null,
  voucher: null,
  journalVoucher: null,
  engage: null,
  extraction: null,
  file: null,
  originals: [],
  result: null,
  payload: {
    direction: 'purchase',
    regime: 'circular_88',
    extractionMethod: 'einvoice_xml',
    lookupHints: [],
    seller: { name: sellerName, taxCode: '0101234564', address: 'Hà Nội' },
    buyer: { name: 'Công ty Demo', taxCode: '0309999999' },
    invoice: {
      series: 'C26TAB',
      number: '1234',
      issueDate: '2026-11-20',
      subtotal: '1000000',
      vatTotal: '100000',
      total: '1100000',
      currency: 'VND',
      foreign: null,
    },
    checks: [{ id: 'signature', status: 'pass', detail: null }],
    lines: [
      {
        lineNo: 1,
        description: 'Cước dịch vụ internet',
        amount: '1000000',
        vatRate: '10',
        vatAmount: '100000',
        debitAccount: '6422',
        accountRule: { source: 'learned' },
        reason: null,
      },
    ],
  },
});

const fileEntry = (id: string, status: 'processing' | 'failed', filename: string): FileStatus => ({
  id,
  filename,
  contentType: 'application/pdf',
  status,
  version: 1,
  proposalId: null,
  proposalStatus: null,
  voided: false,
  error: status === 'failed' ? 'AI parse failed' : null,
  canReextract: status === 'failed',
  statement: null,
  createdAt: '2026-11-23T01:00:00Z',
});

function seedInboxBase() {
  const qc = state.qc;
  qc.setQueryData(['org', 'get'], { role: 'owner', permissions: [], inboundAddress: 'hd@demo.ludy.vn' });
  qc.setQueryData(['files', 'recent'], []);
  qc.setQueryData(['inbox', 'list', { status: 'pending' }], [pendingRow('p1', 'NCC Alpha'), pendingRow('p2', 'NCC Beta')]);
  qc.setQueryData(['inbox', 'get', { id: 'p1' }], pendingDetail('p1', 'NCC Alpha'));
  qc.setQueryData(['inbox', 'timeline', { id: 'p1' }], { items: [], more: false });
  qc.setQueryData(['accounts', 'list'], [{ code: '6422', name: 'Chi phí quản lý doanh nghiệp', active: true, parent: null }]);
  qc.setQueryData(['accountRules', 'list', { legalEntityId: null }], []);
  qc.setQueryData(['periodLock', 'state', { legalEntityId: undefined }], { lockedThrough: null, openingDate: null });
  qc.setQueryData(['inbox', 'hidden', {}], { count: 0 });
  qc.setQueryData(['marketplace', 'staged', {}], []);
  qc.setQueryData(['marketplace', 'columnsFiles', {}], []);
  qc.setQueryData(['marketplace', 'incomeStaged', {}], []);
  qc.setQueryData(['files', 'staged'], []);
  qc.setQueryData(['inbox', 'raised', {}], { total: 0, items: [] });
  qc.setQueryData(['inbox', 'originals', {}], { total: 0, items: [] });
  qc.setQueryData(['bank', 'openLines', { legalEntityId: null }], { accounts: [] });
  qc.setQueryData(['social', 'attentionInbox', {}], { total: 0, channels: [], posts: [] });
  qc.setQueryData(['inbound', 'recent'], []);
}

beforeEach(() => {
  state.qc.clear();
  state.viewport = 'xl';
  state.modules = ['finance', 'social'];
  state.search = {};
});

describe('summarizeActionStrip', () => {
  it('sums each secondary category cleanly and returns 0 when idle', () => {
    expect(
      summarizeActionStrip({
        failedFilesCount: 0,
        failedJobsTotal: 0,
        stagedMarketplaceCount: 0,
        stagedColumnsCount: 0,
        stagedIncomeCount: 0,
        stagedStatementsCount: 0,
        openBankLinesCount: 0,
        originalsTotal: 0,
        socialAttentionTotal: 0,
        socialMailsCount: 0,
        hiddenAppsCount: 0,
      }).totalCount,
    ).toBe(0);

    expect(
      summarizeActionStrip({
        failedFilesCount: 2,
        failedJobsTotal: 1,
        stagedMarketplaceCount: 1,
        stagedColumnsCount: 1,
        stagedIncomeCount: 2,
        stagedStatementsCount: 1,
        openBankLinesCount: 3,
        originalsTotal: 2,
        socialAttentionTotal: 4,
        socialMailsCount: 1,
        hiddenAppsCount: 2,
      }),
    ).toEqual({
      failedCount: 3,
      stagedCount: 5,
      bankCount: 3,
      originalsCount: 2,
      socialCount: 5,
      hiddenCount: 2,
      totalCount: 20,
    });
  });
});

describe('InboxActionStrip', () => {
  it('renders nothing when no secondary items exist', () => {
    seedInboxBase();
    const html = renderNode(
      <InboxActionStrip
        slug="demo"
        tab="pending"
        role="owner"
        failedFiles={[]}
        onReextract={() => undefined}
        reextractPending={false}
        reextractError={null}
      />,
    );
    expect(html).toBe('');
  });

  it('starts collapsed with summary count badges and expands on demand in both locales', () => {
    seedInboxBase();
    state.qc.setQueryData(['bank', 'openLines', { legalEntityId: null }], {
      accounts: [{ bankAccount: '1121', open: 3, ambiguous: 0, oldest: '2026-11-01' }],
    });
    state.qc.setQueryData(['inbox', 'originals', {}], {
      total: 1,
      items: [{ id: 'o1', provider: 'MISA', url: 'https://example.test', code: 'ABC123' }],
    });

    const collapsed = renderNode(
      <InboxActionStrip
        slug="demo"
        tab="pending"
        role="owner"
        failedFiles={[fileEntry('f-fail', 'failed', 'broken.pdf')]}
        onReextract={() => undefined}
        reextractPending={false}
        reextractError={null}
      />,
      'vi',
    );
    expect(collapsed).toContain('data-testid="inbox-action-strip"');
    expect(collapsed).toContain('data-testid="inbox-action-strip-toggle"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('5 mục cần xử lý');
    expect(collapsed).toContain('1 lỗi tải/đọc');
    expect(collapsed).toContain('3 dòng ngân hàng mở');
    expect(collapsed).toContain('1 chờ bản gốc');
    expect(collapsed).not.toContain('data-testid="inbox-action-strip-content"');
    expect(collapsed).not.toContain('data-testid="failed-files-card"');

    const expanded = renderNode(
      <InboxActionStrip
        slug="demo"
        tab="pending"
        role="owner"
        failedFiles={[fileEntry('f-fail', 'failed', 'broken.pdf')]}
        onReextract={() => undefined}
        reextractPending={false}
        reextractError={null}
        defaultExpanded
      />,
      'en',
    );
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('data-testid="inbox-action-strip-content"');
    expect(expanded).toContain('data-testid="failed-files-card"');
    expect(expanded).toContain('broken.pdf');
    expect(expanded).toContain('5 items need attention');
    expect(expanded).toContain(catalog('en').inbox.bankLines.title);
  });
});

describe('InboxPage queue-first layout and xl split preview', () => {
  it('keeps processing files outside, hides the large welcome when items wait, and renders xl split preview cleanly', () => {
    seedInboxBase();
    state.qc.setQueryData(['files', 'recent'], [
      fileEntry('f-proc', 'processing', 'reading-now.pdf'),
      fileEntry('f-err', 'failed', 'unreadable.pdf'),
    ]);
    state.qc.setQueryData(['bank', 'openLines', { legalEntityId: null }], {
      accounts: [{ bankAccount: '1121', open: 2, ambiguous: 0, oldest: '2026-11-01' }],
    });

    state.viewport = 'xl';
    const html = renderNode(<InboxPage />, 'vi');

    // Compact dropzone replaces the 2-card welcome while proposals exist.
    expect(html).toContain(catalog('vi').inbox.dropHereCompact);
    expect(html).not.toContain(catalog('vi').inbox.forwardTitle);
    expect(html).not.toContain(catalog('vi').inbox.formatsZip);

    // Live processing chip stays directly visible; failed file card stays inside collapsed strip while surfacing error text inline.
    expect(html).toContain('reading-now.pdf');
    expect(html).not.toContain('unreadable.pdf');
    expect(html).toContain('AI parse failed');
    expect(html).toContain('data-testid="inbox-action-strip"');
    expect(html).toContain('aria-expanded="false"');

    // Split preview renders side-by-side at xl with one h1 and embedded h2 detail (without duplicating page shortcuts).
    expect(html).toContain('data-testid="inbox-split-layout"');
    expect(html).toContain('data-testid="inbox-split-queue"');
    expect(html).toContain('data-testid="inbox-split-preview"');
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(html).toContain('<h2 class="text-lg font-semibold tracking-tight text-foreground">NCC Alpha</h2>');
    expect(html).toContain('href="/o/demo/inbox/p1"');
    expect(html).toContain(catalog('vi').inbox.preview.openDetail);
    expect(html).not.toContain(catalog('vi').inboxDetail.shortcuts);
    expect(html).toContain('border-dashed border-proposal/60');
    expect(html).toContain(catalog('vi').inboxDetail.approve);
    // PhoneActionBar must not mount inside desktop split preview.
    expect(html).not.toContain('fixed inset-x-0 bottom-0');
  });

  it('shows the welcome cards when empty, and switches cleanly to table (md) and stacked cards (mobile)', () => {
    seedInboxBase();
    state.qc.setQueryData(['inbox', 'list', { status: 'pending' }], []);
    const emptyHtml = renderNode(<InboxPage />, 'vi');
    expect(emptyHtml).toContain(catalog('vi').inbox.dropHere);
    expect(emptyHtml).toContain(catalog('vi').inbox.forwardTitle);
    expect(emptyHtml).not.toContain('data-testid="inbox-split-layout"');

    seedInboxBase();
    state.viewport = 'md';
    const mdHtml = renderNode(<InboxPage />, 'vi');
    expect(mdHtml).not.toContain('data-testid="inbox-split-layout"');
    expect(mdHtml).toContain('NCC Alpha');
    expect(mdHtml).toContain('NCC Beta');

    state.viewport = 'mobile';
    const mobileHtml = renderNode(<InboxPage />, 'vi');
    expect(mobileHtml).not.toContain('data-testid="inbox-split-layout"');
    expect(mobileHtml).toContain('<ul class="space-y-2">');
    expect(mobileHtml).toContain('href="/o/demo/inbox/p1"');
  });
});

describe('ProposalDetail and InboxDetailPage', () => {
  it('preserves /o/$slug/inbox/$id deep-link layout and mobile PhoneActionBar', () => {
    seedInboxBase();
    state.viewport = 'mobile';
    const mobileDetail = renderNode(<InboxDetailPage />, 'vi');
    expect((mobileDetail.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(mobileDetail).toContain(catalog('vi').inboxDetail.back);
    expect(mobileDetail).toContain('fixed inset-x-0 bottom-0');

    state.viewport = 'wide-detail';
    const wideDetail = renderNode(<InboxDetailPage />, 'vi');
    expect(wideDetail).toContain('aria-current="page"');
    expect(wideDetail).toContain('lg:grid-cols-5');

    const embedded = renderNode(<ProposalDetail slug="demo" id="p1" mode="embedded" />, 'vi');
    expect((embedded.match(/<h1\b/g) ?? []).length).toBe(0);
    expect(embedded).not.toContain('lg:grid-cols-5');
    expect(embedded).toContain(catalog('vi').inbox.preview.openDetail);
  });
});
