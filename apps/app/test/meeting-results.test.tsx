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

const READER = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
function render(results: Results, summaryEnabled = false, template: 'general' | 'briefing' | 'customer' = 'general') {
  client.current.setQueryData(['meetings', 'results', 'get'], results);
  client.current.setQueryData(['meetings', 'results', 'summaryStatus'], { meetingId: 'm1', enabled: summaryEnabled });
  client.current.setQueryData(['org', 'get'], { members: [{ userId: READER, email: 'lan@example.com', displayName: 'Chị Lan', role: 'member' }] });
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <MeetingResults meetingId="m1" readers={[READER, '0198a0b4-0000-7e6f-8a9b-0c1d2e3f4a5c']} template={template} />
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
    expect(html).toContain(en.meetings.results.draftExpiry);
  });

  it('names people and never shows an id: the attendee picker lists names, and a member who left reads as a plain fallback', () => {
    const html = render({ meetingId: 'm1', isRecorder: true, draft: null, published: null, items: [] });
    expect(html).toContain('Chị Lan');
    expect(html).toContain(en.meetings.results.unknownMember);
    // The id stays in the option's value attribute; no text node shows it.
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text).not.toContain(READER);
    expect(text).not.toContain('0198a0b4-0000');
  });

  it('shows a reader only the shared summary and items, with no editor, no add form and no share button', () => {
    const html = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'Đã chia sẻ'), items: [item('b')] });
    expect(html).toContain('Đã chia sẻ');
    expect(html).toContain(en.meetings.results.readerNote);
    expect(html).toContain(en.meetings.results.makeTask);
    expect(html).not.toContain(en.meetings.results.publish);
    expect(html).not.toContain(en.meetings.results.addItem);
    expect(html).not.toContain(en.meetings.results.draftTitle);
    expect(html).not.toContain(en.meetings.results.draftExpiry);
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

  it('shows the Vy summary box to the recorder only when the system lets Vy summarize', () => {
    const results: Results = { meetingId: 'm1', isRecorder: true, draft: null, published: null, items: [] };
    expect(render(results, false)).not.toContain('data-testid="vy-summary"');
    const on = render(results, true);
    expect(on).toContain('data-testid="vy-summary"');
    expect(on).toContain(en.meetings.results.vy.start);
    // A reader never sees it, whatever the switch says.
    expect(render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'x'), items: [] }, true)).not.toContain('data-testid="vy-summary"');
  });

  it('asks the recorder to confirm what Vy wrote before sharing it: the share button waits, and a draft they wrote themselves shares at once', () => {
    const vyDraft = { ...view('draft', 'Vy viết'), feature: 'meetings.summary' as const, tainted: true };
    const waiting = render({ meetingId: 'm1', isRecorder: true, draft: vyDraft, published: null, items: [item('a', { stage: 'draft', tainted: true })] });
    expect(waiting).toContain('data-testid="vy-review"');
    expect(waiting).toContain(en.meetings.results.reviewed);
    expect(waiting).toContain(en.meetings.results.fromVy);
    expect(/<button[^>]*>(?:(?!<\/button>).)*Share with the attendees<\/button>/.exec(waiting)?.[0]).toMatch(/\sdisabled(=|\s|>)/);
    const own = render({ meetingId: 'm1', isRecorder: true, draft: view('draft', 'Tôi viết'), published: null, items: [item('b', { stage: 'draft' })] });
    expect(own).not.toContain('data-testid="vy-review"');
    expect(/<button[^>]*>(?:(?!<\/button>).)*Share with the attendees<\/button>/.exec(own)?.[0]).not.toMatch(/\sdisabled(=|\s|>)/);
  });
});

// Minutes templates (A4, #3162): the recorder picks the type, types section by section when Vy is off, and everyone reads a template's text under its headings.
describe('MeetingResults with a minutes template', () => {
  const briefing = 'Kết quả công việc kỳ trước\nĐã gửi hợp đồng.\n\nKế hoạch kỳ tới\nGửi báo giá thứ sáu.';
  it('gives the recorder the five types, with the chosen one selected, and one box per section instead of the single summary box', () => {
    const html = render({ meetingId: 'm1', isRecorder: true, draft: null, published: null, items: [] }, false, 'briefing');
    expect(html).toContain('data-testid="template-picker"');
    for (const name of Object.values(en.meetings.templates.names)) expect(html).toContain(name);
    expect(/<option[^>]*value="briefing"[^>]*selected/.test(html) || /<option[^>]*selected[^>]*value="briefing"/.test(html)).toBe(true);
    expect(html).toContain('data-testid="section-editor"');
    for (const label of Object.values(en.meetings.templates.sections.briefing)) expect(html).toContain(label);
    expect(html).not.toContain(`aria-label="${en.meetings.results.summary}"`);
  });

  it('keeps the single summary box on the general summary, and gives a reader no picker and no editor', () => {
    const general = render({ meetingId: 'm1', isRecorder: true, draft: null, published: null, items: [] });
    expect(general).toContain(`aria-label="${en.meetings.results.summary}"`);
    expect(general).not.toContain('data-testid="section-editor"');
    const reader = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', briefing), items: [] }, false, 'briefing');
    expect(reader).not.toContain('data-testid="template-picker"');
    expect(reader).not.toContain('data-testid="section-editor"');
  });

  it('fills the editor from the draft by its headings, and shows a shared template text under its section names', () => {
    const recorder = render({ meetingId: 'm1', isRecorder: true, draft: view('draft', briefing), published: null, items: [] }, false, 'briefing');
    expect(recorder).toContain('Đã gửi hợp đồng.');
    expect(recorder).toContain('Gửi báo giá thứ sáu.');
    expect(recorder).not.toContain(en.meetings.templates.reflow);
    const reader = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', briefing), items: [] }, false, 'briefing');
    expect(reader).toContain(en.meetings.templates.sections.briefing.progress);
    expect(reader).toContain('Gửi báo giá thứ sáu.');
    // The headings are not printed twice as text: the Vietnamese heading line is gone, the section name is the screen's own.
    expect(reader).not.toContain('Kết quả công việc kỳ trước');
  });

  it('puts text that is not in the template\'s form into the first section and says so, and shows a shared one whole', () => {
    const recorder = render({ meetingId: 'm1', isRecorder: true, draft: view('draft', 'Một đoạn viết trước khi đổi loại'), published: null, items: [] }, false, 'customer');
    expect(recorder).toContain('Một đoạn viết trước khi đổi loại');
    expect(recorder).toContain(en.meetings.templates.reflow.replace(/'/g, '&#x27;'));
    const reader = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'Một đoạn viết trước khi đổi loại'), items: [] }, false, 'customer');
    expect(reader).toContain('Một đoạn viết trước khi đổi loại');
  });
});

