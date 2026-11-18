// SPDX-License-Identifier: AGPL-3.0-only
// SSR and UI contract checks for Notes v2 T1 (#3558): personal lists sidebar, sections, P1-P4 priorities and #tags.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { MyWork, TodoListsResponse, TodoSummary } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { browserTimeZone } from '../src/lib/my-work.ts';

const authState = vi.hoisted(() => ({ modules: ['notes'] as string[] }));
const queryClientState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: authState.modules }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => ({
            queryKey: [...path, args?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched in unit test')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'call') return () => Promise.resolve({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { client: node([]), clientForOrg: () => node([]), orpc: node([]), queryClient: queryClientState.current, errorMessage: String };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'demo-org' }),
    useSearch: () => ({}),
    useNavigate: () => () => Promise.resolve(),
    Link: ({ children, to, ...rest }: { children?: ReactNode; to: string; 'data-testid'?: string; className?: string }) =>
      createElement('a', { href: to, ...rest }, children),
  };
});

import { MyWorkPage } from '../src/routes/my-work.tsx';

function wrap(locale: 'vi' | 'en', node: ReactNode) {
  return (
    <QueryClientProvider client={queryClientState.current}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>
  );
}

const makeTodo = (overrides: Partial<TodoSummary> = {}): TodoSummary => ({
  id: '30000000-0000-4000-8000-000000000001',
  title: 'Kiểm tra tờ khai thuế',
  status: 'open',
  priority: 4,
  tags: [],
  listId: null,
  sectionId: null,
  dueOn: null,
  dueAt: null,
  dueTime: null,
  timeZone: 'Asia/Ho_Chi_Minh',
  remindAt: null,
  group: 'none',
  overdue: false,
  steps: { done: 0, total: 0 },
  sourceNoteId: null,
  sourceNote: null,
  taskId: null,
  recurrence: null,
  seriesId: null,
  tainted: false,
  revision: 1,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
  doneAt: null,
  deletedAt: null,
  ...overrides,
});

describe('MyWorkPage personal lists, priorities and #tags SSR (#3558)', () => {
  it('renders personal lists sidebar, Inbox count, priority badges, #tags chips and sort control in vi and en', () => {
    authState.modules = ['notes'];
    queryClientState.current.clear();
    const listId = '10000000-0000-4000-8000-000000000001';
    const lists: TodoListsResponse = {
      inboxCount: 1,
      lists: [
        {
          id: listId,
          name: 'Thuế tháng 11',
          color: 'blue',
          sections: [{ id: 'sec-1', name: 'Nộp trước ngày 20' }],
          sortKey: 'V',
          openCount: 2,
          revision: 1,
          createdAt: '2026-11-17T00:00:00.000Z',
          updatedAt: '2026-11-17T00:00:00.000Z',
        },
      ],
    };
    const myWork: MyWork = {
      todos: [
        makeTodo({ id: 't1', title: 'Nộp thuế GTGT', priority: 1, tags: ['thue', 'gap'], listId, sectionId: 'sec-1', group: 'today' }),
        makeTodo({ id: 't2', title: 'Gọi khách A', priority: 4, tags: ['khach'], listId: null, sectionId: null, group: 'none' }),
      ],
      tasks: [],
      tasksTruncated: false,
      projectsAvailable: false,
      noSeatHint: false,
    };
    queryClientState.current.setQueryData(['notes', 'todos', 'lists', 'list', {}], lists);
    queryClientState.current.setQueryData(['notes', 'todos', 'myWork', { timeZone: browserTimeZone() }], myWork);

    const htmlVi = renderToStaticMarkup(wrap('vi', <MyWorkPage />));
    expect(htmlVi).toContain('data-testid="my-work-lists-sidebar"');
    expect(htmlVi).toContain('Hộp thu');
    expect(htmlVi).toContain('Thuế tháng 11');
    expect(htmlVi).toContain('data-testid="todo-priority-badge"');
    expect(htmlVi).toContain('P1');
    expect(htmlVi).toContain('#thue');
    expect(htmlVi).toContain('data-testid="my-work-priority-filter"');
    expect(htmlVi).toContain('data-testid="my-work-sort"');
    expect(htmlVi).toContain('data-testid="my-work-tag-bar"');

    const htmlEn = renderToStaticMarkup(wrap('en', <MyWorkPage />));
    expect(htmlEn).toContain('Inbox');
    expect(htmlEn).toContain('Priority P1-P4');
    expect(htmlEn).toContain('Filter by priority');
  });
});
