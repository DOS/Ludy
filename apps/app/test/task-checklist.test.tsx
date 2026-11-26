// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import {
  TASK_CHECKLIST_STEPS_MAX,
  TASK_CHECKLIST_STEP_MAX,
  countTaskChecklistSteps,
  parseTaskChecklist,
  serializeTaskChecklist,
  zProjectTaskCreate,
  zTaskChecklist,
  type ProjectTaskCard,
  type TaskChecklistStep,
} from '@ludy/kernel-contract';
import { act, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDomNode, createScopedDomHarness } from './fake-dom.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { en as enMessages } from '../src/i18n/messages/en.ts';

const queryClientState = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const authState = vi.hoisted(() => ({ modules: ['kernel', 'projects', 'notes'] as string[] }));
const mutationState = vi.hoisted(() => ({
  handler: null as null | ((variables: Record<string, unknown>) => Promise<unknown>),
}));
const TASK_ID = '20000000-0000-4000-8000-000000000101';
const PROJECT_ID = '10000000-0000-4000-8000-000000000001';

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: async () => null });
        if (prop === 'mutationOptions') {
          return (opts: Record<string, unknown> = {}) => ({
            mutationFn: async (variables: Record<string, unknown>) =>
              mutationState.handler ? mutationState.handler(variables) : undefined,
            ...opts,
          });
        }
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    queryClient: queryClientState.current,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: authState.modules }) }));

vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    useParams: () => ({ slug: 'demo-org', id: TASK_ID }),
    useNavigate: () => () => Promise.resolve(),
    useSearch: () => ({}),
    Link: ({ children, to, className }: { children?: ReactNode; to: string; className?: string }) =>
      createElement('a', { href: to, className }, children),
  };
});

const {
  TaskChecklistBadge,
  TaskChecklistEditor,
  TaskChecklistSection,
  hasBlankChecklistStep,
  isTaskStaleRevision,
  normalizeChecklistSteps,
  taskRevisionPrecondition,
} = await import('../src/components/task-checklist.tsx');
const { ProjectBoardView } = await import('../src/components/project-board.tsx');
const { EditProjectTaskDialog } = await import('../src/components/project-task-dialog.tsx');
const { TaskDetailPage } = await import('../src/routes/tasks.tsx');

function wrap(node: ReactNode, locale: 'vi' | 'en' = 'vi') {
  return (
    <QueryClientProvider client={queryClientState.current}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>
  );
}

function makeCard(overrides: Partial<ProjectTaskCard> = {}): ProjectTaskCard {
  return {
    id: TASK_ID,
    title: 'Đối soát hóa đơn đầu vào',
    description: null,
    status: 'todo',
    assigneePositionId: null,
    due: null,
    checklist: [],
    tainted: false,
    checkedOut: false,
    commentCount: 0,
    createdAt: '2026-11-16T09:00:00.000Z',
    addedAt: '2026-11-16T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  queryClientState.current.clear();
  authState.modules = ['kernel', 'projects', 'notes'];
  mutationState.handler = null;
});

describe('task checklist contract & helpers (#2606)', () => {
  it('validates step shape, length, trimming, count limit and extra keys', () => {
    const parsed = zTaskChecklist.parse([
      { text: '  Kiểm tra MST  ', done: false },
      { text: 'Xuất bảng kê', done: true },
    ]);
    expect(parsed).toEqual([
      { text: 'Kiểm tra MST', done: false },
      { text: 'Xuất bảng kê', done: true },
    ]);
    expect(countTaskChecklistSteps(parsed)).toEqual({ done: 1, total: 2 });
    expect(serializeTaskChecklist(parsed)).toBe('[{"text":"Kiểm tra MST","done":false},{"text":"Xuất bảng kê","done":true}]');
    expect(parseTaskChecklist([{ text: 'Bước A', done: false, extra: 1 }, null, 'bad'])).toEqual([{ text: 'Bước A', done: false }]);

    expect(zTaskChecklist.safeParse([{ text: '   ', done: false }]).success).toBe(false);
    expect(zTaskChecklist.safeParse([{ text: '\t\n\r\v\f', done: false }]).success).toBe(false);
    expect(zTaskChecklist.safeParse([{ text: '\u00A0', done: false }]).success).toBe(false);
    expect(zTaskChecklist.safeParse([{ text: '\u1680\u2003\u2028\u2029\u202F\u205F\u3000\uFEFF', done: false }]).success).toBe(false);
    expect(zTaskChecklist.parse([{ text: '\u00A0\t Bước Unicode \u3000\uFEFF', done: false }])).toEqual([
      { text: 'Bước Unicode', done: false },
    ]);
    expect(zTaskChecklist.safeParse([{ text: 'a'.repeat(TASK_CHECKLIST_STEP_MAX + 1), done: false }]).success).toBe(false);
    expect(zTaskChecklist.safeParse([{ text: 'ok', done: false, extra: true }]).success).toBe(false);
    expect(
      zTaskChecklist.safeParse(
        Array.from({ length: TASK_CHECKLIST_STEPS_MAX + 1 }, (_, i) => ({ text: `Bước ${i + 1}`, done: false })),
      ).success,
    ).toBe(false);

    expect(
      zProjectTaskCreate.safeParse({
        projectId: PROJECT_ID,
        title: 'Việc dự án',
        assigneePositionId: null,
        checklist: [{ text: '  Bước 1 ', done: false }],
      }).success,
    ).toBe(true);
  });

  it('normalizes steps and detects blank step drafts', () => {
    expect(normalizeChecklistSteps([{ text: '  Bước 1  ', done: true }])).toEqual([{ text: 'Bước 1', done: true }]);
    expect(normalizeChecklistSteps([{ text: '\u00A0Bước Unicode\t', done: false }])).toEqual([{ text: 'Bước Unicode', done: false }]);
    expect(hasBlankChecklistStep([{ text: '   ', done: false }])).toBe(true);
    expect(hasBlankChecklistStep([{ text: '\u00A0\t\u3000\uFEFF', done: false }])).toBe(true);
    expect(hasBlankChecklistStep([{ text: 'Bước 1', done: false }])).toBe(false);
  });

  it('builds optional expectedRevision preconditions and recognizes TASK_STALE_REVISION across locales', () => {
    expect(taskRevisionPrecondition(undefined)).toEqual({});
    expect(taskRevisionPrecondition(3)).toEqual({ expectedRevision: 3 });
    expect(isTaskStaleRevision({ code: 'TASK_STALE_REVISION' })).toBe(true);
    expect(isTaskStaleRevision({ data: { code: 'TASK_STALE_REVISION' } })).toBe(true);
    expect(isTaskStaleRevision({ code: 'TASK_CHECKED_OUT' })).toBe(false);
    expect(isTaskStaleRevision(null)).toBe(false);
    expect(viMessages.kernelErrors.codes.TASK_STALE_REVISION).toBeTruthy();
    expect(enMessages.kernelErrors.codes.TASK_STALE_REVISION).toBeTruthy();
  });
});

describe('task checklist UI (#2606)', () => {
  it('renders done/total badge on project board and list view only when checklist has steps', () => {
    const withSteps = makeCard({
      id: '10000000-0000-4000-8000-000000000011',
      title: 'Việc có bước',
      checklist: [
        { text: 'Bước 1', done: true },
        { text: 'Bước 2', done: false },
        { text: 'Bước 3', done: true },
      ],
    });
    const withoutSteps = makeCard({ id: '10000000-0000-4000-8000-000000000012', title: 'Việc không bước', checklist: [] });

    const boardHtml = renderToStaticMarkup(
      wrap(
        <ProjectBoardView
          slug="demo-org"
          view="board"
          tasks={[withSteps, withoutSteps]}
          seats={[]}
          canEdit={true}
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={() => undefined}
          onCreateTask={() => undefined}
          onEditTask={() => undefined}
          onRemoveTask={() => undefined}
        />,
      ),
    );
    expect(boardHtml).toContain('data-testid="task-checklist-badge"');
    expect(boardHtml).toContain('2/3');
    expect((boardHtml.match(/data-testid="task-checklist-badge"/g) ?? []).length).toBe(1);

    const listHtml = renderToStaticMarkup(
      wrap(
        <ProjectBoardView
          slug="demo-org"
          view="list"
          tasks={[withSteps]}
          seats={[]}
          canEdit={true}
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={() => undefined}
          onCreateTask={() => undefined}
          onEditTask={() => undefined}
          onRemoveTask={() => undefined}
        />,
      ),
    );
    expect(listHtml).toContain('2/3');
    expect(renderToStaticMarkup(wrap(<TaskChecklistBadge steps={[]} />))).toBe('');
  });

  it('renders interactive checklist editor states and limit/error hints', () => {
    const full = Array.from({ length: TASK_CHECKLIST_STEPS_MAX }, (_, i) => ({ text: `Bước ${i + 1}`, done: false }));
    const editorHtml = renderToStaticMarkup(
      wrap(
        <TaskChecklistEditor
          idPrefix="unit"
          value={[{ text: 'Kiểm tra A', done: true }, { text: '', done: false }]}
          stepError={true}
          onChange={() => undefined}
        />,
      ),
    );
    expect(editorHtml).toContain('1/2');
    expect(editorHtml).toContain('Kiểm tra A');
    expect(editorHtml).toContain('line-through');
    expect(editorHtml).toContain(viMessages.tasks.checklistStepRequired);

    const limitHtml = renderToStaticMarkup(
      wrap(<TaskChecklistEditor idPrefix="full" value={full} onChange={() => undefined} />, 'en'),
    );
    expect(limitHtml).toContain('Up to 50 steps per task.');
    expect(limitHtml).not.toContain(enMessages.tasks.checklistAdd);
  });

  it('renders checklist section on task detail and respects checkedOut and readOnly locks', () => {
    queryClientState.current.setQueryData(['org', 'get'], { role: 'owner', members: [] });
    queryClientState.current.setQueryData(['chart', 'get'], { root: [], positions: [], agents: [], killSwitches: [] });
    queryClientState.current.setQueryData(['tasks', 'get'], {
      task: {
        id: TASK_ID,
        title: 'Chốt báo cáo tháng',
        kind: 'human',
        status: 'todo',
        description: null,
        assigneePositionId: null,
        parentTaskId: null,
        source: 'human',
        sourceRef: null,
        requestDepth: 0,
        tainted: false,
        createdByType: 'user',
        due: null,
        checklist: [
          { text: 'Tổng hợp số liệu', done: true },
          { text: 'Gửi kế toán trưởng', done: false },
        ],
        fence: '0',
        checkedOut: false,
        createdAt: '2026-11-16T09:00:00.000Z',
      },
      comments: [],
      proposal: null,
    });

    const detailHtml = renderToStaticMarkup(wrap(<TaskDetailPage />));
    expect(detailHtml).toContain('data-testid="task-checklist-section"');
    expect(detailHtml).toContain('Tổng hợp số liệu');
    expect(detailHtml).toContain('Gửi kế toán trưởng');
    expect(detailHtml).toContain('1/2');

    const readOnlyHtml = renderToStaticMarkup(
      wrap(
        <TaskChecklistSection
          taskId={TASK_ID}
          checklist={[{ text: 'Chỉ xem', done: false }]}
          revision={2}
          checkedOut={false}
          readOnly={true}
        />,
      ),
    );
    expect(readOnlyHtml).toContain('disabled');
    expect(readOnlyHtml).not.toContain(viMessages.tasks.checklistAdd);

    const emptyHtml = renderToStaticMarkup(
      wrap(<TaskChecklistSection taskId={TASK_ID} checklist={[]} checkedOut={true} />),
    );
    expect(emptyHtml).toContain(viMessages.tasks.checklistEmpty);

    const dialogClosedHtml = renderToStaticMarkup(
      wrap(
        <EditProjectTaskDialog
          slug="demo-org"
          projectId="30000000-0000-4000-8000-000000000001"
          task={makeCard({ checklist: [{ text: 'Bước hộp thoại', done: false }] })}
          seats={[]}
          open={false}
          onOpenChange={() => undefined}
        />,
      ),
    );
    expect(dialogClosedHtml).toBe('');
  });
});

describe('TaskChecklistSection mounted DOM overlapping edits & 44px targets (#4761)', () => {
  const domHarness = createScopedDomHarness();

  afterEach(async () => {
    mutationState.handler = null;
    await domHarness.teardownScopedDom();
  });

  it('gives checklist move-up, move-down, and remove controls 44px mobile touch targets (max-md:size-11)', async () => {
    const body = domHarness.installScopedDom();
    const container = new FakeDomNode(1, 'div');
    body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    domHarness.setMountedRoot(root);

    await act(async () => {
      root.render(
        wrap(
          <TaskChecklistSection
            taskId={TASK_ID}
            checklist={[
              { text: 'Bước A', done: false },
              { text: 'Bước B', done: false },
            ]}
            revision={1}
            checkedOut={false}
          />,
        ),
      );
    });

    const moveUpBtns = container.querySelectorAll(`button[aria-label="${viMessages.tasks.checklistMoveUp}"]`);
    const moveDownBtns = container.querySelectorAll(`button[aria-label="${viMessages.tasks.checklistMoveDown}"]`);
    const removeBtns = container.querySelectorAll(`button[aria-label="${viMessages.tasks.checklistRemove}"]`);
    expect(moveUpBtns).toHaveLength(2);
    expect(moveDownBtns).toHaveLength(2);
    expect(removeBtns).toHaveLength(2);
    for (const btn of [...moveUpBtns, ...moveDownBtns, ...removeBtns]) {
      expect(btn.className).toContain('size-8');
      expect(btn.className).toContain('max-md:size-11');
    }
  });

  it('syncs savedRef on latest success without reverting or dropping rapid overlapping edits', async () => {
    const body = domHarness.installScopedDom();
    const container = new FakeDomNode(1, 'div');
    body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    domHarness.setMountedRoot(root);

    let serverRevision = 1;
    const pending: Array<{
      variables: Record<string, unknown>;
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
    }> = [];
    mutationState.handler = (variables) =>
      new Promise((resolve, reject) => {
        if (variables.expectedRevision !== serverRevision) {
          reject(Object.assign(new Error('stale'), { code: 'TASK_STALE_REVISION' }));
          return;
        }
        pending.push({ variables, resolve, reject });
      });

    let updateHostProps!: (next: { checklist: TaskChecklistStep[]; revision: number }) => void;
    function Host() {
      const [state, setState] = useState<{ checklist: TaskChecklistStep[]; revision: number }>({
        checklist: [
          { text: 'Bước 1', done: false },
          { text: 'Bước 2', done: false },
        ],
        revision: 1,
      });
      updateHostProps = setState;
      return wrap(
        <TaskChecklistSection
          taskId={TASK_ID}
          checklist={state.checklist}
          revision={state.revision}
          checkedOut={false}
        />,
      );
    }

    await act(async () => {
      root.render(<Host />);
    });

    const checkboxes = () => container.querySelectorAll('input').filter((el) => el.type === 'checkbox');
    const badgeText = () => container.querySelector('[data-testid="task-checklist-badge"]')?.textContent ?? '';
    expect(checkboxes()).toHaveLength(2);
    expect(badgeText()).toBe('0/2');

    // 1. Two rapid overlapping edits in the same tick coalesce into one in-flight mutation plus one queued revision.
    await act(async () => {
      const cb0 = checkboxes()[0]!;
      const cb1 = checkboxes()[1]!;
      cb0.checked = true;
      cb0.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
      cb1.checked = true;
      cb1.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]!.variables.expectedRevision).toBe(1);
    expect(pending[0]!.variables.checklist).toEqual([
      { text: 'Bước 1', done: true },
      { text: 'Bước 2', done: false },
    ]);
    expect(checkboxes().map((cb) => cb.checked)).toEqual([true, true]);
    expect(badgeText()).toBe('2/2');

    // 2. First mutation settles with intermediate rev=2 prop -> dispatches queued edit with expectedRevision=2 and must NOT revert!
    await act(async () => {
      serverRevision = 2;
      pending[0]!.resolve({ taskId: TASK_ID, revision: 2 });
      updateHostProps({
        checklist: [
          { text: 'Bước 1', done: true },
          { text: 'Bước 2', done: false },
        ],
        revision: 2,
      });
    });
    expect(pending).toHaveLength(2);
    expect(pending[1]!.variables.expectedRevision).toBe(2);
    expect(pending[1]!.variables.checklist).toEqual([
      { text: 'Bước 1', done: true },
      { text: 'Bước 2', done: true },
    ]);
    expect(checkboxes().map((cb) => cb.checked)).toEqual([true, true]);
    expect(badgeText()).toBe('2/2');

    // 3. Second mutation settles -> savedRef syncs to 2/2 and revisionRef=3; a stale rev=2 prop afterwards must NOT revert!
    await act(async () => {
      serverRevision = 3;
      pending[1]!.resolve({ taskId: TASK_ID, revision: 3 });
    });
    await act(async () => {
      updateHostProps({
        checklist: [
          { text: 'Bước 1', done: true },
          { text: 'Bước 2', done: false },
        ],
        revision: 2,
      });
    });
    expect(checkboxes().map((cb) => cb.checked)).toEqual([true, true]);
    expect(badgeText()).toBe('2/2');

    // 4. Subsequent edit while parent prop still lags at rev=2 uses revisionRef=3 and keeps 1/2 across lagging prop renders.
    await act(async () => {
      const cb0 = checkboxes()[0]!;
      cb0.checked = false;
      cb0.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
    });
    expect(pending).toHaveLength(3);
    expect(pending[2]!.variables.expectedRevision).toBe(3);
    expect(pending[2]!.variables.checklist).toEqual([
      { text: 'Bước 1', done: false },
      { text: 'Bước 2', done: true },
    ]);
    await act(async () => {
      serverRevision = 4;
      pending[2]!.resolve({ taskId: TASK_ID, revision: 4 });
    });
    expect(checkboxes().map((cb) => cb.checked)).toEqual([false, true]);
    expect(badgeText()).toBe('1/2');

    // 5. Failed save clears the pending queue and reverts to confirmed savedStepsRef (1/2), never stale lagging parent props (rev=2).
    await act(async () => {
      const cb0 = checkboxes()[0]!;
      const cb1 = checkboxes()[1]!;
      cb0.checked = true;
      cb0.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
      cb1.checked = false;
      cb1.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
    });
    expect(pending).toHaveLength(4);
    expect(pending[3]!.variables.expectedRevision).toBe(4);
    expect(checkboxes().map((cb) => cb.checked)).toEqual([true, false]);
    await act(async () => {
      serverRevision = 5;
      pending[3]!.reject(Object.assign(new Error('stale'), { code: 'TASK_STALE_REVISION' }));
    });
    expect(pending).toHaveLength(4);
    expect(checkboxes().map((cb) => cb.checked)).toEqual([false, true]);
    expect(badgeText()).toBe('1/2');

    // 6. Chained save #1 succeeds then queued save #2 fails with a non-stale error -> still invalidates queries so boards refresh rev=5.
    const invalidateSpy = vi.spyOn(queryClientState.current, 'invalidateQueries');
    await act(async () => {
      updateHostProps({
        checklist: [
          { text: 'Bước 1', done: false },
          { text: 'Bước 2', done: true },
        ],
        revision: 5,
      });
    });
    invalidateSpy.mockClear();
    await act(async () => {
      const cb0 = checkboxes()[0]!;
      const cb1 = checkboxes()[1]!;
      cb0.checked = true;
      cb0.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
      cb1.checked = false;
      cb1.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
    });
    expect(pending).toHaveLength(5);
    await act(async () => {
      serverRevision = 6;
      pending[4]!.resolve({ taskId: TASK_ID, revision: 6 });
    });
    expect(pending).toHaveLength(6);
    expect(invalidateSpy).not.toHaveBeenCalled();
    await act(async () => {
      pending[5]!.reject(new Error('NETWORK_ERROR'));
    });
    expect(invalidateSpy).toHaveBeenCalled();
    expect(checkboxes().map((cb) => cb.checked)).toEqual([true, true]);
    expect(badgeText()).toBe('2/2');
    invalidateSpy.mockRestore();
  });
});
