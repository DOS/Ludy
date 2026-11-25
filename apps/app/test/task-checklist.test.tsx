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
} from '@ludy/kernel-contract';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { en as enMessages } from '../src/i18n/messages/en.ts';

const queryClientState = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const authState = vi.hoisted(() => ({ modules: ['kernel', 'projects', 'notes'] as string[] }));
const TASK_ID = '20000000-0000-4000-8000-000000000101';
const PROJECT_ID = '10000000-0000-4000-8000-000000000001';

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: async () => null });
        if (prop === 'mutationOptions') return (opts: Record<string, unknown> = {}) => ({ mutationFn: async () => undefined, ...opts });
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
