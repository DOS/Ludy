// SPDX-License-Identifier: AGPL-3.0-only
// UI tests for ProjectTemplateDialog, TaskRecurrenceControl, repeat badges, and Projects/Tasks pages (#2607, #4908).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeDomNode, createScopedDomHarness } from './fake-dom.ts';
import {
  BUILTIN_PROJECT_TEMPLATE_KEYS,
  type BuiltinProjectTemplateKey,
  type ProjectBoard,
  type ProjectListResult,
  type ProjectSeat,
  type ProjectTaskCard,
  type ProjectTaskRecurrenceView,
  type ProjectTemplateListResult,
  type ProjectTemplateSummary,
} from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const authState = vi.hoisted(() => ({ modules: ['projects', 'notes'] as string[] }));
const archiveCalls = vi.hoisted(() => [] as unknown[]);
const archiveGate = vi.hoisted(() => ({
  pending: null as Promise<void> | null,
  error: null as Error | null,
}));
const dialogMockState = vi.hoisted(() => ({
  deferClose: false,
  pendingComplete: null as (() => void) | null,
}));
const templateFixturesState = vi.hoisted(() => ({ current: null as ProjectTemplateListResult | null }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: authState.modules }),
}));

const queryClientState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => {
            const key = [...path, args?.input ?? {}];
            return {
              queryKey: key,
              queryFn: () => {
                if (path.join('.') === 'projects.listTemplates' && templateFixturesState.current) {
                  return Promise.resolve(templateFixturesState.current);
                }
                const cached = queryClientState.current.getQueryData(key);
                if (cached !== undefined) return Promise.resolve(cached);
                return Promise.reject(new Error('not fetched in unit test'));
              },
            };
          };
        }
        if (prop === 'mutationOptions') {
          return () => ({
            mutationFn: async (input: unknown) => {
              if (path.join('.') === 'projects.archiveTemplate') {
                archiveCalls.push(input);
                if (archiveGate.pending) await archiveGate.pending;
                if (archiveGate.error) throw archiveGate.error;
                return { archived: true };
              }
              return {};
            },
          });
        }
        if (prop === 'call') return () => Promise.resolve({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { clientForOrg: () => node([]), orpc: node([]), queryClient: queryClientState.current, errorMessage: String };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'demo-org', id: '00000000-0000-4000-8000-000000000001' }),
    useNavigate: () => () => Promise.resolve(),
    Link: ({ children, to, ...rest }: { children?: ReactNode; to: string; 'data-testid'?: string; className?: string }) =>
      createElement('a', { href: to, 'data-testid': rest['data-testid'], className: rest.className }, children),
  };
});

vi.mock('@ludy/ui/components/dialog', async () => {
  const { cloneElement, createContext, createElement, isValidElement, useContext, useRef, useState } = await import('react');
  const DialogCtx = createContext<{
    open: boolean;
    setOpen: (next: boolean) => void;
    finalFocusRef: { current: unknown };
  }>({
    open: false,
    setOpen: () => undefined,
    finalFocusRef: { current: undefined },
  });
  return {
    Dialog: ({
      open,
      onOpenChange,
      onOpenChangeComplete,
      children,
    }: {
      open?: boolean;
      onOpenChange?: (next: boolean) => void;
      onOpenChangeComplete?: (open: boolean) => void;
      children?: ReactNode;
    }) => {
      const [internalOpen, setInternalOpen] = useState(false);
      const [closing, setClosing] = useState(false);
      const finalFocusRef = useRef<unknown>(undefined);
      const isOpen = open === undefined ? internalOpen : Boolean(open);
      const runFinalFocus = () => {
        const ff = finalFocusRef.current;
        const resolved = typeof ff === 'function' ? (ff as (t: string) => unknown)('keyboard') : ff;
        if (resolved && typeof resolved === 'object') {
          const target = 'current' in resolved ? (resolved as { current: unknown }).current : resolved;
          if (target && typeof target === 'object' && 'focus' in target && typeof (target as { focus?: unknown }).focus === 'function') {
            (target as { focus: () => void }).focus();
          }
        }
      };
      const setOpen = (next: boolean) => {
        if (!next && dialogMockState.deferClose) {
          setClosing(true);
          onOpenChange?.(false);
          dialogMockState.pendingComplete = () => {
            dialogMockState.pendingComplete = null;
            setClosing(false);
            if (open === undefined) setInternalOpen(false);
            runFinalFocus();
            onOpenChangeComplete?.(false);
          };
          return;
        }
        if (open === undefined) setInternalOpen(next);
        onOpenChange?.(next);
        if (!next) {
          runFinalFocus();
          onOpenChangeComplete?.(false);
        }
      };
      return createElement(DialogCtx.Provider, { value: { open: isOpen || closing, setOpen, finalFocusRef } }, children);
    },
    DialogTrigger: ({ render, disabled, children }: { render?: ReactNode; disabled?: boolean; children?: ReactNode }) => {
      const { setOpen } = useContext(DialogCtx);
      if (isValidElement(render)) {
        const typedRender = render as React.ReactElement<{ onClick?: (e: unknown) => void; disabled?: boolean; children?: ReactNode }>;
        const prevClick = typedRender.props.onClick;
        const nextProps = {
          disabled: Boolean(disabled),
          onClick: (e: unknown) => {
            prevClick?.(e);
            if (!disabled) setOpen(true);
          },
        };
        return children !== undefined ? cloneElement(typedRender, nextProps, children) : cloneElement(typedRender, nextProps);
      }
      return createElement('button', { type: 'button', disabled: Boolean(disabled), onClick: () => setOpen(true) }, children);
    },
    DialogContent: ({
      children,
      closeLabel: _c,
      variant,
      finalFocus,
      ...rest
    }: Record<string, unknown> & { children?: ReactNode }) => {
      const { open, finalFocusRef } = useContext(DialogCtx);
      finalFocusRef.current = finalFocus;
      return open
        ? createElement(
            'div',
            {
              'data-slot': 'dialog-content',
              ...(variant !== undefined ? { 'data-variant': String(variant) } : {}),
              ...rest,
            },
            children,
          )
        : null;
    },
    DialogHeader: ({ children, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('div', rest, children),
    DialogTitle: ({ children, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('h2', rest, children),
    DialogDescription: ({ children, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('p', rest, children),
    DialogFooter: ({ children, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('div', rest, children),
    DialogClose: ({ render, onClick, children, ...rest }: Record<string, unknown> & { render?: ReactNode; onClick?: (e: unknown) => void; children?: ReactNode }) => {
      const { setOpen } = useContext(DialogCtx);
      const handleClick = (e: unknown) => {
        onClick?.(e);
        setOpen(false);
      };
      if (isValidElement(render)) {
        const typedRender = render as React.ReactElement<{ onClick?: (e: unknown) => void; children?: ReactNode }>;
        const prevClick = typedRender.props.onClick;
        const nextProps = {
          ...rest,
          onClick: (e: unknown) => {
            prevClick?.(e);
            handleClick(e);
          },
        };
        return children !== undefined ? cloneElement(typedRender, nextProps, children) : cloneElement(typedRender, nextProps);
      }
      return createElement('span', { ...rest, onClick: handleClick }, children);
    },
  };
});

const { ProjectBoardView } = await import('../src/components/project-board.tsx');
const {
  DEFAULT_BUILTIN_PROJECT_TEMPLATE_KEY,
  ProjectTemplateDialog,
  nextTemplateRadioIndex,
} = await import('../src/components/project-template-dialog.tsx');
const { TaskRecurrenceControl, formatRecurrenceBadgeLabel } = await import('../src/components/task-recurrence-control.tsx');
const { ProjectsPage, ProjectDetailPage } = await import('../src/routes/projects.tsx');
const { TaskDetailPage } = await import('../src/routes/tasks.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => (
  <QueryClientProvider client={queryClientState.current}>
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

function starterFixtures(locale: 'vi' | 'en'): ProjectTemplateSummary[] {
  const byKey: Record<BuiltinProjectTemplateKey, { name: string; taskTitle: string; hasColumns?: boolean }> =
    locale === 'en'
      ? {
          'software-project': {
            name: 'Software project',
            taskTitle: 'Scope sprint backlog and acceptance criteria',
            hasColumns: true,
          },
          'marketing-project': {
            name: 'Marketing project',
            taskTitle: 'Finalize campaign brief and target audience',
          },
          'monthly-close': {
            name: 'Monthly book close',
            taskTitle: 'Reconcile bank statements and petty cash',
          },
          'client-onboarding': {
            name: 'Client onboarding',
            taskTitle: 'Verify signed contract and billing tax details',
          },
          'campaign-launch': {
            name: 'Campaign launch',
            taskTitle: 'Finalize core message and target audience',
          },
        }
      : {
          'software-project': {
            name: 'Dự án phần mềm',
            taskTitle: 'Chốt phạm vi sprint và ưu tiên backlog',
            hasColumns: true,
          },
          'marketing-project': {
            name: 'Dự án Marketing',
            taskTitle: 'Lập bản tóm tắt chiến dịch và chân dung khách hàng',
          },
          'monthly-close': {
            name: 'Khóa sổ cuối tháng',
            taskTitle: 'Đối chiếu sổ phụ ngân hàng và tiền mặt',
          },
          'client-onboarding': {
            name: 'Tiếp nhận khách hàng mới',
            taskTitle: 'Kiểm tra hợp đồng đã ký và thông tin xuất hóa đơn',
          },
          'campaign-launch': {
            name: 'Triển khai chiến dịch',
            taskTitle: 'Chốt thông điệp chính và tệp khách hàng mục tiêu',
          },
        };

  return BUILTIN_PROJECT_TEMPLATE_KEYS.map((key) => {
    const info = byKey[key];
    return {
      id: key,
      source: 'builtin',
      builtinKey: key,
      name: info.name,
      description: `${info.name} description`,
      status: 'active',
      tasks: [{ title: info.taskTitle, dueOffsetDays: 1 }],
      taskCount: 1,
      ...(info.hasColumns
        ? {
            defaultColumns: [
              { name: locale === 'en' ? 'Backlog' : 'Cần làm (Backlog)', taskStatus: 'todo', color: 'neutral' },
              { name: locale === 'en' ? 'In progress' : 'Đang phát triển', taskStatus: 'in_progress', color: 'primary' },
              { name: locale === 'en' ? 'Blocked / Waiting' : 'Đang chờ / Bị chặn', taskStatus: 'waiting', color: 'warning' },
              { name: locale === 'en' ? 'QA / In review' : 'Kiểm thử / Review', taskStatus: 'in_review', color: 'proposal' },
              { name: locale === 'en' ? 'Done' : 'Đã xong', taskStatus: 'done', color: 'success' },
            ],
          }
        : {}),
      canManage: false,
      createdAt: null,
      updatedAt: null,
    };
  });
}

const card = (over: Partial<ProjectTaskCard>): ProjectTaskCard => ({
  id: '10000000-0000-4000-8000-000000000001',
  title: 'Kiểm tra chứng từ',
  description: null,
  status: 'todo',
  assigneePositionId: null,
  due: null,
  checklist: [],
  tainted: false,
  checkedOut: false,
  commentCount: 0,
  createdAt: '2026-11-10T01:00:00.000Z',
  addedAt: '2026-11-10T01:00:00.000Z',
  ...over,
});

const seat: ProjectSeat = {
  id: '20000000-0000-4000-8000-000000000001',
  title: 'Kế toán trưởng',
  status: 'active',
  onProject: true,
  holder: null,
};

describe('projects templates & recurring UI (#2607)', () => {
  it('renders create-from-template button on ProjectsPage and save-as-template button on ProjectDetailPage', () => {
    authState.modules = ['projects'];
    const qc = queryClientState.current;
    qc.clear();

    const listData: ProjectListResult = {
      projects: [],
      canWrite: true,
      truncated: false,
    };
    qc.setQueryData(['projects', 'list', { status: ['active', 'on_hold', 'done'] }], listData);

    const listHtml = renderToStaticMarkup(wrap('vi', <ProjectsPage />));
    expect(listHtml).toContain('create-from-template-button');
    expect(listHtml).toContain('Tạo từ mẫu');

    const boardData: ProjectBoard = {
      project: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Khóa sổ tháng 11',
        description: null,
        ownerUserId: null,
        ownerName: null,
        status: 'active',
        visibility: 'org',
        canManage: true,
        canWrite: true,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
      members: [],
      seats: [seat],
      isTeamOrg: false,
      viewerHasSeat: false,
      tasks: [
        card({
          recurrence: {
            cadence: 'monthly',
            interval: 1,
            monthDay: -1,
            timeZone: 'Asia/Ho_Chi_Minh',
          },
          recurrenceCount: 2,
          recurrenceNextAt: '2026-12-31T00:00:00.000Z',
        }),
      ],
      totalVisible: 1,
      hiddenByEntityCount: 0,
      truncated: false,
    };
    qc.setQueryData(['projects', 'board', { projectId: '00000000-0000-4000-8000-000000000001' }], boardData);

    const detailHtml = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(detailHtml).toContain('save-as-template-button');
    expect(detailHtml).toContain('Lưu làm mẫu');
    expect(detailHtml).toContain('task-recurrence-badge');
    expect(detailHtml).toContain('Hàng tháng');

    qc.setQueryData(
      ['projects', 'board', { projectId: '00000000-0000-4000-8000-000000000001' }],
      { ...boardData, project: { ...boardData.project, visibility: 'private' } },
    );
    const privateDetailHtml = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(privateDetailHtml).not.toContain('save-as-template-button');
  });

  it('renders repeat badge on both board and list views and renders recurrence control on TaskDetailPage', () => {
    const recurringTask = card({
      recurrence: {
        cadence: 'weekly',
        interval: 2,
        weekday: 1,
        timeZone: 'Asia/Ho_Chi_Minh',
      },
    });
    const noop = () => {};

    const boardHtml = renderToStaticMarkup(
      wrap(
        'en',
        <ProjectBoardView
          slug="demo-org"
          view="board"
          tasks={[recurringTask]}
          seats={[seat]}
          canEdit
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={noop}
          onCreateTask={noop}
          onEditTask={noop}
          onRemoveTask={noop}
        />,
      ),
    );
    expect(boardHtml).toContain('task-recurrence-badge');
    expect(boardHtml).toContain('Every 2 weeks');

    const listHtml = renderToStaticMarkup(
      wrap(
        'en',
        <ProjectBoardView
          slug="demo-org"
          view="list"
          tasks={[recurringTask]}
          seats={[seat]}
          canEdit
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={noop}
          onCreateTask={noop}
          onEditTask={noop}
          onRemoveTask={noop}
        />,
      ),
    );
    expect(listHtml).toContain('task-recurrence-badge');
    expect(listHtml).toContain('Every 2 weeks');

    const qc = queryClientState.current;
    qc.clear();
    qc.setQueryData(['org', 'get', {}], { role: 'owner', members: [] });
    qc.setQueryData(['chart', 'get', {}], { root: [], positions: [], agents: [], killSwitches: [] });
    qc.setQueryData(['tasks', 'get', { id: '00000000-0000-4000-8000-000000000001' }], {
      task: {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Khóa sổ cuối tháng',
        status: 'todo',
        description: null,
        due: null,
        checklist: [],
        createdAt: '2026-11-16T00:00:00.000Z',
        tainted: false,
        checkedOut: false,
        assigneePositionId: null,
        sourceRef: null,
      },
      comments: [],
      proposal: null,
    });
    const recurrenceView: ProjectTaskRecurrenceView = {
      projectId: '30000000-0000-4000-8000-000000000001',
      taskId: '00000000-0000-4000-8000-000000000001',
      recurrence: {
        cadence: 'monthly',
        interval: 1,
        monthDay: -1,
        timeZone: 'Asia/Ho_Chi_Minh',
      },
      recurrenceCount: 1,
      recurrenceLastDue: '2026-11-30',
      recurrenceNextAt: '2026-12-31T00:00:00.000Z',
      recurrenceSourceTaskId: null,
    };
    qc.setQueryData(
      ['projects', 'getTaskRecurrence', { taskId: '00000000-0000-4000-8000-000000000001' }],
      recurrenceView,
    );

    const taskDetailHtml = renderToStaticMarkup(wrap('vi', <TaskDetailPage />));
    expect(taskDetailHtml).toContain('task-recurrence-badge');
    expect(taskDetailHtml).toContain('task-recurrence-control');
    expect(taskDetailHtml).toContain('Ngày cuối tháng');

    const copyHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <TaskRecurrenceControl
          projectId={recurrenceView.projectId}
          taskId={recurrenceView.taskId}
          canEdit
          view={{
            ...recurrenceView,
            recurrence: null,
            recurrenceNextAt: null,
            recurrenceSourceTaskId: '90000000-0000-4000-8000-000000000001',
          }}
        />,
      ),
    );
    expect(copyHtml).toContain('task-recurrence-generated-hint');

    expect(
      formatRecurrenceBadgeLabel(
        { cadence: 'weekly', interval: 1, weekday: 1, timeZone: 'Asia/Ho_Chi_Minh' },
        (k) => (k === 'recurrence.badgeWeeklySingle' ? 'Hàng tuần' : 'other'),
      ),
    ).toBe('Hàng tuần');
  });

  it('defaults Create Project from Template to software-project in vi & en, orders all 5 templates, and meets a11y + 44px touch targets', () => {
    expect(DEFAULT_BUILTIN_PROJECT_TEMPLATE_KEY).toBe('software-project');
    expect(BUILTIN_PROJECT_TEMPLATE_KEYS).toEqual([
      'software-project',
      'marketing-project',
      'monthly-close',
      'client-onboarding',
      'campaign-launch',
    ]);

    expect(nextTemplateRadioIndex(0, 'ArrowRight', 6)).toBe(1);
    expect(nextTemplateRadioIndex(0, 'ArrowDown', 6)).toBe(1);
    expect(nextTemplateRadioIndex(0, 'ArrowLeft', 6)).toBe(5);
    expect(nextTemplateRadioIndex(0, 'ArrowUp', 6)).toBe(5);
    expect(nextTemplateRadioIndex(3, 'Home', 6)).toBe(0);
    expect(nextTemplateRadioIndex(1, 'End', 6)).toBe(5);
    expect(nextTemplateRadioIndex(0, 'Enter', 6)).toBeNull();
    expect(nextTemplateRadioIndex(0, 'ArrowRight', 0)).toBeNull();

    for (const locale of ['vi', 'en'] as const) {
      const qc = queryClientState.current;
      qc.clear();
      const customTemplate: ProjectTemplateSummary = {
        id: '40000000-0000-4000-8000-000000000001',
        source: 'custom',
        builtinKey: null,
        name: locale === 'en' ? 'Custom sprint template' : 'Mẫu sprint riêng',
        description: null,
        status: 'active',
        tasks: [{ title: locale === 'en' ? 'Kickoff' : 'Khởi động', dueOffsetDays: 0 }],
        taskCount: 1,
        canManage: true,
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
      };
      const listData: ProjectTemplateListResult = {
        templates: [...starterFixtures(locale), customTemplate],
        canWrite: true,
      };
      qc.setQueryData(['projects', 'listTemplates', { language: locale }], listData);

      setActiveLocale(locale);
      let html = '';
      try {
        html = renderToStaticMarkup(
          <QueryClientProvider client={qc}>
            <I18nProvider>
              <ProjectTemplateDialog mode="create" open onOpenChange={() => undefined} onCreated={() => undefined} />
            </I18nProvider>
          </QueryClientProvider>,
        );
      } finally {
        setActiveLocale('vi');
      }

      expect(html, locale).toContain('data-testid="project-template-dialog"');
      expect(html, locale).toContain('role="radiogroup"');
      expect(html, locale).toContain('role="radio"');

      // software-project is selected by default and focused first in the radiogroup.
      expect(html, locale).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*data-testid="template-option-software-project"/);
      for (const otherKey of ['marketing-project', 'monthly-close', 'client-onboarding', 'campaign-launch']) {
        expect(html, `${locale}:${otherKey}`).toMatch(
          new RegExp(`aria-checked="false"[^>]*tabindex="-1"[^>]*data-testid="template-option-${otherKey}"`),
        );
      }
      expect(html, locale).toMatch(
        new RegExp(`aria-checked="false"[^>]*tabindex="-1"[^>]*data-testid="template-option-${customTemplate.id}"`),
      );

      // Ordering preserves software-project -> marketing-project -> monthly-close -> client-onboarding -> campaign-launch.
      const orderPositions = BUILTIN_PROJECT_TEMPLATE_KEYS.map((key) => html.indexOf(`data-testid="template-option-${key}"`));
      for (let i = 1; i < orderPositions.length; i += 1) {
        expect(orderPositions[i - 1], `${locale}:order-${i}`).toBeGreaterThan(-1);
        expect(orderPositions[i], `${locale}:order-${i}`).toBeGreaterThan(orderPositions[i - 1]!);
      }

      // Preview displays software-project tasks and #2605-compatible default board columns using semantic tokens.
      expect(html, locale).toContain('data-testid="template-preview-columns"');
      expect(html, locale).toContain(locale === 'en' ? 'Software project' : 'Dự án phần mềm');
      expect(html, locale).toContain(locale === 'en' ? 'Marketing project' : 'Dự án Marketing');
      expect(html, locale).toContain(locale === 'en' ? 'QA / In review' : 'Kiểm thử / Review');
      expect(html, locale).toContain('border-primary bg-primary/5 ring-1 ring-primary');
      expect(html, locale).toContain('text-foreground');

      // 44px mobile touch targets on every radio button (5 built-in + 1 custom), and zero archive buttons or lists inside role="radiogroup".
      const previewStart = html.indexOf('data-testid="template-preview"');
      const radiogroupHtml = html.slice(html.indexOf('role="radiogroup"'), previewStart);
      expect(previewStart, locale).toBeGreaterThan(-1);
      const radioButtons = radiogroupHtml.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
      expect(radioButtons, locale).toHaveLength(6);
      for (const radioButton of radioButtons) {
        expect(radioButton, locale).toContain('min-h-11');
      }
      const radiogroupButtons = radiogroupHtml.match(/<button\b[^>]*>/g) ?? [];
      expect(radiogroupButtons, locale).toHaveLength(6);
      expect(radiogroupHtml, locale).not.toContain('<ul');
      expect(radiogroupHtml, locale).not.toContain('<li');
      const archiveLabel =
        locale === 'en' ? `Archive template ${customTemplate.name}` : `Lưu trữ mẫu ${customTemplate.name}`;
      expect(radiogroupHtml, locale).not.toContain(archiveLabel);
    }
  });
});

describe('ProjectTemplateDialog mounted DOM lifecycle (#4908, #5035)', () => {
  const domHarness = createScopedDomHarness(() => {
    templateFixturesState.current = null;
    setActiveLocale('vi');
  });

  afterEach(async () => {
    archiveGate.pending = null;
    archiveGate.error = null;
    dialogMockState.deferClose = false;
    dialogMockState.pendingComplete = null;
    await domHarness.teardownScopedDom();
  });

  it('exercises keyboard .focus() in radiogroup, keeps custom archive ConfirmDialog outside radiogroup, and resets via useEffect on reopen', async () => {
    setActiveLocale('vi');
    archiveCalls.length = 0;
    const body = domHarness.installScopedDom();
    const container = new FakeDomNode(1, 'div');
    body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    domHarness.setMountedRoot(root);

    const qc = queryClientState.current;
    qc.clear();
    const customTemplate: ProjectTemplateSummary = {
      id: '40000000-0000-4000-8000-000000000001',
      source: 'custom',
      builtinKey: null,
      name: 'Mẫu sprint riêng',
      description: 'Mô tả mẫu riêng',
      status: 'active',
      tasks: [{ title: 'Khởi động', dueOffsetDays: 0 }],
      taskCount: 1,
      canManage: true,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const fixtures = {
      templates: [...starterFixtures('vi'), customTemplate],
      canWrite: true,
    } satisfies ProjectTemplateListResult;
    templateFixturesState.current = fixtures;
    qc.setQueryData(['projects', 'listTemplates', { language: 'vi' }], fixtures);

    const renderCreateDialog = async (open: boolean) => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={qc}>
            <I18nProvider>
              <ProjectTemplateDialog mode="create" open={open} onOpenChange={() => undefined} onCreated={() => undefined} />
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
    };

    await renderCreateDialog(true);
    const radioGroup = container.querySelector('[role="radiogroup"]')!;
    expect(radioGroup).not.toBeNull();
    expect(radioGroup.querySelectorAll('ul')).toHaveLength(0);
    expect(radioGroup.querySelectorAll('li')).toHaveLength(0);
    expect(container.querySelector(`[data-testid="template-archive-${customTemplate.id}"]`)).toBeNull();

    // Keyboard End moves selection to customTemplate and moves DOM focus onto its radio option.
    const firstRadio = container.querySelector('[data-testid="template-option-software-project"]')!;
    expect(firstRadio.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      firstRadio.dispatchEvent({ type: 'keydown', key: 'End', bubbles: true, cancelable: true });
    });

    const customRadio = container.querySelector(`[data-testid="template-option-${customTemplate.id}"]`)!;
    expect(customRadio.getAttribute('aria-checked')).toBe('true');
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(customRadio);

    // Selecting customTemplate exposes its archive ConfirmDialog trigger cleanly OUTSIDE role="radiogroup" with 44px target.
    const archiveTrigger = container.querySelector(`[data-testid="template-archive-${customTemplate.id}"]`)!;
    expect(archiveTrigger).not.toBeNull();
    expect(radioGroup.contains(archiveTrigger)).toBe(false);
    expect(archiveTrigger.getAttribute('aria-label')).toBe('Lưu trữ mẫu Mẫu sprint riêng');
    expect(archiveTrigger.className).toContain('max-md:min-h-11');
    expect(archiveTrigger.className).toContain('max-md:min-w-11');

    // Keyboard ArrowLeft moves focus back to the previous built-in radio, then click custom radio again and archive it.
    await act(async () => {
      customRadio.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', bubbles: true, cancelable: true });
    });
    const prevRadio = container.querySelector('[data-testid="template-option-campaign-launch"]')!;
    expect(prevRadio.getAttribute('aria-checked')).toBe('true');
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(prevRadio);

    await act(async () => {
      customRadio.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
    });
    const visibleArchive = container.querySelector(`[data-testid="template-archive-${customTemplate.id}"]`)!;
    await act(async () => {
      visibleArchive.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
    });
    const confirmArchiveBtn = container
      .querySelectorAll('button')
      .find((b) => b.textContent.trim() === catalog('vi').projects.templates.archiveConfirmBtn)!;
    expect(confirmArchiveBtn).toBeDefined();
    await act(async () => {
      confirmArchiveBtn.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(archiveCalls).toHaveLength(1);
    expect((archiveCalls[0] as { templateId: string }).templateId).toBe(customTemplate.id);
    // Archiving the selected custom template falls back to DEFAULT_BUILTIN_PROJECT_TEMPLATE_KEY and moves focus onto its radio option.
    const fallbackRadio = container.querySelector('[data-testid="template-option-software-project"]');
    expect(fallbackRadio?.getAttribute('aria-checked')).toBe('true');
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(fallbackRadio);

    // Reopening create dialog resets selection via useEffect back to software-project.
    await act(async () => {
      customRadio.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
    });
    expect(customRadio.getAttribute('aria-checked')).toBe('true');
    await renderCreateDialog(false);
    await renderCreateDialog(true);
    expect(container.querySelector('[data-testid="template-option-software-project"]')?.getAttribute('aria-checked')).toBe('true');

    // Reopening save dialog resets nameError and restores initialName via useEffect.
    const renderSaveDialog = async (open: boolean, initialName: string) => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={qc}>
            <I18nProvider>
              <ProjectTemplateDialog
                mode="save"
                open={open}
                projectId="00000000-0000-4000-8000-000000000001"
                initialName={initialName}
                initialDescription={null}
                onOpenChange={() => undefined}
              />
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
    };
    await renderSaveDialog(true, '');
    const form = container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true });
    });
    expect(container.querySelector('input[id="template-dialog-name-save"]')?.getAttribute('aria-invalid')).toBe('true');
    await renderSaveDialog(false, 'Tên mới từ dự án');
    await renderSaveDialog(true, 'Tên mới từ dự án');
    const resetInput = container.querySelector('input[id="template-dialog-name-save"]')!;
    expect(resetInput.getAttribute('aria-invalid')).not.toBe('true');
    expect(resetInput.value).toBe('Tên mới từ dự án');
  });

  it('does not steal focus when the user focuses another field while archiving settles (#5035)', async () => {
    setActiveLocale('vi');
    archiveCalls.length = 0;
    let resolveArchive!: () => void;
    archiveGate.pending = new Promise<void>((resolve) => {
      resolveArchive = resolve;
    });

    const body = domHarness.installScopedDom();
    const container = new FakeDomNode(1, 'div');
    body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    domHarness.setMountedRoot(root);

    const qc = queryClientState.current;
    qc.clear();
    const customTemplate: ProjectTemplateSummary = {
      id: '40000000-0000-4000-8000-000000000002',
      source: 'custom',
      builtinKey: null,
      name: 'Mẫu đang chờ lưu trữ',
      description: null,
      status: 'active',
      tasks: [{ title: 'Bước 1', dueOffsetDays: 0 }],
      taskCount: 1,
      canManage: true,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const fixtures = {
      templates: [...starterFixtures('vi'), customTemplate],
      canWrite: true,
    } satisfies ProjectTemplateListResult;
    templateFixturesState.current = fixtures;
    qc.setQueryData(['projects', 'listTemplates', { language: 'vi' }], fixtures);

    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <I18nProvider>
            <ProjectTemplateDialog mode="create" open onOpenChange={() => undefined} onCreated={() => undefined} />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    const customRadio = container.querySelector(`[data-testid="template-option-${customTemplate.id}"]`)!;
    await act(async () => {
      customRadio.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
    });
    const archiveTrigger = container.querySelector(`[data-testid="template-archive-${customTemplate.id}"]`)!;
    await act(async () => {
      archiveTrigger.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
    });
    const confirmArchiveBtn = container
      .querySelectorAll('button')
      .find((b) => b.textContent.trim() === catalog('vi').projects.templates.archiveConfirmBtn)!;
    await act(async () => {
      confirmArchiveBtn.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const nameInput = container.querySelector('input[id="template-dialog-name-create"]')!;
    nameInput.focus();
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(nameInput);

    await act(async () => {
      resolveArchive();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.querySelector('[data-testid="template-option-software-project"]')?.getAttribute('aria-checked')).toBe('true');
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(nameInput);
  });

  it('restores focus to fallback radio when fast archive finishes during 100ms ConfirmDialog close animation while focus is on confirm button (#5035)', async () => {
    setActiveLocale('vi');
    archiveCalls.length = 0;
    dialogMockState.deferClose = true;

    const body = domHarness.installScopedDom();
    const container = new FakeDomNode(1, 'div');
    body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    domHarness.setMountedRoot(root);

    const qc = queryClientState.current;
    qc.clear();
    const customTemplate: ProjectTemplateSummary = {
      id: '40000000-0000-4000-8000-000000000003',
      source: 'custom',
      builtinKey: null,
      name: 'Mẫu đóng nhanh',
      description: null,
      status: 'active',
      tasks: [{ title: 'Bước 1', dueOffsetDays: 0 }],
      taskCount: 1,
      canManage: true,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const fixtures = {
      templates: [...starterFixtures('vi'), customTemplate],
      canWrite: true,
    } satisfies ProjectTemplateListResult;
    templateFixturesState.current = fixtures;
    qc.setQueryData(['projects', 'listTemplates', { language: 'vi' }], fixtures);

    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <I18nProvider>
            <ProjectTemplateDialog mode="create" open onOpenChange={() => undefined} onCreated={() => undefined} />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    const customRadio = container.querySelector(`[data-testid="template-option-${customTemplate.id}"]`)!;
    await act(async () => {
      customRadio.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
    });
    const archiveTrigger = container.querySelector(`[data-testid="template-archive-${customTemplate.id}"]`)!;
    await act(async () => {
      archiveTrigger.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
    });
    const confirmArchiveBtn = container
      .querySelectorAll('button')
      .find((b) => b.textContent.trim() === catalog('vi').projects.templates.archiveConfirmBtn)!;
    // Keyboard confirm leaves focus on the destructive confirm button during the 100ms close transition.
    confirmArchiveBtn.focus();
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(confirmArchiveBtn);

    await act(async () => {
      confirmArchiveBtn.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      dialogMockState.pendingComplete?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const fallbackRadio = container.querySelector('[data-testid="template-option-software-project"]');
    expect(fallbackRadio?.getAttribute('aria-checked')).toBe('true');
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(fallbackRadio);
  });

  it('keeps focus on the still-selected custom template when archive fails (#5035)', async () => {
    setActiveLocale('vi');
    archiveCalls.length = 0;
    let rejectPending!: () => void;
    archiveGate.pending = new Promise<void>((resolve) => {
      rejectPending = () => {
        archiveGate.error = new Error('archive failed');
        resolve();
      };
    });

    const body = domHarness.installScopedDom();
    const container = new FakeDomNode(1, 'div');
    body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    domHarness.setMountedRoot(root);

    const qc = queryClientState.current;
    qc.clear();
    const customTemplate: ProjectTemplateSummary = {
      id: '40000000-0000-4000-8000-000000000004',
      source: 'custom',
      builtinKey: null,
      name: 'Mẫu lỗi lưu trữ',
      description: null,
      status: 'active',
      tasks: [{ title: 'Bước 1', dueOffsetDays: 0 }],
      taskCount: 1,
      canManage: true,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const fixtures = {
      templates: [...starterFixtures('vi'), customTemplate],
      canWrite: true,
    } satisfies ProjectTemplateListResult;
    templateFixturesState.current = fixtures;
    qc.setQueryData(['projects', 'listTemplates', { language: 'vi' }], fixtures);

    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <I18nProvider>
            <ProjectTemplateDialog mode="create" open onOpenChange={() => undefined} onCreated={() => undefined} />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    const customRadio = container.querySelector(`[data-testid="template-option-${customTemplate.id}"]`)!;
    await act(async () => {
      customRadio.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
    });
    const archiveTrigger = container.querySelector(`[data-testid="template-archive-${customTemplate.id}"]`)!;
    await act(async () => {
      archiveTrigger.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
    });
    const confirmArchiveBtn = container
      .querySelectorAll('button')
      .find((b) => b.textContent.trim() === catalog('vi').projects.templates.archiveConfirmBtn)!;
    confirmArchiveBtn.focus();
    await act(async () => {
      confirmArchiveBtn.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // While pending after dialog closes, focus stays on the selected custom radio instead of jumping to software-project.
    expect(customRadio.getAttribute('aria-checked')).toBe('true');
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(customRadio);

    await act(async () => {
      rejectPending();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // On failure, custom radio stays selected and focused so arrow navigation starts from the right option.
    expect(customRadio.getAttribute('aria-checked')).toBe('true');
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(customRadio);
  });
});
