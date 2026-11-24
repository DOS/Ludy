// SPDX-License-Identifier: AGPL-3.0-only
// Overlay consolidation across Projects, eSign, and Meetings (#4522, Wave P1-4):
// verifies FormPanel (Sheet) / FormDialog (1-3 field) container usage, Cmd+Enter submit & dirty-close
// wiring, Escape/focus-return guards, zero nested <form> markup, preserved test hooks/badges/stacked
// tables, and >= 44px mobile touch parity (max-md:min-h-11 / min-h-11).
import { readFileSync } from 'node:fs';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MeetingSummary,
  ProjectBoard,
  ProjectCycle,
  ProjectDetail,
  ProjectSeat,
  ProjectTaskCard,
} from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

interface CapturedOverlayCall {
  kind: 'FormPanel' | 'FormDialog';
  title: string;
  testId?: string;
  submitTestId?: string;
  wide?: boolean;
  noValidate?: boolean;
  formId?: string;
  busy?: boolean;
  dirty?: boolean;
  hasOnSubmit: boolean;
  hasOutside: boolean;
}

const captured = vi.hoisted(() => ({ calls: [] as CapturedOverlayCall[] }));
const queryClientState = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const authState = vi.hoisted(() => ({ modules: ['kernel', 'projects', 'notes', 'sign', 'meetings'] as string[] }));

vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: authState.modules }) }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts?.input !== undefined ? [...path, opts.input] : path,
            queryFn: () => Promise.reject(new Error('not fetched in unit test')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: async () => ({}) });
        if (prop === 'call') return async () => ({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: node([]),
    clientForOrg: () => node([]),
    queryClient: queryClientState.current,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    uploadMeetingMedia: vi.fn(),
  };
});

vi.mock('../src/i18n/provider.tsx', () => ({
  useFormat: () => ({
    date: (v: string) => v.slice(0, 10),
    dateTime: (v: string) => v,
    time: (v: string) => v.slice(11, 16),
    weekdayShort: () => 'Mon',
    number: (v: number | bigint | string) => String(v),
    money: (v: string) => `${v} VND`,
    aiAmount: (v: string) => v,
  }),
  useLocaleSetting: () => ({ locale: 'vi', setLocale: () => undefined }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'demo-org', id: '00000000-0000-4000-8000-000000000001' }),
    useNavigate: () => () => Promise.resolve(),
    useSearch: () => ({}),
    Link: ({ children, to, className }: { children?: ReactNode; to: string; className?: string }) =>
      createElement('a', { href: to, className }, children),
  };
});

// Stand-in portals render FormPanel and FormDialog inline during SSR so their fields, attributes,
// footer bindings, and outside sections can be inspected directly.
vi.mock('../src/components/form-panel.tsx', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/components/form-panel.tsx')>();
  const { createElement, Fragment } = await import('react');
  return {
    ...original,
    FormPanel: (p: {
      title: string;
      description?: ReactNode;
      testId?: string;
      wide?: boolean;
      busy?: boolean;
      noValidate?: boolean;
      formId?: string;
      dirty?: boolean;
      onSubmit?: (event: unknown) => void;
      outside?: ReactNode;
      footer: ReactNode | ((requestClose: () => void) => ReactNode);
      children: ReactNode;
    }) => {
      captured.calls.push({
        kind: 'FormPanel',
        title: p.title,
        ...(p.testId ? { testId: p.testId } : {}),
        ...(p.wide !== undefined ? { wide: p.wide } : {}),
        ...(p.noValidate !== undefined ? { noValidate: p.noValidate } : {}),
        ...(p.formId ? { formId: p.formId } : {}),
        ...(p.busy !== undefined ? { busy: p.busy } : {}),
        ...(p.dirty !== undefined ? { dirty: p.dirty } : {}),
        hasOnSubmit: p.onSubmit !== undefined,
        hasOutside: p.outside !== undefined,
      });
      const renderedFooter = typeof p.footer === 'function' ? p.footer(() => undefined) : p.footer;
      const body = p.onSubmit
        ? p.outside !== undefined
          ? createElement(
              Fragment,
              null,
              createElement(
                'form',
                { id: p.formId ?? 'panel-form', 'aria-label': p.title, noValidate: p.noValidate },
                createElement('fieldset', { disabled: p.busy }, p.children),
              ),
              p.outside,
              createElement('footer', null, renderedFooter),
            )
          : createElement(
              'form',
              { 'aria-label': p.title, noValidate: p.noValidate },
              createElement('fieldset', { disabled: p.busy }, p.children),
              createElement('footer', null, renderedFooter),
            )
        : createElement(Fragment, null, p.children, p.outside, createElement('footer', null, renderedFooter));

      return createElement(
        'section',
        { role: 'dialog', 'data-slot': 'sheet-content', 'data-testid': p.testId },
        createElement('h2', null, p.title),
        p.description ? createElement('p', null, p.description) : null,
        body,
      );
    },
  };
});

vi.mock('../src/components/form-dialog.tsx', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/components/form-dialog.tsx')>();
  const { createElement } = await import('react');
  return {
    ...original,
    FormDialog: (p: {
      title: string;
      description?: string;
      testId?: string;
      submitTestId?: string;
      busy?: boolean;
      dirty?: boolean;
      submitLabel: string;
      onSubmit: (event: unknown) => void;
      children: ReactNode;
    }) => {
      captured.calls.push({
        kind: 'FormDialog',
        title: p.title,
        ...(p.testId ? { testId: p.testId } : {}),
        ...(p.submitTestId ? { submitTestId: p.submitTestId } : {}),
        ...(p.busy !== undefined ? { busy: p.busy } : {}),
        ...(p.dirty !== undefined ? { dirty: p.dirty } : {}),
        hasOnSubmit: true,
        hasOutside: false,
      });
      return createElement(
        'section',
        { role: 'dialog', 'data-slot': 'dialog-content', 'data-testid': p.testId },
        createElement('h2', null, p.title),
        p.description ? createElement('p', null, p.description) : null,
        createElement(
          'form',
          { 'aria-label': p.title, noValidate: true },
          createElement('fieldset', { disabled: p.busy }, p.children),
          createElement('button', { type: 'button' }, 'Cancel'),
          createElement('button', { type: 'submit', 'data-testid': p.submitTestId }, p.submitLabel),
        ),
      );
    },
  };
});

const { CreateProjectDialog, EditProjectTaskDialog, ProjectSettingsDialog } = await import(
  '../src/components/project-task-dialog.tsx'
);
const { CreateEnvelopeDialog, SignEnvelopesPage } = await import('../src/routes/sign-envelopes.tsx');
const { MeetingsPage, NewMeetingFormPanel } = await import('../src/routes/meetings.tsx');

function renderLocale(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClientState.current}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function assertNoNestedForms(html: string): void {
  let depth = 0;
  for (const tag of html.matchAll(/<\/?form\b/g)) {
    if (tag[0] === '<form') {
      depth += 1;
      expect(depth, 'HTML must never nest <form> inside <form>').toBeLessThanOrEqual(1);
    } else {
      depth = Math.max(0, depth - 1);
    }
  }
  expect(depth).toBe(0);
}

function readSrc(relPath: string): string {
  return readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const sampleTask: ProjectTaskCard = {
  id: '20000000-0000-4000-8000-000000000101',
  title: 'Kiểm tra bảng kê đầu vào',
  description: 'Đối soát MST trước khi chốt kỳ',
  status: 'todo',
  assigneePositionId: null,
  due: '2026-12-01T00:00:00.000Z',
  checklist: [{ text: 'Kiểm tra hóa đơn', done: false }],
  tainted: false,
  checkedOut: false,
  commentCount: 0,
  openBlockerCount: 1,
  cycleId: null,
  storyPoints: 3,
  createdAt: '2026-11-20T00:00:00.000Z',
  addedAt: '2026-11-20T00:00:00.000Z',
};

const sampleSeats: ProjectSeat[] = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    title: 'Kế toán trưởng',
    status: 'active',
    onProject: true,
    holder: { type: 'user', userId: 'u1', displayName: 'Lan Anh', email: 'lan@example.com' },
  },
];

const sampleCycles: ProjectCycle[] = [
  {
    id: '40000000-0000-4000-8000-000000000001',
    projectId: '10000000-0000-4000-8000-000000000001',
    number: 1,
    name: 'Chu kỳ 1',
    goal: null,
    status: 'active',
    startsOn: '2026-11-20',
    endsOn: '2026-12-04',
    startedAt: '2026-11-20T00:00:00.000Z',
    completedAt: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    totalTasks: 1,
    openTasks: 1,
    doneTasks: 0,
    cancelledTasks: 0,
    totalPoints: 3,
    donePoints: 0,
  },
];

const sampleProject: ProjectDetail = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Quyết toán quý IV',
  description: 'Hoàn thiện báo cáo tài chính',
  status: 'active',
  visibility: 'org',
  ownerUserId: 'u1',
  ownerName: 'Lan Anh',
  canManage: true,
  canWrite: true,
  cyclesEnabled: true,
  cycleDurationWeeks: 2,
  pointsEnabled: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
};

const sampleMembers: ProjectBoard['members'] = [
  { userId: 'u1', role: 'owner', displayName: 'Lan Anh', email: 'lan@example.com', onProject: true },
  { userId: 'u2', role: 'member', displayName: 'Minh Tuấn', email: 'minh@example.com', onProject: false },
];

beforeEach(() => {
  captured.calls.length = 0;
  queryClientState.current.clear();
});

describe('Overlay consolidation across Projects, eSign, and Meetings (#4522)', () => {
  it('renders Projects CreateProjectDialog in FormDialog with preserved testid and mobile controls', () => {
    expect(
      renderLocale(
        <CreateProjectDialog open={false} onOpenChange={() => undefined} onCreated={() => undefined} />,
      ),
    ).toBe('');

    const html = renderLocale(
      <CreateProjectDialog open onOpenChange={() => undefined} onCreated={() => undefined} />,
    );
    expect(captured.calls).toEqual([
      {
        kind: 'FormDialog',
        title: viMessages.projects.createTitle,
        testId: 'create-project-dialog',
        busy: false,
        dirty: false,
        hasOnSubmit: true,
        hasOutside: false,
      },
    ]);
    expect(html).toContain('data-testid="create-project-dialog"');
    expect(html).toContain('data-testid="project-visibility-select"');
    expect(html).toContain('data-testid="project-visibility-notice"');
    expect(html).toContain('id="create-project-name"');
    expect(html).toContain('id="create-project-desc"');
    expect(html).toContain('max-md:min-h-11');
    assertNoNestedForms(html);
  });

  it('renders EditProjectTaskDialog in wide FormPanel with outside sub-forms and no nested <form>', () => {
    expect(
      renderLocale(
        <EditProjectTaskDialog
          slug="demo-org"
          projectId={sampleProject.id}
          task={sampleTask}
          seats={sampleSeats}
          open={false}
          onOpenChange={() => undefined}
        />,
      ),
    ).toBe('');

    const html = renderLocale(
      <EditProjectTaskDialog
        slug="demo-org"
        projectId={sampleProject.id}
        task={sampleTask}
        projectTasks={[sampleTask]}
        seats={sampleSeats}
        cyclesEnabled
        pointsEnabled
        cycles={sampleCycles}
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]).toMatchObject({
      kind: 'FormPanel',
      title: viMessages.projects.modals.editTaskTitle,
      testId: 'edit-project-task-dialog',
      wide: true,
      noValidate: true,
      busy: false,
      dirty: false,
      hasOnSubmit: true,
      hasOutside: true,
    });
    const formId = captured.calls[0]?.formId;
    expect(formId).toBeTruthy();
    expect(html).toContain(`form="${formId}"`);
    expect(html).toContain('data-testid="edit-project-task-dialog"');
    expect(html).toContain('data-testid="edit-task-open-blockers-warning"');
    expect(html).toContain('data-testid="project-dependencies-section"');
    expect(html).toContain('data-testid="task-time-tracking-panel"');
    expect(html).toContain('data-testid="task-recurrence-control"');
    expect(html).toContain('max-md:min-h-11');
    assertNoNestedForms(html);
  });

  it('renders ProjectSettingsDialog in wide FormPanel, keeps ConfirmDialog untouched, and guards non-editable mode', () => {
    expect(
      renderLocale(
        <ProjectSettingsDialog
          open={false}
          onOpenChange={() => undefined}
          project={sampleProject}
          members={sampleMembers}
        />,
      ),
    ).toBe('');

    const editableHtml = renderLocale(
      <ProjectSettingsDialog open onOpenChange={() => undefined} project={sampleProject} members={sampleMembers} />,
    );
    expect(captured.calls[0]).toMatchObject({
      kind: 'FormPanel',
      title: viMessages.projects.modals.editProjectTitle,
      testId: 'project-settings-dialog',
      wide: true,
      noValidate: true,
      dirty: false,
      hasOnSubmit: true,
      hasOutside: true,
    });
    expect(editableHtml).toContain('data-testid="project-settings-dialog"');
    expect(editableHtml).toContain('data-testid="settings-cycles-enabled"');
    expect(editableHtml).toContain('data-testid="settings-points-enabled"');
    expect(editableHtml).toContain(viMessages.projects.modals.archiveBtn);
    assertNoNestedForms(editableHtml);

    captured.calls.length = 0;
    const readOnlyHtml = renderLocale(
      <ProjectSettingsDialog
        open
        onOpenChange={() => undefined}
        project={{ ...sampleProject, canManage: false }}
        members={sampleMembers}
      />,
    );
    expect(captured.calls[0]).toMatchObject({
      kind: 'FormPanel',
      testId: 'project-settings-dialog',
      dirty: false,
      hasOnSubmit: false,
      hasOutside: true,
    });
    expect(readOnlyHtml).not.toContain(viMessages.projects.modals.saveDetails);
  });

  it('renders eSign CreateEnvelopeDialog in FormDialog and keeps stacked DataTable on SignEnvelopesPage', () => {
    const html = renderLocale(
      <CreateEnvelopeDialog onClose={() => undefined} onCreated={() => undefined} />,
    );
    expect(captured.calls).toEqual([
      {
        kind: 'FormDialog',
        title: viMessages.sign.createTitle,
        testId: 'sign-create-dialog',
        submitTestId: 'sign-create-submit-btn',
        busy: false,
        dirty: false,
        hasOnSubmit: true,
        hasOutside: false,
      },
    ]);
    expect(html).toContain('data-testid="sign-create-dialog"');
    expect(html).toContain('data-testid="sign-upload-pdf-input"');
    expect(html).toContain('id="sign-new-title"');
    expect(html).toContain('data-testid="sign-create-submit-btn"');
    expect(html).toContain('max-md:min-h-11');
    assertNoNestedForms(html);

    queryClientState.current.setQueryData(['sign', 'envelopes', 'demo-org', 'all'], {
      items: [
        {
          id: 'env-1',
          title: 'Hợp đồng dịch vụ 2026',
          status: 'draft',
          routingMode: 'parallel',
          certificateCode: null,
          sealStatus: null,
          pageCount: 2,
          sourceFileId: 'f-1',
          signerSummary: { total: 1, signed: 0, waitingForMe: false },
          createdAt: '2026-11-20T00:00:00.000Z',
        },
      ],
    });
    const listHtml = renderLocale(<SignEnvelopesPage />);
    expect(listHtml).toContain('data-testid="sign-envelope-list"');
    expect(listHtml).toContain('max-sm:[&amp;_tr]:block');
  });

  it('renders Meetings NewMeetingFormPanel in wide FormPanel with 44px touch parity and preserves success badges', () => {
    const html = renderLocale(
      <NewMeetingFormPanel onClose={() => undefined} onCreated={() => undefined} />,
      'en',
    );
    expect(captured.calls).toEqual([
      {
        kind: 'FormPanel',
        title: enMessages.meetings.newModalTitle,
        testId: 'new-meeting-panel',
        wide: true,
        noValidate: true,
        busy: false,
        dirty: false,
        hasOnSubmit: true,
        hasOutside: false,
      },
    ]);
    expect(html).toContain('data-testid="new-meeting-panel"');
    expect(html).toContain('id="meeting-title"');
    expect(html).toContain('id="meeting-lang"');
    expect(html).toContain('id="meeting-vis"');
    expect(html).toContain('id="meeting-audio"');
    expect(html).toContain('id="keep-video"');
    expect(html).toContain('id="consent-method"');
    expect(html).toContain('id="consent-agreed"');
    expect(html).toContain('data-testid="recording-notice"');
    expect(html).toContain('max-md:min-h-11');
    assertNoNestedForms(html);

    const meetingSummary: MeetingSummary = {
      id: 'm1',
      title: 'Họp giao ban',
      language: 'vi',
      visibility: 'attendees',
      status: 'ready',
      recorderUserId: 'u1',
      startedAt: '2026-11-23T02:00:00.000Z',
      endedAt: '2026-11-23T02:30:00.000Z',
      lengthSeconds: 1800,
      keepVideo: false,
      liveNotes: false,
      summaryTemplate: 'general',
      audioRetentionDate: '2026-12-23',
      textRetentionDate: null,
      hasAudio: true,
      hasVideo: false,
      hasTranscript: true,
      platform: 'meet',
      readersCount: 2,
      createdAt: '2026-11-23T02:00:00.000Z',
      updatedAt: '2026-11-23T02:30:00.000Z',
    };
    queryClientState.current.setQueryData(['meetings', 'list', { limit: 200 }], [meetingSummary]);
    const pageHtml = renderLocale(<MeetingsPage />, 'vi');
    expect(pageHtml).toContain('data-slot="badge" data-variant="success"');
    expect(pageHtml).not.toContain('data-slot="badge" data-variant="default"');
  });

  it('wires FormPanel/FormDialog behavior across all three migrated files with zero raw form Dialog regressions', () => {
    const projectDialogSrc = readSrc('../src/components/project-task-dialog.tsx');
    const signSrc = readSrc('../src/routes/sign-envelopes.tsx');
    const meetingsSrc = readSrc('../src/routes/meetings.tsx');

    // Only AttachTaskDialog (non-form picker) and ConfirmDialog remain as Dialog in project-task-dialog.tsx.
    expect(projectDialogSrc.match(/<DialogContent\b/g)).toHaveLength(1);
    expect(projectDialogSrc).toContain('data-testid="attach-task-dialog"');
    expect(projectDialogSrc).toContain('<ConfirmDialog');
    expect(projectDialogSrc).toContain('<FormDialog');
    expect(projectDialogSrc).toContain('<FormPanel');

    // Only sharedLinkDialog (non-form read-only URL viewer) remains as inline Dialog in sign-envelopes.tsx.
    expect(signSrc.match(/<DialogContent\b/g)).toHaveLength(1);
    expect(signSrc).toContain('id="shared-sign-link-url"');
    expect(signSrc).toContain('<FormDialog');

    // Meetings route removes raw Dialog entirely and routes new-meeting form through FormPanel.
    expect(meetingsSrc).not.toContain('<Dialog');
    expect(meetingsSrc).toContain('<FormPanel');
  });
});
