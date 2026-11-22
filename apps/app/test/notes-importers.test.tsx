// SPDX-License-Identifier: AGPL-3.0-only
// SSR checks for 1-step Evernote (.enex) and Todoist (.csv) import entry points on NotesPage and MyWorkPage (#3564).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIME_ZONE } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const testState = vi.hoisted(() => ({
  client: null as unknown as QueryClient,
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['kernel', 'notes', 'projects'] }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  testState.client = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
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
  return {
    client: node([]),
    clientForOrg: () => node([]),
    orpc: node([]),
    queryClient: testState.client,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    importEvernoteEnex: vi.fn(),
    importTodoistCsv: vi.fn(),
  };
});

vi.mock('../src/i18n/provider.tsx', () => ({
  useFormat: () => ({
    date: (v: string) => `date:${v.slice(0, 10)}`,
    dateTime: (v: string) => v,
    number: (v: number | bigint | string) => String(v),
  }),
  useLocaleSetting: () => ({ locale: 'vi', setLocale: () => undefined }),
}));

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

const { NotesPage } = await import('../src/routes/notes.tsx');
const { MyWorkPage } = await import('../src/routes/my-work.tsx');

function renderInLocale(locale: 'vi' | 'en', node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={testState.client}>
      <IntlProvider locale={locale} timeZone={DEFAULT_TIME_ZONE} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('Notes v2 E5a (#3564) import buttons and role gating', () => {
  it('shows .enex and .csv import buttons for writers in vi and en, and hides them for viewers', () => {
    testState.client.clear();
    testState.client.setQueryData(['me', 'get', {}], { orgs: [{ slug: 'demo-org', role: 'member' }] });
    testState.client.setQueryData(['notes', 'notebooks', 'list', {}], { notebooks: [], allCount: 0, unfiledCount: 0 });
    testState.client.setQueryData(['notes', 'list', { view: 'mine' }], []);
    testState.client.setQueryData(['notes', 'todos', 'lists', 'list', {}], { lists: [] });
    testState.client.setQueryData(['notes', 'todos', 'myWork', { timeZone: 'UTC' }], { todos: [], tasks: [], tasksTruncated: false });

    const notesVi = renderInLocale('vi', <NotesPage />);
    expect(notesVi).toContain('data-testid="notes-import-enex-btn"');
    expect(notesVi).toContain('Nhập .enex');

    const notesEn = renderInLocale('en', <NotesPage />);
    expect(notesEn).toContain('Import .enex');

    const workVi = renderInLocale('vi', <MyWorkPage />);
    expect(workVi).toContain('data-testid="my-work-import-csv-btn"');
    expect(workVi).toContain('Nhập .csv');

    const workEn = renderInLocale('en', <MyWorkPage />);
    expect(workEn).toContain('Import .csv');

    testState.client.setQueryData(['me', 'get', {}], { orgs: [{ slug: 'demo-org', role: 'viewer' }] });
    expect(renderInLocale('vi', <NotesPage />)).not.toContain('data-testid="notes-import-enex-btn"');
    expect(renderInLocale('vi', <MyWorkPage />)).not.toContain('data-testid="my-work-import-csv-btn"');
  });
});
