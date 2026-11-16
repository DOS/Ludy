// SPDX-License-Identifier: AGPL-3.0-only
// The board card's unanswered comment count (#3298): the board asks once for its posts and puts each card's own number on it. Rendered on the server with the queries
// answered from a seeded cache, as ai-usage-screen.test.tsx does.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, asked: [] as unknown[] }));
const C1 = '10000000-0000-4000-8000-000000000001';

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
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { client: node([]), orpc: node([]), queryClient: client.current, errorMessage: String, fetchFile: () => Promise.reject(new Error('not fetched')) };
});
vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    Link: ({ children, to, params, className }: { children?: ReactNode; to: string; params?: Record<string, string>; className?: string }) =>
      createElement('a', { href: Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to), className }, children),
  };
});

const { SocialBoard } = await import('../src/components/social-board.tsx');

const post = (id: string, externalPostId: string, body: string) => ({
  id,
  body,
  title: null,
  status: 'published',
  scheduledAt: null,
  dueAt: null,
  assigneeUserId: null,
  labelIds: [] as string[],
  openComments: 0,
  archivedAt: null,
  variants: [{ id: `v-${id}`, connectionId: C1, provider: 'facebook_page', status: 'published', externalPostId, revision: 1, contentHash: `sha256:${'a'.repeat(64)}`, scheduledAt: null }],
});

function board(counts: unknown) {
  const qc = client.current;
  qc.clear();
  client.asked.length = 0;
  qc.setQueryData(['org', 'get'], { role: 'admin', members: [] });
  if (counts !== undefined) qc.setQueryData(['conversations', 'postCounts'], counts);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
        {/* The fixture carries only what the card reads. */}
        <SocialBoard
          posts={[post('p1', 'fb-1', 'First post'), post('p2', 'fb-2', 'Second post')] as never}
          slug="demo-org"
          names={new Map([[C1, 'Page']])}
          labels={[]}
          canWrite
          canDecide
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('SocialBoard unanswered comment counts (#3298)', () => {
  beforeEach(() => client.current.clear());

  it('asks once for the board and shows each card its own count', () => {
    const html = board({ counts: [{ connectionId: C1, externalPostId: 'fb-1', unanswered: 3 }] });
    expect(client.asked).toHaveLength(1);
    expect((client.asked[0] as { posts: unknown[] }).posts).toHaveLength(2);
    const cards = html.split('data-testid="board-card"').slice(1);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('3 unanswered comments');
    expect(cards[1]).not.toContain('unanswered');
  });

  it('shows no count while the read is out or failed', () => {
    expect(board(undefined)).not.toContain('unanswered');
  });
});
