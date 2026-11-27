// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'use-intl';
import type { NotesMinutesAnswer, NotesMinutesStatus } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import {
  MeetingNotesMinutes,
  NotesMinutesBody,
  buildApplySummaryPayload,
  notesMinutesRunCodeOf,
} from '../src/components/meeting-notes-minutes.tsx';

const client: { current: QueryClient } = { current: new QueryClient() };

vi.mock('../src/lib/api.ts', async () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_target, prop) => {
        if (prop === 'queryKey' || prop === 'key') return () => path;
        if (prop === 'queryOptions') return (opts: { input?: unknown } = {}) => ({ queryKey: [...path, opts.input], queryFn: () => null });
        if (prop === 'call') return async () => null;
        return node([...path, String(prop)]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});

const escaped = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MEETING_ID = '11111111-1111-4111-8111-111111111111';

function renderBody(
  props: Partial<Parameters<typeof NotesMinutesBody>[0]> & { status: NotesMinutesStatus },
  locale: 'vi' | 'en' = 'vi',
): string {
  const qc = new QueryClient();
  client.current = qc;
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={locale === 'vi' ? viMessages : en}>
      <QueryClientProvider client={qc}>
        <NotesMinutesBody
          meetingId={MEETING_ID}
          answer={undefined}
          running={false}
          writeError={null}
          applying={false}
          applied={false}
          applyError={null}
          onRun={() => {}}
          onApply={() => {}}
          {...props}
        />
      </QueryClientProvider>
    </IntlProvider>,
  );
}

describe('MeetingNotesMinutes (#5129)', () => {
  it('hides itself for non-recorders, recorded meetings with transcripts, and when Vy is off', () => {
    for (const reason of ['not_recorder', 'has_transcript', 'off'] as const) {
      const qc = new QueryClient();
      client.current = qc;
      qc.setQueryData(['meetings', 'notesMinutes', 'status', { meetingId: MEETING_ID }], {
        meetingId: MEETING_ID,
        available: false,
        reason,
        estimate: null,
      } satisfies NotesMinutesStatus);
      const html = renderToStaticMarkup(
        <IntlProvider locale="vi" messages={viMessages}>
          <QueryClientProvider client={qc}>
            <MeetingNotesMinutes meetingId={MEETING_ID} template="general" />
          </QueryClientProvider>
        </IntlProvider>,
      );
      expect(html, `reason ${reason}`).toBe('');
    }
  });

  it('shows blocked notes/redacted/forbidden/paused/budget messages without action button', () => {
    const cases: Array<[NotesMinutesStatus['reason'], string, 'vi' | 'en']> = [
      ['no_notes', viMessages.meetings.notesMinutes.blockedNoNotes, 'vi'],
      ['redacted', viMessages.meetings.notesMinutes.blockedRedacted, 'vi'],
      ['forbidden', en.meetings.notesMinutes.blockedForbidden, 'en'],
      ['paused', en.meetings.notesMinutes.blockedPaused, 'en'],
      ['budget', en.meetings.notesMinutes.blockedBudget, 'en'],
    ];
    for (const [reason, message, locale] of cases) {
      const html = renderBody(
        {
          status: {
            meetingId: MEETING_ID,
            available: false,
            reason,
            estimate: null,
          },
        },
        locale,
      );
      expect(html).toContain(escaped(message));
      expect(html).not.toContain(escaped((locale === 'vi' ? viMessages : en).meetings.notesMinutes.button));
    }
  });

  it('renders available CTA, cited drafted preview, dropped count, empty/failed states, and applied status', () => {
    const readyStatus: NotesMinutesStatus = {
      meetingId: MEETING_ID,
      available: true,
      reason: null,
      estimate: { inputTokens: 1800, outputTokens: 600, cost: null },
    };
    const readyHtml = renderBody({ status: readyStatus });
    expect(readyHtml).toContain(escaped(viMessages.meetings.notesMinutes.button));
    expect(readyHtml).toContain('2400');

    const drafted: NotesMinutesAnswer = {
      state: 'drafted',
      errorCode: null,
      summary: 'Chot ngan sach 15.000.000 đ cho quy 4.',
      decisions: [{ text: 'Duyet goi 15.000.000 đ.', noteLine: 1 }],
      items: [{ title: 'Gui bao gia cho khach', who: 'Lan', when: 'thu Sau', noteLine: 2 }],
      dropped: 2,
    };
    const draftedHtml = renderBody({ status: readyStatus, answer: drafted, applied: true });
    expect(draftedHtml).toContain(escaped(viMessages.meetings.notesMinutes.fromVy));
    expect(draftedHtml).toContain('Chot ngan sach 15.000.000 đ cho quy 4.');
    expect(draftedHtml).toContain('Dòng ghi chú #1');
    expect(draftedHtml).toContain('Dòng ghi chú #2');
    expect(draftedHtml).toContain(escaped(viMessages.meetings.notesMinutes.applyButton));
    expect(draftedHtml).toContain(escaped(viMessages.meetings.notesMinutes.applied));

    const emptyHtml = renderBody({
      status: readyStatus,
      answer: { state: 'none', errorCode: null, summary: '', decisions: [], items: [], dropped: 0 },
    });
    expect(emptyHtml).toContain(escaped(viMessages.meetings.notesMinutes.empty));

    const failedHtml = renderBody({
      status: readyStatus,
      answer: { state: 'failed', errorCode: 'NOTES_MINUTES_UNPARSABLE', summary: '', decisions: [], items: [], dropped: 0 },
    });
    expect(failedHtml).toContain(escaped(viMessages.meetings.notesMinutes.codes.NOTES_MINUTES_UNPARSABLE));
    expect(notesMinutesRunCodeOf('UNKNOWN_CODE')).toBe('default');
  });

  it('adapts summary payload cleanly for general and sectioned templates without losing decisions', () => {
    const answer: NotesMinutesAnswer = {
      state: 'drafted',
      errorCode: null,
      summary: '',
      decisions: [{ text: 'Chot gia ban Q4', noteLine: 1 }],
      items: [],
      dropped: 0,
    };
    expect(buildApplySummaryPayload(MEETING_ID, answer, 'general', null)).toEqual({
      meetingId: MEETING_ID,
      summary: 'Chot gia ban Q4',
      decisions: ['Chot gia ban Q4'],
    });
    expect(buildApplySummaryPayload(MEETING_ID, answer, 'customer', null)).toMatchObject({
      meetingId: MEETING_ID,
      decisions: ['Chot gia ban Q4'],
      sections: [
        { key: 'needs', text: 'Chot gia ban Q4' },
        { key: 'discussed', text: '' },
        { key: 'feedback', text: '' },
        { key: 'next_steps', text: '' },
      ],
    });
    expect(buildApplySummaryPayload(MEETING_ID, { ...answer, decisions: [] }, 'general', null)).toBeNull();
  });
});
