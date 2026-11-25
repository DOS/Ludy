// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR tests for Notes v2 E1 (#3559): notebooks and 2-level stacks, interactive preview checkboxes,
// [[Note]] wiki-links (autocomplete, preview rendering, backlinks), and Markdown export.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIME_ZONE,
  type Note,
  type NoteSummary,
  type NotebookSummary,
  type NotesExport,
} from '@ludy/kernel-contract';
import { groupNotebooks, NoteWikiAutocomplete, wikiComboboxAriaProps } from '../src/components/note-notebooks.tsx';
import { catalog } from '../src/i18n/runtime.ts';
import { Markdown, parseBlocks, toggleMarkdownTaskLine } from '../src/lib/markdown.tsx';
import { notesMarkdown } from '../src/lib/notes-export.ts';
import {
  cleanNoteLineText,
  findActiveWikiAutocomplete,
  insertWikiLinkAt,
  parseNotesSearch,
  parseWikiLinkToken,
} from '../src/lib/notes.ts';

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
        if (prop === 'queryOptions')
          return (opts?: { input?: unknown }) => ({
            queryKey: [...path, opts?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const api = node([]);
  return {
    orpc: api,
    client: api,
    clientForOrg: () => api,
    queryClient: testState.client,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
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
    Link: ({
      children,
      to,
      params,
      search,
      ...rest
    }: {
      children?: ReactNode;
      to: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
    } & Record<string, unknown>) => {
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

const NB_PRIV = '11111111-1111-4111-8111-111111111111';
const NB_ORG = '22222222-2222-4222-8222-222222222222';
const NOTE_A = '33333333-3333-4333-8333-333333333333';
const NOTE_B = '44444444-4444-4444-8444-444444444444';

function wrap(locale: 'vi' | 'en', node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={testState.client}>
      <IntlProvider locale={locale} timeZone={DEFAULT_TIME_ZONE} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('interactive preview checkboxes and fenced code blocks (#3559)', () => {
  it('toggles exact task lines in O(n), preserves indentation and CRLF, and ignores fenced code blocks', () => {
    const body = '# Viec tuan\n  - [ ] Gui bao gia\n```md\n- [ ] Khong doi trong code\n```\n* [X] Chot hoa don';
    expect(toggleMarkdownTaskLine(body, 1, true)).toBe(
      '# Viec tuan\n  - [x] Gui bao gia\n```md\n- [ ] Khong doi trong code\n```\n* [X] Chot hoa don',
    );
    expect(toggleMarkdownTaskLine(body, 3, true)).toBeNull();
    expect(toggleMarkdownTaskLine(body, 5, false)).toBe(
      '# Viec tuan\n  - [ ] Gui bao gia\n```md\n- [ ] Khong doi trong code\n```\n* [ ] Chot hoa don',
    );
    expect(toggleMarkdownTaskLine(body, 0, true)).toBeNull();
    expect(toggleMarkdownTaskLine('- [ ] Mot\r\n- [x] Hai\r\n', 0, true)).toBe('- [x] Mot\r\n- [x] Hai\r\n');

    // Standalone \r normalizes consistently between parseBlocks and toggleMarkdownTaskLine (#4211).
    const crBody = '# Tieu de\r- [ ] Mot\r- [ ] Hai\r\n```md\r- [ ] Trong ma\r```\r- [ ] Ba';
    const blocks = parseBlocks(crBody);
    const listItems = blocks.flatMap((b) => (b.kind === 'list' ? b.items : []));
    expect(listItems.map((item) => item.lineIndex)).toEqual([1, 2, 6]);
    expect(toggleMarkdownTaskLine(crBody, 2, true)).toBe('# Tieu de\n- [ ] Mot\n- [x] Hai\r\n```md\n- [ ] Trong ma\n```\n- [ ] Ba');
    expect(toggleMarkdownTaskLine(crBody, 4, true)).toBeNull();
    expect(toggleMarkdownTaskLine(crBody, 6, true)).toBe('# Tieu de\n- [ ] Mot\n- [ ] Hai\r\n```md\n- [ ] Trong ma\n```\n- [x] Ba');
  });

  it('prevents clicking a rendered wiki-link or external link inside a task label from toggling its checkbox (#4211)', () => {
    const findAll = (node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] => {
      const out: ReactElement<Record<string, unknown>>[] = [];
      const walk = (n: ReactNode) => {
        if (Array.isArray(n)) {
          for (const child of n) walk(child);
          return;
        }
        if (!isValidElement(n)) return;
        const el = n as ReactElement<Record<string, unknown>>;
        if (pred(el)) out.push(el);
        if (el.props.children !== undefined) walk(el.props.children as ReactNode);
      };
      walk(node);
      return out;
    };

    const onToggleTask = vi.fn();
    const onWikiClick = vi.fn();
    let labelEl: ReactElement<Record<string, unknown>> | null = null;

    function CaptureTask() {
      const tree = Markdown({
        text: '- [ ] Xem [[Ke hoach Q4]] va [Tai lieu](https://example.com)',
        onToggleTask,
        resolveWikiLink: () => ({
          href: `/o/acme/notes?list=mine&note=${NOTE_A}`,
          label: 'Ke hoach Q4',
          available: true,
          onClick: onWikiClick,
        }),
      });
      const taskItem = findAll(tree, (el) => typeof el.type === 'function' && el.props.lineIndex === 0)[0]!;
      labelEl = (taskItem.type as (props: Record<string, unknown>) => ReactElement<Record<string, unknown>>)(taskItem.props);
      return labelEl;
    }

    renderToStaticMarkup(<CaptureTask />);
    expect(labelEl).not.toBeNull();
    const label = labelEl!;
    const checkbox = findAll(label, (el) => el.type === 'input')[0]!;
    const span = findAll(label, (el) => el.type === 'span')[0]!;
    const wikiAnchor = findAll(label, (el) => el.type === 'a' && el.props['data-testid'] === 'note-wiki-link')[0]!;
    const externalAnchor = findAll(label, (el) => el.type === 'a' && el.props.href === 'https://example.com')[0]!;

    // Clicking the rendered wiki-link stops propagation, prevents default, navigates, and suppresses any synthetic checkbox toggle.
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const anchorTarget = { closest: (sel: string) => (sel === 'a' ? wikiAnchor : null) };
    (span.props.onClickCapture as (e: unknown) => void)({ target: anchorTarget });
    (wikiAnchor.props.onClick as (e: unknown) => void)({ stopPropagation, preventDefault });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onWikiClick).toHaveBeenCalledTimes(1);

    const syntheticCheckbox = { checked: true };
    (checkbox.props.onChange as (e: unknown) => void)({ target: syntheticCheckbox, currentTarget: syntheticCheckbox });
    expect(onToggleTask).not.toHaveBeenCalled();
    expect(syntheticCheckbox.checked).toBe(false);

    // Clicking an external link inside the task label stops propagation without blocking external navigation or toggling.
    const extStop = vi.fn();
    const extPrevent = vi.fn();
    const externalTarget = { closest: (sel: string) => (sel === 'a' ? externalAnchor : null) };
    (span.props.onClickCapture as (e: unknown) => void)({ target: externalTarget });
    (externalAnchor.props.onClick as (e: unknown) => void)({ stopPropagation: extStop, preventDefault: extPrevent });
    expect(extStop).toHaveBeenCalledTimes(1);
    expect(extPrevent).not.toHaveBeenCalled();
    (checkbox.props.onChange as (e: unknown) => void)({ target: syntheticCheckbox, currentTarget: syntheticCheckbox });
    expect(onToggleTask).not.toHaveBeenCalled();

    // Direct pointer/checkbox interaction outside <a> toggles normally.
    const plainTarget = { closest: () => null };
    (label.props.onPointerDownCapture as (e: unknown) => void)({ target: plainTarget });
    (checkbox.props.onChange as (e: unknown) => void)({ target: { checked: true }, currentTarget: { checked: true } });
    expect(onToggleTask).toHaveBeenCalledWith(0, true);
  });

  it('renders interactive checkboxes only when onToggleTask is provided and skips fenced code blocks', () => {
    const md = '- [ ] Buoc 1\n~~~\n- [ ] Trong khoi ma\n[[Khong link]]\n~~~\n- [x] Buoc 2';
    const readOnly = renderToStaticMarkup(<Markdown text={md} />);
    expect(readOnly).not.toContain('data-testid="note-task-checkbox"');
    expect(readOnly).toContain('disabled=""');
    expect(readOnly).toContain('data-testid="note-code-block"');

    const interactive = renderToStaticMarkup(<Markdown text={md} onToggleTask={() => undefined} />);
    expect(interactive.match(/data-testid="note-task-checkbox"/g)).toHaveLength(2);
    expect(interactive).toContain('data-line-index="0"');
    expect(interactive).toContain('data-line-index="5"');
  });
});

describe('[[Note]] wiki-links, autocomplete, and search helpers (#3559)', () => {
  it('parses wiki-link tokens, strips them cleanly for Make To-Do, and resolves preview links outside code', () => {
    expect(parseWikiLinkToken('Ke hoach Q4')).toEqual({ title: 'Ke hoach Q4' });
    expect(parseWikiLinkToken(`${NOTE_A}|Ke hoach Q4`)).toEqual({ noteId: NOTE_A, title: 'Ke hoach Q4' });
    expect(parseWikiLinkToken('')).toBeNull();

    expect(cleanNoteLineText('- [ ] Xem [[Ke hoach Q4]] va [[' + NOTE_A + '|Bao cao]]')).toBe('Xem Ke hoach Q4 va Bao cao');

    const rendered = renderToStaticMarkup(
      <Markdown
        text={`Xem [[Ke hoach Q4]], [[Khong co]] va \`[[Trong ma]]\``}
        resolveWikiLink={(t) =>
          t.title === 'Ke hoach Q4'
            ? { href: `/o/acme/notes?list=mine&note=${NOTE_A}`, label: 'Ke hoach Q4', available: true }
            : null
        }
      />,
    );
    expect(rendered).toContain('data-testid="note-wiki-link"');
    expect(rendered).toContain(`href="/o/acme/notes?list=mine&amp;note=${NOTE_A}"`);
    expect(rendered).toContain('data-testid="note-wiki-unresolved"');
    expect(rendered).toContain('>[[Trong ma]]</code>');
  });

  it('detects active [[ autocomplete outside code spans and inserts plain or disambiguated [[id|Title]] links', () => {
    const text = 'Mo dau [[Ke ho';
    const match = findActiveWikiAutocomplete(text, text.length);
    expect(match).toEqual({ from: 7, query: 'Ke ho' });

    expect(findActiveWikiAutocomplete('`[[Ke ho', 8)).toBeNull();
    expect(findActiveWikiAutocomplete('```\n[[Ke ho', 11)).toBeNull();

    const plain = insertWikiLinkAt(text, 7, text.length, { id: NOTE_A, title: 'Ke hoach Q4' }, false);
    expect(plain.value).toBe('Mo dau [[Ke hoach Q4]]');

    const disambiguated = insertWikiLinkAt('Xem [[Ke]] tiep', 4, 8, { id: NOTE_A, title: 'Ke hoach Q4' }, true);
    expect(disambiguated.value).toBe(`Xem [[${NOTE_A}|Ke hoach Q4]] tiep`);

    // A title that loses characters to fit in [[...]] keeps the id, so the link still names its note.
    const cleaned = insertWikiLinkAt('[[Sa', 0, 4, { id: NOTE_A, title: 'Sales | UK' }, false);
    expect(cleaned.value).toBe(`[[${NOTE_A}|Sales UK]]`);
    const onlyBrackets = insertWikiLinkAt('[[', 0, 2, { id: NOTE_A, title: '[]' }, false);
    expect(onlyBrackets.value).toBe(`[[${NOTE_A}]]`);
  });

  it('parses notebook and stack URL search params and groups 2-level stacks + pinned + standalone notebooks', () => {
    expect(parseNotesSearch({ notebook: 'unfiled', stack: 'IgnoredWhenNotebookSet' })).toEqual({ notebook: 'unfiled' });
    expect(parseNotesSearch({ notebook: NB_PRIV.toUpperCase() })).toEqual({ notebook: NB_PRIV });
    expect(parseNotesSearch({ stack: '  Kinh doanh  ' })).toEqual({ stack: 'Kinh doanh' });

    const items: NotebookSummary[] = [
      {
        id: NB_PRIV,
        authorUserId: 'u-1',
        mine: true,
        editable: true,
        visibility: 'private',
        name: 'So rieng',
        stackName: null,
        pinned: true,
        sortKey: 'a0',
        noteCount: 2,
        revision: 1,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
      },
      {
        id: NB_ORG,
        authorUserId: 'u-1',
        mine: true,
        editable: true,
        visibility: 'org',
        name: 'Khach VIP',
        stackName: 'Kinh doanh',
        pinned: false,
        sortKey: 'a1',
        noteCount: 3,
        revision: 1,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
      },
    ];
    const grouped = groupNotebooks(items);
    expect(grouped.pinned).toHaveLength(1);
    expect(grouped.stacks).toHaveLength(1);
    expect(grouped.stacks[0]?.stackName).toBe('Kinh doanh');
    expect(grouped.stacks[0]?.noteCount).toBe(3);
    expect(grouped.standalone).toHaveLength(1);
  });

  it('exports notebooks and note notebook paths in Markdown export', () => {
    const data: NotesExport = {
      exportedAt: '2026-11-18T00:00:00.000Z',
      truncated: false,
      notebooks: [
        {
          id: NB_ORG,
          visibility: 'org',
          name: 'Khach VIP',
          stackName: 'Kinh doanh',
          pinned: true,
          sortKey: 'a0',
          createdAt: '2026-11-18T00:00:00.000Z',
          updatedAt: '2026-11-18T00:00:00.000Z',
        },
      ],
      notes: [
        {
          id: NOTE_A,
          notebookId: NB_ORG,
          visibility: 'org',
          title: 'Bien ban hop',
          body: '- [x] Da gui',
          tags: [],
          pinned: false,
          createdAt: '2026-11-18T00:00:00.000Z',
          updatedAt: '2026-11-18T00:00:00.000Z',
          archivedAt: null,
          deletedAt: null,
          links: [],
        },
      ],
      todos: [],
      todoLists: [],
    };
    const md = notesMarkdown(data, {
      heading: 'Ghi chu va viec cua toi',
      exportedAt: 'Xuat luc',
      notes: 'Ghi chu',
      notebooks: 'So tay',
      notebook: 'So tay',
      stack: 'Ngan so tay',
      todos: 'Viec cua toi',
      todoLists: 'Danh sach viec',
      private: 'Rieng tu',
      shared: 'Dung chung',
      tags: 'Nhan',
      priority: 'Uu tien',
      list: 'Danh sach',
      sections: 'Nhanh',
      pinned: 'Da ghim',
      archived: 'Luu tru',
      trashed: 'Thung rac',
      created: 'Tao',
      updated: 'Cap nhat',
      links: 'Lien ket',
      status: { open: 'Dang mo', done: 'Da xong', handed_over: 'Da ban giao', cancelled: 'Da huy' },
      due: 'Han',
      remind: 'Nhac',
      done: 'Xong',
      truncated: 'Cat bot',
    });
    expect(md).toContain('## So tay (1)');
    expect(md).toContain('Kinh doanh / Khach VIP');
  });
});

describe('NotesPage notebooks, stacks, picker & backlinks SSR (#3559)', () => {
  it('renders 2-level stacks, hides private notebooks on shared notes, warns before sharing in private notebook, and renders backlinks', () => {
    const notebooks: NotebookSummary[] = [
      {
        id: NB_PRIV,
        authorUserId: 'u-1',
        mine: true,
        editable: true,
        visibility: 'private',
        name: 'So luong rieng',
        stackName: 'Nhan su',
        pinned: false,
        sortKey: 'a0',
        noteCount: 1,
        revision: 1,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
      },
      {
        id: NB_ORG,
        authorUserId: 'u-1',
        mine: true,
        editable: true,
        visibility: 'org',
        name: 'Khach VIP',
        stackName: 'Kinh doanh',
        pinned: true,
        sortKey: 'a1',
        noteCount: 1,
        revision: 1,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
      },
    ];
    const backlinkSummary: NoteSummary = {
      id: NOTE_B,
      authorUserId: 'u-2',
      mine: false,
      visibility: 'org',
      notebookId: NB_ORG,
      title: 'Bao cao tuan 46',
      tags: [],
      pinned: false,
      tainted: false,
      revision: 1,
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
      archivedAt: null,
      deletedAt: null,
    };
    const privInPrivNb: Note = {
      id: NOTE_A,
      authorUserId: 'u-1',
      mine: true,
      visibility: 'private',
      notebookId: NB_PRIV,
      title: 'Ghi chu rieng trong so rieng',
      body: '- [ ] Kiem tra bang luong',
      tags: [],
      pinned: false,
      tainted: false,
      revision: 1,
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
      archivedAt: null,
      deletedAt: null,
      links: [],
    };

    testState.client.clear();
    testState.search = { note: NOTE_A, list: 'mine' };
    testState.client.setQueryData(['me', 'get', {}], { orgs: [{ slug: 'acme', role: 'member' }] });
    testState.client.setQueryData(['notes', 'notebooks', 'list', {}], { notebooks, allCount: 2, unfiledCount: 0 });
    testState.client.setQueryData(['notes', 'list', { view: 'mine' }], []);
    testState.client.setQueryData(['notes', 'list', { view: 'shared' }], [backlinkSummary]);
    testState.client.setQueryData(['notes', 'get', { noteId: NOTE_A }], privInPrivNb);
    testState.client.setQueryData(['notes', 'backlinks', { noteId: NOTE_A }], [backlinkSummary]);

    const viHtml = wrap('vi', <NotesPage />);
    expect(viHtml).toContain('data-testid="notebooks-sidebar"');
    expect(viHtml).toContain('data-testid="notebook-stack"');
    expect(viHtml).toContain('Kinh doanh');
    expect(viHtml).toContain('data-testid="note-private-notebook-share-hint"');
    expect(viHtml).toContain('data-testid="note-backlinks"');
    expect(viHtml).toContain('Bao cao tuan 46');

    // When the open note is shared ('org'), private notebooks are excluded from the picker options.
    testState.client.setQueryData(
      ['notes', 'get', { noteId: NOTE_A }],
      { ...privInPrivNb, visibility: 'org', notebookId: NB_ORG },
    );
    const enSharedHtml = wrap('en', <NotesPage />);
    expect(enSharedHtml).toContain('Kinh doanh / Khach VIP');
    expect(enSharedHtml).not.toContain('Nhan su / So luong rieng');
    // When wiki autocomplete is closed, the editor keeps its implicit textbox role without combobox attributes.
    expect(enSharedHtml).not.toContain('role="combobox"');
  });

  it('aligns ARIA combobox and listbox roles for wiki-link autocomplete (#4211)', () => {
    expect(
      wikiComboboxAriaProps({ open: false, listboxId: 'note-wiki-listbox-1', activeIndex: 0, matchCount: 2 }),
    ).toEqual({});

    expect(
      wikiComboboxAriaProps({ open: true, listboxId: 'note-wiki-listbox-1', activeIndex: 0, matchCount: 0 }),
    ).toEqual({
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': false,
    });

    expect(
      wikiComboboxAriaProps({ open: true, listboxId: 'note-wiki-listbox-1', activeIndex: 1, matchCount: 3 }),
    ).toEqual({
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': true,
      'aria-controls': 'note-wiki-listbox-1',
      'aria-activedescendant': 'note-wiki-listbox-1-opt-1',
    });

    const candidates: NoteSummary[] = [
      {
        id: NOTE_A,
        authorUserId: 'u-1',
        mine: true,
        visibility: 'private',
        notebookId: null,
        title: 'Ke hoach Q4',
        tags: [],
        pinned: false,
        tainted: false,
        revision: 1,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: NOTE_B,
        authorUserId: 'u-2',
        mine: false,
        visibility: 'org',
        notebookId: null,
        title: 'Bao cao tuan',
        tags: [],
        pinned: false,
        tainted: false,
        revision: 1,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
        archivedAt: null,
        deletedAt: null,
      },
    ];

    const populatedHtml = wrap(
      'vi',
      <NoteWikiAutocomplete
        listboxId="note-wiki-listbox-1"
        query=""
        candidates={candidates}
        activeIndex={0}
        onPick={() => undefined}
      />,
    );
    expect(populatedHtml).toContain('<div id="note-wiki-listbox-1" role="listbox"');
    expect(populatedHtml).toContain('<ul role="none"');
    expect(populatedHtml).toContain('<li role="none"');
    expect(populatedHtml).toContain('role="option"');
    expect(populatedHtml).toContain('tabindex="-1"');
    // Hint paragraph sits outside role="listbox" so listbox owns only role="none" -> role="option" children.
    const listboxStart = populatedHtml.indexOf('role="listbox"');
    const hintStart = populatedHtml.indexOf(catalog('vi').notes.wikiLinks.hint);
    expect(hintStart).toBeGreaterThan(-1);
    expect(hintStart).toBeLessThan(listboxStart);

    const emptyHtml = wrap(
      'vi',
      <NoteWikiAutocomplete
        listboxId="note-wiki-listbox-1"
        query="khong-khop"
        candidates={candidates}
        activeIndex={0}
        onPick={() => undefined}
      />,
    );
    expect(emptyHtml).not.toContain('role="listbox"');
    expect(emptyHtml).toContain('role="status"');
  });
});
