// SPDX-License-Identifier: AGPL-3.0-only
// The summary and action items panel on a meeting's page (#2580, M6 part A): the recorder sees a draft editor, the items and the one share button; a reader
// sees only what was shared, with no editor and no draft wording; nobody with nothing shared sees an empty box. Rendered on the server from the query cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ActionItemView, MeetingResults as Results } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});

const { MeetingResults } = await import('../src/components/meeting-results.tsx');

const item = (id: string, over: Partial<ActionItemView> = {}): ActionItemView => ({
  id,
  stage: 'published',
  status: 'suggested',
  title: 'Gửi báo giá cho khách',
  who: 'An',
  whoUserId: null,
  when: 'thứ sáu',
  whenDate: null,
  transcriptSeconds: 125,
  flags: [],
  tainted: false,
  taskId: null,
  positions: [],
  clean: false,
  ...over,
});
const view = (stage: 'draft' | 'published', summary: string) => ({ id: `r-${stage}`, feature: 'manual' as const, stage, summary, decisions: ['Giữ giá cũ'], tainted: false });

function render(results: Results) {
  client.current.setQueryData(['meetings', 'results', 'get'], results);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <MeetingResults meetingId="m1" readers={['u1']} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('MeetingResults', () => {
  it('gives the recorder a draft editor, the items, a way to add one and the share button', () => {
    const html = render({ meetingId: 'm1', isRecorder: true, draft: view('draft', 'Chốt báo giá'), published: null, items: [item('a', { stage: 'draft' })] });
    expect(html).toContain(en.meetings.results.recorderNote);
    expect(html).toContain('Chốt báo giá');
    expect(html).toContain(en.meetings.results.publish);
    expect(html).toContain(en.meetings.results.addItem);
    expect(html).toContain('Gửi báo giá cho khách');
    expect(html).toContain('2:05');
    expect(html).toContain(en.meetings.results.delete);
    expect(html.match(/data-testid="action-item"/g)).toHaveLength(1);
  });

  it('shows a reader only the shared summary and items, with no editor, no add form and no share button', () => {
    const html = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'Đã chia sẻ'), items: [item('b')] });
    expect(html).toContain('Đã chia sẻ');
    expect(html).toContain(en.meetings.results.readerNote);
    expect(html).toContain(en.meetings.results.makeTask);
    expect(html).not.toContain(en.meetings.results.publish);
    expect(html).not.toContain(en.meetings.results.addItem);
    expect(html).not.toContain(en.meetings.results.draftTitle);
    expect(html).not.toContain(en.meetings.results.delete);
  });

  it('offers "make the clear tasks" only when an item is clear, flags contact details and says when an attendee holds several seats', () => {
    const clear = item('c', { clean: true, whoUserId: 'u1', whenDate: '2026-11-13', positions: [{ id: 'p1', title: 'Bán hàng' }] });
    const flagged = item('d', { flags: ['contact_in_title'], whoUserId: 'u1', positions: [{ id: 'p1', title: 'A' }, { id: 'p2', title: 'B' }] });
    const html = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'x'), items: [clear, flagged] });
    expect(html).toContain('Make 1 clear tasks');
    expect(html).toContain(en.meetings.results.flagContact);
    expect(html).toContain(en.meetings.results.severalSeats);
    const none = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'x'), items: [flagged] });
    expect(none).not.toContain('clear tasks');
  });

  it('shows no task form for an item that already has its task, and nothing at all to a reader with nothing shared', () => {
    const html = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'x'), items: [item('e', { status: 'accepted', taskId: 't1' })] });
    expect(html).toContain(en.meetings.results.accepted);
    expect(html).not.toContain(en.meetings.results.makeTask);
    expect(render({ meetingId: 'm1', isRecorder: false, draft: null, published: null, items: [] })).toBe('');
  });
});
