// SPDX-License-Identifier: AGPL-3.0-only
// "Còn bỏ ngỏ" on a meeting's page (#4768), rendered on the server with no network: with no status answer (AI off, not the recorder, no transcript) there is no card and no word about it; the answer shows the questions
// and the decisions as plain text (markup in a line stays text), each with the time of its transcript line as a way to open it there, "no suggestion" and the fixed words of a failure, in Vietnamese and English.
// The one write on the card is the recorder's own "add to my notes" on a line; nothing publishes or makes a task.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { OpenPointsAnswer } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { appendNoteLine, noteLineFor } from '../src/lib/series-notes.ts';

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

const { MeetingOpenPoints, OpenPointsResult, openPointsRunCodeOf } = await import('../src/components/meeting-open-points.tsx');

const wrap = (node: React.ReactNode, locale: 'en' | 'vi' = 'vi') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const gate = (enabled: boolean | null, props: { isRecorder: boolean; hasTranscript: boolean }, locale: 'en' | 'vi' = 'vi') => {
  client.current.clear();
  if (enabled !== null) client.current.setQueryData(['meetings', 'openPoints', 'status'], { meetingId: 'm1', enabled, reason: enabled ? null : 'off' });
  return wrap(<MeetingOpenPoints meetingId="m1" onJump={() => undefined} {...props} />, locale);
};
const answer = (over: Partial<OpenPointsAnswer>): OpenPointsAnswer => ({ state: 'listed', errorCode: null, questions: [], decisions: [], dropped: 0, ...over });
const result = (a: OpenPointsAnswer, locale: 'en' | 'vi' = 'vi') => wrap(<OpenPointsResult answer={a} meetingId="m1" onJump={() => undefined} />, locale);

describe('who sees the card', () => {
  it('shows the card to the recorder of a meeting with a transcript when AI is on, in both languages', () => {
    const props = { isRecorder: true, hasTranscript: true };
    expect(gate(true, props)).toContain('Còn bỏ ngỏ');
    expect(gate(true, props)).toContain('Liệt kê những gì còn bỏ ngỏ');
    expect(gate(true, props, 'en')).toContain('Left open');
    expect(gate(true, props)).toContain('data-testid="open-points-run"');
  });
  it('shows nothing when AI is off, to a reader, with no transcript, or before the status is known', () => {
    expect(gate(false, { isRecorder: true, hasTranscript: true })).toBe('');
    expect(gate(true, { isRecorder: false, hasTranscript: true })).toBe('');
    expect(gate(true, { isRecorder: true, hasTranscript: false })).toBe('');
    expect(gate(null, { isRecorder: true, hasTranscript: true })).toBe('');
  });
});

describe('the answer', () => {
  const QUESTIONS = [{ text: 'Ai gửi <i>báo giá</i> cho khách A?', seconds: 20 }, { text: 'Họp lại lúc nào?', seconds: 3725 }];
  const DECISIONS = [{ text: 'Có giảm giá cho khách A hay không.', seconds: 65 }];
  it('lists the questions and the decisions as plain text, each with the time of its transcript line as a way to open it', () => {
    const html = result(answer({ questions: QUESTIONS, decisions: DECISIONS, dropped: 2 }));
    expect([...html.matchAll(/data-testid="open-points-line"/g)]).toHaveLength(3);
    expect([...html.matchAll(/data-testid="open-points-jump"/g)]).toHaveLength(3);
    expect(html).toContain('data-testid="open-points-questions"');
    expect(html).toContain('data-testid="open-points-decisions"');
    expect(html).toContain('Câu hỏi chưa thấy trả lời');
    expect(html).toContain('Việc nêu ra nhưng chưa quyết');
    expect(html).toContain('0:20');
    expect(html).toContain('1:02:05');
    // Markup in a line stays text.
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;i&gt;báo giá&lt;/i&gt;');
    expect(html).toContain('Đã bỏ 2 dòng');
    expect(html).toContain('không được lưu');
  });
  it('leaves out the heading of a list that is empty', () => {
    const html = result(answer({ questions: QUESTIONS }));
    expect(html).toContain('data-testid="open-points-questions"');
    expect(html).not.toContain('data-testid="open-points-decisions"');
  });
  it('names each time button by what it does and keeps the visible time in the name, at a size a finger can hit (WCAG 2.5.3, 2.5.8)', () => {
    const html = result(answer({ questions: QUESTIONS, decisions: DECISIONS }), 'en');
    const buttons = [...html.matchAll(/<button[^>]*data-testid="open-points-jump"[^>]*>([^<]*)<\/button>/g)];
    expect(buttons).toHaveLength(3);
    for (const [tag, time] of buttons) {
      expect(tag).toContain(`aria-label="Open the transcript at ${time}"`);
      expect(tag).toContain('min-h-6');
      expect(tag).toContain('max-md:min-h-11');
    }
  });
  it('offers one write only, the recorder\'s own "add to my notes", on each line, and nothing that publishes or makes a task', () => {
    const html = result(answer({ questions: QUESTIONS, decisions: DECISIONS }), 'en');
    const buttons = [...html.matchAll(/<button[^>]*data-testid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(buttons)).toEqual(new Set(['open-points-jump', 'open-points-carry']));
    expect([...html.matchAll(/data-testid="open-points-carry"/g)]).toHaveLength(3);
    expect(html).toContain('Add to my notes');
  });
  it('has the words that announce how many questions and decisions came, in both languages', () => {
    expect(en.meetings.openPoints.found).toContain('plural');
    expect(viMessages.meetings.openPoints.found).toBe('{questions, plural, other {# câu hỏi}} và {decisions, plural, other {# việc cần quyết}}');
  });
  it('says "no suggestion" for an empty answer, in both languages', () => {
    expect(result(answer({ state: 'none' }))).toContain('chưa có gợi ý');
    expect(result(answer({ state: 'none' }), 'en')).toContain('No suggestion this time');
  });
  it('words a failure by its fixed code, and any other code in general words', () => {
    expect(result(answer({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED' }))).toContain('Ngân sách AI');
    expect(result(answer({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED' }), 'en')).toContain('The AI budget for this period is used up.');
    expect(result(answer({ state: 'failed', errorCode: 'SOMETHING_ELSE' }), 'en')).toContain('Try again in a few minutes');
    expect(openPointsRunCodeOf(null)).toBe('default');
    expect(openPointsRunCodeOf('OPEN_POINTS_TIMEOUT')).toBe('OPEN_POINTS_TIMEOUT');
  });
});

describe('the line a point becomes in the notes', () => {
  it('is one plain line with its time, added once at the end and never cut', () => {
    const line = noteLineFor(en.meetings.openPoints.note.question.replace('{text}', 'Ai gửi báo giá?'), '0:20');
    expect(line).toBe('- Not answered: Ai gửi báo giá? (0:20)');
    expect(appendNoteLine('Ghi chú của tôi', line)).toBe(`Ghi chú của tôi\n${line}`);
    expect(appendNoteLine(`a\n${line}`, line)).toBe(`a\n${line}`);
    expect(appendNoteLine('x'.repeat(5990), line)).toBeNull();
  });
});
