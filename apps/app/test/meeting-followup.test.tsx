// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up email dialog of a meeting (L3, #2590): the recorder of a meeting with a shared summary gets the button, nobody else does; the draft shows the shared facts and
// the fixed words, the suggested recipients (those who already got it marked, unticked), the sends left, and a send that waits for the recorder's click. Rendered on the server.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { FollowupDraft, FollowupNoteStatus, FollowupStyle, MeetingResults as Results } from '@ludy/kernel-contract';
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

const { FollowupForm, stageAfterLoadError } = await import('../src/components/meeting-followup.tsx');
const { MeetingResults } = await import('../src/components/meeting-results.tsx');

const DRAFT: FollowupDraft = {
  meetingId: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b',
  lang: 'vi',
  org: 'Công ty Tiên Phong',
  factsKey: 'k',
  facts: { summary: 'Chốt báo giá tuần này.', decisions: ['Giữ giá cũ'], items: [{ title: 'Gửi báo giá', who: 'An', when: 'thứ sáu' }] },
  words: { subject: 'Tóm tắt cuộc họp 12/11/2026', greeting: 'Xin chào,', lead: 'Cảm ơn mọi người.', closing: 'Cảm ơn.' },
  recipients: [
    { kind: 'attendee', id: 'u1', name: 'Chị Lan', email: 'lan@example.test', alreadySent: false },
    { kind: 'party', id: 'p1', name: 'Công ty Khách', email: 'khach@example.test', alreadySent: true },
  ],
  sendsLeft: 2,
};

function form(
  draft: FollowupDraft,
  locale: 'en' | 'vi' = 'en',
  opts: { initialStyle?: FollowupStyle; noteStatus?: FollowupNoteStatus | null } = {},
) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <FollowupForm
          draft={draft}
          initialStyle={opts.initialStyle ?? 'structured'}
          noteStatus={opts.noteStatus ?? null}
          onStageChange={() => {}}
          onSent={() => {}}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('FollowupForm', () => {
  it('shows the shared facts, the fixed words, the recipients and the sends left, and says nothing is sent before the click', () => {
    const html = form(DRAFT);
    expect(html).toContain(en.meetings.followup.note);
    expect(html).toContain('Chốt báo giá tuần này.');
    expect(html).toContain('Giữ giá cũ');
    expect(html).toContain('Gửi báo giá');
    expect(html).toContain('Tóm tắt cuộc họp 12/11/2026');
    expect(html).toContain('Chị Lan');
    expect(html).toContain('lan@example.test');
    // The contact who already got it is marked and not ticked, so the send is to one person and asks no repeat tick yet.
    expect(html).toContain(en.meetings.followup.alreadySent);
    expect(html).toContain('Send to 1');
    expect(html).toContain('2 sends left');
    expect(html).not.toContain(en.meetings.followup.reviewed);
    expect(html).toContain('data-testid="followup-wording"');
  });

  it('keeps the send closed when the meeting has no sends left, and says so', () => {
    const html = form({ ...DRAFT, sendsLeft: 0 });
    expect(html).toContain(en.meetings.followup.limitReached);
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="followup-send"|<button[^>]*data-testid="followup-send"[^>]*disabled/);
  });

  it('shows unpublished draft notice and confirmation checkbox for draft stage, and stage switcher when both exist', () => {
    const html = form({ ...DRAFT, stage: 'draft', hasPublished: false, hasDraft: true, recipients: [] });
    expect(html).toContain('data-testid="followup-unpublished-notice"');
    expect(html).toContain('data-testid="followup-confirm-unpublished"');
    expect(html).toContain(en.meetings.followup.confirmUnpublished);
    expect(html).toContain(en.meetings.followup.noRecipientsDraft);
    expect(html).not.toContain('data-testid="followup-stage-switch"');
    // Send stays disabled until unpublished confirmation and recipients are provided.
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="followup-send"|<button[^>]*data-testid="followup-send"[^>]*disabled/);

    const bothHtml = form({ ...DRAFT, stage: 'published', hasPublished: true, hasDraft: true });
    expect(bothHtml).toContain('data-testid="followup-stage-switch"');
    expect(bothHtml).toContain('data-testid="followup-stage-published"');
    expect(bothHtml).toContain('data-testid="followup-stage-draft"');
    expect(bothHtml).not.toContain('data-testid="followup-unpublished-notice"');
  });

  it('supports personal_note style with editable textarea even when AI is off, disabled reason when budget spent, and click-only Vy button when enabled', () => {
    const offHtml = form(DRAFT, 'en', {
      initialStyle: 'personal_note',
      noteStatus: { meetingId: DRAFT.meetingId, enabled: false, reason: 'off' },
    });
    expect(offHtml).toContain('data-testid="followup-note-body"');
    expect(offHtml).toContain('data-testid="followup-note-ai-off"');
    expect(offHtml).not.toContain('data-testid="followup-note-generate"');

    const budgetHtml = form(DRAFT, 'en', {
      initialStyle: 'personal_note',
      noteStatus: { meetingId: DRAFT.meetingId, enabled: false, reason: 'budget' },
    });
    expect(budgetHtml).toContain('data-testid="followup-note-generate"');
    expect(budgetHtml).toContain('data-testid="followup-note-disabled-reason"');
    expect(budgetHtml).toContain(en.meetings.followup.noteAiStatus.budget);
    expect(budgetHtml).toMatch(/<button[^>]*disabled[^>]*data-testid="followup-note-generate"|<button[^>]*data-testid="followup-note-generate"[^>]*disabled/);

    const enabledHtml = form(DRAFT, 'vi', {
      initialStyle: 'personal_note',
      noteStatus: { meetingId: DRAFT.meetingId, enabled: true, reason: null },
    });
    expect(enabledHtml).toContain(viMessages.meetings.followup.noteButton);
    expect(enabledHtml).toContain('data-testid="followup-note-body"');
    expect(enabledHtml).not.toContain('data-testid="followup-review"');
  });

  it('is in Vietnamese when asked, and both languages carry every key of the dialog', () => {
    expect(form(DRAFT, 'vi')).toContain(viMessages.meetings.followup.note);
    expect(Object.keys(en.meetings.followup).sort()).toEqual(Object.keys(viMessages.meetings.followup).sort());
    expect(Object.keys(en.meetings.followup.wording).sort()).toEqual(Object.keys(viMessages.meetings.followup.wording).sort());
    expect(Object.keys(en.meetings.followup.noteAiStatus).sort()).toEqual(Object.keys(viMessages.meetings.followup.noteAiStatus).sort());
    expect(Object.keys(en.meetings.followup.noteState).sort()).toEqual(Object.keys(viMessages.meetings.followup.noteState).sort());
  });
});

describe('the stage the dialog asks for after a failed load (#4479)', () => {
  it('falls back to the default stage when the chosen draft is gone (published in another tab), and keeps every other choice and error', () => {
    const gone = { code: 'NO_DRAFT_SUMMARY' };
    expect(stageAfterLoadError('draft', gone)).toBeUndefined();
    expect(stageAfterLoadError('published', gone)).toBe('published');
    expect(stageAfterLoadError(undefined, gone)).toBeUndefined();
    expect(stageAfterLoadError('draft', { code: 'FORBIDDEN' })).toBe('draft');
    expect(stageAfterLoadError('draft', new Error('network'))).toBe('draft');
    expect(stageAfterLoadError('draft', null)).toBe('draft');
  });
});

describe('the button on the meeting page', () => {
  const published = { id: 'r', feature: 'manual' as const, stage: 'published' as const, summary: 'Chốt báo giá.', decisions: [], tainted: false };
  const render = (results: Results) => {
    client.current.setQueryData(['meetings', 'results', 'get'], results);
    client.current.setQueryData(['meetings', 'results', 'summaryStatus'], { meetingId: 'm1', enabled: false });
    client.current.setQueryData(['org', 'get'], { members: [] });
    return renderToStaticMarkup(
      <QueryClientProvider client={client.current}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <MeetingResults meetingId="m1" readers={[]} />
        </IntlProvider>
      </QueryClientProvider>,
    );
  };
  it('is the recorder\'s alone, works for published or reviewed/manual unpublished draft, and stays hidden for unreviewed tainted draft', () => {
    expect(render({ meetingId: 'm1', transcriptUnread: 0, isRecorder: true, draft: null, published, items: [] })).toContain(en.meetings.followup.open);
    expect(render({ meetingId: 'm1', transcriptUnread: 0, isRecorder: false, draft: null, published, items: [] })).not.toContain(en.meetings.followup.open);
    expect(render({ meetingId: 'm1', transcriptUnread: 0, isRecorder: true, draft: { ...published, stage: 'draft', tainted: false }, published: null, items: [] })).toContain(en.meetings.followup.open);
    expect(render({ meetingId: 'm1', transcriptUnread: 0, isRecorder: true, draft: { ...published, stage: 'draft', tainted: true }, published: null, items: [] })).not.toContain(en.meetings.followup.open);
  });
});
