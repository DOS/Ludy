// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingSummary } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC({ defaultOptions: { queries: { retryOnMount: false, retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts?.input && Object.keys(opts.input as object).length > 0 ? [...path, opts.input] : path,
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)), uploadMeetingMedia: vi.fn() };
});
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: ['kernel', 'crm', 'meetings'] }) }));
vi.mock('../src/i18n/provider.tsx', () => ({
  useFormat: () => ({
    date: (v: string) => `d:${v.slice(0, 10)}`,
    dateTime: (v: string) => `dt:${v.slice(0, 16)}`,
    time: (v: string) => `t:${v.slice(11, 16)}`,
    weekdayShort: () => 'Mon',
    number: (v: number | bigint | string) => String(v),
    aiAmount: (v: string) => `$${v}`,
  }),
}));
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    useNavigate: () => vi.fn(),
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string> } & Record<string, unknown>) =>
      createElement('a', { href: to.replace('$slug', params?.slug ?? '').replace('$id', params?.id ?? ''), ...rest }, children),
  };
});

const { MeetingsPage } = await import('../src/routes/meetings.tsx');

const summary = (over: Partial<MeetingSummary> = {}): MeetingSummary => ({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Họp giao ban tuần',
  language: 'vi',
  visibility: 'attendees',
  status: 'ready',
  recorderUserId: '11111111-1111-4111-8111-111111111111',
  startedAt: '2026-11-23T02:00:00.000Z',
  endedAt: '2026-11-23T02:45:00.000Z',
  lengthSeconds: 2700,
  keepVideo: false,
  liveNotes: false,
  summaryTemplate: 'general',
  audioRetentionDate: '2026-12-23',
  textRetentionDate: null,
  hasAudio: true,
  hasVideo: false,
  hasTranscript: true,
  platform: 'meet',
  readersCount: 3,
  createdAt: '2026-11-23T02:00:00.000Z',
  updatedAt: '2026-11-23T02:45:00.000Z',
  ...over,
});

function renderPage(locale: 'en' | 'vi' = 'en') {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <MeetingsPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('MeetingsPage (#4477)', () => {
  beforeEach(() => {
    client.current.clear();
  });

  it('renders tabs with count badges, settings trigger, collapsed utility strip, toolbar, and DataTable rows', () => {
    client.current.setQueryData(['meetings', 'list', { limit: 200 }], [
      summary(),
      summary({
        id: '00000000-0000-4000-8000-000000000002',
        title: 'Review khách hàng',
        visibility: 'org',
        status: 'completed',
        lengthSeconds: 5400,
        hasAudio: true,
        hasVideo: true,
        hasTranscript: false,
        platform: 'zoom',
        readersCount: 1,
      }),
    ]);
    client.current.setQueryData(['meetings', 'today', 'facts'], {
      enabled: true,
      totalMinutes: 60,
      items: [{ event: { id: 'a1', title: 'Họp sáng', startsAt: '2026-11-23T02:00:00Z', endsAt: '2026-11-23T03:00:00Z', timeZone: 'Asia/Ho_Chi_Minh', joinUrl: null, invitees: 2, meetingId: null }, brief: { previous: null, decisions: [], items: [], customer: null, deals: [], empty: true } }],
    });
    client.current.setQueryData(['meetings', 'agenda', 'list', { range: 'upcoming' }], {
      enabled: true,
      events: [
        { id: 'u1', title: 'Họp ngày mai', startsAt: '2026-11-24T02:00:00Z', endsAt: '2026-11-24T03:00:00Z', timeZone: 'Asia/Ho_Chi_Minh', joinUrl: null, invitees: 2, meetingId: null },
        { id: 'u2', title: 'Họp tuần sau', startsAt: '2026-11-28T02:00:00Z', endsAt: '2026-11-28T03:00:00Z', timeZone: 'Asia/Ho_Chi_Minh', joinUrl: null, invitees: 1, meetingId: null },
      ],
    });

    const html = renderPage('en');
    expect(html).toContain('data-testid="meetings-tabs"');
    expect(html).toContain('data-testid="meetings-tab-recorded"');
    expect(html).toContain('data-testid="meetings-tab-today"');
    expect(html).toContain('data-testid="meetings-tab-upcoming"');
    expect(html).toContain('data-testid="meetings-settings-trigger"');
    expect(html).toContain('data-testid="meetings-utility-strip"');
    expect(html).toContain('data-testid="meetings-tool-digest"');
    expect(html).toContain('data-testid="meetings-tool-ask"');
    expect(html).toContain('data-testid="meetings-tool-search"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-testid="meetings-toolbar"');
    expect(html).toContain('data-testid="meetings-filter-trigger"');
    expect(html).toContain('id="meeting-sort"');
    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="meetings-filtered-count"');

    // DataTable rows and badges
    expect(html.match(/data-testid="meeting-row"/g)).toHaveLength(2);
    expect(html).toContain('data-meeting-row-link');
    expect(html).toContain('Họp giao ban tuần');
    expect(html).toContain('Review khách hàng');
    expect(html).toContain(en.meetings.agenda.service.meet);
    expect(html).toContain(en.meetings.agenda.service.zoom);
    expect(html).toContain(en.meetings.badgeTranscript);
    expect(html).toContain('45 min');
    expect(html).toContain('1 h 30 min');
    expect(html).toContain('3 readers');
    expect(html).toContain('1 reader');
    expect(html).toContain('d:2026-12-23');
    const escapeHtmlAttr = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    expect(html).toContain(`data-label="${escapeHtmlAttr(en.meetings.table.colMeeting)}"`);
    expect(html).toContain(`data-label="${escapeHtmlAttr(en.meetings.table.colWhen)}"`);
    expect(html).toContain(`data-label="${escapeHtmlAttr(en.meetings.table.colSummary)}"`);
    expect(html).toContain(`data-label="${escapeHtmlAttr(en.meetings.table.colRetention)}"`);
    // Settings drawer is closed on initial render, so settings cards are not mounted inline.
    expect(html).not.toContain('data-testid="meetings-settings-sheet"');
    expect(html).not.toContain('data-testid="meeting-digest"');

    // Vietnamese rendering
    const htmlVi = renderPage('vi');
    expect(htmlVi).toContain(viMessages.meetings.tabs.recorded);
    expect(htmlVi).toContain(viMessages.meetings.tabs.today);
    expect(htmlVi).toContain(viMessages.meetings.tabs.upcoming);
    expect(htmlVi).toContain(viMessages.meetings.badgeTranscript);
    expect(htmlVi).toContain('3 người đọc');
  });

  it('renders empty state when there are no recorded meetings and error state when loading fails', () => {
    client.current.setQueryData(['meetings', 'list', { limit: 200 }], []);
    const emptyHtml = renderPage('en');
    expect(emptyHtml).toContain(en.meetings.empty);
    expect(emptyHtml).not.toContain('data-testid="meeting-row"');

    client.current.clear();
    client.current
      .getQueryCache()
      .build(client.current, { queryKey: ['meetings', 'list', { limit: 200 }] })
      .setState({ status: 'error', error: new Error('Cannot load meetings'), fetchStatus: 'idle', data: undefined });
    const errHtml = renderPage('en');
    expect(errHtml).toContain('role="alert"');
    expect(errHtml).toContain('Cannot load meetings');
  });
});
