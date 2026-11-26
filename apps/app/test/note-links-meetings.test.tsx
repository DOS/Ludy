// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['kernel', 'notes', 'meetings', 'projects'] as string[],
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: state.modules }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children?: React.ReactNode;
    className?: string;
  }) => {
    const href = Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to);
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.client = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: state.client, errorMessage: String };
});

const { MEETING_PICKER_LIMIT, NoteLinks, RecordLinkAdder, filterMeetingOptions } = await import('../src/components/note-links.tsx');

describe('NoteLinks & RecordLinkAdder with meetings.meeting (N10)', () => {
  beforeEach(() => {
    state.client.clear();
    state.modules = ['kernel', 'notes', 'meetings', 'projects'];
  });

  it('links to the meeting detail page when readable and shows unavailable placeholder when unreadable', () => {
    const htmlEn = renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
          <NoteLinks
            slug="acme"
            onRemove={() => undefined}
            links={[
              { id: 'l1', targetType: 'meetings.meeting', targetId: 'm-123', createdAt: '2026-11-16T00:00:00.000Z', available: true },
              { id: 'l2', targetType: 'meetings.meeting', targetId: 'm-secret', createdAt: '2026-11-16T00:00:00.000Z', available: false },
            ]}
          />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(htmlEn).toContain('href="/o/acme/meetings/m-123"');
    expect(htmlEn).toContain('>Meeting<');
    expect(htmlEn).not.toContain('/o/acme/meetings/m-secret');
    expect(htmlEn).toContain('You cannot open this record');

    const htmlVi = renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <NoteLinks
            slug="acme"
            onRemove={() => undefined}
            links={[{ id: 'l2', targetType: 'meetings.meeting', targetId: 'm-secret', createdAt: '2026-11-16T00:00:00.000Z', available: false }]}
          />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(htmlVi).toContain('Cuộc họp');
    expect(htmlVi).toContain('Bản ghi không mở được');
  });

  it('shows meetings.meeting option in RecordLinkAdder only when meetings module is active', () => {
    const withMeetings = renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
          <RecordLinkAdder existingLinks={[]} onAdd={() => undefined} defaultOpen />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(withMeetings).toContain('value="meetings.meeting"');
    expect(withMeetings).toContain('>Meeting<');

    state.modules = ['kernel', 'notes'];
    const withoutMeetings = renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
          <RecordLinkAdder existingLinks={[]} onAdd={() => undefined} defaultOpen />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(withoutMeetings).not.toContain('meetings.meeting');
  });

  it('filters fetched meetings case-insensitively and shows a 100-item window hint when the meeting list cap is reached', () => {
    const sample = [
      { id: 'm1', label: 'Họp chốt báo giá Q4' },
      { id: 'm2', label: 'Weekly Finance Sync' },
      { id: 'm3', label: 'Khách hàng ABC' },
    ];
    expect(filterMeetingOptions(sample, '')).toEqual(sample);
    expect(filterMeetingOptions(sample, '  finance ')).toEqual([{ id: 'm2', label: 'Weekly Finance Sync' }]);
    expect(filterMeetingOptions(sample, 'báo giá')).toEqual([{ id: 'm1', label: 'Họp chốt báo giá Q4' }]);
    expect(filterMeetingOptions(sample, 'nonexistent')).toEqual([]);

    state.client.setQueryData(['meetings', 'list'], [
      { id: 'm1', title: 'Họp chốt báo giá Q4' },
      { id: 'm2', title: 'Weekly Finance Sync' },
    ]);
    const shortListHtml = renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
          <RecordLinkAdder existingLinks={[]} onAdd={() => undefined} defaultOpen defaultTargetType="meetings.meeting" />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(shortListHtml).toContain('data-testid="record-link-meeting-search"');
    expect(shortListHtml).toContain('Họp chốt báo giá Q4');
    expect(shortListHtml).not.toContain('data-testid="record-link-meeting-window-hint"');

    const cappedMeetings = Array.from({ length: MEETING_PICKER_LIMIT }, (_, i) => ({
      id: `m-${i}`,
      title: `Cuộc họp #${i + 1}`,
    }));
    state.client.setQueryData(['meetings', 'list'], cappedMeetings);
    const cappedEn = renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
          <RecordLinkAdder existingLinks={[]} onAdd={() => undefined} defaultOpen defaultTargetType="meetings.meeting" />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(cappedEn).toContain('data-testid="record-link-meeting-window-hint"');
    expect(cappedEn).toContain(en.notes.links.meetingWindowHint.replace('{limit}', String(MEETING_PICKER_LIMIT)));

    const cappedVi = renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <RecordLinkAdder existingLinks={[]} onAdd={() => undefined} defaultOpen defaultTargetType="meetings.meeting" />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(cappedVi).toContain(viMessages.notes.links.meetingWindowHint.replace('{limit}', String(MEETING_PICKER_LIMIT)));
  });
});

describe('the task picker of RecordLinkAdder (#4421)', () => {
  it('marks the invisible characters of a task title an AI coworker wrote and leaves a person\'s title as typed', () => {
    state.client.clear();
    state.modules = ['kernel', 'notes'];
    state.client.setQueryData(['tasks', 'list'], [
      { id: 't1', title: 'Gửi báo\u202e giá\u200b', tainted: true },
      { id: 't2', title: 'Việc\u202e riêng', tainted: false },
    ]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={state.client}>
        <IntlProvider locale="en" timeZone="Asia/Ho_Chi_Minh" messages={catalog('en')}>
          <RecordLinkAdder existingLinks={[]} onAdd={() => undefined} defaultOpen />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain('Gửi báo\u27e8U+202E\u27e9 giá\u27e8U+200B\u27e9');
    expect(html).not.toContain('Gửi báo\u202e');
    expect(html).toContain('Việc\u202e riêng');
  });
});
