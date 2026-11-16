// SPDX-License-Identifier: AGPL-3.0-only
// SSR and pure helper tests for ProjectTasksFromSourceDialog and task provenance links (#2608) in English and Vietnamese.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIME_ZONE, type ProjectTasksFromSourceStatus } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const testState = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['kernel', 'projects', 'notes', 'meetings', 'social'] as string[],
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: testState.modules }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  testState.client = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input ?? {}], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: async () => ({}) });
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
    useParams: () => ({ slug: 'acme', id: '00000000-0000-4000-8000-000000000001' }),
    useSearch: () => ({}),
  };
});

const {
  ProjectTasksFromSourceBody,
  defaultSourceTab,
  isCurrentConversationPage,
  toSourceEditableRows,
} = await import('../src/components/project-tasks-from-source-dialog.tsx');
const { DirectMeetingLink } = await import('../src/routes/tasks.tsx');
const { TaskConversationLink } = await import('../src/components/task-conversation-link.tsx');

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function renderWithIntl(locale: 'vi' | 'en', node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={testState.client}>
      <IntlProvider locale={locale} timeZone={DEFAULT_TIME_ZONE} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function setupDialogCache(opts: {
  status?: ProjectTasksFromSourceStatus;
  meter?: { aiOn: boolean; state: string };
} = {}) {
  testState.client.clear();
  if (opts.status) testState.client.setQueryData(['projects', 'tasksFromSourceStatus', {}], opts.status);
  if (opts.meter) {
    testState.client.setQueryData(['ai', 'meter', { module: 'projects' }], {
      ...opts.meter,
      scope: null,
      percent: 0,
      resetAt: '2026-12-01T00:00:00.000Z',
    });
  }
}

describe('ProjectTasksFromSourceDialog helpers & states (#2608)', () => {
  it('defaults tab cleanly to installed modules and initializes unedited proposal rows', () => {
    expect(defaultSourceTab({ notes: true, meetings: true })).toBe('note');
    expect(defaultSourceTab({ notes: false, meetings: true })).toBe('meeting');
    expect(defaultSourceTab({ notes: false, meetings: false })).toBe('conversation');

    expect(
      toSourceEditableRows([{ title: 'Follow up with client', assigneePositionId: null, dueOn: '2026-11-20' }]),
    ).toEqual([
      {
        key: 'row-0',
        selected: true,
        title: 'Follow up with client',
        assigneePositionId: null,
        dueOn: '2026-11-20',
        edited: false,
      },
    ]);
  });

  it('shows blocked AI state clearly in Vietnamese and English without crashing when meetings is off', () => {
    testState.modules = ['kernel', 'projects', 'notes'];
    setupDialogCache({
      status: { available: false, reason: 'paused', resetOn: null },
      meter: { aiOn: true, state: 'ok' },
    });

    const viHtml = renderWithIntl(
      'vi',
      <ProjectTasksFromSourceBody open onClose={() => {}} slug="acme" projectId={PROJECT_ID} />,
    );
    expect(viHtml).toContain('Ghi chú');
    expect(viHtml).toContain('Cuộc họp');
    expect(viHtml).toContain('Hội thoại');
    expect(viHtml).toContain('tạm dừng');

    const enHtml = renderWithIntl(
      'en',
      <ProjectTasksFromSourceBody open onClose={() => {}} slug="acme" projectId={PROJECT_ID} />,
    );
    expect(enHtml).toContain('Note');
    expect(enHtml).toContain('Meeting');
    expect(enHtml).toContain('Conversation');
    expect(enHtml).toContain('AI is paused by a kill switch');
  });

  it('renders readable provenance links for meeting & conversation, and neutral fallbacks when unreadable or module off', () => {
    testState.modules = ['kernel', 'projects', 'meetings', 'social'];
    testState.client.clear();
    testState.client.setQueryData(['meetings', 'get', { meetingId: MEETING_ID }], { title: 'Họp chốt hợp đồng' });

    const meetingHtml = renderWithIntl('vi', <DirectMeetingLink meetingId={MEETING_ID} slug="acme" />);
    expect(meetingHtml).toContain(`/o/acme/meetings/${MEETING_ID}`);
    expect(meetingHtml).toContain('Họp chốt hợp đồng');

    const convHtml = renderWithIntl('vi', <TaskConversationLink conversationId={CONV_ID} slug="acme" />);
    expect(convHtml).toContain(`/o/acme/social/inbox?c=${CONV_ID}`);
    expect(convHtml).toContain('Mở hội thoại');

    // Unreadable meeting or disabled meetings/social module falls back safely without leaking existence.
    testState.modules = ['kernel', 'projects'];
    const closedMeetingHtml = renderWithIntl('en', <DirectMeetingLink meetingId={MEETING_ID} slug="acme" />);
    expect(closedMeetingHtml).toContain('The meeting record cannot be opened.');
    expect(closedMeetingHtml).not.toContain('Họp chốt hợp đồng');

    const closedConvHtml = renderWithIntl('en', <TaskConversationLink conversationId={CONV_ID} slug="acme" />);
    expect(closedConvHtml).toBe('');
  });

  it('renders conversation search input and load-more button when conversations list has more pages', () => {
    testState.modules = ['kernel', 'projects'];
    testState.client.clear();
    testState.client.setQueryData(['projects', 'tasksFromSourceStatus', {}], {
      available: true,
      reason: null,
      resetOn: null,
    });
    testState.client.setQueryData(['ai', 'meter', { module: 'projects' }], {
      aiOn: true,
      state: 'ok',
      scope: null,
      percent: 0,
      resetAt: '2026-12-01T00:00:00.000Z',
    });
    testState.client.setQueryData(['conversations', 'list', { limit: 50 }], {
      conversations: [
        {
          id: CONV_ID,
          kind: 'comment_thread',
          status: 'new',
          channel: { connectionId: 'ch-1', provider: 'zalo', displayName: 'Zalo OA' },
          postId: null,
          contact: { identityId: 'id-1', displayName: 'Khách Q4', idTail: '9999', partyId: null, partyName: null, address: null },
          assigneeUserId: null,
          lastSeq: 1,
          lastMessageAt: '2026-11-16T00:00:00.000Z',
          lastInboundAt: '2026-11-16T00:00:00.000Z',
          replyWindowUntil: null,
          preview: 'Cần báo giá',
          unread: false,
          composing: [],
          intent: null,
          subject: 'Hội thoại trang 1',
        },
      ],
      more: true,
    });

    const html = renderWithIntl(
      'vi',
      <ProjectTasksFromSourceBody open onClose={() => {}} slug="acme" projectId={PROJECT_ID} />,
    );
    expect(html).toContain('data-testid="project-tasks-source-search"');
    expect(html).toContain('Hội thoại trang 1');
    expect(html).toContain('data-testid="project-tasks-source-load-more"');
    expect(html).toContain('Tải thêm hội thoại');
  });

  it('discards stale load-more conversation responses when search query or epoch changes', () => {
    expect(isCurrentConversationPage(1, 'vip', { epoch: 1, search: 'vip' })).toBe(true);
    expect(isCurrentConversationPage(2, 'vip', { epoch: 1, search: 'vip' })).toBe(false);
    expect(isCurrentConversationPage(2, 'khach', { epoch: 1, search: '' })).toBe(false);
  });
});
