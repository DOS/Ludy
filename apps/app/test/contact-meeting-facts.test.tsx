// SPDX-License-Identifier: AGPL-3.0-only
// UI unit and SSR tests for ContactMeetingFacts and formatContactBriefDraft (#4991 PM1):
// verifies Vietnamese and English rendering, deterministic draft formatting, viewer and missing-CRM gating,
// collapsible disclosure buttons with mobile 44px hit targets, private draft controls, and second-click putToNotes visibility.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingBriefDraftListOutput, MeetingFactsContact, MeetingFactsOutput, MeetingResearchOutput } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const modules = vi.hoisted(() => ({ list: ['kernel', 'crm', 'finance', 'meetings'] as string[] }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, ...rest }: { children?: ReactNode; to: string }) =>
      createElement('a', { href: to, ...(rest as object) }, children),
  };
});

vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: modules.list }) }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC({ defaultOptions: { queries: { retryOnMount: false, retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts?.input !== undefined ? [...path, opts.input] : path,
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return (opts?: { input?: unknown }) => (opts?.input !== undefined ? [...path, opts.input] : path);
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});

const { ContactMeetingFacts, formatContactBriefDraft } = await import('../src/components/contact-meeting-facts.tsx');

const wrap = (node: ReactNode, locale: 'vi' | 'en' = 'vi') => (
  <QueryClientProvider client={client.current}>
    <IntlProvider locale={locale} messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

const contactFixture = (over: Partial<MeetingFactsContact> = {}): MeetingFactsContact => ({
  partyId: '00000000-0000-4000-8000-000000000011',
  contactName: 'Công ty Hoa Mai',
  deals: [{ dealId: '00000000-0000-4000-8000-000000000021', title: 'Gói tư vấn thuế năm', stage: 'Báo giá', amount: '25000000', expectedClose: '2026-12-31' }],
  latestQuote: { quoteId: '00000000-0000-4000-8000-000000000031', label: 'BG-2026-0042', total: '27000000', status: 'sent', validUntil: '2026-12-20', expired: false, sentOn: '2026-11-20' },
  invoices: { openCount: 2, overdueAmount: '1500000', lastInvoiceDate: '2026-11-10', lastPaidDate: '2026-11-01' },
  messages: ['Chị cần thêm 3 tài khoản trong tháng này'],
  ...over,
});

const factsFixture = (contacts: MeetingFactsContact[] = [contactFixture()]): MeetingFactsOutput => ({
  targetKind: 'meeting',
  targetId: '00000000-0000-4000-8000-000000000099',
  wordsAllowed: true,
  contacts,
});

const emptyDrafts: MeetingBriefDraftListOutput = { drafts: [] };

const reset = () => {
  client.current.clear();
  modules.list = ['kernel', 'crm', 'finance', 'meetings'];
};

describe('formatContactBriefDraft (#4991)', () => {
  it('formats deals, quotes, invoice summary, and messages deterministically with zero em dashes', () => {
    const out = formatContactBriefDraft(
      contactFixture(),
      {
        heading: 'Chuẩn bị trước họp: Công ty Hoa Mai',
        deals: 'Cơ hội đang mở',
        noDeals: 'Chưa có cơ hội đang mở.',
        quote: 'Báo giá đã gửi gần nhất',
        noQuote: 'Chưa gửi báo giá nào.',
        quoteExpired: 'đã hết hạn',
        quoteStatus: { sent: 'đã gửi', accepted: 'đã được chấp nhận', declined: 'bị từ chối', superseded: 'đã thay thế' },
        invoices: 'Hóa đơn và công nợ',
        invoicesSummary: (openCount, overdue, lastInvoice, lastPaid) =>
          `Hóa đơn đang mở: ${openCount}; Quá hạn: ${overdue}; Hóa đơn gần nhất: ${lastInvoice}; Thanh toán gần nhất: ${lastPaid}`,
        messages: 'Tin nhắn đến mới nhất',
        noMessages: 'Không có tin nhắn khách.',
        noDate: 'chưa có',
      },
      {
        money: (v) => `${v} VND`,
        date: (v) => v,
      },
    );
    expect(out).toContain('Chuẩn bị trước họp: Công ty Hoa Mai');
    expect(out).toContain('- Gói tư vấn thuế năm | Báo giá | 25000000 VND | 2026-12-31');
    expect(out).toContain('- BG-2026-0042 | 27000000 VND | đã gửi | 2026-12-20');
    expect(out).toContain('Hóa đơn đang mở: 2; Quá hạn: 1500000 VND');
    expect(out).toContain('- Chị cần thêm 3 tài khoản trong tháng này');
    expect(out).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('ContactMeetingFacts (#4991)', () => {
  it('renders matched contact facts, decimal amounts, Keep-as-draft button, and hides nothing-for-viewer or missing CRM', () => {
    reset();
    const meetingId = '00000000-0000-4000-8000-000000000099';
    client.current.setQueryData(['crm', 'contacts', 'meetingFacts', { targetKind: 'meeting', targetId: meetingId }], factsFixture());
    client.current.setQueryData(['meetings', 'briefDraft', 'list', { targetKind: 'meeting', targetId: meetingId }], emptyDrafts);

    const htmlVi = renderToStaticMarkup(
      wrap(<ContactMeetingFacts slug="acme" targetKind="meeting" targetId={meetingId} linkedMeetingId={meetingId} isRecorder canRead />, 'vi'),
    );
    expect(htmlVi).toContain('data-testid="contact-meeting-facts"');
    expect(htmlVi).toContain('Công ty Hoa Mai');
    expect(htmlVi).toContain('Gói tư vấn thuế năm');
    expect(htmlVi).toContain('BG-2026-0042');
    expect(htmlVi.replace(/\s| /g, '')).toMatch(/25[.,]000[.,]000/);
    expect(htmlVi.replace(/\s| /g, '')).toMatch(/1[.,]500[.,]000/);
    expect(htmlVi).toContain('Chị cần thêm 3 tài khoản trong tháng này');
    expect(htmlVi).toContain('data-testid="contact-facts-keep-draft"');
    expect(htmlVi).toContain('min-h-11');
    expect(htmlVi).not.toContain('data-testid="contact-facts-put-to-notes"');

    // English locale parity.
    const htmlEn = renderToStaticMarkup(
      wrap(<ContactMeetingFacts slug="acme" targetKind="meeting" targetId={meetingId} linkedMeetingId={meetingId} isRecorder canRead />, 'en'),
    );
    expect(htmlEn).toContain('Contact facts before the meeting');
    expect(htmlEn).toContain('Keep as draft');

    // Viewer sees nothing.
    expect(
      renderToStaticMarkup(wrap(<ContactMeetingFacts slug="acme" targetKind="meeting" targetId={meetingId} linkedMeetingId={meetingId} isRecorder={false} canRead={false} />, 'vi')),
    ).toBe('');

    // Without CRM installed, renders nothing.
    modules.list = ['kernel', 'meetings'];
    expect(
      renderToStaticMarkup(wrap(<ContactMeetingFacts slug="acme" targetKind="meeting" targetId={meetingId} linkedMeetingId={meetingId} isRecorder canRead />, 'vi')),
    ).toBe('');

    // With CRM installed but without Meetings installed, facts still render while private draft controls stay hidden.
    modules.list = ['kernel', 'crm', 'finance'];
    const crmOnlyHtml = renderToStaticMarkup(
      wrap(<ContactMeetingFacts slug="acme" targetKind="meeting" targetId={meetingId} canRead />, 'vi'),
    );
    expect(crmOnlyHtml).toContain('Công ty Hoa Mai');
    expect(crmOnlyHtml).not.toContain('data-testid="contact-facts-draft-section"');
  });

  it('shows private draft textarea and second-click Add-to-meeting-notes button only for recorder when a draft exists', () => {
    reset();
    const meetingId = '00000000-0000-4000-8000-000000000099';
    const partyId = '00000000-0000-4000-8000-000000000011';
    client.current.setQueryData(['crm', 'contacts', 'meetingFacts', { targetKind: 'meeting', targetId: meetingId }], factsFixture());
    client.current.setQueryData(['meetings', 'briefDraft', 'list', { targetKind: 'meeting', targetId: meetingId }], {
      drafts: [
        {
          id: '00000000-0000-4000-8000-0000000000aa',
          partyId,
          targetKind: 'agenda',
          targetId: '00000000-0000-4000-8000-0000000000ab',
          body: 'Bản nháp riêng của Lan',
          updatedAt: '2026-11-27T10:00:00.000Z',
        },
      ],
    });

    const htmlRecorder = renderToStaticMarkup(
      wrap(<ContactMeetingFacts slug="acme" targetKind="meeting" targetId={meetingId} linkedMeetingId={meetingId} isRecorder canRead />, 'vi'),
    );
    expect(htmlRecorder).toContain('data-testid="contact-facts-draft-input"');
    expect(htmlRecorder).toContain('Bản nháp riêng của Lan');
    expect(htmlRecorder).toContain('data-testid="contact-facts-put-to-notes"');
    expect(htmlRecorder).toContain('data-testid="contact-facts-remove-draft"');

    // Non-recorder can view/edit private draft but cannot click Add to meeting notes.
    const htmlNonRecorder = renderToStaticMarkup(
      wrap(<ContactMeetingFacts slug="acme" targetKind="meeting" targetId={meetingId} linkedMeetingId={meetingId} isRecorder={false} canRead />, 'vi'),
    );
    expect(htmlNonRecorder).toContain('data-testid="contact-facts-draft-input"');
    expect(htmlNonRecorder).not.toContain('data-testid="contact-facts-put-to-notes"');
  });

  it('renders an accessible collapsible toggle with 44px mobile tap target and matching aria-label on agenda/booking rows', () => {
    reset();
    const html = renderToStaticMarkup(
      wrap(
        <ContactMeetingFacts
          slug="acme"
          targetKind="agenda"
          targetId="00000000-0000-4000-8000-000000000077"
          collapsible
          rowLabel="Họp với Hoa Mai"
          canRead
        />,
        'vi',
      ),
    );
    expect(html).toContain('data-testid="contact-facts-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Thông tin trước họp cho Họp với Hoa Mai"');
    expect(html).toContain('min-h-11');
    expect(html).not.toContain('data-testid="contact-meeting-facts"');
  });

  it('renders PM2 "Nhờ Dy chuẩn bị", confirmed website URL before fetch, AI-off message, and formats Dy draft quotes cleanly (#4992)', () => {
    reset();
    const meetingId = '00000000-0000-4000-8000-000000000099';
    const withSite = contactFixture();
    withSite.websiteUrl = 'https://hoamai.test';
    client.current.setQueryData(['crm', 'contacts', 'meetingFacts', { targetKind: 'meeting', targetId: meetingId }], factsFixture([withSite]));
    client.current.setQueryData(['meetings', 'briefDraft', 'list', { targetKind: 'meeting', targetId: meetingId }], emptyDrafts);
    client.current.setQueryData(['ai', 'meter', { module: 'crm' }], {
      aiOn: false,
      state: 'none',
      percent: null,
      scope: null,
      resetAt: '2026-12-01T00:00:00.000Z',
    });

    const htmlAiOff = renderToStaticMarkup(
      wrap(<ContactMeetingFacts slug="acme" targetKind="meeting" targetId={meetingId} linkedMeetingId={meetingId} isRecorder canRead />, 'vi'),
    );
    expect(htmlAiOff).toContain('Nhờ Dy chuẩn bị');
    expect(htmlAiOff).toContain('data-testid="contact-facts-website-confirm"');
    expect(htmlAiOff).toContain('https://hoamai.test');
    expect(htmlAiOff).toContain('data-testid="contact-facts-research-btn"');
    expect(htmlAiOff).toContain('min-h-11');
    expect(htmlAiOff).toContain('break-all');
    expect(htmlAiOff).toContain('data-testid="contact-facts-research-status"');
    expect(htmlAiOff).toContain('AI đang tắt nên Dy chưa viết tóm tắt.');
    expect(htmlAiOff).not.toContain('checked=""');

    // Free-mail contact with websiteUrl: null hides website confirmation checkbox.
    const withoutSite = contactFixture();
    withoutSite.websiteUrl = null;
    client.current.setQueryData(['crm', 'contacts', 'meetingFacts', { targetKind: 'meeting', targetId: meetingId }], factsFixture([withoutSite]));
    const htmlNoSite = renderToStaticMarkup(
      wrap(<ContactMeetingFacts slug="acme" targetKind="meeting" targetId={meetingId} linkedMeetingId={meetingId} isRecorder canRead />, 'vi'),
    );
    expect(htmlNoSite).not.toContain('data-testid="contact-facts-website-confirm"');

    // Private draft helper includes Dy's summary, points, and quotes marked "từ trang web của họ" (never unquoted page HTML).
    const research: MeetingResearchOutput = {
      ai: 'ok',
      partyId: withSite.partyId,
      websiteUrl: 'https://hoamai.test',
      websiteOutcome: 'used',
      summary: 'Công ty Hoa Mai đang mở cơ hội gói CRM 2026.',
      points: ['Chốt báo giá gần nhất.', 'Hỏi thêm về quy mô 30 đại lý.'],
      websiteQuotes: ['30 đại lý toàn quốc'],
      tainted: true,
    };
    const draftWithResearch = formatContactBriefDraft(
      withSite,
      {
        heading: 'Chuẩn bị trước họp: Công ty Hoa Mai',
        deals: 'Cơ hội đang mở',
        noDeals: 'Chưa có cơ hội đang mở.',
        quote: 'Báo giá đã gửi gần nhất',
        noQuote: 'Chưa gửi báo giá nào.',
        quoteExpired: 'đã hết hạn',
        quoteStatus: { sent: 'đã gửi', accepted: 'đã được chấp nhận', declined: 'bị từ chối', superseded: 'đã thay bằng bản mới' },
        invoices: 'Hóa đơn và công nợ',
        invoicesSummary: (open, overdue) => `Mở: ${open}, quá hạn: ${overdue}`,
        messages: 'Tin nhắn đến mới nhất',
        noMessages: 'Không có tin nhắn.',
        noDate: 'chưa có',
        researchHeading: 'Bản tóm tắt gợi ý của Dy (bản nháp)',
        researchWebsiteQuote: (quote) => `“${quote}” (từ trang web của họ)`,
      },
      { money: (v) => `${v} VND`, date: (d) => d },
      research,
    );
    expect(draftWithResearch).toContain('Bản tóm tắt gợi ý của Dy (bản nháp):');
    expect(draftWithResearch).toContain('Công ty Hoa Mai đang mở cơ hội gói CRM 2026.');
    expect(draftWithResearch).toContain('“30 đại lý toàn quốc” (từ trang web của họ)');
    expect(draftWithResearch).not.toContain('\u2014');
  });
});
