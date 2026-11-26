// SPDX-License-Identifier: AGPL-3.0-only
// React UI, bounded exponential backoff polling, accessible status/retry recovery, and file helper tests for NoteAttachments (#4213).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTE_ATTACHMENT_MAX_BYTES, type NoteAttachment } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

interface HookState {
  inTarget: boolean;
  stateIdx: number;
  states: unknown[];
  refIdx: number;
  refs: Array<{ current: unknown }>;
  memoIdx: number;
  memos: Array<{ deps?: readonly unknown[]; value: unknown }>;
  idIdx: number;
  effectIdx: number;
  effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }>;
}

const hookDriver = vi.hoisted(
  (): HookState => ({
    inTarget: false,
    stateIdx: 0,
    states: [],
    refIdx: 0,
    refs: [],
    memoIdx: 0,
    memos: [],
    idIdx: 0,
    effectIdx: 0,
    effects: [],
  }),
);

const mockRefreshNotes = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined));
const mockToast = vi.hoisted(() => vi.fn());
const mockDeleteMutation = vi.hoisted(() => vi.fn(async (_id: string) => ({ deleted: true })));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useId: () => {
      if (!hookDriver.inTarget) return actual.useId();
      return `:note-att-${hookDriver.idIdx++}:`;
    },
    useState: (<S,>(initial?: S | (() => S)) => {
      if (!hookDriver.inTarget) return actual.useState(initial as S);
      const idx = hookDriver.stateIdx++;
      if (idx >= hookDriver.states.length) {
        hookDriver.states.push(typeof initial === 'function' ? (initial as () => S)() : initial);
      }
      const setState = (val: S | ((prev: S) => S)) => {
        const prev = hookDriver.states[idx] as S;
        hookDriver.states[idx] = typeof val === 'function' ? (val as (p: S) => S)(prev) : val;
      };
      return [hookDriver.states[idx] as S, setState];
    }) as typeof actual.useState,
    useRef: (<T,>(initial: T) => {
      if (!hookDriver.inTarget) return actual.useRef(initial);
      const idx = hookDriver.refIdx++;
      if (idx >= hookDriver.refs.length) hookDriver.refs.push({ current: initial });
      return hookDriver.refs[idx] as { current: T };
    }) as typeof actual.useRef,
    useMemo: (<T,>(factory: () => T, deps: readonly unknown[]) => {
      if (!hookDriver.inTarget) return actual.useMemo(factory, deps);
      const idx = hookDriver.memoIdx++;
      const prev = hookDriver.memos[idx];
      const changed =
        !prev || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps![i]));
      if (changed) {
        const value = factory();
        hookDriver.memos[idx] = { deps, value };
      }
      return hookDriver.memos[idx]!.value as T;
    }) as typeof actual.useMemo,
    useEffect: ((effect: () => void | (() => void), deps?: readonly unknown[]) => {
      if (!hookDriver.inTarget) return actual.useEffect(effect, deps);
      const idx = hookDriver.effectIdx++;
      const prev = hookDriver.effects[idx];
      const changed =
        !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps![i]));
      if (changed) {
        prev?.cleanup?.();
        const cleanup = effect();
        hookDriver.effects[idx] = {
          ...(deps !== undefined ? { deps } : {}),
          ...(typeof cleanup === 'function' ? { cleanup } : {}),
        };
      }
    }) as typeof actual.useEffect,
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useMutation: ((opts: Parameters<typeof actual.useMutation>[0]) => {
      if (!hookDriver.inTarget) return actual.useMutation(opts);
      return {
        isPending: false,
        error: null,
        variables: undefined,
        mutate: (id: string) => void mockDeleteMutation(id),
        reset: () => undefined,
      };
    }) as typeof actual.useMutation,
  };
});

vi.mock('@ludy/ui/components/dialog', async () => {
  const { createElement } = await import('react');
  const wrap =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) => (open ? createElement('div', null, children) : null),
    DialogContent: wrap('div'),
    DialogDescription: wrap('p'),
    DialogHeader: wrap('div'),
    DialogTitle: wrap('h2'),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  class MockClientError extends Error {
    code: string;
    constructor(code: string, format: (t: (k: string, vals?: Record<string, unknown>) => string) => string) {
      super(format((k) => k));
      this.name = 'ClientError';
      this.code = code;
    }
  }
  return {
    ClientError: MockClientError,
    clientForOrg: () => ({ notes: { attachments: { delete: mockDeleteMutation } } }),
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    fetchNoteAttachmentBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' })),
    uploadNoteAttachment: vi.fn(async () => ({})),
  };
});

vi.mock('../src/lib/toast.ts', () => ({
  toast: mockToast,
}));

vi.mock('../src/components/notes-panel.tsx', () => ({
  refreshNotes: mockRefreshNotes,
}));

vi.mock('../src/components/sign/pdf-canvas-viewer.tsx', () => ({
  PdfCanvasViewer: () => null,
}));

const {
  NOTE_ATTACHMENT_POLL_INITIAL_MS,
  NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS,
  NOTE_ATTACHMENT_POLL_MAX_MS,
  NoteAttachments,
  extractClipboardFiles,
  formatAttachmentBytes,
  isNotePdf,
  isSafeNoteAudio,
  isSafeNoteRasterImage,
  nextNoteAttachmentPollDelayMs,
  validateNoteAttachmentFile,
} = await import('../src/components/note-attachments.tsx');

function resetHooks() {
  for (const entry of hookDriver.effects) entry.cleanup?.();
  hookDriver.inTarget = false;
  hookDriver.stateIdx = 0;
  hookDriver.states = [];
  hookDriver.refIdx = 0;
  hookDriver.refs = [];
  hookDriver.memoIdx = 0;
  hookDriver.memos = [];
  hookDriver.idIdx = 0;
  hookDriver.effectIdx = 0;
  hookDriver.effects = [];
}

function makeAttachment(overrides: Partial<NoteAttachment> = {}): NoteAttachment {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    noteId: '22222222-2222-4222-8222-222222222222',
    authorUserId: '33333333-3333-4333-8333-333333333333',
    filename: 'hop-dong.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    sha256: 'a'.repeat(64),
    extractStatus: 'pending',
    createdAt: '2026-11-25T10:00:00.000Z',
    ...overrides,
  };
}

const idleUploader = {
  uploadingName: null,
  uploadError: null,
  clearUploadError: () => undefined,
  uploadFiles: async () => undefined,
  onEditorPaste: () => undefined,
};

function findElements(node: ReactNode, predicate: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const matches: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (!n || typeof n === 'boolean' || typeof n === 'string' || typeof n === 'number') return;
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (isValidElement(n)) {
      const el = n as ReactElement<Record<string, unknown>>;
      if (predicate(el)) matches.push(el);
      if (el.props && 'children' in el.props) walk(el.props.children as ReactNode);
    }
  };
  walk(node);
  return matches;
}

function renderStatic(attachments: readonly NoteAttachment[], locale: 'vi' | 'en' = 'vi') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        <NoteAttachments attachments={attachments} slug="demo-org" canUpload canDelete uploader={idleUploader} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function createProbe(locale: 'vi' | 'en' = 'vi') {
  let latestTree: ReactNode = null;
  function Probe({ attachments }: { attachments: readonly NoteAttachment[] }) {
    hookDriver.inTarget = true;
    hookDriver.stateIdx = 0;
    hookDriver.refIdx = 0;
    hookDriver.memoIdx = 0;
    hookDriver.idIdx = 0;
    hookDriver.effectIdx = 0;
    try {
      latestTree = NoteAttachments({
        attachments,
        slug: 'demo-org',
        canUpload: true,
        canDelete: true,
        uploader: idleUploader,
      });
      return latestTree;
    } finally {
      hookDriver.inTarget = false;
    }
  }
  const renderProbe = (attachments: readonly NoteAttachment[]) =>
    renderToStaticMarkup(
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        <Probe attachments={attachments} />
      </IntlProvider>,
    );
  return { renderProbe, tree: () => latestTree };
}

describe('NoteAttachments helpers and backoff schedule (#4213)', () => {
  it('computes bounded exponential backoff delays starting at 2s and capped at 30s', () => {
    expect(NOTE_ATTACHMENT_POLL_INITIAL_MS).toBe(2_000);
    expect(NOTE_ATTACHMENT_POLL_MAX_MS).toBe(30_000);
    expect(NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS).toBe(10);
    expect(nextNoteAttachmentPollDelayMs(0)).toBe(2_000);
    expect(nextNoteAttachmentPollDelayMs(1)).toBe(4_000);
    expect(nextNoteAttachmentPollDelayMs(2)).toBe(8_000);
    expect(nextNoteAttachmentPollDelayMs(3)).toBe(16_000);
    expect(nextNoteAttachmentPollDelayMs(4)).toBe(30_000);
    expect(nextNoteAttachmentPollDelayMs(9)).toBe(30_000);
    expect(nextNoteAttachmentPollDelayMs(1000)).toBe(30_000);
    expect(nextNoteAttachmentPollDelayMs(-3)).toBe(2_000);
    expect(nextNoteAttachmentPollDelayMs(Number.NaN)).toBe(2_000);
  });

  it('validates size, clipboard files, and safe inline media types', () => {
    expect(isSafeNoteRasterImage('IMAGE/PNG')).toBe(true);
    expect(isSafeNoteRasterImage('image/svg+xml')).toBe(false);
    expect(isSafeNoteAudio('audio/mpeg')).toBe(true);
    expect(isNotePdf('application/pdf')).toBe(true);
    expect(formatAttachmentBytes(512)).toBe('512 B');
    expect(formatAttachmentBytes(2048)).toBe('2.0 KB');
    expect(formatAttachmentBytes(2 * 1024 * 1024)).toBe('2.0 MB');

    const empty = new File([], 'empty.txt', { type: 'text/plain' });
    expect(validateNoteAttachmentFile(empty)).toMatchObject({ code: 'notes.attachments.emptyFile' });
    const tooBig = new File([new Uint8Array(NOTE_ATTACHMENT_MAX_BYTES + 1)], 'huge.pdf', { type: 'application/pdf' });
    expect(validateNoteAttachmentFile(tooBig)).toMatchObject({ code: 'notes.attachments.fileTooLarge' });

    const files = extractClipboardFiles(
      {
        files: [new File(['png'], 'image.png', { type: 'image/png' })],
      },
      1_700_000_000_000,
    );
    expect(files[0]?.name).toBe('anh-chup-1700000000000.png');
  });

  it('renders localized status badges and active polling region, never rendering SVG or HTML inline', () => {
    const viHtml = renderStatic(
      [
        makeAttachment({ id: 'att-1', filename: 'logo.svg', contentType: 'image/svg+xml', extractStatus: 'skipped' }),
        makeAttachment({ id: 'att-1b', filename: 'page.html', contentType: 'text/html', extractStatus: 'skipped' }),
        makeAttachment({ id: 'att-2', filename: 'hop-dong.pdf', contentType: 'application/pdf', extractStatus: 'pending' }),
        makeAttachment({ id: 'att-3', filename: 'notes.txt', contentType: 'text/plain', extractStatus: 'done' }),
        makeAttachment({ id: 'att-4', filename: 'broken.pdf', contentType: 'application/pdf', extractStatus: 'failed' }),
        makeAttachment({ id: 'att-5', filename: 'shot.png', contentType: 'image/png', extractStatus: 'skipped' }),
      ],
      'vi',
    );
    expect(viHtml).toContain('data-testid="note-attachment-status-pending"');
    expect(viHtml).toContain('data-testid="note-attachment-status-done"');
    expect(viHtml).toContain('data-testid="note-attachment-status-failed"');
    expect(viHtml).not.toContain('data-testid="note-attachment-status-skipped"');
    expect(viHtml).toContain('data-testid="note-attachment-poll-active"');
    expect(viHtml).toContain('role="status"');
    expect(viHtml).toContain('aria-live="polite"');
    // Raster image renders preview skeleton in SSR; SVG/HTML only expose download/delete buttons and never iframe/img.
    expect(viHtml).toContain('Đang tải xem trước...');
    expect(viHtml).not.toContain('<iframe');
    expect(viHtml).not.toContain('note-attachment-image"');

    const enHtml = renderStatic([makeAttachment({ extractStatus: 'pending' })], 'en');
    expect(enHtml).toContain('Waiting for attachment text extraction...');
  });
});

describe('NoteAttachments bounded polling lifecycle and accessible retry recovery (#4213)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHooks();
    mockRefreshNotes.mockReset();
    mockRefreshNotes.mockResolvedValue(undefined);
    mockToast.mockReset();
    mockDeleteMutation.mockReset();
  });

  afterEach(() => {
    resetHooks();
    vi.useRealTimers();
  });

  it('does not poll when no attachment is pending', async () => {
    const { renderProbe } = createProbe('vi');
    const html = renderProbe([makeAttachment({ extractStatus: 'done' }), makeAttachment({ id: 'att-2', extractStatus: 'skipped' })]);
    expect(html).not.toContain('note-attachment-poll-active');
    expect(html).not.toContain('note-attachment-poll-paused');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockRefreshNotes).not.toHaveBeenCalled();
  });

  it('backs off exponentially (2s, 4s, 8s, 16s, 30s...), caps at 10 polls, and exposes an accessible retry button', async () => {
    const pending = [makeAttachment({ id: 'att-pending-1', extractStatus: 'pending' })];
    const { renderProbe, tree } = createProbe('vi');

    let html = renderProbe(pending);
    expect(html).toContain('data-testid="note-attachment-poll-active"');
    expect(html).not.toContain('data-testid="note-attachment-poll-paused"');
    expect(mockRefreshNotes).not.toHaveBeenCalled();

    // Poll 1 at 2s
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(1);

    // Poll 2 at +4s
    await vi.advanceTimersByTimeAsync(3_999);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(2);

    // Poll 3 at +8s
    await vi.advanceTimersByTimeAsync(7_999);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(3);

    // Poll 4 at +16s
    await vi.advanceTimersByTimeAsync(15_999);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(4);

    // Polls 5..10 at +30s each (6 * 30s = 180s)
    for (let expected = 5; expected <= NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS; expected++) {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(mockRefreshNotes).toHaveBeenCalledTimes(expected - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockRefreshNotes).toHaveBeenCalledTimes(expected);
    }

    // Poll cap reached: advancing further triggers zero additional polls.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS);

    html = renderProbe(pending);
    expect(html).toContain('data-testid="note-attachment-poll-paused"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-testid="note-attachment-poll-retry"');
    expect(html).toContain('Kiểm tra lại');

    // Manual retry runs refreshNotes immediately and restarts the bounded backoff cycle from 2s.
    const retryBtn = findElements(tree(), (el) => el.props['data-testid'] === 'note-attachment-poll-retry')[0];
    expect(retryBtn).toBeDefined();
    await (retryBtn!.props.onClick as () => Promise<void> | void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS + 1);

    html = renderProbe(pending);
    expect(html).toContain('data-testid="note-attachment-poll-active"');
    expect(html).not.toContain('data-testid="note-attachment-poll-paused"');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS + 2);
  });

  it('continues backoff across transient background errors and surfaces errors on manual retry while keeping retry button', async () => {
    const pending = [makeAttachment({ id: 'att-err', extractStatus: 'pending' })];
    mockRefreshNotes.mockRejectedValue(new Error('Mất kết nối máy chủ'));
    const { renderProbe, tree } = createProbe('vi');

    renderProbe(pending);
    // Exhaust all 10 attempts despite background rejections.
    await vi.advanceTimersByTimeAsync(210_000);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS);

    let html = renderProbe(pending);
    expect(html).toContain('data-testid="note-attachment-poll-paused"');

    const retryBtn = findElements(tree(), (el) => el.props['data-testid'] === 'note-attachment-poll-retry')[0];
    await (retryBtn!.props.onClick as () => Promise<void> | void)();
    await vi.advanceTimersByTimeAsync(0);

    html = renderProbe(pending);
    expect(html).toContain('Mất kết nối máy chủ');
    expect(html).toContain('data-testid="note-attachment-poll-retry"');
  });

  it('stops polling when pending attachments complete and restarts when a new pending attachment arrives', async () => {
    const att1Pending = [makeAttachment({ id: 'att-1', extractStatus: 'pending' })];
    const att1Done = [makeAttachment({ id: 'att-1', extractStatus: 'done' })];
    const att2Pending = [
      makeAttachment({ id: 'att-1', extractStatus: 'done' }),
      makeAttachment({ id: 'att-2', extractStatus: 'pending' }),
    ];

    const { renderProbe } = createProbe('en');
    renderProbe(att1Pending);
    await vi.advanceTimersByTimeAsync(210_000);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS);
    expect(renderProbe(att1Pending)).toContain('data-testid="note-attachment-poll-paused"');

    // Once finished, polling banner disappears and no more refreshes run.
    const doneHtml = renderProbe(att1Done);
    expect(doneHtml).not.toContain('note-attachment-poll-active');
    expect(doneHtml).not.toContain('note-attachment-poll-paused');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS);

    // Adding a new pending attachment restarts backoff at 2s.
    const newPendingHtml = renderProbe(att2Pending);
    expect(newPendingHtml).toContain('data-testid="note-attachment-poll-active"');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockRefreshNotes).toHaveBeenCalledTimes(NOTE_ATTACHMENT_POLL_MAX_ATTEMPTS + 1);
  });

  it('skips post-await state updates in handleRetryPoll when unmounted mid-flight', async () => {
    const pending = [makeAttachment({ id: 'att-unmount', extractStatus: 'pending' })];
    const { renderProbe, tree } = createProbe('vi');

    renderProbe(pending);
    await vi.advanceTimersByTimeAsync(210_000);
    expect(renderProbe(pending)).toContain('data-testid="note-attachment-poll-paused"');

    let resolveRetry!: () => void;
    mockRefreshNotes.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );

    const retryBtn = findElements(tree(), (el) => el.props['data-testid'] === 'note-attachment-poll-retry')[0];
    const pendingPromise = (retryBtn!.props.onClick as () => Promise<void>)();

    // Unmount while refreshNotes() is in flight: run effect cleanups without clearing state slots.
    for (const entry of hookDriver.effects) entry.cleanup?.();
    const stateSnapshot = [...hookDriver.states];

    resolveRetry();
    await pendingPromise;
    expect(hookDriver.states).toEqual(stateSnapshot);

    // Also verify rejected mid-flight retry after unmount does not write actionError or toggling state.
    resetHooks();
    mockRefreshNotes.mockResolvedValue(undefined);
    const secondProbe = createProbe('vi');
    secondProbe.renderProbe(pending);
    await vi.advanceTimersByTimeAsync(210_000);
    expect(secondProbe.renderProbe(pending)).toContain('data-testid="note-attachment-poll-paused"');

    let rejectRetry!: (err: Error) => void;
    mockRefreshNotes.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRetry = reject;
        }),
    );
    const secondRetryBtn = findElements(secondProbe.tree(), (el) => el.props['data-testid'] === 'note-attachment-poll-retry')[0];
    const rejectedPromise = (secondRetryBtn!.props.onClick as () => Promise<void>)();

    for (const entry of hookDriver.effects) entry.cleanup?.();
    const rejectSnapshot = [...hookDriver.states];

    rejectRetry(new Error('Post-unmount failure'));
    await rejectedPromise;
    expect(hookDriver.states).toEqual(rejectSnapshot);
  });
});
