// SPDX-License-Identifier: AGPL-3.0-only
// UI tests for ProjectTemplateDialog, TaskRecurrenceControl, repeat badges, and Projects/Tasks pages (#2607, #4908).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
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

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: authState.modules }),
}));

const queryClientState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC();
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
  const { cloneElement, createContext, createElement, isValidElement, useContext } = await import('react');
  const OpenCtx = createContext(false);
  return {
    Dialog: ({ open = false, children }: { open?: boolean; children?: ReactNode }) =>
      createElement(OpenCtx.Provider, { value: Boolean(open) }, children),
    DialogTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) =>
      isValidElement(render)
        ? cloneElement(render as React.ReactElement<{ children?: ReactNode }>, {}, children)
        : createElement('button', { type: 'button' }, children),
    DialogContent: ({
      children,
      closeLabel: _c,
      variant: _v,
      ...rest
    }: Record<string, unknown> & { children?: ReactNode }) => {
      const isOpen = useContext(OpenCtx);
      return isOpen ? createElement('div', rest, children) : null;
    },
    DialogHeader: ({ children, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('div', rest, children),
    DialogTitle: ({ children, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('h2', rest, children),
    DialogDescription: ({ children, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('p', rest, children),
    DialogFooter: ({ children, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('div', rest, children),
    DialogClose: ({ render, children, ...rest }: Record<string, unknown> & { render?: ReactNode; children?: ReactNode }) =>
      isValidElement(render)
        ? cloneElement(render as React.ReactElement<{ children?: ReactNode }>, rest, children)
        : createElement('span', rest, children),
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

      // 44px mobile touch targets on every radio button (5 built-in + 1 custom) and distinct archive icon label.
      const radioButtons = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
      expect(radioButtons, locale).toHaveLength(6);
      for (const radioButton of radioButtons) {
        expect(radioButton, locale).toContain('min-h-11');
      }
      const archiveLabel =
        locale === 'en' ? `Archive template ${customTemplate.name}` : `Lưu trữ mẫu ${customTemplate.name}`;
      const archiveButton = html.match(new RegExp(`<button[^>]*aria-label="${archiveLabel}"[^>]*>`))?.[0];
      expect(archiveButton, locale).toBeDefined();
      expect(archiveButton, locale).toContain('max-md:min-h-11 max-md:min-w-11');
    }
  });
});
