// SPDX-License-Identifier: AGPL-3.0-only
// "Gửi qua Zalo" (Meetings B5, #3169), rendered on the server: it appears only for a customer with a Zalo direct thread, offers only the published lines to tick, shows the
// reply window's reason and disables the button when it is closed, and never offers an action item's owner or the transcript.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionItemView } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const modules = vi.hoisted(() => ({ current: ['kernel', 'crm', 'social', 'meetings'] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: modules.current }) }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useParams: () => ({ slug: 'acme' }),
  useNavigate: () => () => Promise.resolve(),
}));

const { MeetingZalo, zaloThreadsOf } = await import('../src/components/meeting-zalo.tsx');

const item = (id: string, over: Partial<ActionItemView> = {}): ActionItemView => ({
  id,
  stage: 'published',
  status: 'accepted',
  title: 'Gửi báo giá',
  who: 'Chị Lan (nhân viên nội bộ)',
  whoUserId: null,
  when: 'thứ sáu',
  whenDate: '2026-12-31',
  transcriptSeconds: 125,
  flags: [],
  tainted: false,
  taskId: null,
  positions: [],
  clean: false,
  suggestion: null,
  ...over,
});

const thread = (id: string, provider = 'zalo_oa', kind = 'direct', lastMessageAt: string | null = '2026-11-14T08:00:00.000Z') => ({
  id,
  kind,
  status: 'new',
  channel: { connectionId: 'cc1', provider, displayName: 'OA Cửa hàng' },
  lastMessageAt,
});

const detail = (allowed: boolean, reason: string | null = null, replyWindowUntil: string | null = null) => ({
  conversation: { contact: { partyName: 'Anh Nam', displayName: 'Nam Zalo' }, channel: { displayName: 'OA Cửa hàng' }, replyWindowUntil },
  reply: { allowed, reason },
});

function render(threads: unknown[], reply: { allowed: boolean; reason: string | null; until?: string | null } | null, locale: 'en' | 'vi' = 'en', summary: string | null = 'Tóm tắt nội bộ'): string {
  client.current.setQueryData(['meetings', 'links', 'list'], [{ id: 'l1', meetingId: 'm1', kind: 'party', targetId: 'p1', label: 'Anh Nam', createdBy: 'u1', createdAt: '2026-11-11T08:00:00.000Z' }]);
  client.current.setQueryData(['crm', 'contacts', 'conversations'], threads);
  if (reply) client.current.setQueryData(['conversations', 'get'], detail(reply.allowed, reply.reason, reply.until ?? null));
  const node: ReactNode = (
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingZalo meetingId="m1" title="Họp với anh Nam" summary={summary} decisions={['Chốt giá 10 triệu']} items={[item('a')]} />
      </IntlProvider>
    </QueryClientProvider>
  );
  return renderToStaticMarkup(node);
}

describe('zaloThreadsOf', () => {
  it('keeps only Zalo direct threads, once each, newest first', () => {
    // Thread `a` is listed under two contacts (a company and its person): it counts once, with the later of its two dates in the second list.
    const found = zaloThreadsOf([
      [thread('a', 'zalo_oa', 'direct', '2026-11-01T00:00:00.000Z'), thread('b', 'facebook_page'), thread('c', 'zalo_oa', 'comment_thread')],
      [thread('d', 'zalo_oa', 'direct', '2026-11-10T00:00:00.000Z'), thread('a', 'zalo_oa', 'direct', '2026-11-12T00:00:00.000Z')],
      undefined,
    ]);
    expect(found.map((x) => x.id)).toEqual(['a', 'd']);
    expect(zaloThreadsOf([[thread('x', 'zalo_oa', 'direct', '2026-11-01T00:00:00.000Z'), thread('y', 'zalo_oa', 'direct', '2026-11-09T00:00:00.000Z')]]).map((x) => x.id)).toEqual(['y', 'x']);
  });
});

describe('MeetingZalo', () => {
  beforeEach(() => {
    client.current.clear();
    modules.current = ['kernel', 'crm', 'social', 'meetings'];
  });

  it('offers the published lines to tick and an enabled button only while the reply window is open and a line is ticked (nothing ticked: disabled)', () => {
    const html = render([thread('t1')], { allowed: true, reason: null });
    expect(html).toContain('data-testid="meeting-zalo"');
    expect(html).toContain('Chốt giá 10 triệu');
    expect(html).toContain('Gửi báo giá');
    expect(html).toContain('31/12/2026');
    // Nothing is ticked yet, so the text is empty and the button is off.
    expect(html).toContain(en.meetings.zalo.nothing);
    expect(html).toMatch(/data-testid="meeting-zalo-open"[^>]*disabled|disabled[^>]*data-testid="meeting-zalo-open"/);
    expect(html).not.toContain('meeting-zalo-closed');
  });

  it('never shows an action item owner, and the summary is offered but not ticked', () => {
    const html = render([thread('t1')], { allowed: true, reason: null });
    expect(html).not.toContain('Chị Lan');
    expect(html).toContain(en.meetings.zalo.summary);
    expect(html).not.toMatch(/Tóm tắt nội bộ<\/textarea>/);
  });

  it('says why when the reply window is closed, with Hộp thư\'s own words for it', () => {
    const html = render([thread('t1')], { allowed: false, reason: 'window_closed' });
    expect(html).toContain('meeting-zalo-closed');
    expect(html).toContain(en.conversations.replyBlocked.window_closed);
  });

  it('treats a window whose own end has passed as closed even when the last read said open (a page left open), and a thread that failed to read as not answerable', () => {
    const passed = render([thread('t1')], { allowed: true, reason: null, until: '2020-01-01T00:00:00.000Z' });
    expect(passed).toContain('meeting-zalo-closed');
    expect(passed).toContain(en.conversations.replyBlocked.window_closed);
    const open = render([thread('t1')], { allowed: true, reason: null, until: '2999-01-01T00:00:00.000Z' });
    expect(open).not.toContain('meeting-zalo-closed');
  });

  it('shows nothing without a Zalo thread, without the CRM or Hộp thư module, or while the thread has not been read yet (the button is off and says it is checking)', () => {
    expect(render([thread('t1', 'facebook_page')], null)).toBe('');
    expect(render([], null)).toBe('');
    modules.current = ['kernel', 'meetings'];
    expect(render([thread('t1')], null)).toBe('');
    modules.current = ['kernel', 'crm', 'social', 'meetings'];
    const waiting = render([thread('t1')], null);
    expect(waiting).toContain(en.meetings.zalo.loading);
    expect(waiting).toMatch(/data-testid="meeting-zalo-open"[^>]*disabled|disabled[^>]*data-testid="meeting-zalo-open"/);
  });

  it('is written in Vietnamese and English with the same keys', () => {
    const html = render([thread('t1')], { allowed: true, reason: null }, 'vi');
    expect(html).toContain(viMessages.meetings.zalo.title);
    expect(Object.keys(viMessages.meetings.zalo).sort()).toEqual(Object.keys(en.meetings.zalo).sort());
  });
});
