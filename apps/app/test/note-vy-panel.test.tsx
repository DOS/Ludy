// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR rendering tests for Notes N8 member-scoped Vy panel (#1677).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Note, NoteVyResults, NoteVyStatus } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const apiState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  apiState.current = new QC({ defaultOptions: { queries: { retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts && 'input' in opts ? [...path, opts.input] : path,
            queryFn: () => Promise.reject(new Error('not fetched in SSR test')),
          });
        }
        if (prop === 'key') {
          return (opts?: { input?: unknown }) => (opts && 'input' in opts ? [...path, opts.input] : path);
        }
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    clientForOrg: () => ({}),
    queryClient: apiState.current,
    errorMessage: String,
  };
});

const {
  NoteVyPanel,
  bulletsToText,
  errorCodeOf,
  noteVyBlocked,
  noteVyErrorKey,
  textToBullets,
  toEditableTodoSuggestions,
} = await import('../src/components/note-vy-panel.tsx');

const SAMPLE_NOTE: Pick<Note, 'id' | 'title' | 'body' | 'mine' | 'deletedAt' | 'revision'> = {
  id: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b',
  title: 'Hop voi khach hang Q4',
  body: 'Ngay mai gui bao gia cho anh Minh. Kiem tra hop dong trong tuan nay.',
  mine: true,
  deletedAt: null,
  revision: 2,
};

function renderPanel(
  locale: 'en' | 'vi',
  options: {
    note?: Pick<Note, 'id' | 'title' | 'body' | 'mine' | 'deletedAt' | 'revision'>;
    status?: NoteVyStatus;
    meter?: { aiOn: boolean; state: 'ok' | 'stop' };
    results?: NoteVyResults;
    saveBlocked?: boolean;
    canWrite?: boolean;
  } = {},
): string {
  const qc = apiState.current;
  qc.clear();
  const note = options.note ?? SAMPLE_NOTE;
  if (options.status) qc.setQueryData(['notes', 'vyStatus', {}], options.status);
  if (options.meter) qc.setQueryData(['ai', 'meter', { module: 'notes' }], options.meter);
  if (options.results) qc.setQueryData(['notes', 'vyResults', { noteId: note.id }], options.results);

  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <NoteVyPanel
            slug="acme"
            note={note}
            canWrite={options.canWrite}
            saveBlocked={options.saveBlocked}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale('vi');
  }
}

describe('NoteVyPanel helpers (#1677)', () => {
  it('computes blocked states cleanly', () => {
    expect(noteVyBlocked(undefined, undefined)).toBeNull();
    expect(noteVyBlocked({ available: false, reason: 'off', resetOn: null }, { aiOn: true })).toBe('off');
    expect(noteVyBlocked({ available: false, reason: 'paused', resetOn: null }, { aiOn: true })).toBe('paused');
    expect(noteVyBlocked({ available: false, reason: 'budget', resetOn: '2026-12-01' }, { aiOn: true })).toBe('budget');
    expect(noteVyBlocked({ available: false, reason: 'forbidden', resetOn: null }, { aiOn: true })).toBe('forbidden');
    expect(noteVyBlocked({ available: true, reason: null, resetOn: null }, { aiOn: false })).toBe('noModel');
    expect(noteVyBlocked({ available: true, reason: null, resetOn: null }, { aiOn: true })).toBeNull();
  });

  it('maps error codes, extracts error codes, and parses/formats bullets and editable todo suggestions', () => {
    expect(noteVyErrorKey('NOTE_TOO_LONG')).toBe('NOTE_TOO_LONG');
    expect(noteVyErrorKey('VY_RUN_BUSY')).toBe('AI_BUSY');
    expect(noteVyErrorKey('UNKNOWN_CODE')).toBe('default');
    expect(noteVyErrorKey(null)).toBe('default');

    expect(errorCodeOf({ code: 'NOTE_IN_TRASH' })).toBe('NOTE_IN_TRASH');
    expect(errorCodeOf({ data: { code: 'AI_STOPPED' } })).toBe('AI_STOPPED');
    expect(errorCodeOf(new Error('plain'))).toBeNull();

    expect(bulletsToText(['One', 'Two'])).toBe('One\nTwo');
    expect(textToBullets('- One\n * Two\n\n  Three  ')).toEqual(['One', 'Two', 'Three']);

    expect(
      toEditableTodoSuggestions([
        { title: 'Gui bao gia', details: 'PDF', dueOn: '2026-11-20' },
        { title: 'Goi lai', details: '', dueOn: null },
      ]),
    ).toEqual([
      { selected: true, title: 'Gui bao gia', details: 'PDF', dueOn: '2026-11-20', dueTime: '', reminder: 'auto' },
      { selected: true, title: 'Goi lai', details: '', dueOn: '', dueTime: '', reminder: 'auto' },
    ]);
  });
});

describe('NoteVyPanel SSR rendering (#1677)', () => {
  it('renders available controls in VI & EN and keeps AI coworker framing without "assistant" or "tro ly"', () => {
    const htmlVi = renderPanel('vi', {
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
    });
    expect(htmlVi).toContain('Nhờ Vy với ghi chú này');
    expect(htmlVi).toContain('Vy đề xuất · AI');
    expect(htmlVi).toContain('Tóm tắt ghi chú');
    expect(htmlVi).toContain('Gợi ý việc cần làm');
    expect(htmlVi.toLowerCase()).not.toContain('trợ lý');

    const htmlEn = renderPanel('en', {
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
    });
    expect(htmlEn).toContain('Vy for this note');
    expect(htmlEn).toContain('Proposed by Vy · AI');
    expect(htmlEn).toContain('Summarize note');
    expect(htmlEn).toContain('Suggest personal to-dos');
    expect(htmlEn.toLowerCase()).not.toContain('assistant');
  });

  it('hides completely for trashed notes and surfaces blocked notices without breaking notes', () => {
    expect(
      renderPanel('en', {
        note: { ...SAMPLE_NOTE, deletedAt: '2026-11-16T00:00:00.000Z' },
        status: { available: true, reason: null, resetOn: null },
        meter: { aiOn: true, state: 'ok' },
      }),
    ).toBe('');

    const noModelHtml = renderPanel('en', {
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: false, state: 'ok' },
    });
    expect(noModelHtml).toContain('AI is not configured on this server');
    expect(noModelHtml).toMatch(/disabled=""[^>]*data-testid="note-vy-summarize-btn"/);

    const pausedHtml = renderPanel('vi', {
      status: { available: false, reason: 'paused', resetOn: null },
      meter: { aiOn: true, state: 'ok' },
    });
    expect(pausedHtml).toContain('AI đang tạm dừng');

    const budgetHtml = renderPanel('en', {
      status: { available: false, reason: 'budget', resetOn: '2026-12-01' },
      meter: { aiOn: true, state: 'stop' },
    });
    expect(budgetHtml).toContain('AI budget for Notes is used up');
    expect(budgetHtml).toContain('2026');

    const saveBlockedHtml = renderPanel('en', {
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
      saveBlocked: true,
    });
    expect(saveBlockedHtml).toMatch(/disabled=""[^>]*data-testid="note-vy-suggest-todos-btn"/);

    const forbiddenHtml = renderPanel('en', {
      status: { available: false, reason: 'forbidden', resetOn: null },
      meter: { aiOn: true, state: 'ok' },
    });
    expect(forbiddenHtml).toContain('data-testid="note-vy-blocked"');
    expect(forbiddenHtml).not.toContain('data-testid="note-vy-summarize-btn"');
    expect(forbiddenHtml).not.toContain('data-testid="note-vy-suggest-todos-btn"');

    const pendingHtml = renderPanel('en', {});
    expect(pendingHtml).not.toContain('data-testid="note-vy-blocked"');
  });

  it('renders dashed proposal containers, author-only apply summary controls, and read-only summary for shared note readers', () => {
    const results: NoteVyResults = {
      noteId: SAMPLE_NOTE.id,
      summary: {
        state: 'ready',
        runId: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c',
        noteId: SAMPLE_NOTE.id,
        noteRevision: 1,
        stale: true,
        summary: 'Khach dong y gia Q4.',
        bullets: ['Gui hop dong truoc thu Sau'],
        dropped: 1,
        errorCode: null,
      },
      todoSuggest: {
        state: 'ready',
        runId: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5d',
        noteId: SAMPLE_NOTE.id,
        noteRevision: SAMPLE_NOTE.revision,
        stale: false,
        suggestions: [{ title: 'Gui hop dong', details: 'Ban PDF', dueOn: '2026-11-20' }],
        dropped: 0,
        errorCode: null,
      },
    };

    const authorHtml = renderPanel('vi', {
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
      results,
    });
    expect(authorHtml).toContain('border-dashed border-proposal/60');
    expect(authorHtml).toContain('Đề xuất');
    expect(authorHtml).toContain('data-testid="note-vy-summary-stale"');
    expect(authorHtml).toContain('data-testid="note-vy-summary-input"');
    expect(authorHtml).toContain('data-testid="note-vy-accept-summary-btn"');
    expect(authorHtml).toContain('data-testid="note-vy-accept-todos-btn"');

    const readerHtml = renderPanel('en', {
      note: { ...SAMPLE_NOTE, mine: false },
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
      results,
    });
    expect(readerHtml).toContain('Suggested');
    expect(readerHtml).toContain('Only the note author can insert this summary into the note.');
    expect(readerHtml).toContain('data-testid="note-vy-summary-readonly"');
    expect(readerHtml).not.toContain('data-testid="note-vy-accept-summary-btn"');
    expect(readerHtml).toContain('data-testid="note-vy-accept-todos-btn"');

    const viewerHtml = renderPanel('en', {
      note: { ...SAMPLE_NOTE, mine: true },
      canWrite: false,
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
      results,
    });
    expect(viewerHtml).toContain('data-testid="note-vy-summary-readonly"');
    expect(viewerHtml).toContain('data-testid="note-vy-todos-readonly"');
    expect(viewerHtml).not.toContain('data-testid="note-vy-accept-summary-btn"');
    expect(viewerHtml).not.toContain('data-testid="note-vy-accept-todos-btn"');

    const emptyTodosHtml = renderPanel('en', {
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
      results: {
        noteId: SAMPLE_NOTE.id,
        summary: null,
        todoSuggest: {
          state: 'ready',
          runId: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5e',
          noteId: SAMPLE_NOTE.id,
          noteRevision: SAMPLE_NOTE.revision,
          stale: false,
          suggestions: [],
          dropped: 2,
          errorCode: null,
        },
      },
    });
    expect(emptyTodosHtml).toContain('data-testid="note-vy-empty-todos"');
    expect(emptyTodosHtml).not.toContain('data-testid="note-vy-accept-todos-btn"');
  });
});
