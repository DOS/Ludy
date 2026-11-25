// SPDX-License-Identifier: AGPL-3.0-only
// SSR and UI contract checks for Notes v2 Vy planner (T4b) and inbox organizer (E5b) (#3563, #4322):
// triggers, viewer hiding, ARIA regions, 44px mobile tap targets (max-md:min-h-11), "Đề xuất" badges,
// tag # normalization, past-date focus apply disable, expectedRevision forwarding, and initialResult draft init.
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotebookSummary, NoteOrganizeResult, TodoPlanResult } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

interface DrivenMutationSlot {
  isPending: boolean;
  error: unknown;
  variables: unknown;
  inFlight: Promise<void> | null;
}

const hookDriver = vi.hoisted(() => ({
  inTargetComponent: false,
  states: [] as unknown[],
  stateCursor: 0,
  refs: [] as Array<{ current: unknown }>,
  refCursor: 0,
  mutations: [] as DrivenMutationSlot[],
  mutationCursor: 0,
}));

const apiMocks = vi.hoisted(() => ({
  notesUpdate: vi.fn(async () => ({ noteId: '20000000-0000-4000-8000-000000000021', revision: 2 })),
  todosReschedule: vi.fn(async (input: { todoIds: string[]; dueOn: string; expectedRevision?: number }) => ({
    updated: input.todoIds.length,
    todoIds: input.todoIds,
  })),
  todosGet: vi.fn(),
  todosUpdate: vi.fn(async () => ({ todoId: '30000000-0000-4000-8000-000000000011', revision: 2 })),
  toast: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (<S,>(initialState?: S | (() => S)) => {
      if (!hookDriver.inTargetComponent) return actual.useState(initialState as S);
      const idx = hookDriver.stateCursor++;
      if (idx >= hookDriver.states.length) {
        hookDriver.states.push(typeof initialState === 'function' ? (initialState as () => S)() : initialState);
      }
      const setState = (action: S | ((prev: S) => S)) => {
        const prev = hookDriver.states[idx] as S;
        hookDriver.states[idx] = typeof action === 'function' ? (action as (p: S) => S)(prev) : action;
      };
      return [hookDriver.states[idx] as S, setState];
    }) as typeof actual.useState,
    useRef: (<T,>(initialValue: T) => {
      if (!hookDriver.inTargetComponent) return actual.useRef(initialValue);
      const idx = hookDriver.refCursor++;
      if (idx >= hookDriver.refs.length) {
        hookDriver.refs.push({ current: initialValue });
      }
      return hookDriver.refs[idx] as { current: T };
    }) as typeof actual.useRef,
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: ((options: { queryKey: readonly unknown[] }) => {
      if (!hookDriver.inTargetComponent) {
        return actual.useQuery(options as Parameters<typeof actual.useQuery>[0]);
      }
      const data = queryClientState.current.getQueryData(options.queryKey);
      return {
        data,
        isSuccess: data !== undefined,
        error: null,
        isPending: false,
      };
    }) as typeof actual.useQuery,
    useMutation: ((options: {
      mutationFn?: (variables: unknown) => Promise<unknown>;
      onSuccess?: (data: unknown, variables: unknown) => Promise<unknown> | unknown;
      onError?: (err: unknown, variables: unknown) => Promise<unknown> | unknown;
    }) => {
      if (!hookDriver.inTargetComponent) {
        return actual.useMutation(options as Parameters<typeof actual.useMutation>[0]);
      }
      const idx = hookDriver.mutationCursor++;
      if (idx >= hookDriver.mutations.length) {
        hookDriver.mutations.push({ isPending: false, error: null, variables: undefined, inFlight: null });
      }
      const slot = hookDriver.mutations[idx]!;
      return {
        isPending: slot.isPending,
        error: slot.error,
        variables: slot.variables,
        reset: () => {
          slot.isPending = false;
          slot.error = null;
          slot.variables = undefined;
        },
        mutate: (variables?: unknown) => {
          slot.isPending = true;
          slot.error = null;
          slot.variables = variables;
          slot.inFlight = (async () => {
            try {
              const data = await options.mutationFn?.(variables);
              await options.onSuccess?.(data, variables);
              slot.isPending = false;
            } catch (err) {
              slot.error = err;
              await options.onError?.(err, variables);
              slot.isPending = false;
            }
          })();
        },
      };
    }) as typeof actual.useMutation,
  };
});

vi.mock('../src/lib/toast.ts', () => ({
  toast: apiMocks.toast,
}));

vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement } = await import('react');
  return {
    Sheet: ({ open = true, children }: { open?: boolean; children?: ReactNode }) => (open ? createElement('div', { 'data-slot': 'sheet' }, children) : null),
    SheetContent: ({ closeLabel, children, ...rest }: { closeLabel: string; children?: ReactNode; [k: string]: unknown }) =>
      createElement('div', { role: 'dialog', 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'sheet-header' }, children),
    SheetBody: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'sheet-body' }, children),
    SheetFooter: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'sheet-footer' }, children),
    SheetTitle: ({ children }: { children?: ReactNode }) => createElement('h2', { 'data-slot': 'sheet-title' }, children),
    SheetDescription: ({ children }: { children?: ReactNode }) => createElement('p', { 'data-slot': 'sheet-description' }, children),
  };
});

const queryClientState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

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
  const orgClient = {
    notes: {
      update: apiMocks.notesUpdate,
      todoPlan: vi.fn(),
      organize: vi.fn(),
      todos: {
        reschedule: apiMocks.todosReschedule,
        get: apiMocks.todosGet,
        update: apiMocks.todosUpdate,
      },
    },
  };
  return { client: node([]), clientForOrg: () => orgClient, orpc: node([]), queryClient: queryClientState.current, errorMessage: String };
});

import { DateInput } from '../src/components/date-input.tsx';
import {
  MyWorkVyPlannerPanel,
  MyWorkVyPlannerTrigger,
  buildFocusDrafts,
  buildRescheduleDrafts,
} from '../src/components/my-work-vy-planner.tsx';
import {
  NotesVyOrganizerPanel,
  NotesVyOrganizerTrigger,
  buildOrganizeDrafts,
  parseOrganizerTags,
} from '../src/components/notes-vy-organizer.tsx';
import { orpc } from '../src/lib/api.ts';

function collectElements(
  node: ReactNode,
  pred: (el: ReactElement<Record<string, unknown>>) => boolean,
  out: ReactElement<Record<string, unknown>>[] = [],
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectElements(item, pred, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  if (pred(el)) out.push(el);
  if (el.props.children !== undefined) collectElements(el.props.children as ReactNode, pred, out);
  return out;
}

function requireByTestId(node: ReactNode, testId: string): ReactElement<Record<string, unknown>> {
  const found = collectElements(node, (el) => el.props['data-testid'] === testId)[0];
  if (!found) throw new Error(`missing testId ${testId}`);
  return found;
}

function wrap(locale: 'vi' | 'en', node: ReactNode) {
  return (
    <QueryClientProvider client={queryClientState.current}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>
  );
}

const OK_METER = {
  aiOn: true,
  state: 'ok' as const,
  percent: 10,
  scope: null,
  resetAt: '2026-12-01',
};

describe('Notes v2 Vy UI components (#3563)', () => {
  it('renders MyWorkVyPlannerTrigger with >= 44px mobile target and hides it for viewers', () => {
    const qc = queryClientState.current;
    qc.clear();
    qc.setQueryData(orpc.me.get.queryOptions().queryKey, {
      userId: 'u1',
      email: 'u1@example.com',
      displayName: null,
      orgs: [{ orgId: 'o1', slug: 'demo-org', name: 'Demo', role: 'member' }],
    });
    const ref = createRef<HTMLButtonElement>();
    const memberHtml = renderToStaticMarkup(
      wrap('vi', <MyWorkVyPlannerTrigger slug="demo-org" open={false} onToggle={() => {}} buttonRef={ref} />),
    );
    expect(memberHtml).toContain('Vy sắp lịch hôm nay');
    expect(memberHtml).toContain('my-work-vy-plan-btn');
    expect(memberHtml).toContain('max-md:min-h-11');
    expect(memberHtml).not.toContain('trợ lý');

    qc.setQueryData(orpc.me.get.queryOptions().queryKey, {
      userId: 'u1',
      email: 'u1@example.com',
      displayName: null,
      orgs: [{ orgId: 'o1', slug: 'demo-org', name: 'Demo', role: 'viewer' }],
    });
    const viewerHtml = renderToStaticMarkup(
      wrap('vi', <MyWorkVyPlannerTrigger slug="demo-org" open={false} onToggle={() => {}} buttonRef={ref} />),
    );
    expect(viewerHtml).toBe('');
  });

  it('renders MyWorkVyPlannerPanel blocked state and ready focus/reschedule proposal rows with Đề xuất badge', () => {
    const qc = queryClientState.current;
    qc.clear();
    qc.setQueryData(orpc.me.get.queryOptions().queryKey, {
      userId: 'u1',
      email: 'u1@example.com',
      displayName: null,
      orgs: [{ orgId: 'o1', slug: 'demo-org', name: 'Demo', role: 'member' }],
    });
    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: false,
      reason: 'budget',
      resetOn: '2026-12-01',
    });
    qc.setQueryData(orpc.ai.meter.queryOptions({ input: { module: 'notes' } }).queryKey, OK_METER);

    const ref = createRef<HTMLButtonElement>();
    const blockedHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <MyWorkVyPlannerPanel slug="demo-org" open viewerTz="Asia/Ho_Chi_Minh" triggerRef={ref} onClose={() => {}} />,
      ),
    );
    expect(blockedHtml).toContain('my-work-vy-planner');
    expect(blockedHtml).toContain('role="region"');
    expect(blockedHtml).toContain('Vy đề xuất · AI');
    expect(blockedHtml).toContain('my-work-vy-blocked');
    expect(blockedHtml).toContain('max-md:min-h-11');

    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: true,
      reason: null,
      resetOn: null,
    });
    const samplePlan: TodoPlanResult = {
      state: 'ready',
      runId: '40000000-0000-4000-8000-000000000001',
      today: '2026-11-21',
      focus: [
        {
          todoId: '30000000-0000-4000-8000-000000000011',
          title: 'Nộp tờ khai thuế',
          priority: 1,
          dueOn: '2026-11-20',
          dueTime: null,
          overdue: true,
          reason: 'Quá hạn cần xử lý ngay',
          revision: 1,
        },
      ],
      reschedules: [
        {
          todoId: '30000000-0000-4000-8000-000000000011',
          title: 'Nộp tờ khai thuế',
          currentDueOn: '2026-11-20',
          dueOn: '2026-11-22',
          reason: 'Dời sang ngày mai',
          revision: 1,
        },
      ],
      dropped: 0,
      errorCode: null,
    };
    const readyHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <MyWorkVyPlannerPanel
          slug="demo-org"
          open
          viewerTz="Asia/Ho_Chi_Minh"
          triggerRef={ref}
          onClose={() => {}}
          initialResult={samplePlan}
        />,
      ),
    );
    expect(readyHtml).toContain('Nộp tờ khai thuế');
    expect(readyHtml).toContain('Đề xuất');
    expect(readyHtml).toContain('border-dashed border-proposal/60 bg-proposal/5');
    expect(readyHtml).toContain('data-testid="coworker-attribution"');
    expect(readyHtml).toContain('my-work-vy-focus-proposal-badge-30000000-0000-4000-8000-000000000011');
    expect(readyHtml).toContain('my-work-vy-reschedule-apply-30000000-0000-4000-8000-000000000011');
    expect(readyHtml).not.toContain('uppercase');
  });

  it('renders NotesVyOrganizerTrigger and NotesVyOrganizerPanel with AI badge, Đề xuất proposals, and paused hint', () => {
    const qc = queryClientState.current;
    qc.clear();
    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: false,
      reason: 'paused',
      resetOn: null,
    });
    qc.setQueryData(orpc.ai.meter.queryOptions({ input: { module: 'notes' } }).queryKey, OK_METER);

    const ref = createRef<HTMLButtonElement>();
    const triggerHtml = renderToStaticMarkup(
      wrap('vi', <NotesVyOrganizerTrigger open={false} onToggle={() => {}} buttonRef={ref} />),
    );
    expect(triggerHtml).toContain('Vy dọn hộp thư');
    expect(triggerHtml).toContain('notes-vy-organize-btn');
    expect(triggerHtml).toContain('max-md:min-h-11');

    const notebooks: NotebookSummary[] = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        authorUserId: 'u1',
        visibility: 'private',
        name: 'Tài chính cá nhân',
        stackName: null,
        pinned: false,
        sortKey: '000001',
        noteCount: 0,
        mine: true,
        editable: true,
        revision: 1,
        createdAt: '2026-11-21T00:00:00Z',
        updatedAt: '2026-11-21T00:00:00Z',
      },
    ];
    const pausedHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <NotesVyOrganizerPanel slug="demo-org" open notebooks={notebooks} triggerRef={ref} onClose={() => {}} />,
      ),
    );
    expect(pausedHtml).toContain('notes-vy-organizer');
    expect(pausedHtml).toContain('Vy đề xuất · AI');
    expect(pausedHtml).toContain('notes-vy-organize-blocked');
    expect(pausedHtml).not.toContain('trợ lý');

    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: true,
      reason: null,
      resetOn: null,
    });
    const sampleOrganize: NoteOrganizeResult = {
      state: 'ready',
      runId: '40000000-0000-4000-8000-000000000002',
      suggestions: [
        {
          noteId: '20000000-0000-4000-8000-000000000021',
          title: 'Biên lai tiền điện',
          visibility: 'private',
          revision: 1,
          existingTags: [],
          notebookId: '10000000-0000-4000-8000-000000000001',
          notebookName: 'Tài chính cá nhân',
          tags: ['evn', 'hóa đơn'],
          reason: 'Thuộc chi phí hàng tháng',
          canEditTags: true,
        },
      ],
      dropped: 0,
      errorCode: null,
    };
    const readyHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <NotesVyOrganizerPanel
          slug="demo-org"
          open
          notebooks={notebooks}
          triggerRef={ref}
          onClose={() => {}}
          initialResult={sampleOrganize}
        />,
      ),
    );
    expect(readyHtml).toContain('Biên lai tiền điện');
    expect(readyHtml).toContain('Tài chính cá nhân');
    expect(readyHtml).toContain('#evn');
    expect(readyHtml).toContain('Đề xuất');
    expect(readyHtml).toContain('border-dashed border-proposal/60 bg-proposal/5');
    expect(readyHtml).toContain('data-testid="coworker-attribution"');
    expect(readyHtml).toContain('notes-vy-organize-apply-20000000-0000-4000-8000-000000000021');
  });

  it('mounts both Vy organizer panels inside right-hand Sheet drawers with focus return and no Vietnamese uppercase headings', () => {
    const plannerSource = readFileSync(new URL('../src/components/my-work-vy-planner.tsx', import.meta.url), 'utf8');
    const organizerSource = readFileSync(new URL('../src/components/notes-vy-organizer.tsx', import.meta.url), 'utf8');
    for (const [label, src] of [
      ['my-work-vy-planner', plannerSource],
      ['notes-vy-organizer', organizerSource],
    ] as const) {
      expect(src, label).toContain("@ludy/ui/components/sheet");
      expect(src, label).toContain('<SheetContent');
      expect(src, label).toContain('triggerRef.current');
      expect(src, label).toContain('<ProposalSurface');
      expect(src, label).toContain('<CoworkerAttribution');
      expect(src, label).not.toContain('uppercase');
    }
  });
});

describe('Notes v2 Vy polish & validation (#4322)', () => {
  beforeEach(() => {
    queryClientState.current.clear();
    apiMocks.notesUpdate.mockReset();
    apiMocks.notesUpdate.mockResolvedValue({ noteId: '20000000-0000-4000-8000-000000000021', revision: 2 });
    apiMocks.todosReschedule.mockReset();
    apiMocks.todosReschedule.mockImplementation(async (input) => ({
      updated: input.todoIds.length,
      todoIds: input.todoIds,
    }));
    apiMocks.todosGet.mockReset();
    apiMocks.todosUpdate.mockReset();
    apiMocks.toast.mockReset();
    hookDriver.inTargetComponent = false;
    hookDriver.states = [];
    hookDriver.stateCursor = 0;
    hookDriver.refs = [];
    hookDriver.refCursor = 0;
    hookDriver.mutations = [];
    hookDriver.mutationCursor = 0;
  });

  it('normalizes leading # on organizer tag input and builds clean initialResult drafts', () => {
    expect(parseOrganizerTags('#evn, ##Hóa đơn, evn, #, ### ,  #thuế ')).toEqual(['evn', 'hóa đơn', 'thuế']);
    expect(parseOrganizerTags('###, # ')).toEqual([]);
    expect(parseOrganizerTags(`#${'a'.repeat(40)}`)).toEqual(['a'.repeat(40)]);

    expect(buildOrganizeDrafts(null)).toEqual({});
    expect(
      buildOrganizeDrafts({ state: 'failed', runId: null, suggestions: [], dropped: 0, errorCode: 'AI_BUSY' }),
    ).toEqual({});
    expect(buildFocusDrafts(null)).toEqual({});
    expect(buildRescheduleDrafts(null)).toEqual({});

    const samplePlan: TodoPlanResult = {
      state: 'ready',
      runId: '40000000-0000-4000-8000-000000000001',
      today: '2026-11-21',
      focus: [
        {
          todoId: '30000000-0000-4000-8000-000000000011',
          title: 'Qua han duoc keo ve hom nay',
          priority: 1,
          dueOn: '2026-11-20',
          dueTime: null,
          overdue: true,
          reason: 'Uu tien cao',
          revision: 3,
        },
        {
          todoId: '30000000-0000-4000-8000-000000000012',
          title: 'Chua co ngay hen',
          priority: 2,
          dueOn: null,
          dueTime: null,
          overdue: false,
          reason: 'Nen lam hom nay',
          revision: 1,
        },
      ],
      reschedules: [
        {
          todoId: '30000000-0000-4000-8000-000000000011',
          title: 'Qua han',
          currentDueOn: '2026-11-20',
          dueOn: '2026-11-22',
          reason: 'Doi lich',
          revision: 3,
        },
      ],
      dropped: 0,
      errorCode: null,
    };
    expect(buildFocusDrafts(samplePlan)).toEqual({
      '30000000-0000-4000-8000-000000000011': {
        priority: 1,
        dueOn: '2026-11-21',
        edited: false,
        applied: false,
        error: null,
      },
      '30000000-0000-4000-8000-000000000012': {
        priority: 2,
        dueOn: '2026-11-21',
        edited: false,
        applied: false,
        error: null,
      },
    });
    expect(buildRescheduleDrafts(samplePlan)).toEqual({
      '30000000-0000-4000-8000-000000000011': {
        dueOn: '2026-11-22',
        edited: false,
        applied: false,
        error: null,
      },
    });
  });

  it('strips # from manual tags in NotesVyOrganizerPanel chips/payloads and updates initialResult drafts on apply & error', async () => {
    const qc = queryClientState.current;
    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: true,
      reason: null,
      resetOn: null,
    });
    qc.setQueryData(orpc.ai.meter.queryOptions({ input: { module: 'notes' } }).queryKey, OK_METER);

    const noteA = '20000000-0000-4000-8000-000000000021';
    const noteB = '20000000-0000-4000-8000-000000000022';
    const nbId = '10000000-0000-4000-8000-000000000001';
    const notebooks: NotebookSummary[] = [
      {
        id: nbId,
        authorUserId: 'u1',
        visibility: 'private',
        name: 'Tài chính cá nhân',
        stackName: null,
        pinned: false,
        sortKey: '000001',
        noteCount: 0,
        mine: true,
        editable: true,
        revision: 1,
        createdAt: '2026-11-21T00:00:00Z',
        updatedAt: '2026-11-21T00:00:00Z',
      },
    ];
    const initialResult: NoteOrganizeResult = {
      state: 'ready',
      runId: '40000000-0000-4000-8000-000000000002',
      suggestions: [
        {
          noteId: noteA,
          title: 'Biên lai tiền điện',
          visibility: 'private',
          revision: 4,
          existingTags: ['tồn tại'],
          notebookId: null,
          notebookName: null,
          tags: ['evn'],
          reason: 'Chi phí tháng 11',
          canEditTags: true,
        },
        {
          noteId: noteB,
          title: 'Hóa đơn nước',
          visibility: 'private',
          revision: 2,
          existingTags: [],
          notebookId: nbId,
          notebookName: 'Tài chính cá nhân',
          tags: ['nước'],
          reason: 'Chi phí cố định',
          canEditTags: true,
        },
      ],
      dropped: 0,
      errorCode: null,
    };

    const ref = createRef<HTMLButtonElement>();
    let capturedTree: ReactNode = null;
    function Probe(props: Parameters<typeof NotesVyOrganizerPanel>[0]) {
      hookDriver.inTargetComponent = true;
      hookDriver.stateCursor = 0;
      hookDriver.refCursor = 0;
      hookDriver.mutationCursor = 0;
      try {
        const rendered = NotesVyOrganizerPanel(props);
        capturedTree = rendered;
        return rendered;
      } finally {
        hookDriver.inTargetComponent = false;
      }
    }
    const renderProbe = () =>
      renderToStaticMarkup(
        wrap(
          'vi',
          <Probe
            slug="demo-org"
            open
            notebooks={notebooks}
            triggerRef={ref}
            onClose={() => {}}
            initialResult={initialResult}
          />,
        ),
      );

    // 1. Initial render with initialResult immediately shows Apply All (2) because drafts were initialized.
    const initialHtml = renderProbe();
    expect(initialHtml).toContain('data-testid="notes-vy-organize-apply-all"');
    expect(initialHtml).toContain('Áp dụng tất cả (2)');

    // 2. Typing only '#' leaves Apply disabled (no notebook selected) and renders no '#' badge.
    (requireByTestId(capturedTree, `notes-vy-organize-tags-${noteA}`).props.onChange as (e: {
      target: { value: string };
    }) => void)({ target: { value: '###, # ' } });
    const hashOnlyHtml = renderProbe();
    expect(requireByTestId(capturedTree, `notes-vy-organize-apply-${noteA}`).props.disabled).toBe(true);
    expect(hashOnlyHtml).not.toContain('>#<');

    // 3. Typing '#evn, ##hóa đơn, tồn tại' strips leading '#' in preview chips and merges cleanly on Apply.
    (requireByTestId(capturedTree, `notes-vy-organize-tags-${noteA}`).props.onChange as (e: {
      target: { value: string };
    }) => void)({ target: { value: '#evn, ##hóa đơn, tồn tại' } });
    const taggedHtml = renderProbe();
    expect(taggedHtml).toContain('>#evn<');
    expect(taggedHtml).toContain('>#hóa đơn<');
    expect(taggedHtml).not.toContain('##evn');
    expect(taggedHtml).not.toContain('###hóa đơn');

    // 4. Applying noteA updates initialized draft to Applied on success.
    (requireByTestId(capturedTree, `notes-vy-organize-apply-${noteA}`).props.onClick as () => void)();
    await hookDriver.mutations[1]!.inFlight;
    expect(apiMocks.notesUpdate).toHaveBeenCalledWith({
      noteId: noteA,
      revision: 4,
      tags: ['tồn tại', 'evn', 'hóa đơn'],
    });
    const afterApplyOneHtml = renderProbe();
    expect(afterApplyOneHtml).toContain(`data-testid="notes-vy-organize-applied-badge-${noteA}"`);

    // 5. Applying remaining noteB via single Apply records initialized row error when API rejects.
    apiMocks.notesUpdate.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { code: 'NOTE_REVISION_CONFLICT' }));
    (requireByTestId(capturedTree, `notes-vy-organize-apply-${noteB}`).props.onClick as () => void)();
    await hookDriver.mutations[1]!.inFlight;
    const afterErrorHtml = renderProbe();
    expect(afterErrorHtml).toContain(catalog('vi').notes.vy.errors.NOTE_REVISION_CONFLICT);

    // 6. Apply All on a fresh initialResult mount applies noteA and isolates conflict error on noteB.
    hookDriver.states = [];
    renderProbe();
    apiMocks.notesUpdate.mockClear();
    apiMocks.notesUpdate
      .mockResolvedValueOnce({ noteId: noteA, revision: 5 })
      .mockRejectedValueOnce(Object.assign(new Error('Conflict'), { code: 'NOTE_REVISION_CONFLICT' }));
    (requireByTestId(capturedTree, 'notes-vy-organize-apply-all').props.onClick as () => void)();
    await hookDriver.mutations[2]!.inFlight;
    expect(apiMocks.notesUpdate).toHaveBeenCalledTimes(2);
    const afterApplyAllHtml = renderProbe();
    expect(afterApplyAllHtml).toContain(`data-testid="notes-vy-organize-applied-badge-${noteA}"`);
    expect(afterApplyAllHtml).not.toContain(`data-testid="notes-vy-organize-applied-badge-${noteB}"`);
    expect(afterApplyAllHtml).toContain(catalog('vi').notes.vy.errors.NOTE_REVISION_CONFLICT);
  });

  it('disables Focus Apply on manual past date, forwards expectedRevision on reschedule, and initializes initialResult drafts in MyWorkVyPlannerPanel', async () => {
    const qc = queryClientState.current;
    qc.setQueryData(orpc.me.get.queryOptions().queryKey, {
      userId: 'u1',
      email: 'u1@example.com',
      displayName: null,
      orgs: [{ orgId: 'o1', slug: 'demo-org', name: 'Demo', role: 'member' }],
    });
    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: true,
      reason: null,
      resetOn: null,
    });
    qc.setQueryData(orpc.ai.meter.queryOptions({ input: { module: 'notes' } }).queryKey, OK_METER);

    const focusId = '30000000-0000-4000-8000-000000000011';
    const reschedA = '30000000-0000-4000-8000-000000000012';
    const reschedB = '30000000-0000-4000-8000-000000000013';
    const initialPlan: TodoPlanResult = {
      state: 'ready',
      runId: '40000000-0000-4000-8000-000000000003',
      today: '2026-11-21',
      focus: [
        {
          todoId: focusId,
          title: 'Nộp tờ khai thuế',
          priority: 1,
          dueOn: '2026-11-20',
          dueTime: null,
          overdue: true,
          reason: 'Quá hạn cần xử lý ngay',
          revision: 5,
        },
      ],
      reschedules: [
        {
          todoId: reschedA,
          title: 'Gọi kế toán',
          currentDueOn: '2026-11-19',
          dueOn: '2026-11-22',
          reason: 'Dời sang mai',
          revision: 7,
        },
        {
          todoId: reschedB,
          title: 'Gửi hóa đơn',
          currentDueOn: '2026-11-18',
          dueOn: '2026-11-22',
          reason: 'Dời sang mai',
          revision: 9,
        },
      ],
      dropped: 0,
      errorCode: null,
    };

    const ref = createRef<HTMLButtonElement>();
    let capturedTree: ReactNode = null;
    function Probe(props: Parameters<typeof MyWorkVyPlannerPanel>[0]) {
      hookDriver.inTargetComponent = true;
      hookDriver.stateCursor = 0;
      hookDriver.refCursor = 0;
      hookDriver.mutationCursor = 0;
      try {
        const rendered = MyWorkVyPlannerPanel(props);
        capturedTree = rendered;
        return rendered;
      } finally {
        hookDriver.inTargetComponent = false;
      }
    }
    const renderProbe = () =>
      renderToStaticMarkup(
        wrap(
          'vi',
          <Probe
            slug="demo-org"
            open
            viewerTz="Asia/Ho_Chi_Minh"
            triggerRef={ref}
            onClose={() => {}}
            initialResult={initialPlan}
          />,
        ),
      );

    renderProbe();
    expect(requireByTestId(capturedTree, `my-work-vy-focus-apply-${focusId}`).props.disabled).toBe(false);

    // 1. Typing a past date ('2026-11-20' < '2026-11-21') disables Focus Apply button.
    const focusDateInput = collectElements(capturedTree, (el) => el.type === DateInput)[0]!;
    (focusDateInput.props.onChange as (nextDueOn: string) => void)('2026-11-20');
    renderProbe();
    expect(requireByTestId(capturedTree, `my-work-vy-focus-apply-${focusId}`).props.disabled).toBe(true);

    // 2. Clearing Focus date ('') keeps Focus Apply enabled (not treated as past date).
    (collectElements(capturedTree, (el) => el.type === DateInput)[0]!.props.onChange as (nextDueOn: string) => void)('');
    renderProbe();
    expect(requireByTestId(capturedTree, `my-work-vy-focus-apply-${focusId}`).props.disabled).toBe(false);

    // 3. Typing today or future keeps Focus Apply enabled and forwards expectedRevision on reschedule.
    (collectElements(capturedTree, (el) => el.type === DateInput)[0]!.props.onChange as (nextDueOn: string) => void)(
      '2026-11-23',
    );
    renderProbe();
    expect(requireByTestId(capturedTree, `my-work-vy-focus-apply-${focusId}`).props.disabled).toBe(false);

    (requireByTestId(capturedTree, `my-work-vy-focus-apply-${focusId}`).props.onClick as () => void)();
    await hookDriver.mutations[1]!.inFlight;
    expect(apiMocks.todosReschedule).toHaveBeenCalledWith({
      todoIds: [focusId],
      dueOn: '2026-11-23',
      expectedRevision: 5,
    });
    const afterFocusHtml = renderProbe();
    expect(afterFocusHtml).toContain(`data-testid="my-work-vy-focus-applied-badge-${focusId}"`);

    // 4. Single reschedule forwards expectedRevision and marks initialized initialResult row as Applied.
    (requireByTestId(capturedTree, `my-work-vy-reschedule-apply-${reschedA}`).props.onClick as () => void)();
    await hookDriver.mutations[2]!.inFlight;
    expect(apiMocks.todosReschedule).toHaveBeenCalledWith({
      todoIds: [reschedA],
      dueOn: '2026-11-22',
      expectedRevision: 7,
    });
    const afterOneReschedHtml = renderProbe();
    expect(afterOneReschedHtml).toContain(`data-testid="my-work-vy-reschedule-applied-badge-${reschedA}"`);

    // 5. Apply All forwards expectedRevision for all pending reschedules and isolates conflict errors to the stale row.
    const applyAllBtn = collectElements(
      capturedTree,
      (el) => el.props['data-testid'] === 'my-work-vy-reschedule-apply-all',
    )[0];
    expect(applyAllBtn).toBeUndefined();
    hookDriver.states = [];
    renderProbe();
    apiMocks.todosReschedule.mockClear();
    apiMocks.todosReschedule
      .mockResolvedValueOnce({ updated: 1, todoIds: [reschedA] })
      .mockRejectedValueOnce(Object.assign(new Error('Revision conflict'), { code: 'TODO_REVISION_CONFLICT' }));
    (requireByTestId(capturedTree, 'my-work-vy-reschedule-apply-all').props.onClick as () => void)();
    await hookDriver.mutations[3]!.inFlight;
    expect(apiMocks.todosReschedule).toHaveBeenNthCalledWith(1, {
      todoIds: [reschedA],
      dueOn: '2026-11-22',
      expectedRevision: 7,
    });
    expect(apiMocks.todosReschedule).toHaveBeenNthCalledWith(2, {
      todoIds: [reschedB],
      dueOn: '2026-11-22',
      expectedRevision: 9,
    });
    const afterAllHtml = renderProbe();
    expect(afterAllHtml).toContain(`data-testid="my-work-vy-reschedule-applied-badge-${reschedA}"`);
    expect(afterAllHtml).not.toContain(`data-testid="my-work-vy-reschedule-applied-badge-${reschedB}"`);
    expect(afterAllHtml).toContain(catalog('vi').notes.vy.errors.TODO_REVISION_CONFLICT);
  });
});
