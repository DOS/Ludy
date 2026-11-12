// SPDX-License-Identifier: AGPL-3.0-only
// The search box and the hits on the meetings screen (L2, #2589), in Vietnamese and English: the box and its note, a hit with the meeting, its date, the time, the line with the
// typed words marked and a link that opens the transcript at that line, a draft marked as the member's own, the empty answer, the cap note and the paging. Rendered on the server.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingSearchResult } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
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
vi.mock('../src/i18n/provider.tsx', () => ({ useFormat: () => ({ date: (v: string) => `date:${v.slice(0, 10)}` }) }));
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, search, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string> } & Record<string, unknown>) =>
      createElement('a', { href: `${to.replace('$slug', params?.slug ?? '').replace('$id', params?.id ?? '')}?seg=${search?.seg ?? ''}`, ...rest }, children),
  };
});

const { MeetingSearch, SearchResults } = await import('../src/components/meeting-search.tsx');

const hit = (over: Partial<MeetingSearchResult['hits'][number]> = {}): MeetingSearchResult['hits'][number] => ({
  meetingId: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b',
  meetingTitle: 'Họp báo giá',
  heldAt: '2026-11-10T03:00:00.000Z',
  segmentId: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c',
  startSeconds: 72,
  speakerLabel: 'Lan',
  text: 'Anh Tuấn đề nghị chiết khấu 5% cho đơn đầu',
  stage: 'published',
  ...over,
});

function render(node: ReactNode, locale: 'en' | 'vi') {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the search box', () => {
  it('shows the label, the placeholder and the note in both languages, and no result before a search', () => {
    const vn = render(<MeetingSearch slug="acme" />, 'vi');
    expect(vn).toContain('Tìm trong nội dung các cuộc họp');
    expect(vn).toContain('Gõ không dấu cũng tìm được');
    expect(vn).toContain('type="search"');
    expect(vn).not.toContain('meeting-search-hit');
    const eng = render(<MeetingSearch slug="acme" />, 'en');
    expect(eng).toContain('Search inside meetings');
    expect(eng).toContain('Typing without Vietnamese marks works too');
    expect(eng).not.toContain('Xóa kết quả');
  });
});

describe('the hits', () => {
  const page = { hits: [hit(), hit({ segmentId: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5d', stage: 'draft', startSeconds: 3725, text: 'Nháp: chiết khấu cho Hà' })], hasMore: false, capped: false };
  it('shows the meeting, date, time, speaker and the line with the typed words marked, linked to the transcript line', () => {
    const html = render(<SearchResults slug="acme" result={page} typed="chiet khau" page={1} onPage={() => {}} />, 'vi');
    expect(html).toContain('Họp báo giá');
    expect(html).toContain('date:2026-11-10');
    expect(html).toContain('1:12');
    expect(html).toContain('1:02:05');
    expect(html).toContain('Lan');
    expect(html).toContain('<mark');
    expect(html).toMatch(/<mark[^>]*>chiết<\/mark>/);
    expect(html).toMatch(/<mark[^>]*>khấu<\/mark>/);
    expect(html).toContain('href="/o/acme/meetings/0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b?seg=0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c"');
    expect(html).toContain('Mở cuộc họp Họp báo giá tại 1:12');
    // A draft line is marked as the member's own; a published one is not.
    expect(html.match(/Bản nháp của bạn/g)).toHaveLength(1);
    expect(html).not.toContain('Trang trước');
  });
  it('says so in both languages when nothing was found', () => {
    const none = { hits: [], hasMore: false, capped: false };
    expect(render(<SearchResults slug="acme" result={none} typed="zzz" page={1} onPage={() => {}} />, 'vi')).toContain('Không thấy dòng nào có các từ này');
    expect(render(<SearchResults slug="acme" result={none} typed="zzz" page={1} onPage={() => {}} />, 'en')).toContain('No line with these words');
  });
  it('shows the paging when there is a next page or a previous one, and the cap note at the cap', () => {
    const more = render(<SearchResults slug="acme" result={{ ...page, hasMore: true }} typed="chiet" page={1} onPage={() => {}} />, 'en');
    expect(more).toContain('Next page');
    expect(more).toContain('Page 1');
    expect(more).toMatch(/Previous page[^>]*>|disabled[^>]*>Previous page/);
    const capped = render(<SearchResults slug="acme" result={{ ...page, hasMore: true, capped: true }} typed="chiet" page={10} onPage={() => {}} />, 'en');
    expect(capped).toContain('Only the first 200 results are shown');
    expect(capped).toContain('Page 10');
  });
});

describe('the messages', () => {
  it('has the same search keys in both languages', () => {
    expect(Object.keys(viMessages.meetings.contentSearch).sort()).toEqual(Object.keys(en.meetings.contentSearch).sort());
  });
});
