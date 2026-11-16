// SPDX-License-Identifier: AGPL-3.0-only
// The unanswered comment badge on a calendar chip and on a post list row (#3298): with a count the badge reads "N bình luận chưa trả lời", with none there is no badge.
// Rendered on the server inside the provider, the query answered from a seeded cache, as ai-usage-screen.test.tsx does.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const C1 = '10000000-0000-4000-8000-000000000001';

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
  return { client: node([]), orpc: node([]), queryClient: client.current, errorMessage: String, fetchFile: () => Promise.reject(new Error('not fetched')) };
});
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useNavigate: () => () => Promise.resolve(),
    Link: ({ children, to, params, className, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; className?: string; 'data-testid'?: string }) =>
      createElement('a', { href: Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to), className, 'data-testid': rest['data-testid'] }, children),
  };
});

const { Chip } = await import('../src/components/social-calendar.tsx');
const { PostRow } = await import('../src/routes/social.tsx');
const { UnansweredProvider } = await import('../src/components/social-unanswered.tsx');
const { calendarGroups, calendarItems } = await import('../src/lib/social-calendar.ts');

const post = (id: string, externalPostId: string) => ({
  id,
  body: 'Bài đăng thử',
  title: null,
  status: 'published',
  scheduledAt: '2026-11-16T03:00:00.000Z',
  dueAt: null,
  assigneeUserId: null,
  labelIds: [] as string[],
  openComments: 0,
  archivedAt: null,
  recurrence: null,
  recurrenceSourceId: null,
  updatedAt: '2026-11-16T03:00:00.000Z',
  variants: [
    {
      id: `v-${id}`,
      connectionId: C1,
      provider: 'facebook_page',
      status: 'published',
      externalPostId,
      effectiveAt: '2026-11-16T03:00:00.000Z',
      effective: { body: 'Bài đăng thử' },
      error: null,
    },
  ],
});

const P1 = post('p1', 'fb-1');
const P2 = post('p2', 'fb-2');

function render(locale: 'vi' | 'en', node: (posts: unknown[]) => ReactNode, counts: unknown) {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['conversations', 'postCounts'], counts);
  const posts = [P1, P2];
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        <UnansweredProvider posts={posts as never}>{node(posts)}</UnansweredProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const counted = { counts: [{ connectionId: C1, externalPostId: 'fb-1', unanswered: 2 }] };
const chipOf = (p: ReturnType<typeof post>) => {
  const group = calendarGroups(calendarItems([p as never]))[0];
  if (!group) throw new Error('no chip group');
  return (
    <Chip group={group} slug="demo-org" names={new Map([[C1, 'Trang']])} draggable={false} picked={null} onToggle={() => undefined} onDragStart={() => undefined} onDragEnd={() => undefined} onPlan={null} menu="changeDate" />
  );
};

describe('the calendar chip (#3298)', () => {
  beforeEach(() => client.current.clear());

  it('shows the unanswered count of its post in Vietnamese and English', () => {
    const viHtml = render('vi', () => chipOf(P1), counted);
    expect(viHtml).toContain('data-testid="calendar-chip"');
    expect(viHtml).toContain('2 bình luận chưa trả lời');
    expect(render('en', () => chipOf(P1), counted)).toContain('2 unanswered comments');
  });

  it('shows no badge on a chip whose post has none', () => {
    const html = render('vi', () => chipOf(P2), counted);
    expect(html).toContain('data-testid="calendar-chip"');
    expect(html).not.toContain('unanswered-comments');
    expect(html).not.toContain('chưa trả lời');
  });
});

describe('the post list row (#3298)', () => {
  beforeEach(() => client.current.clear());

  const row = (p: ReturnType<typeof post>) => <PostRow post={p as never} slug="demo-org" names={new Map([[C1, 'Trang']])} labels={[]} right="16/11" />;

  it('shows the unanswered count of its post, and none on a row without', () => {
    const html = render('vi', () => row(P1), counted);
    expect(html).toContain('2 bình luận chưa trả lời');
    const none = render('vi', () => row(P2), counted);
    expect(none).not.toContain('chưa trả lời');
    expect(none).not.toContain('unanswered-comments');
  });
});
