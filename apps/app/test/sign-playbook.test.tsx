// SPDX-License-Identifier: AGPL-3.0-only
// UI rendering, accessibility, RBAC, and i18n copy tests for SME contract playbook (Slice 5d, #4442).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viCatalog } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import type { SignPlaybookGetResult, SignPlaybookRulesListResult } from '../src/lib/sign-api.ts';

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

const { PlaybookRulesCard, parseKeywordsCsv } = await import('../src/components/sign/playbook-rules-card.tsx');
const { EnvelopePlaybookCard } = await import('../src/components/sign/envelope-playbook-card.tsx');

function renderInLocale(locale: 'vi' | 'en', node: ReactNode, client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const RULE_1_ID = '01900000-0000-4000-8000-000000000101';
const RULE_2_ID = '01900000-0000-4000-8000-000000000102';
const ENV_ID = '01900000-0000-7000-8000-000000000201';
const FILE_ID = '01900000-0000-7000-8000-000000000301';

describe('sign.playbook i18n hygiene (#4442)', () => {
  it('contains zero em dashes or en dashes in English and Vietnamese playbook copy', () => {
    const collectStrings = (obj: Record<string, unknown>): string[] =>
      Object.values(obj).flatMap((v) =>
        typeof v === 'string' ? [v] : v && typeof v === 'object' ? collectStrings(v as Record<string, unknown>) : [],
      );

    for (const [locale, cat] of [
      ['en', en.sign.playbook],
      ['vi', viCatalog.sign.playbook],
    ] as const) {
      for (const str of collectStrings(cat as unknown as Record<string, unknown>)) {
        expect(str, locale).not.toMatch(/[\u2013\u2014]/);
      }
    }
    expect(en.aiMeter.features.sign_playbook_check).not.toMatch(/[\u2013\u2014]/);
    expect(viCatalog.aiMeter.features.sign_playbook_check).not.toMatch(/[\u2013\u2014]/);
  });

  it('deduplicates and trims comma-separated match keywords cleanly', () => {
    expect(parseKeywordsCsv(' phạt vi phạm , 8%, Phạt Vi Phạm,  , điều 301 ')).toEqual([
      'phạt vi phạm',
      '8%',
      'điều 301',
    ]);
  });
});

describe('PlaybookRulesCard (/o/$slug/sign/settings, #4442)', () => {
  const sampleRules: SignPlaybookRulesListResult = {
    canManage: true,
    isSeeded: false,
    items: [
      {
        id: RULE_1_ID,
        title: 'Giới hạn phạt vi phạm tối đa 8%',
        guidance: 'Theo Điều 301 Luật Thương mại 2005, mức phạt không vượt quá 8%.',
        severity: 'critical',
        matchKeywords: ['phạt vi phạm', '8%'],
        active: true,
        isDefault: true,
        createdBy: null,
        createdAt: '2027-01-01T00:00:00.000Z',
        updatedAt: '2027-01-01T00:00:00.000Z',
      },
      {
        id: RULE_2_ID,
        title: 'Thời hạn thanh toán không quá 30 ngày',
        guidance: 'Thanh toán trong vòng 30 ngày.',
        severity: 'warn',
        matchKeywords: ['thanh toán', '30 ngày'],
        active: false,
        isDefault: false,
        createdBy: '01900000-0000-7000-8000-000000000011',
        createdAt: '2027-01-02T00:00:00.000Z',
        updatedAt: '2027-01-02T00:00:00.000Z',
      },
    ],
  };

  it('renders owner/admin management actions with 44px touch targets and hides write controls for members', () => {
    const ownerQc = new QueryClient();
    ownerQc.setQueryData(['sign', 'playbook-rules', 'acme'], sampleRules);
    const ownerHtml = renderInLocale('vi', <PlaybookRulesCard slug="acme" role="owner" />, ownerQc);

    expect(ownerHtml).toContain('data-testid="playbook-add-rule-btn"');
    expect(ownerHtml).toContain('data-testid="playbook-restore-defaults-btn"');
    expect(ownerHtml).toContain(`data-testid="playbook-edit-btn-${RULE_1_ID}"`);
    expect(ownerHtml).toContain(`data-testid="playbook-delete-btn-${RULE_1_ID}"`);
    expect(ownerHtml).toContain('min-h-11');
    expect(ownerHtml).toContain('Mặc định VN SME');
    expect(ownerHtml).not.toContain('data-testid="playbook-readonly-notice"');

    const memberQc = new QueryClient();
    memberQc.setQueryData(['sign', 'playbook-rules', 'acme'], { ...sampleRules, canManage: false });
    const memberHtml = renderInLocale('en', <PlaybookRulesCard slug="acme" role="member" />, memberQc);

    expect(memberHtml).toContain('data-testid="playbook-readonly-notice"');
    expect(memberHtml).not.toContain('data-testid="playbook-add-rule-btn"');
    expect(memberHtml).not.toContain(`data-testid="playbook-edit-btn-${RULE_1_ID}"`);
  });
});

describe('EnvelopePlaybookCard (/o/$slug/sign/envelopes/$id, #4442)', () => {
  const sampleCheck: SignPlaybookGetResult = {
    canEdit: true,
    activeRulesCount: 6,
    check: {
      id: '01900000-0000-7000-8000-000000000401',
      envelopeId: ENV_ID,
      sourceSha256: 'a'.repeat(64),
      isStale: false,
      mode: 'ai',
      promptVersion: 'sign-playbook-v1',
      createdBy: '01900000-0000-7000-8000-000000000011',
      createdAt: '2027-02-01T00:00:00.000Z',
      updatedAt: '2027-02-01T00:00:00.000Z',
      findings: [
        {
          ruleId: RULE_1_ID,
          ruleTitle: 'Giới hạn phạt vi phạm tối đa 8%',
          severity: 'critical',
          verdict: 'fail',
          rationale: 'Mức phạt 15% vượt trần 8% theo Điều 301 Luật Thương mại 2005.',
          pageNumber: 2,
          quoteExcerpt: 'Bên vi phạm chịu mức phạt 15% giá trị hợp đồng.',
          suggestedRedline: 'Mức phạt vi phạm tối đa không vượt quá 8% giá trị phần nghĩa vụ bị vi phạm.',
          proposedByAi: true,
          manualNote: null,
          overriddenBy: null,
          overriddenAt: null,
        },
        {
          ruleId: RULE_2_ID,
          ruleTitle: 'Thời hạn thanh toán không quá 30 ngày',
          severity: 'warn',
          verdict: 'pass',
          rationale: 'Thanh toán trong 15 ngày.',
          pageNumber: 1,
          quoteExcerpt: 'Thanh toán trong vòng 15 ngày.',
          suggestedRedline: null,
          proposedByAi: false,
          manualNote: 'Đã thống nhất với kế toán',
          overriddenBy: '01900000-0000-7000-8000-000000000011',
          overriddenAt: '2027-02-01T01:00:00.000Z',
        },
      ],
    },
  };

  it('renders tainted AI proposal badge, page jump buttons, redline copy button, and accessible override labels', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sign', 'playbook-check', ENV_ID], sampleCheck);
    const html = renderInLocale(
      'vi',
      <EnvelopePlaybookCard
        envelopeId={ENV_ID}
        sourceFileId={FILE_ID}
        inspectStatus="passed"
        pdfBytes={null}
        onJumpToPage={vi.fn()}
      />,
      qc,
    );

    expect(html).toContain('data-testid="playbook-run-rule-btn"');
    expect(html).toContain('data-testid="playbook-run-ai-btn"');
    expect(html).toContain('1 đạt · 0 cần xem · 1 không đạt');
    expect(html).toContain(`data-testid="playbook-ai-badge-${RULE_1_ID}"`);
    expect(html).toContain('Đề xuất');
    expect(html).toContain(`data-testid="playbook-jump-page-${RULE_1_ID}"`);
    expect(html).toContain('Trang 2');
    expect(html).toContain(`data-testid="playbook-copy-redline-${RULE_1_ID}"`);
    expect(html).toContain(`for="playbook-verdict-${RULE_1_ID}"`);
    expect(html).toContain(`for="playbook-note-${RULE_1_ID}"`);

    const viewerQc = new QueryClient();
    viewerQc.setQueryData(['sign', 'playbook-check', ENV_ID], { ...sampleCheck, canEdit: false });
    const viewerHtml = renderInLocale(
      'en',
      <EnvelopePlaybookCard
        envelopeId={ENV_ID}
        sourceFileId={FILE_ID}
        inspectStatus="passed"
        pdfBytes={null}
        onJumpToPage={vi.fn()}
      />,
      viewerQc,
    );

    expect(viewerHtml).not.toContain('data-testid="playbook-run-rule-btn"');
    expect(viewerHtml).not.toContain(`data-testid="playbook-override-save-${RULE_1_ID}"`);
    expect(viewerHtml).toContain(`data-testid="playbook-jump-page-${RULE_1_ID}"`);
    expect(viewerHtml).toContain('Đã thống nhất với kế toán');
  });
});
