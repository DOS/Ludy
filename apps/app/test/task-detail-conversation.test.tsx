// SPDX-License-Identifier: AGPL-3.0-only
// The task detail page and the way back to the Inbox thread (#3421): the link shows for a task whose source is a conversation, and for no other. Rendered on the
// server with the queries answered from a seeded cache, as ai-usage-screen.test.tsx does.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const authState = vi.hoisted(() => ({ modules: ['kernel', 'social'] as string[] }));
const TASK = '20000000-0000-4000-8000-000000000001';
const THREAD = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: authState.modules }) }));
vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    useParams: () => ({ slug: 'demo-org', id: TASK }),
    Link: ({ children, to, params, search, className }: { children?: ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string>; className?: string }) => {
      const path = Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to);
      const query = search ? `?${new URLSearchParams(search).toString()}` : '';
      return createElement('a', { href: path + query, className }, children);
    },
  };
});

const { TaskDetailPage } = await import('../src/routes/tasks.tsx');

function page(sourceRef: unknown): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['org', 'get'], { role: 'owner', members: [] });
  qc.setQueryData(['chart', 'get'], { root: [], positions: [], agents: [], killSwitches: [] });
  qc.setQueryData(['tasks', 'get'], {
    task: { id: TASK, title: 'Gọi lại khách', status: 'todo', description: null, due: null, checklist: [], createdAt: '2026-11-16T09:00:00.000Z', tainted: false, checkedOut: false, assigneePositionId: null, sourceRef },
    comments: [],
    proposal: null,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
        <TaskDetailPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('TaskDetailPage conversation link (#3421)', () => {
  beforeEach(() => {
    authState.modules = ['kernel', 'social'];
  });

  it('links a task made from a conversation to that thread in the Inbox', () => {
    const html = page({ type: 'kernel.conversation', id: THREAD });
    expect(html).toContain('Gọi lại khách');
    expect(html).toContain(`href="/o/demo-org/social/inbox?c=${THREAD}"`);
    expect(html).toContain('Open the conversation');
  });

  it('shows no such link for another source, none, or a malformed one', () => {
    for (const ref of [null, {}, { type: 'social.post', id: THREAD }, { type: 'kernel.conversation', id: 'nope' }]) {
      const html = page(ref);
      expect(html).toContain('Gọi lại khách');
      expect(html).not.toContain('/social/inbox');
    }
  });

  it('shows no link with the Engage module off', () => {
    authState.modules = ['kernel'];
    const html = page({ type: 'kernel.conversation', id: THREAD });
    expect(html).toContain('Gọi lại khách');
    expect(html).not.toContain('/social/inbox');
  });
});
