// SPDX-License-Identifier: AGPL-3.0-only
// Home Today copy verification and UI rendering/accessibility tests for eSign Slice 4e (#3821).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viCatalog } from '../src/i18n/messages/vi.ts';
import { catalog, translatorFor } from '../src/i18n/runtime.ts';
import type { SignEnvelopeObligationRecordContract, SignObligationRenewalListItem } from '../src/lib/sign-api.ts';

const routerState = vi.hoisted(() => ({
  slug: 'acme',
  id: '01900000-0000-7000-8000-000000000001',
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({
      children,
      to,
      params,
      className,
    }: {
      children?: ReactNode;
      to: string;
      params?: Record<string, string>;
      className?: string;
    }) =>
      createElement(
        'a',
        {
          href: to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? ''),
          ...(className ? { className } : {}),
        },
        children,
      ),
    useParams: () => ({ slug: routerState.slug, id: routerState.id }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  return {
    orpc: {},
    queryClient: new QC(),
    client: {},
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: vi.fn(),
    fetchFile: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

const {
  EnvelopeObligationsCard,
  hasVisibleObligationProposalFields,
  resolveProposalLoadIntoForm,
} = await import('../src/components/sign/envelope-obligations-card.tsx');
const { SignEnvelopesPage } = await import('../src/routes/sign-envelopes.tsx');

function renderVi(node: ReactNode, client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function renderEn(node: ReactNode, client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={catalog('en')} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const TITLES: Array<{ key: string; params: Record<string, string | number> }> = [
  { key: 'sign.obligationExpiryToday', params: {} },
  { key: 'sign.obligationRenewalWindowOpen', params: { days: 12 } },
  { key: 'sign.obligationRenewalSoon', params: { days: 20 } },
  { key: 'sign.obligationOverdueDays', params: { days: 4 } },
  { key: 'sign.obligationDueToday', params: {} },
  { key: 'sign.obligationDueSoon', params: { days: 5 } },
  { key: 'sign.obligationMore', params: { count: 3 } },
];

type Say = (key: string, values?: Record<string, string | number>) => string;
const sayIn = (lang: 'en' | 'vi'): Say => translatorFor(lang) as unknown as Say;

const source = readFileSync(
  fileURLToPath(new URL('../../../modules/sign/src/obligations.ts', import.meta.url)),
  'utf8',
);
const sourceKeys = [...new Set([...source.matchAll(/key:\s*'(sign\.[A-Za-z]+)'/g)].map((m) => m[1] as string))];

describe('eSign obligations Today items in words (#3821)', () => {
  it('covers every title key emitted by modules/sign/src/obligations.ts in both vi and en with zero dashes or coworker names', () => {
    expect(sourceKeys.sort()).toEqual(TITLES.map((t) => t.key).sort());

    for (const [locale, cat] of [
      ['en', en],
      ['vi', viCatalog],
    ] as const) {
      const signItems = (cat as unknown as { today: { items: { sign: Record<string, unknown> } } }).today.items.sign;
      for (const fullKey of sourceKeys) {
        const subKey = fullKey.replace(/^sign\./, '');
        expect(typeof signItems[subKey], `${locale} ${fullKey}`).toBe('string');
      }
    }

    for (const lang of ['en', 'vi'] as const) {
      const say = sayIn(lang);
      for (const title of TITLES) {
        const text = say(`today.items.${title.key}`, title.params);
        expect(text, `${lang} ${title.key}`).not.toContain('today.items');
        expect(text, `${lang} ${title.key}`).not.toMatch(/[\u2013\u2014]/);
        expect(text, `${lang} ${title.key}`).not.toMatch(/\b(Vy|Ly|Dy|Uy)\b/);
        expect(text, `${lang} ${title.key}`).not.toMatch(/assistant|trợ lý/i);
        for (const [name, value] of Object.entries(title.params)) {
          expect(text, `${lang} ${title.key} ${name}`).toContain(String(value));
        }
      }
    }
  });
});

describe('EnvelopeObligationsCard and Renewals tab (#3821)', () => {
  const ENV_ID = '01900000-0000-7000-8000-000000000001';
  const ORG_ID = '01900000-0000-7000-8000-000000000099';

  it('renders tainted Vy proposal banner with PDF page jump buttons, manual form controls, and paired Label htmlFor attributes', () => {
    const proposedRecord: SignEnvelopeObligationRecordContract = {
      id: '01900000-0000-7000-8000-000000000010',
      orgId: ORG_ID,
      envelopeId: ENV_ID,
      status: 'proposed',
      counterpartyName: null,
      effectiveDate: null,
      expiryDate: null,
      renewalNoticeDays: null,
      autoRenew: false,
      contractValue: null,
      currency: 'GBP',
      obligations: [],
      proposal: {
        counterpartyName: 'Công ty TNHH Minh Anh',
        effectiveDate: '2026-12-01',
        expiryDate: '2027-11-30',
        renewalNoticeDays: 30,
        autoRenew: true,
        contractValue: '24000000',
        currency: 'VND',
        citations: [
          {
            field: 'contractValue',
            pageNumber: 1,
            quoteExcerpt: 'Tổng giá trị thanh toán là 24.000.000 VND',
          },
        ],
        obligations: [
          {
            id: 'obl-1',
            title: 'Thanh toán đợt 1',
            dueDate: '2026-12-15',
            status: 'pending',
            pageNumber: 2,
            quoteExcerpt: 'Thanh toán đợt 1 trước ngày 15/12/2026',
            proposedByAi: true,
          },
        ],
        proposedByAi: true,
      },
      promptVersion: 'v1',
      confirmedBy: null,
      confirmedAt: null,
      createdBy: ORG_ID,
      createdAt: '2026-11-21T00:00:00Z',
      updatedAt: '2026-11-21T00:00:00Z',
    };

    const qc = new QueryClient();
    qc.setQueryData(['sign', 'obligation', ENV_ID], { obligation: proposedRecord, canEdit: true });

    const htmlVi = renderVi(
      <EnvelopeObligationsCard
        envelopeId={ENV_ID}
        sourceFileId="01900000-0000-7000-8000-000000000020"
        pdfBytes={null}
        onJumpToPage={() => {}}
      />,
      qc,
    );

    expect(htmlVi).toContain('sign-obligations-card');
    expect(htmlVi).toContain('Đề xuất từ Vy');
    expect(htmlVi).toContain('sign-obligation-proposal-banner');
    expect(htmlVi).toContain('Trang 1');
    expect(htmlVi).toContain('Trang 2');
    expect(htmlVi).toContain('Đưa vào biểu mẫu');
    expect(htmlVi).toContain('Xác nhận &amp; lưu');
    expect(htmlVi).toContain('value="GBP"');

    // Verify paired explicit htmlFor/id accessibility labels on manual form fields.
    for (const id of [
      'sign-obl-counterparty',
      'sign-obl-effective-date',
      'sign-obl-expiry-date',
      'sign-obl-notice-days',
      'sign-obl-auto-renew',
      'sign-obl-contract-value',
      'sign-obl-currency',
    ]) {
      expect(htmlVi, `for=${id}`).toContain(`for="${id}"`);
      expect(htmlVi, `id=${id}`).toContain(`id="${id}"`);
    }

    // Verify 44px phone touch targets (max-md:min-h-11) on every visible manual obligation control (#4279).
    const controlTags = [
      ...htmlVi.matchAll(/<input(?![^>]*aria-hidden="true")[^>]*id="sign-obl-[^"]+"[^>]*>/g),
      ...htmlVi.matchAll(/<select[^>]*id="sign-obl-currency"[^>]*>/g),
    ].map((match) => match[0]);
    expect(controlTags).toHaveLength(6);
    for (const tag of controlTags) {
      expect(tag).toContain('max-md:min-h-11');
    }
    expect(htmlVi).toMatch(/<label[^>]*for="sign-obl-auto-renew"[^>]*max-md:min-h-11[^>]*>/);
  });

  it('renders read-only confirmed terms with formatted decimal money for viewers and exposes the Renewals tab on SignEnvelopesPage', () => {
    const confirmedRecord: SignEnvelopeObligationRecordContract = {
      id: '01900000-0000-7000-8000-000000000011',
      orgId: ORG_ID,
      envelopeId: ENV_ID,
      status: 'confirmed',
      counterpartyName: 'Công ty TNHH Minh Anh',
      effectiveDate: '2026-12-01',
      expiryDate: '2027-11-30',
      renewalNoticeDays: 30,
      autoRenew: true,
      contractValue: '24000000',
      currency: 'VND',
      obligations: [
        {
          id: 'obl-1',
          title: 'Thanh toán đợt 1',
          dueDate: '2026-12-15',
          status: 'pending',
          completedAt: null,
          pageNumber: 2,
          quoteExcerpt: null,
          proposedByAi: false,
        },
      ],
      proposal: null,
      promptVersion: null,
      confirmedBy: ORG_ID,
      confirmedAt: '2026-11-21T01:00:00Z',
      createdBy: ORG_ID,
      createdAt: '2026-11-21T00:00:00Z',
      updatedAt: '2026-11-21T01:00:00Z',
    };

    const qc = new QueryClient();
    qc.setQueryData(['sign', 'obligation', ENV_ID], { obligation: confirmedRecord, canEdit: false });
    const listEnvelopeItem: SignObligationRenewalListItem['envelope'] = {
      id: ENV_ID,
      title: 'Hợp đồng dịch vụ Minh Anh',
      status: 'completed',
      routingMode: 'parallel',
      sourceKind: 'standalone',
      sourceId: null,
      sourceFileId: '01900000-0000-7000-8000-000000000020',
      inspectStatus: 'passed',
      sealStatus: 'sealed',
      certificateCode: 'CS-2026-ABCD-1234',
      pageCount: 2,
      expiresAt: null,
      sentAt: '2026-11-20T00:00:00Z',
      completedAt: '2026-11-21T00:00:00Z',
      voidedAt: null,
      expiredAt: null,
      version: 3,
      createdBy: ORG_ID,
      createdAt: '2026-11-20T00:00:00Z',
      updatedAt: '2026-11-21T00:00:00Z',
      signerSummary: { total: 1, signed: 1, waitingForMe: false },
    };
    qc.setQueryData(['sign', 'envelopes', 'acme', 'all'], { items: [listEnvelopeItem] });
    const renewalEntry: SignObligationRenewalListItem = {
      envelope: listEnvelopeItem,
      obligation: confirmedRecord,
      renewalNoticeDate: '2027-10-31',
      daysUntilNotice: 12,
      daysUntilExpiry: 42,
      pendingObligationCount: 1,
      overdueObligationCount: 0,
      nextObligationDueDate: '2026-12-15',
    };
    qc.setQueryData(['sign', 'renewals', 'acme'], { items: [renewalEntry] });

    const readonlyHtml = renderEn(
      <EnvelopeObligationsCard
        envelopeId={ENV_ID}
        sourceFileId="01900000-0000-7000-8000-000000000020"
        pdfBytes={null}
        onJumpToPage={() => {}}
      />,
      qc,
    );
    expect(readonlyHtml).toContain('sign-obligation-readonly');
    expect(readonlyHtml).toContain('Counterparty: Công ty TNHH Minh Anh');
    expect(readonlyHtml).toContain('24,000,000');

    const envelopesHtmlVi = renderVi(<SignEnvelopesPage />, qc);
    expect(envelopesHtmlVi).toContain('Sắp gia hạn / Nghĩa vụ');
    expect(envelopesHtmlVi).toContain('sign-tab-renewals');
    expect(envelopesHtmlVi).toMatch(/<a[^>]*class="[^"]*max-md:min-h-11[^"]*"[^>]*>Hợp đồng dịch vụ Minh Anh<\/a>/);

    // Also verify every <Input and <NativeSelect in EnvelopeObligationsCard carries max-md:min-h-11 (including obligation item inputs #4279).
    const cardSource = readFileSync(
      fileURLToPath(new URL('../src/components/sign/envelope-obligations-card.tsx', import.meta.url)),
      'utf8',
    );
    const jsxControls = [...cardSource.matchAll(/<(?:Input|NativeSelect)\b[\s\S]*?onChange=/g)].map((m) => m[0]);
    expect(jsxControls).toHaveLength(8);
    for (const control of jsxControls) {
      expect(control).toContain('max-md:min-h-11');
    }
  });

  it('hides sign-obligation-load-proposal-btn when only depositProposal is present and preserves autoRenew/currency (#4723)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const depositOnlyRecord: SignEnvelopeObligationRecordContract = {
      id: '01900000-0000-7000-8000-000000000445',
      orgId: ORG_ID,
      envelopeId: '01900000-0000-7000-8000-000000000444',
      status: 'confirmed',
      counterpartyName: 'Công ty ABC',
      effectiveDate: null,
      expiryDate: null,
      renewalNoticeDays: null,
      autoRenew: true,
      contractValue: '1500',
      currency: 'USD',
      obligations: [],
      proposal: {
        counterpartyName: null,
        effectiveDate: null,
        expiryDate: null,
        renewalNoticeDays: null,
        autoRenew: false,
        contractValue: null,
        currency: 'VND',
        citations: [],
        obligations: [],
        depositProposal: {
          amount: '5000000',
          currency: 'VND',
          dueDays: 5,
          pageNumber: 1,
          quoteExcerpt: 'Đặt cọc 5.000.000 VNĐ',
          proposedByAi: true,
        },
        proposedByAi: true,
      },
      promptVersion: 'v1',
      confirmedBy: ORG_ID,
      confirmedAt: '2026-11-24T10:05:00.000Z',
      createdBy: ORG_ID,
      createdAt: '2026-11-24T10:00:00.000Z',
      updatedAt: '2026-11-24T10:05:00.000Z',
    };
    qc.setQueryData(['sign', 'obligation', depositOnlyRecord.envelopeId], {
      canEdit: true,
      obligation: depositOnlyRecord,
    });

    expect(hasVisibleObligationProposalFields(depositOnlyRecord.proposal)).toBe(false);
    const htmlDepositOnly = renderEn(
      <EnvelopeObligationsCard
        envelopeId={depositOnlyRecord.envelopeId}
        sourceFileId="01900000-0000-7000-8000-000000000020"
        pdfBytes={null}
        onJumpToPage={() => {}}
      />,
      qc,
    );
    expect(htmlDepositOnly).not.toContain('sign-obligation-load-proposal-btn');
    expect(htmlDepositOnly).toContain('sign-obligation-dismiss-proposal-btn');

    expect(
      resolveProposalLoadIntoForm(depositOnlyRecord.proposal!, {
        contractValue: '1500',
        savedContractValue: '1500',
      }),
    ).toEqual({
      autoRenewUpdate: null,
      contractValueUpdate: null,
      currencyUpdate: null,
    });

    expect(
      resolveProposalLoadIntoForm(
        {
          ...depositOnlyRecord.proposal!,
          autoRenew: true,
          contractValue: '24000000',
          currency: 'VND',
        },
        { contractValue: '1500', savedContractValue: '1500' },
      ),
    ).toEqual({
      autoRenewUpdate: true,
      contractValueUpdate: '24000000',
      currencyUpdate: 'VND',
    });
  });
});
