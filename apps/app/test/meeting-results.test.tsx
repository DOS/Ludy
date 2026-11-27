// SPDX-License-Identifier: AGPL-3.0-only
// The summary and action items panel on a meeting's page (#2580, M6 part A): the recorder sees a draft editor, the items and the one share button; a reader
// sees only what was shared, with no editor and no draft wording; nobody with nothing shared sees an empty box. Rendered on the server from the query cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ActionItemView, MeetingResults as Results } from '@ludy/kernel-contract';
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

const { MeetingResults, SpeakerSuggestions } = await import('../src/components/meeting-results.tsx');

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
  suggestion: null,
  ...over,
});
const view = (stage: 'draft' | 'published', summary: string) => ({ id: `r-${stage}`, feature: 'manual' as const, stage, summary, decisions: ['Giữ giá cũ'], tainted: false });

const READER = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
function render(results: Omit<Results, 'transcriptDraft' | 'transcriptUnread' | 'transcriptUnreadKey'> & { transcriptDraft?: number; transcriptUnread?: number; transcriptUnreadKey?: string }, summaryEnabled = false, template: 'general' | 'briefing' | 'customer' = 'general') {
  client.current.setQueryData(['meetings', 'results', 'get'], { transcriptDraft: 0, transcriptUnread: 0, transcriptUnreadKey: '', ...results });
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

  it('asks the recorder to read a machine transcript before sharing, names the lines in the notice, and keeps the share button off until it is read (#4899)', () => {
    const base = { meetingId: 'm1', isRecorder: true, draft: view('draft', 'Chốt báo giá'), published: null, items: [] };
    // Nothing unread: no notice, the button is on.
    const clean = render({ ...base, transcriptUnread: 0 });
    expect(clean).not.toContain('data-testid="vy-review"');
    // The model's summary is already read but 12 transcript lines are not: the notice names the transcript with its count, and says nothing of the summary.
    const lines = render({ ...base, transcriptUnread: 12 });
    expect(lines).toContain('data-testid="vy-review"');
    expect(lines).toContain(en.meetings.results.reviewNoteTranscript.replace('{count}', '12'));
    expect(lines).not.toContain(en.meetings.results.reviewNote);
    expect(lines).toContain(en.meetings.results.reviewed);
    expect(lines).toMatch(/<button[^>]*disabled[^>]*>\s*(?:<[^>]*>\s*)*Share/);
    // Both unread: both notes are there, one button.
    const both = render({ ...base, draft: { ...view('draft', 'Chốt báo giá'), tainted: true }, transcriptUnread: 3 });
    expect(both).toContain(en.meetings.results.reviewNote);
    expect(both).toContain(en.meetings.results.reviewNoteTranscript.replace('{count}', '3'));
    expect(both.match(/data-testid="vy-review"/g)).toHaveLength(1);
  });

  it('offers the share button when the only draft is transcript lines, with no summary and no item (#4899)', () => {
    const base = { meetingId: 'm1', isRecorder: true, draft: null, published: view('published', 'Đã chia sẻ'), items: [] };
    // No draft of any kind: nothing to share, no share button.
    expect(render({ ...base })).not.toContain(`>${en.meetings.results.publish}<`);
    // Typed (read) transcript lines only: the share button is on and the share note says the transcript goes too.
    const typed = render({ ...base, transcriptDraft: 5 });
    const typedButton = /<button[^>]*>Share with the attendees<\/button>/.exec(typed)?.[0] ?? '';
    expect(typedButton).not.toBe('');
    expect(typedButton).not.toContain('disabled=""');
    expect(typed).toContain(en.meetings.results.publishNote);
    expect(typed).not.toContain('data-testid="vy-review"');
    // A new machine transcription after the minutes were shared: the notice names the lines, the button waits for the review.
    const unread = render({ ...base, transcriptDraft: 5, transcriptUnread: 5, transcriptUnreadKey: 'k'.repeat(32) });
    expect(unread).toContain('data-testid="vy-review"');
    expect(unread).toContain(en.meetings.results.reviewNoteTranscript.replace('{count}', '5'));
    expect(unread).toMatch(/<button[^>]*disabled[^>]*>\s*(?:<[^>]*>\s*)*Share/);
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
    expect(html).toContain('id="meeting-decision-1"');
    expect(html).toContain('id="meeting-action-b"');
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

  it('says who a said name probably means and offers their seats, only for an item with no named attendee and only as a suggestion', () => {
    const quan = { userId: 'u9', name: 'Nguyễn Minh Quân', source: 'member' as const, positions: [{ id: 'p9', title: 'Kế toán' }] };
    const lan = { userId: 'u2', name: 'Lê Thị Lan', source: 'attendee' as const, positions: [] };
    const several = { userId: 'u3', name: 'Trần Văn Nam', source: 'attendee' as const, positions: [{ id: 'p1', title: 'A' }, { id: 'p2', title: 'B' }] };
    const open = (suggestion: ActionItemView['suggestion'], over: Partial<ActionItemView> = {}) =>
      render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'x'), items: [item('s', { who: 'Quân', suggestion, ...over })] });
    const member = open(quan);
    expect(member).toContain('data-testid="assignee-suggestion"');
    expect(member).toContain('Nguyễn Minh Quân');
    expect(member).toContain(en.meetings.results.suggestedBadge);
    expect(member).toContain(en.meetings.results.suggestedOneSeat);
    expect(member).not.toContain(en.meetings.results.severalSeats);
    // The suggestion is plain text: no id reaches the page as visible words.
    expect(member.replace(/<[^>]*>/g, ' ')).not.toContain('u9');
    expect(open(lan)).toContain(en.meetings.results.suggestedNoSeat);
    expect(open(several)).toContain(en.meetings.results.suggestedSeveralSeats);
    // A seat is preselected only when the suggested person holds exactly one; with none or several a person picks it.
    client.current.setQueryData(['chart', 'get'], { root: [], agents: [], killSwitches: [], positions: ['p9', 'p1', 'p2'].map((id) => ({ id, title: id, status: 'active' })) });
    expect(open(quan)).toContain('<option value="p9" selected="">');
    expect(open(lan)).toContain('<option value="" selected="">');
    expect(open(lan)).not.toContain('<option value="p9" selected="">');
    const picked = open(several);
    expect(picked).toContain('<option value="" selected="">');
    expect(picked).not.toMatch(/<option value="p\d" selected/);
    expect(open(null)).not.toContain('data-testid="assignee-suggestion"');
    // An item that already names an attendee shows no suggestion, even if one came along.
    expect(open(quan, { whoUserId: 'u1' })).not.toContain('data-testid="assignee-suggestion"');
  });

  it('offers "ask Vy who this is" only for an item code could not place, and only while Vy may be asked (AI off: the plain pick-a-seat flow, no button)', () => {
    const open = (status: { enabled: boolean } | null, over: Partial<ActionItemView> = {}) => {
      if (status) client.current.setQueryData(['meetings', 'assignee', 'status'], { ...status, reason: status.enabled ? null : 'off', estimate: null });
      else client.current.removeQueries({ queryKey: ['meetings', 'assignee', 'status'] });
      return render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'x'), items: [item('v', { who: 'Tí bên kho', ...over })] });
    };
    const found = { userId: 'u9', name: 'Nguyễn Minh Quân', source: 'member' as const, positions: [] };
    expect(open({ enabled: true })).toContain('data-testid="assignee-ask-button"');
    expect(open({ enabled: true })).toContain(en.meetings.results.askVy);
    // AI off, a pause, or no answer yet: no button and no message about it.
    expect(open({ enabled: false })).not.toContain('assignee-ask');
    expect(open(null)).not.toContain('assignee-ask');
    // Code found a person, the item names an attendee, or there is no said name: nothing to ask.
    expect(open({ enabled: true }, { suggestion: found })).not.toContain('assignee-ask');
    expect(open({ enabled: true }, { whoUserId: 'u1' })).not.toContain('assignee-ask');
    expect(open({ enabled: true }, { who: '  ' })).not.toContain('assignee-ask');
    // Still the plain flow: the seat is picked by a person.
    expect(open({ enabled: true })).toContain(en.meetings.results.makeTask);
  });

  it('shows no task form for an item that already has its task, and nothing at all to a reader with nothing shared', () => {
    const html = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'x'), items: [item('e', { status: 'accepted', taskId: 't1' })] });
    expect(html).toContain(en.meetings.results.accepted);
    expect(html).not.toContain(en.meetings.results.makeTask);
    expect(render({ meetingId: 'm1', isRecorder: false, draft: null, published: null, items: [] })).toBe('');
  });

  it('shows the Vy summary box to the recorder only when the system lets Vy summarize', () => {
    const results: Results = { meetingId: 'm1', isRecorder: true, draft: null, published: null, items: [], transcriptDraft: 0, transcriptUnread: 0, transcriptUnreadKey: '' };
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

  it('stops the recorder from saving a section longer than 1200 characters, as text reflowed from a long free summary can be, and says why', () => {
    const long = 'a'.repeat(1300);
    const html = render({ meetingId: 'm1', isRecorder: true, draft: view('draft', long), published: null, items: [] }, false, 'customer');
    expect(html).toContain(en.meetings.templates.tooLong);
    expect(/<button[^>]*>(?:(?!<\/button>).)*Save draft<\/button>/.exec(html)?.[0]).toMatch(/\sdisabled(=|\s|>)/);
  });

  it('puts text that is not in the template\'s form into the first section and says so, and shows a shared one whole', () => {
    const recorder = render({ meetingId: 'm1', isRecorder: true, draft: view('draft', 'Một đoạn viết trước khi đổi loại'), published: null, items: [] }, false, 'customer');
    expect(recorder).toContain('Một đoạn viết trước khi đổi loại');
    expect(recorder).toContain(en.meetings.templates.reflow.replace(/'/g, '&#x27;'));
    const reader = render({ meetingId: 'm1', isRecorder: false, draft: null, published: view('published', 'Một đoạn viết trước khi đổi loại'), items: [] }, false, 'customer');
    expect(reader).toContain('Một đoạn viết trước khi đổi loại');
  });
});


// Speaker names suggested by the recorder's Vy (#3502): each suggestion is a line with the moment it rests on and a click of the recorder's own; with none, nothing is drawn.
describe('speaker suggestions', () => {
  const draw = (suggestions: Array<{ label: string; name: string; seconds: number }>) => {
    client.current.setQueryData(['meetings', 'results', 'speakerSuggestions'], { meetingId: 'm1', runId: 'r1', suggestions });
    return renderToStaticMarkup(
      <QueryClientProvider client={client.current}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <SpeakerSuggestions meetingId="m1" runId="r1" />
        </IntlProvider>
      </QueryClientProvider>,
    );
  };

  it('shows each suggestion with the time of the line it rests on and a button, and says nothing is renamed without the click', () => {
    const html = draw([
      { label: 'Người nói 2', name: 'Trần Thị Lan', seconds: 125 },
      { label: 'Người nói 1', name: 'Hoàng Văn Ghi', seconds: 5 },
    ]);
    expect(html).toContain('data-testid="speaker-suggestions"');
    expect(html).toContain(en.meetings.results.vy.speakers.title);
    expect(html).toContain(en.meetings.results.vy.speakers.hint);
    expect(html).toContain('Người nói 2 may be Trần Thị Lan (heard at 2:05)');
    expect(html).toContain('Người nói 1 may be Hoàng Văn Ghi (heard at 0:05)');
    expect(html.match(new RegExp(`>${en.meetings.results.vy.speakers.apply}<`, 'g'))).toHaveLength(2);
  });

  it('draws nothing when there is no suggestion', () => {
    expect(draw([])).toBe('');
  });
});
