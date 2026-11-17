// SPDX-License-Identifier: AGPL-3.0-only
// A series of meetings on a meeting's page (#3542): the block "Việc còn dở từ buổi trước" with the previous meeting's open items (accepted ones with the task's status, the others as not assigned), the
// recorder's own click to carry an item into their notes and their control to put the meeting in a series, and nothing for a reader who did not read the previous meeting. Rendered on the server from the
// query cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { SeriesOpenItems } from '@crove/kernel-contract';
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

const { MeetingSeries } = await import('../src/components/meeting-series.tsx');

const ME = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const NAM = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c';
const open = (over: Partial<SeriesOpenItems> = {}): SeriesOpenItems => ({
  meetingId: 'm2',
  inSeries: true,
  previous: { meetingId: 'm1', title: 'Giao ban tuần trước', startedAt: '2026-11-10T02:00:00.000Z' },
  items: [
    { id: 'i1', title: 'Gửi báo giá', who: 'Nam', whoUserId: NAM, when: 'thứ sáu', whenDate: null, assigned: true, taskStatus: 'in_progress', due: '2026-12-01T00:00:00.000Z' },
    { id: 'i2', title: 'Chưa ai nhận', who: '', whoUserId: null, when: '', whenDate: null, assigned: false, taskStatus: null, due: null },
  ],
  ...over,
});
const earlier = (id: string, recorder: string, startedAt: string | null) => ({ id, title: `Họp ${id}`, recorderUserId: recorder, startedAt });

function render(data: SeriesOpenItems | undefined, opts: { isRecorder?: boolean; meetings?: ReturnType<typeof earlier>[] } = {}) {
  client.current.clear();
  if (data) client.current.setQueryData(['meetings', 'series', 'openItems'], data);
  client.current.setQueryData(['org', 'get'], { role: 'member', members: [{ userId: ME, email: 'me@example.com', displayName: 'Tôi', role: 'member' }, { userId: NAM, email: 'nam@example.com', displayName: 'Anh Nam', role: 'member' }] });
  client.current.setQueryData(['me', 'get'], { userId: ME });
  client.current.setQueryData(['meetings', 'list'], opts.meetings ?? []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <MeetingSeries meetingId="m2" isRecorder={opts.isRecorder ?? false} startedAt="2026-11-17T02:00:00.000Z" />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the open items of a series on a meeting page', () => {
  it('lists the previous meeting\'s open items under its title, the accepted with their status and due date and the others as not assigned', () => {
    const html = render(open());
    expect(html).toContain('data-testid="series-open-items"');
    expect(html).toContain(en.meetings.series.title);
    expect(html).toContain('Giao ban tuần trước');
    expect(html).toContain('2026-11-10');
    expect(html).toContain('Gửi báo giá');
    expect(html).toContain('Anh Nam');
    expect(html).toContain(en.meetings.series.status.in_progress);
    expect(html).toContain('Due 2026-12-01');
    expect(html).toContain(en.meetings.series.unassigned);
    expect(html.match(/data-testid="series-item"/g)).toHaveLength(2);
  });

  it('gives the recorder a button to carry each item into their notes, and a reader none', () => {
    expect(render(open(), { isRecorder: true }).match(new RegExp(`>${en.meetings.series.carry}<`, 'g'))).toHaveLength(2);
    expect(render(open(), { isRecorder: false })).not.toContain(en.meetings.series.carry);
  });

  it('draws nothing for a reader who did not read the previous meeting: no block and no hint that there is one', () => {
    expect(render(open({ previous: null, items: [] }))).not.toContain('data-testid="series-open-items"');
    expect(render(open({ previous: null, items: [] }))).not.toContain(en.meetings.series.title);
    expect(render(undefined)).toBe('');
  });

  it('offers the recorder of a meeting outside any series the earlier meetings they recorded, and a way out of a series they are in', () => {
    const list = [earlier('a', ME, '2026-11-10T02:00:00.000Z'), earlier('b', NAM, '2026-11-11T02:00:00.000Z'), earlier('c', ME, '2026-11-20T02:00:00.000Z'), earlier('d', ME, null)];
    const html = render(open({ inSeries: false, previous: null, items: [] }), { isRecorder: true, meetings: list });
    expect(html).toContain('data-testid="series-follow"');
    // Only the recorder's own meetings that started before this one (17 November).
    expect(html).toContain('Họp a (2026-11-10)');
    for (const out of ['Họp b', 'Họp c', 'Họp d']) expect(html).not.toContain(out);
    expect(render(open(), { isRecorder: true })).toContain('data-testid="series-leave"');
    expect(render(open({ inSeries: false, previous: null, items: [] }), { isRecorder: false, meetings: list })).not.toContain('data-testid="series-follow"');
  });
});
