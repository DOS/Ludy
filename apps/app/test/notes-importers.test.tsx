// SPDX-License-Identifier: AGPL-3.0-only
// SSR checks for 1-step Evernote (.enex) and Todoist (.csv) import entry points on NotesPage and MyWorkPage (#3564).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIME_ZONE } from '@ludy/kernel-contract';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { en as enMessages } from '../src/i18n/messages/en.ts';
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

const { NotesPage, resolveEnexPostImportSearch } = await import('../src/routes/notes.tsx');
const { MyWorkPage, collectTodosForImportPreview } = await import('../src/routes/my-work.tsx');
const { resolveNoteImportParseError } = await import('../src/components/note-import-dialog.tsx');

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

  it('maps client NOTE_TOO_LONG to generic 100,000-char importer copy instead of Vy copy', () => {
    const viMsg = resolveNoteImportParseError(
      { code: 'NOTE_TOO_LONG', detail: 'Converted note body exceeds 100,000 characters' },
      {
        invalidSizeLimit: viMessages.notes.import.invalidSizeLimit,
        noteTooLong: viMessages.notes.import.noteTooLong,
        kernelError: (code) => viMessages.kernelErrors.codes[code],
      },
    );
    expect(viMsg).toBe(viMessages.notes.import.noteTooLong);
    expect(viMsg).toContain('100.000');
    expect(viMsg).not.toContain('Vy');
    expect(viMsg).not.toMatch(/[\u2013\u2014]/);

    const enMsg = resolveNoteImportParseError(
      { code: 'NOTE_TOO_LONG', detail: 'Converted note body exceeds 100,000 characters' },
      {
        invalidSizeLimit: enMessages.notes.import.invalidSizeLimit,
        noteTooLong: enMessages.notes.import.noteTooLong,
        kernelError: (code) => enMessages.kernelErrors.codes[code],
      },
    );
    expect(enMsg).toBe(enMessages.notes.import.noteTooLong);
    expect(enMsg).toContain('100,000');
    expect(enMsg).not.toContain('Vy');
    expect(enMsg).not.toMatch(/[\u2013\u2014]/);
  });

  it('preserves chosen targetNotebookId navigation and collects unfiltered todos with listId', () => {
    expect(
      resolveEnexPostImportSearch({ noteIds: ['n-1'], notebookIds: ['nb-1'] }, 'nb-1'),
    ).toEqual({ list: 'mine', notebook: 'nb-1', note: 'n-1' });
    expect(
      resolveEnexPostImportSearch({ noteIds: ['n-1', 'n-2'], notebookIds: ['nb-1'] }, 'nb-1'),
    ).toEqual({ list: 'mine', notebook: 'nb-1' });
    expect(
      resolveEnexPostImportSearch({ noteIds: [], notebookIds: [] }, 'nb-1'),
    ).toEqual({ list: 'mine', notebook: 'nb-1' });
    expect(
      resolveEnexPostImportSearch({ noteIds: ['n-1', 'n-2'], notebookIds: ['nb-1', 'nb-2'] }, null),
    ).toEqual({ list: 'mine' });

    const collected = collectTodosForImportPreview(
      [
        { id: 't1', title: 'Open task', listId: 'list-1' },
        { id: 't2', title: 'Inbox task', listId: null },
      ],
      [
        { id: 't2', title: 'Inbox task', listId: null },
        { id: 't3', title: 'Done task', listId: 'list-2' },
      ],
    );
    expect(collected).toEqual([
      { title: 'Open task', listId: 'list-1' },
      { title: 'Inbox task', listId: null },
      { title: 'Done task', listId: 'list-2' },
    ]);
  });
});
