// SPDX-License-Identifier: AGPL-3.0-only
// UI & accessibility tests for Decree 337/2025/ND-CP HR contract notice and Contract Vault Q&A bar (#4439).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { HrEmploymentView } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import type { SignVaultMatchItem } from '../src/lib/sign-api.ts';

const routerState = vi.hoisted(() => ({
  slug: 'acme',
  id: '01900000-0000-7000-8000-000000000501',
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
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
    }) => createElement('a', { ...rest, href: to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '') }, children),
    useParams: () => ({ slug: routerState.slug, id: routerState.id }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  const orpcNode = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'queryKey') return (opts?: { input?: unknown }) => (opts?.input !== undefined ? [...path, opts.input] : [...path]);
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts?.input !== undefined ? [...path, opts.input] : [...path],
            queryFn: async () => null,
          });
        }
        return orpcNode([...path, prop]);
      },
    });
  return {
    orpc: orpcNode([]),
    queryClient: new QC(),
    client: {},
    clientForOrg: () => ({}),
    getCurrentOrg: () => 'acme',
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: vi.fn(),
    fetchFile: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

const { ContractVaultBar } = await import('../src/components/sign/contract-vault-bar.tsx');
const { HrContractNd337Notice, HrContractSignHandoff } = await import('../src/components/hr-contract-sign-handoff.tsx');
const { SignEnvelopeDetailPage } = await import('../src/routes/sign-envelope-detail.tsx');
const { SignEnvelopesPage } = await import('../src/routes/sign-envelopes.tsx');

function renderLocale(locale: 'vi' | 'en', node: ReactNode, client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const SAMPLE_EMPLOYMENT: HrEmploymentView = {
  id: '01900000-0000-7000-8000-000000000601',
  effectiveFrom: '2026-11-01',
  contractType: 'fixed_term',
  region: 'I',
  baseWage: '22500000',
  payFunction: 'admin',
  payBasis: 'monthly',
  hourlyRate: null,
  pieceRate: null,
  scheduledHoursPerDay: null,
  taxResident: true,
  contractForm: 'electronic',
  termMonths: 12,
  contractEndOn: '2027-10-31',
  fixedTermSequence: 1,
  probationRoleTier: 'college_or_above',
  probationEndOn: '2026-12-30',
  probationWage: '19125000',
};

describe('Decree 337/2025/ND-CP HR contract compliance notice (#4439)', () => {
  it('renders the Decree 337/2025/ND-CP notice on hr_contract envelope detail in vi and en, and hides it on standalone envelopes', () => {
    const baseEnvelope = {
      id: routerState.id,
      title: 'Hợp đồng lao động - Nguyễn Minh Anh',
      subject: null,
      message: null,
      status: 'draft' as const,
      routingMode: 'parallel' as const,
      sourceId: SAMPLE_EMPLOYMENT.id,
      sourceFileId: '01900000-0000-7000-8000-000000000701',
      sourceSha256: 'a'.repeat(64),
      inspectStatus: 'passed' as const,
      inspectError: null,
      pageCount: 2,
      pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842 }],
      detectedTags: [],
      shareSummaryWithSigners: false,
      sharedSummary: null,
      allowDelegation: false,
      sealedFileId: null,
      sealedSha256: null,
      sealStatus: null,
      certificateFileId: null,
      certificateCode: null,
      expiresAt: null,
      autoRemindBeforeExpiry: true,
      sentAt: null,
      completedAt: null,
      declinedAt: null,
      declineAcknowledgedAt: null,
      voidedAt: null,
      voidReason: null,
      expiredAt: null,
      version: 1,
      createdBy: '01900000-0000-7000-8000-000000000801',
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
    };

    const hrClient = new QueryClient();
    hrClient.setQueryData(['sign', 'envelope', routerState.id], {
      envelope: { ...baseEnvelope, sourceKind: 'hr_contract' as const },
      signers: [],
      fields: [],
    });

    const htmlVi = renderLocale('vi', <SignEnvelopeDetailPage />, hrClient);
    expect(htmlVi).toContain('data-testid="sign-hr-contract-nd337-banner"');
    expect(htmlVi).toContain('337/2025/NĐ-CP');
    expect(htmlVi).toContain('Bộ Nội vụ');
    expect(htmlVi).not.toMatch(/[\u2013\u2014]/);

    const htmlEn = renderLocale('en', <SignEnvelopeDetailPage />, hrClient);
    expect(htmlEn).toContain('data-testid="sign-hr-contract-nd337-banner"');
    expect(htmlEn).toContain('337/2025/ND-CP');
    expect(htmlEn).toContain('Ministry of Home Affairs');
    expect(htmlEn).not.toMatch(/[\u2013\u2014]/);

    const standaloneClient = new QueryClient();
    standaloneClient.setQueryData(['sign', 'envelope', routerState.id], {
      envelope: { ...baseEnvelope, sourceKind: 'standalone' as const },
      signers: [],
      fields: [],
    });
    const standaloneHtml = renderLocale('vi', <SignEnvelopeDetailPage />, standaloneClient);
    expect(standaloneHtml).not.toContain('sign-hr-contract-nd337-banner');
  });

  it('renders the Decree 337/2025/ND-CP banner and inline hint on HR send-to-sign surfaces only when sign is enabled', () => {
    expect(renderLocale('vi', <HrContractNd337Notice signEnabled={false} />)).toBe('');

    const bannerVi = renderLocale('vi', <HrContractNd337Notice signEnabled={true} />);
    expect(bannerVi).toContain('data-testid="hr-contract-nd337-banner"');
    expect(bannerVi).toContain('337/2025/NĐ-CP');

    const handoffVi = renderLocale(
      'vi',
      <HrContractSignHandoff
        source={{ employment: SAMPLE_EMPLOYMENT, employee: { id: 'emp-1', displayName: 'Nguyễn Minh Anh' } }}
        canEdit={true}
        signEnabled={true}
        envelope={null}
      />,
    );
    expect(handoffVi).toContain('data-testid="hr-contract-send-esign"');
    expect(handoffVi).toContain('data-testid="hr-contract-nd337-hint"');
    expect(handoffVi).toContain('337/2025/NĐ-CP');

    const noneContract = renderLocale(
      'vi',
      <HrContractSignHandoff
        source={{
          employment: { ...SAMPLE_EMPLOYMENT, contractType: 'none' },
          employee: { id: 'emp-1', displayName: 'Nguyễn Minh Anh' },
        }}
        canEdit={true}
        signEnabled={true}
        envelope={null}
      />,
    );
    expect(noneContract).not.toContain('hr-contract-nd337-hint');
  });
});

describe('ContractVaultBar deterministic search & cited Vy summary (#4439)', () => {
  const ENV_ID = '01900000-0000-7000-8000-000000000555';
  const MATCH_ITEM: SignVaultMatchItem = {
    envelopeId: ENV_ID,
    title: 'Hợp đồng dịch vụ Minh Anh 2026',
    status: 'completed',
    sourceKind: 'standalone',
    pageCount: 3,
    completedAt: '2026-11-21T08:00:00.000Z',
    updatedAt: '2026-11-21T08:00:00.000Z',
    counterpartyName: 'Công ty TNHH Minh Anh',
    effectiveDate: '2026-12-01',
    expiryDate: '2027-11-30',
    renewalNoticeDays: 30,
    autoRenew: true,
    contractValue: '24000000',
    currency: 'VND',
    score: 26,
    snippets: [
      {
        kind: 'clause',
        pageNumber: 2,
        excerpt: 'Mức phạt chậm thanh toán là 0,05%/ngày trên số tiền quá hạn.',
      },
    ],
  };

  it('pairs explicit Label htmlFor, enforces max-md:min-h-11 phone targets, renders AI-off fallback and cited Vy summary, and mounts on SignEnvelopesPage', () => {
    const aiOffHtml = renderLocale(
      'vi',
      <ContractVaultBar
        slug="acme"
        canAskVy={false}
        initialQuestion="phạt chậm thanh toán"
        initialResult={{
          mode: 'ask',
          ai: 'off',
          items: [MATCH_ITEM],
          summary: null,
        }}
      />,
    );

    expect(aiOffHtml).toContain('for="sign-vault-question-input"');
    expect(aiOffHtml).toContain('id="sign-vault-question-input"');
    expect(aiOffHtml).toContain('max-md:min-h-11');
    expect(aiOffHtml).toContain('data-testid="sign-vault-search-btn"');
    // Viewer (canAskVy=false) does not see Ask Vy button, while deterministic search & matches still work!
    expect(aiOffHtml).not.toContain('data-testid="sign-vault-ask-btn"');
    expect(aiOffHtml).toContain('data-testid="sign-vault-ai-notice"');
    expect(aiOffHtml).toContain(`href="/o/acme/sign/envelopes/${ENV_ID}"`);
    expect(aiOffHtml).toMatch(/24[.,]000[.,]000/);

    const citedVyHtml = renderLocale(
      'vi',
      <ContractVaultBar
        slug="acme"
        canAskVy={true}
        initialQuestion="phạt chậm thanh toán"
        initialResult={{
          mode: 'ask',
          ai: 'used',
          items: [MATCH_ITEM],
          summary: {
            answer: 'Hợp đồng dịch vụ Minh Anh 2026 quy định mức phạt chậm thanh toán 0,05%/ngày.',
            proposedByAi: true,
            citations: [
              {
                envelopeId: ENV_ID,
                envelopeTitle: 'Hợp đồng dịch vụ Minh Anh 2026',
                pageNumber: 2,
                quoteExcerpt: 'Mức phạt chậm thanh toán là 0,05%/ngày trên số tiền quá hạn.',
              },
            ],
          },
        }}
      />,
    );

    expect(citedVyHtml).toContain('data-testid="sign-vault-ask-btn"');
    expect(citedVyHtml).toContain('data-testid="sign-vault-vy-summary"');
    expect(citedVyHtml).toContain('Đề xuất từ Vy');
    expect(citedVyHtml).toContain(`data-testid="sign-vault-citation-link-${ENV_ID}"`);
    expect(citedVyHtml).toContain(`href="/o/acme/sign/envelopes/${ENV_ID}"`);
    expect(citedVyHtml).toContain('Trang 2');
    expect(citedVyHtml).not.toMatch(/[\u2013\u2014]/);

    const qc = new QueryClient();
    qc.setQueryData(['sign', 'envelopes', 'acme', 'all'], { items: [] });
    const pageHtml = renderLocale('vi', <SignEnvelopesPage />, qc);
    expect(pageHtml).toContain('data-testid="sign-contract-vault-card"');
    expect(pageHtml).toContain('Hỏi Vy về kho hợp đồng');
  });
});
