// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR tests for Notes N7 (#1676): turning a note line or checklist item into a private to-do and showing
// source note back-links or unavailable state on My work in Vietnamese and English.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIME_ZONE, TODO_TITLE_MAX, type MyWork, type Note, type TodoSummary } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { Markdown } from '../src/lib/markdown.tsx';
import { cleanNoteLineText, extractNoteTodoTitle } from '../src/lib/notes.ts';

const testState = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  search: {} as Record<string, string>,
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
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input ?? {}], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const api = node([]);
  return { orpc: api, client: api, clientForOrg: () => api, queryClient: testState.client, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) };
});

vi.mock('../src/i18n/provider.tsx', () => ({
  useFormat: () => ({
    date: (v: string) => `date:${v.slice(0, 10)}`,
    dateTime: (v: string) => v,
    number: (v: number | bigint | string) => String(v),
  }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, search, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string> } & Record<string, unknown>) => {
      const qs = search ? `?${new URLSearchParams(search).toString()}` : '';
      const href = `${to.replace('$slug', params?.slug ?? '').replace('$id', params?.id ?? '')}${qs}`;
      return createElement('a', { href, ...rest }, children);
    },
    useNavigate: () => () => undefined,
    useParams: () => ({ slug: 'acme' }),
    useSearch: () => testState.search,
  };
});

const { NotesPage } = await import('../src/routes/notes.tsx');
const { MyWorkPage, TodoSourceBadge, TodoSourceDetail } = await import('../src/routes/my-work.tsx');
const { browserTimeZone } = await import('../src/lib/my-work.ts');

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_GONE_ID = '22222222-2222-4222-8222-222222222222';
const TODO_1 = '33333333-3333-4333-8333-333333333331';
const TODO_2 = '33333333-3333-4333-8333-333333333332';
const TODO_3 = '33333333-3333-4333-8333-333333333333';

function wrap(locale: 'vi' | 'en', node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={testState.client}>
      <IntlProvider locale={locale} timeZone={DEFAULT_TIME_ZONE} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const makeTodoSummary = (id: string, title: string, sourceNote: TodoSummary['sourceNote']): TodoSummary => ({
  id,
  title,
  status: 'open',
  dueOn: null,
  dueAt: null,
  dueTime: null,
  timeZone: DEFAULT_TIME_ZONE,
  remindAt: null,
  group: 'none',
  overdue: false,
  steps: { done: 0, total: 0 },
  sourceNoteId: sourceNote?.id ?? null,
  sourceNote,
  taskId: null,
  recurrence: null,
  seriesId: null,
  tainted: false,
  revision: 1,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
  doneAt: null,
  deletedAt: null,
});

describe('note line to to-do helpers (#1676)', () => {
  it('cleans checklist prefixes, Markdown formatting, and clamps titles within 1..300 characters', () => {
    expect(cleanNoteLineText('- [ ] Gọi khách xin sao kê')).toBe('Gọi khách xin sao kê');
    expect(cleanNoteLineText('  - [X] **Kiểm tra** [cổng thuế](https://thuedientu.gdt.gov.vn) với `mã` _này_')).toBe('Kiểm tra cổng thuế với mã này');
    expect(cleanNoteLineText('*Gọi khách*')).toBe('Gọi khách');
    expect(cleanNoteLineText('Gửi *báo giá* hôm nay')).toBe('Gửi báo giá hôm nay');
    expect(cleanNoteLineText('1. Nộp tờ khai quý')).toBe('Nộp tờ khai quý');
    expect(cleanNoteLineText('### Đầu việc tháng 11')).toBe('Đầu việc tháng 11');
    expect(cleanNoteLineText('file_name_v2 và 2 * 3 * 4')).toBe('file_name_v2 và 2 * 3 * 4');
    expect(cleanNoteLineText('- [ ]   ')).toBe('');

    const long = `${'a'.repeat(299)} extra words`;
    const clamped = cleanNoteLineText(long);
    expect(clamped.length).toBeLessThanOrEqual(TODO_TITLE_MAX);
    expect(clamped).toBe('a'.repeat(299));
  });

  it('extracts active selection or the line at a collapsed cursor', () => {
    const body = 'Họp tuần\n- [ ] Gửi báo giá tháng 11\n- Kiểm tra chứng từ';
    expect(extractNoteTodoTitle(body, 0, 0)).toBe('Họp tuần');
    const secondLineOffset = body.indexOf('Gửi báo giá');
    expect(extractNoteTodoTitle(body, secondLineOffset, secondLineOffset)).toBe('Gửi báo giá tháng 11');
    expect(extractNoteTodoTitle(body, secondLineOffset, secondLineOffset + 11)).toBe('Gửi báo giá');
    expect(extractNoteTodoTitle('', 0, 0)).toBe('');
    expect(extractNoteTodoTitle('\n- [ ] Gọi khách', 0, 0)).toBe('');
  });

  it('renders one-click make-todo buttons in Markdown only when onMakeTodo is passed and skips empty lines', () => {
    const body = '# Khách hàng A\n\nGọi sau 15h\n\n- [ ] Xin sao kê\n- [ ]   ';
    const plain = renderToStaticMarkup(<Markdown text={body} />);
    expect(plain).not.toContain('data-testid="note-line-make-todo"');

    const interactive = renderToStaticMarkup(
      <Markdown
        text={body}
        onMakeTodo={() => undefined}
        makeTodoLabel="Tạo việc cần làm"
        makeTodoAriaLabel={(line) => `Tạo việc cần làm từ: ${line}`}
      />,
    );
    expect(interactive.match(/data-testid="note-line-make-todo"/g)).toHaveLength(3);
    expect(interactive).toContain('Tạo việc cần làm từ: Khách hàng A');
    expect(interactive).toContain('Tạo việc cần làm từ: Gọi sau 15h');
    expect(interactive).toContain('Tạo việc cần làm từ: Xin sao kê');
  });
});

describe('NotesPage and MyWorkPage N7 SSR (#1676)', () => {
  function seedNotesPage(note: Note, role: 'member' | 'viewer' = 'member') {
    testState.client.clear();
    testState.search = { note: note.id, list: note.mine ? 'mine' : 'shared' };
    testState.client.setQueryData(['me', 'get', {}], { orgs: [{ slug: 'acme', role }] });
    testState.client.setQueryData(['notes', 'list', { view: note.mine ? 'mine' : 'shared' }], []);
    testState.client.setQueryData(['notes', 'get', { noteId: note.id }], note);
  }

  it('renders make-todo action on own editable note and on shared read-only note lines', () => {
    const ownNote: Note = {
      id: NOTE_ID,
      authorUserId: 'u-1',
      mine: true,
      visibility: 'private',
      title: 'Việc của tôi',
      body: '- [ ] Gửi hóa đơn',
      tags: [],
      pinned: false,
      tainted: false,
      revision: 1,
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
      archivedAt: null,
      deletedAt: null,
      links: [],
    };
    seedNotesPage(ownNote, 'member');
    const ownVi = wrap('vi', <NotesPage />);
    expect(ownVi).toContain('data-testid="note-make-todo"');
    expect(ownVi).toContain('Tạo việc cần làm');

    const sharedNote: Note = {
      ...ownNote,
      mine: false,
      visibility: 'org',
      title: 'Ghi chú chung',
      body: 'Gọi khách sau 15h\n\n- [ ] Xin sao kê tháng 11',
    };
    seedNotesPage(sharedNote, 'member');
    const sharedVi = wrap('vi', <NotesPage />);
    expect(sharedVi).toContain('data-testid="note-line-make-todo"');
    expect(sharedVi).toContain('Tạo việc cần làm');

    const sharedEn = wrap('en', <NotesPage />);
    expect(sharedEn).toContain('Make to-do');

    // Viewers and trashed notes cannot create to-dos from lines.
    seedNotesPage(sharedNote, 'viewer');
    expect(wrap('vi', <NotesPage />)).not.toContain('data-testid="note-line-make-todo"');

    seedNotesPage({ ...ownNote, deletedAt: '2026-11-17T01:00:00.000Z' }, 'member');
    expect(wrap('vi', <NotesPage />)).not.toContain('data-testid="note-make-todo"');
    expect(wrap('vi', <NotesPage />)).not.toContain('data-testid="note-line-make-todo"');
  });

  it('renders source note back-link, unavailable state without leaking title, and clean null state on MyWorkPage', () => {
    testState.client.clear();
    const myWork: MyWork = {
      todos: [
        makeTodoSummary(TODO_1, 'Gọi khách VIP', { id: NOTE_ID, title: 'Hồ sơ khách A', available: true }),
        makeTodoSummary(TODO_2, 'Kiểm tra hợp đồng', { id: NOTE_GONE_ID, title: null, available: false }),
        makeTodoSummary(TODO_3, 'Việc tự tạo', null),
      ],
      tasks: [],
      tasksTruncated: false,
      projectsAvailable: false,
      noSeatHint: false,
    };
    testState.client.setQueryData(['notes', 'todos', 'myWork', { timeZone: browserTimeZone() }], myWork);

    const viHtml = wrap('vi', <MyWorkPage />);
    expect(viHtml).toContain('data-testid="todo-source-note"');
    expect(viHtml).toContain(`/o/acme/notes?note=${NOTE_ID}`);
    expect(viHtml).toContain('Ghi chú: Hồ sơ khách A');
    expect(viHtml).toContain('data-testid="todo-source-note-unavailable"');
    expect(viHtml).toContain('Bản ghi không mở được');
    expect(viHtml).not.toContain(NOTE_GONE_ID);

    const enHtml = wrap('en', <MyWorkPage />);
    expect(enHtml).toContain('Note: Hồ sơ khách A');
    expect(enHtml).toContain('You cannot open this record');

    // Detail component covers both available, unavailable, and cleared (null) source notes.
    expect(wrap('vi', <TodoSourceDetail slug="acme" sourceNote={{ id: NOTE_ID, title: 'Hồ sơ khách A', available: true }} />)).toContain(
      `/o/acme/notes?note=${NOTE_ID}`,
    );
    expect(wrap('vi', <TodoSourceDetail slug="acme" sourceNote={{ id: NOTE_GONE_ID, title: null, available: false }} />)).toContain(
      'Bản ghi không mở được',
    );
    expect(wrap('en', <TodoSourceDetail slug="acme" sourceNote={{ id: NOTE_GONE_ID, title: null, available: false }} />)).toContain(
      'You cannot open this record',
    );
    expect(wrap('vi', <TodoSourceDetail slug="acme" sourceNote={null} />)).toBe('');
    expect(wrap('vi', <TodoSourceBadge slug="acme" sourceNote={null} />)).toBe('');
  });
});
