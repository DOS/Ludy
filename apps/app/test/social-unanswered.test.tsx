// SPDX-License-Identifier: AGPL-3.0-only
// The unanswered platform comment counts on the post list, board and calendar chip (#3298): one batched read for the posts shown, each row's own number, nothing when
// there is none or the read failed. Rendered on the server with the query answered from a seeded cache, as ai-usage-screen.test.tsx does.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_POST_COUNTS_MAX } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, asked: [] as unknown[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => {
            if (path.join('.') === 'conversations.postCounts') client.asked.push(args?.input);
            return { queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) };
          };
        }
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current };
});

const { UnansweredComments, UnansweredProvider, postRefsOf, unansweredByPost } = await import('../src/components/social-unanswered.tsx');

const C1 = '10000000-0000-4000-8000-000000000001';
const C2 = '10000000-0000-4000-8000-000000000002';
const variant = (connectionId: string, externalPostId: string | null, status = 'published') => ({ connectionId, externalPostId, status });
const posts = [
  { id: 'p1', variants: [variant(C1, 'fb-1'), variant(C2, 'ig-1')] },
  { id: 'p2', variants: [variant(C1, 'fb-2')] },
  { id: 'p3', variants: [variant(C1, null), variant(C2, 'ig-3', 'scheduled')] },
];

describe('postRefsOf and unansweredByPost (#3298)', () => {
  it('asks only about the published channels of the posts shown, each platform post once', () => {
    expect(postRefsOf(posts)).toEqual([
      { connectionId: C1, externalPostId: 'fb-1' },
      { connectionId: C2, externalPostId: 'ig-1' },
      { connectionId: C1, externalPostId: 'fb-2' },
    ]);
    expect(postRefsOf([{ id: 'x', variants: [variant(C1, 'fb-1'), variant(C1, 'fb-1')] }])).toEqual([{ connectionId: C1, externalPostId: 'fb-1' }]);
    expect(postRefsOf([])).toEqual([]);
  });

  it('keeps a read within what the kernel allows', () => {
    const many = Array.from({ length: CONVERSATION_POST_COUNTS_MAX + 30 }, (_, i) => ({ id: `p${i}`, variants: [variant(C1, `fb-${i}`)] }));
    expect(postRefsOf(many)).toHaveLength(CONVERSATION_POST_COUNTS_MAX);
  });

  it("sums a post's channels, and leaves out a post with none", () => {
    const counted = unansweredByPost(posts, [
      { connectionId: C1, externalPostId: 'fb-1', unanswered: 2 },
      { connectionId: C2, externalPostId: 'ig-1', unanswered: 3 },
      { connectionId: C1, externalPostId: 'fb-2', unanswered: 1 },
    ]);
    expect([...counted]).toEqual([
      ['p1', 5],
      ['p2', 1],
    ]);
    expect(unansweredByPost(posts, []).size).toBe(0);
  });
});

function render(locale: 'vi' | 'en', counts: unknown) {
  const qc = client.current;
  qc.clear();
  client.asked.length = 0;
  if (counts !== undefined) qc.setQueryData(['conversations', 'postCounts'], counts);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <UnansweredProvider posts={posts}>
          <ul>
            {posts.map((p) => (
              <li key={p.id} data-post={p.id}>
                <UnansweredComments postId={p.id} />
              </li>
            ))}
          </ul>
        </UnansweredProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('UnansweredProvider and UnansweredComments (#3298)', () => {
  beforeEach(() => client.current.clear());

  it('asks once for the whole list, never one read a row', () => {
    render('en', { counts: [] });
    expect(client.asked).toHaveLength(1);
    expect(client.asked[0]).toEqual({ posts: postRefsOf(posts) });
  });

  it('shows each row its own count in Vietnamese and English, and nothing on a row with none', () => {
    const counts = { counts: [{ connectionId: C1, externalPostId: 'fb-1', unanswered: 2 }, { connectionId: C1, externalPostId: 'fb-2', unanswered: 1 }] };
    const vi = render('vi', counts);
    expect(vi).toContain('2 bình luận chưa trả lời');
    expect(vi).toContain('1 bình luận chưa trả lời');
    const en = render('en', counts);
    expect(en).toContain('2 unanswered comments');
    expect(en).toContain('1 unanswered comment<');
    const rows = en.split('<li').slice(1);
    expect(rows[2]).not.toContain('unanswered');
    expect((en.match(/data-testid="unanswered-comments"/g) ?? []).length).toBe(2);
  });

  it('shows nothing before the read answers, or when it failed', () => {
    expect(render('en', undefined)).not.toContain('unanswered');
  });

  it('asks nothing for a screen without a published post', () => {
    const qc = client.current;
    qc.clear();
    client.asked.length = 0;
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <UnansweredProvider posts={[{ id: 'd', variants: [variant(C1, null, 'draft')] }]}>
            <UnansweredComments postId="d" />
          </UnansweredProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    // The query is built (hooks run) but disabled; no read leaves with an empty list, which the kernel would refuse.
    expect(client.asked.every((i) => (i as { posts: unknown[] }).posts.length === 0)).toBe(true);
  });
});
