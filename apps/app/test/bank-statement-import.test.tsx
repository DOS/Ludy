// SPDX-License-Identifier: AGPL-3.0-only
// Bank statement import preview, post-import notice, and Inbox staged statement summary (#4223), rendered on the server:
// the feedSkipped alert and conflict warning in bank.tsx, the post-import notice distinguishing plain duplicates from
// cut-over-skipped lines, and the staged Inbox card separating duplicateLines from feed.leftOut.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankImportPreview, BankImportResult, FileStatus } from '@ludy/kernel-contract';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {},
    queryClient: client.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: () => undefined,
    getCurrentOrg: () => 'acme',
  };
});
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useParams: () => ({ slug: 'acme' }),
  useSearch: () => ({}),
  Link: ({ to, children }: { to: string; children: unknown }) => <a href={to}>{children as never}</a>,
}));
vi.mock('../src/routes/vouchers.tsx', () => ({ VoucherFormPanel: () => <div data-testid="voucher-form-stub" /> }));
vi.mock('../src/lib/toast.ts', () => ({ toast: () => undefined }));

const { StatementImportPreview, StatementImportedNotice } = await import('../src/routes/bank.tsx');
const { StagedStatements } = await import('../src/components/staged-statements.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

function render(locale: 'en' | 'vi', node: ReactNode): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const previewData = (over: Partial<BankImportPreview> = {}): BankImportPreview => ({
  bankAccount: '1121.VCB',
  order: 'oldest_first',
  rows: [
    { rowNo: 2, date: '2026-10-10', description: 'Khách trả tiền', amount: '100000', balance: '100000', reference: 'FT-1', status: 'new', clash: null, errors: [] },
    { rowNo: 3, date: '2026-10-12', description: 'Đã nhập trước', amount: '50000', balance: '150000', reference: 'FT-2', status: 'duplicate', clash: null, errors: [] },
    { rowNo: 4, date: '2026-10-16', description: 'Từ nguồn tự động', amount: '200000', balance: '350000', reference: 'FT-3', status: 'duplicate', clash: null, errors: [] },
    { rowNo: 5, date: '2026-10-17', description: 'Chênh lệch nguồn', amount: '900000', balance: '1250000', reference: 'FT-4', status: 'conflict', clash: { date: '2026-10-17', amount: '300000' }, errors: [] },
  ],
  counts: { new: 1, duplicate: 2, ambiguous: 0, conflict: 1, invalid: 0 },
  breaks: [],
  from: '2026-10-10',
  to: '2026-10-17',
  ok: true,
  feed: { from: '2026-10-15', leftOut: 1 },
  ...over,
});

const stagedFile = (over: Partial<NonNullable<FileStatus['statement']>> = {}): FileStatus => ({
  id: '0190a000-0000-7000-8000-0000000000f1',
  filename: 'sao-ke-thang-10.xlsx',
  contentType: 'application/zip',
  status: 'staged',
  error: null,
  proposalId: null,
  proposalStatus: null,
  voided: false,
  version: 1,
  canReextract: true,
  createdAt: '2026-10-20T01:00:00.000Z',
  statement: {
    state: 'staged',
    bankAccount: '1121.VCB',
    accountMask: '*******1234',
    filename: 'sao-ke-thang-10.xlsx',
    lines: 4,
    newLines: 1,
    duplicateLines: 1,
    conflictLines: 0,
    feed: { from: '2026-10-15', leftOut: 2 },
    from: '2026-10-10',
    to: '2026-10-18',
    totalIn: '600000',
    totalOut: '0',
    decidedBy: null,
    origin: { channel: 'upload', by: 'An', from: null },
    entity: { id: '0190a000-0000-7000-8000-0000000000e1', name: 'Công ty Mẫu' },
    ...over,
  },
});

describe('StatementImportPreview and StatementImportedNotice (#4223)', () => {
  beforeEach(() => client.current.clear());

  it('shows the feedSkipped alert, separates feed skips in the preview summary, and keeps conflict warnings in both languages', () => {
    const enHtml = render('en', <StatementImportPreview data={previewData()} importing={false} onImport={() => undefined} />);
    expect(enHtml).toContain('data-testid="bank-feed-skipped"');
    expect(enHtml).toContain('Skipped 1 line dated 15/10/2026 or later');
    expect(enHtml).toContain('1 new, 1 already there, 1 skipped by bank feed, 0 to look at, 0 with errors');
    expect(enHtml).toContain('data-testid="bank-conflict-note"');
    expect(enHtml).toContain('Same reference as another line: 17/10/2026');

    const viHtml = render('vi', <StatementImportPreview data={previewData({ feed: { from: '2026-10-15', leftOut: 2 }, counts: { new: 1, duplicate: 3, ambiguous: 0, conflict: 0, invalid: 0 } })} importing={false} onImport={() => undefined} />);
    expect(viHtml).toContain('data-testid="bank-feed-skipped"');
    expect(viHtml).toContain('Đã bỏ qua 2 dòng từ ngày 15/10/2026 trở đi');
    expect(viHtml).toContain('1 dòng mới, 1 dòng đã có, 2 dòng bỏ qua theo nguồn tự động');
    expect(viHtml).not.toContain('data-testid="bank-conflict-note"');
  });

  it('omits the feedSkipped alert when feed is absent or leftOut is zero', () => {
    const noFeed = render('en', <StatementImportPreview data={previewData({ feed: undefined, counts: { new: 1, duplicate: 1, ambiguous: 0, conflict: 0, invalid: 0 } })} importing={false} onImport={() => undefined} />);
    expect(noFeed).not.toContain('data-testid="bank-feed-skipped"');
    expect(noFeed).toContain('1 new, 1 already there, 0 to look at, 0 with errors');

    const zeroSkipped = render('vi', <StatementImportPreview data={previewData({ feed: { from: '2026-11-01', leftOut: 0 }, counts: { new: 1, duplicate: 1, ambiguous: 0, conflict: 0, invalid: 0 } })} importing={false} onImport={() => undefined} />);
    expect(zeroSkipped).not.toContain('data-testid="bank-feed-skipped"');
  });

  it('names cut-over skips separately from plain duplicates in the post-import notice', () => {
    const result: BankImportResult = {
      importId: '0190a000-0000-7000-8000-0000000000a1',
      counts: { new: 2, duplicate: 4, ambiguous: 0, conflict: 0, invalid: 0 },
      breaks: [],
      feed: { from: '2026-10-15', leftOut: 3 },
    };
    const enHtml = render('en', <StatementImportedNotice result={result} />);
    expect(enHtml).toContain('Imported 2 lines (1 already there and 3 skipped because your bank feed supplies lines from 15/10/2026).');

    const viHtml = render('vi', <StatementImportedNotice result={result} />);
    expect(viHtml).toContain('Đã nhập 2 dòng (1 dòng đã có được bỏ qua, 3 dòng bỏ qua vì nguồn tự động lấy từ ngày 15/10/2026).');

    const plainOnly = render('vi', <StatementImportedNotice result={{ importId: result.importId, counts: { new: 2, duplicate: 1, ambiguous: 0, conflict: 0, invalid: 0 }, breaks: [] }} />);
    expect(plainOnly).toContain('Đã nhập 2 dòng (1 dòng đã có được bỏ qua).');
  });
});

describe('StagedStatements cut-over summary (#4223)', () => {
  beforeEach(() => client.current.clear());

  it('separates cut-over-skipped lines from duplicateLines and warns on the staged Inbox card in both languages', () => {
    client.current.setQueryData(['files', 'staged'], [stagedFile()]);
    const enHtml = render('en', <StagedStatements canDecide={true} refetchMs={false} />);
    expect(enHtml).toContain('4 lines (1 new, 1 already there, 2 skipped by bank feed)');
    expect(enHtml).toContain('data-testid="staged-feed-skipped"');
    expect(enHtml).toContain('Skipped 2 lines dated 15/10/2026 or later');

    const viHtml = render('vi', <StagedStatements canDecide={true} refetchMs={false} />);
    expect(viHtml).toContain('4 dòng (1 mới, 1 đã có, 2 bỏ qua theo nguồn tự động)');
    expect(viHtml).toContain('data-testid="staged-feed-skipped"');
    expect(viHtml).toContain('Đã bỏ qua 2 dòng từ ngày 15/10/2026 trở đi');
  });

  it('keeps the plain summary without the feed warning when feed is null or leftOut is zero', () => {
    client.current.setQueryData(['files', 'staged'], [stagedFile({ feed: null, duplicateLines: 2 })]);
    const html = render('en', <StagedStatements canDecide={true} refetchMs={false} />);
    expect(html).toContain('4 lines (1 new, 2 already there)');
    expect(html).not.toContain('data-testid="staged-feed-skipped"');
  });
});
