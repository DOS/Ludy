// SPDX-License-Identifier: AGPL-3.0-only
// The task picker of the project's "add an existing task" dialog marks the title an AI coworker wrote (#4421).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const testState = vi.hoisted(() => ({ client: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: ['kernel', 'projects'] }) }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  testState.client = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: async () => ({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const api = node([]);
  return { orpc: api, client: api, clientForOrg: () => api, queryClient: testState.client, errorMessage: (e: unknown) => String(e) };
});

// The dialog portals to the body, which the server does not render: these stand-ins draw its content in place.
vi.mock('@ludy/ui/components/dialog', async () => {
  const { createElement } = await import('react');
  const pass = (tag: string) => (p: { children?: ReactNode }) => createElement(tag, null, p.children);
  return {
    Dialog: (p: { open?: boolean; children?: ReactNode }) => (p.open ? createElement('div', null, p.children) : null),
    DialogContent: pass('div'),
    DialogHeader: pass('div'),
    DialogTitle: pass('h2'),
    DialogDescription: pass('p'),
    DialogFooter: pass('div'),
    DialogClose: pass('span'),
  };
});

vi.mock('../src/i18n/provider.tsx', () => ({
  useFormat: () => ({ date: (v: string) => v.slice(0, 10), dateTime: (v: string) => v, number: (v: number | bigint | string) => String(v) }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, ...rest }: { children?: ReactNode }) => createElement('a', rest, children),
    useNavigate: () => () => undefined,
  };
});

const { AttachTaskDialog } = await import('../src/components/project-task-dialog.tsx');

describe('the task picker of the add-existing-task dialog (#4421)', () => {
  it('marks the invisible characters of a task title an AI coworker wrote and leaves a person\'s title as typed', () => {
    testState.client.clear();
    testState.client.setQueryData(['projects', 'unassignedTasks'], [
      { id: 't1', title: 'Gửi báo‮ giá​', tainted: true, status: 'todo', assigneePositionId: null, due: null, createdAt: '2026-11-20T00:00:00.000Z' },
      { id: 't2', title: 'Việc‮ riêng', tainted: false, status: 'todo', assigneePositionId: null, due: null, createdAt: '2026-11-20T00:00:00.000Z' },
    ]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={testState.client}>
        <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
          <AttachTaskDialog open onOpenChange={() => undefined} projectId="p1" disabled={false} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain('Gửi báo⟨U+202E⟩ giá⟨U+200B⟩');
    expect(html).not.toContain('Gửi báo‮');
    expect(html).toContain('Việc‮ riêng');
  });
});
