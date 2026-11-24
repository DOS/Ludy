// SPDX-License-Identifier: AGPL-3.0-only
// UI, accessibility (>=44px mobile targets), bilingual i18n, and citation link tests for /hr/my Stage 6A (#4526).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HrSelfPolicyQaResult, HrSelfRequestDraftResult } from '@ludy/kernel-contract';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme-corp' }),
  Link: ({
    children,
    to,
    params,
    search,
    ...rest
  }: {
    children?: ReactNode;
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    [key: string]: unknown;
  }) => {
    const base = to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '');
    const qs = search ? new URLSearchParams(search).toString() : '';
    return <a href={qs ? `${base}?${qs}` : base} {...rest}>{children}</a>;
  },
}));

vi.mock('../src/lib/api.ts', () => ({
  orpc: {},
  client: {
    hr: {
      self: {
        requestDraft: vi.fn(),
        policyQa: vi.fn(),
      },
    },
  },
  getCurrentOrg: () => 'acme-corp',
  queryClient: new QueryClient(),
  errorMessage: (e: unknown) => String(e),
}));

const { HrSelfCoworkerCard } = await import('../src/components/hr-self-coworker-card.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const NOTE_ID = '00000000-0000-7000-8000-000000000901';

function wrap(ui: ReactNode, locale: 'vi' | 'en'): string {
  setActiveLocale(locale);
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function collectLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? [p] : collectLeafKeys(v as Record<string, unknown>, p);
  });
}

describe('HR Stage 6A self-service coworker UI (#4526)', () => {
  it('ships complete VI/EN coworker translations with zero em/en dashes and zero forbidden assistant labels', () => {
    expect(collectLeafKeys(viMessages.hrMy.coworker)).toEqual(collectLeafKeys(enMessages.hrMy.coworker));
    const serialized = JSON.stringify({
      vi: viMessages.hrMy.coworker,
      en: enMessages.hrMy.coworker,
      viBadge: viMessages.hrMy.leave.aiDraftBadge,
      enBadge: enMessages.hrMy.leave.aiDraftBadge,
    });
    expect(serialized).not.toMatch(/[\u2013\u2014]/);
    expect(serialized).not.toMatch(/assistant|trợ lý/i);
    expect(viMessages.aiMeter.features.hr_request_draft).toBeTruthy();
    expect(enMessages.aiMeter.features.hr_request_draft).toBeTruthy();
    expect(viMessages.aiMeter.features.hr_policy_qa).toBeTruthy();
    expect(enMessages.aiMeter.features.hr_policy_qa).toBeTruthy();
  });

  it('renders AI-draft badge, leave/OT pre-fill controls, trip hint, and >=44px mobile touch targets', () => {
    const leaveDraft: HrSelfRequestDraftResult = {
      aiStatus: 'off',
      source: 'deterministic',
      tainted: true,
      draft: {
        kind: 'leave',
        startOn: '2026-11-27',
        endOn: '2026-11-27',
        leaveKind: 'annual_leave',
        days: '0.5',
        reason: 'xin nghi phep chieu thu 6',
        halfDaySession: 'afternoon',
      },
    };
    const htmlVi = wrap(
      <HrSelfCoworkerCard
        linked
        onApplyLeave={() => undefined}
        onApplyOvertime={() => undefined}
        initialDraftResult={leaveDraft}
      />,
      'vi',
    );
    expect(htmlVi).toContain('data-testid="hr-my-ly-card"');
    expect(htmlVi).toContain('data-testid="hr-my-ly-draft-input"');
    expect(htmlVi).toContain('max-md:min-h-11');
    expect(htmlVi).toContain('data-testid="hr-my-ly-draft-badge"');
    expect(htmlVi).toContain('data-testid="hr-my-ly-draft-ai-off"');
    expect(htmlVi).toContain('data-testid="hr-my-ly-half-day-session"');
    expect(htmlVi).toContain('Buổi chiều');
    expect(htmlVi).toContain('data-testid="hr-my-ly-apply-leave"');

    const tripDraft: HrSelfRequestDraftResult = {
      aiStatus: 'off',
      source: 'deterministic',
      tainted: true,
      draft: {
        kind: 'business_trip_unsupported',
        startOn: '2026-11-25',
        endOn: '2026-11-26',
        destination: 'Da Nang',
        reason: 'di cong tac Da Nang 2 ngay',
        hint: 'Business trip requests are scheduled for Stage 6B.',
      },
    };
    const htmlEn = wrap(
      <HrSelfCoworkerCard
        linked
        onApplyLeave={() => undefined}
        onApplyOvertime={() => undefined}
        initialDraftResult={tripDraft}
      />,
      'en',
    );
    expect(htmlEn).toContain('data-testid="hr-my-ly-draft-trip-hint"');
    expect(htmlEn).toContain('Da Nang');
  });

  it('renders policy Q&A notes_off, AI-off excerpts, and verified clickable note citations', () => {
    const notesOff: HrSelfPolicyQaResult = {
      notesAvailable: false,
      aiStatus: 'notes_off',
      tainted: false,
      answer: null,
      citations: [],
      matches: [],
    };
    const offHtml = wrap(
      <HrSelfCoworkerCard
        linked={false}
        onApplyLeave={() => undefined}
        onApplyOvertime={() => undefined}
        initialQaResult={notesOff}
      />,
      'vi',
    );
    expect(offHtml).not.toContain('data-testid="hr-my-ly-draft-section"');
    expect(offHtml).toContain('data-testid="hr-my-ly-qa-notes-off"');

    const qaWithCitation: HrSelfPolicyQaResult = {
      notesAvailable: true,
      aiStatus: 'used',
      tainted: true,
      answer: 'Nhân viên được hưởng 12 ngày phép năm.',
      citations: [
        {
          noteId: NOTE_ID,
          title: 'Chính sách nghỉ phép',
          excerpt: '12 ngày phép năm có lương',
          visibility: 'org',
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
      ],
      matches: [
        {
          noteId: NOTE_ID,
          title: 'Chính sách nghỉ phép',
          excerpt: '12 ngày phép năm có lương',
          visibility: 'org',
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
      ],
    };
    const citedHtml = wrap(
      <HrSelfCoworkerCard
        linked
        onApplyLeave={() => undefined}
        onApplyOvertime={() => undefined}
        initialQaResult={qaWithCitation}
      />,
      'en',
    );
    expect(citedHtml).toContain('data-testid="hr-my-ly-qa-answer"');
    expect(citedHtml).toContain('data-testid="hr-my-ly-qa-disclaimer"');
    expect(citedHtml).toContain('HR coworker Ly');
    expect(citedHtml).toContain(`data-testid="hr-my-ly-citation-link-${NOTE_ID}"`);
    expect(citedHtml).toContain(`/o/acme-corp/notes?note=${NOTE_ID}`);
  });
});
