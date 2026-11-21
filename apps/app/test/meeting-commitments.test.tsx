// SPDX-License-Identifier: AGPL-3.0-only
// "Ai cam kết làm gì" on a meeting's page (#3954), rendered on the server with no network: with no status answer (AI off, not the recorder, no transcript) there is no card and no word about it; the answer shows
// the lines grouped by speaker as plain text (markup in a line stays text), each with the time of its transcript line as a way to open it there, "no suggestion" and the fixed words of a failure, in Vietnamese
// and English. Nothing on the card saves, shares or makes a task.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { CommitmentsAnswer } from '@crove/kernel-contract';
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

const { MeetingCommitments, CommitmentsResult, commitmentsRunCodeOf } = await import('../src/components/meeting-commitments.tsx');

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
  if (enabled !== null) client.current.setQueryData(['meetings', 'commitments', 'status'], { meetingId: 'm1', enabled, reason: enabled ? null : 'off' });
  return wrap(<MeetingCommitments meetingId="m1" onJump={() => undefined} {...props} />, locale);
};
const answer = (over: Partial<CommitmentsAnswer>): CommitmentsAnswer => ({ state: 'listed', errorCode: null, speakers: [], dropped: 0, ...over });
const result = (a: CommitmentsAnswer, locale: 'en' | 'vi' = 'vi') => wrap(<CommitmentsResult answer={a} onJump={() => undefined} />, locale);

describe('who sees the card', () => {
  it('shows the card to the recorder of a meeting with a transcript when AI is on, in both languages', () => {
    const props = { isRecorder: true, hasTranscript: true };
    expect(gate(true, props)).toContain('Ai cam kết làm gì');
    expect(gate(true, props)).toContain('Liệt kê cam kết');
    expect(gate(true, props, 'en')).toContain('Who committed to what');
    expect(gate(true, props)).toContain('data-testid="commitments-run"');
  });
  it('shows nothing when AI is off, to a reader, with no transcript, or before the status is known', () => {
    expect(gate(false, { isRecorder: true, hasTranscript: true })).toBe('');
    expect(gate(true, { isRecorder: false, hasTranscript: true })).toBe('');
    expect(gate(true, { isRecorder: true, hasTranscript: false })).toBe('');
    expect(gate(null, { isRecorder: true, hasTranscript: true })).toBe('');
  });
});

describe('the answer', () => {
  const SPEAKERS = [
    { label: 'Lan', lines: [{ kind: 'decision' as const, text: 'Giữ giá cũ.', seconds: 65 }] },
    { label: '<b>Nam</b>', lines: [{ kind: 'commitment' as const, text: 'Gửi <i>báo giá</i> trước thứ sáu.', seconds: 3725 }, { kind: 'commitment' as const, text: 'Báo lại khách.', seconds: 90 }] },
  ];
  it('groups the lines by speaker as plain text, each with the time of its transcript line as a way to open it', () => {
    const html = result(answer({ speakers: SPEAKERS, dropped: 2 }));
    expect([...html.matchAll(/data-testid="commitments-speaker"/g)]).toHaveLength(2);
    expect([...html.matchAll(/data-testid="commitments-line"/g)]).toHaveLength(3);
    expect([...html.matchAll(/data-testid="commitments-jump"/g)]).toHaveLength(3);
    expect(html).toContain('1:05');
    expect(html).toContain('1:02:05');
    expect(html).toContain('Sẽ làm');
    expect(html).toContain('Đã quyết');
    // Markup in a speaker label or a line stays text.
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;b&gt;Nam&lt;/b&gt;');
    expect(html).toContain('Đã bỏ 2 dòng');
    expect(html).toContain('không được lưu');
  });
  it('names each time button by what it does and keeps the visible time in the name, at a size a finger can hit (WCAG 2.5.3, 2.5.8; #4055)', () => {
    const html = result(answer({ speakers: SPEAKERS }), 'en');
    const buttons = [...html.matchAll(/<button[^>]*data-testid="commitments-jump"[^>]*>([^<]*)<\/button>/g)];
    expect(buttons).toHaveLength(3);
    for (const [tag, time] of buttons) {
      expect(tag).toContain(`aria-label="Open the transcript at ${time}"`);
      expect(tag).toContain('min-h-6');
      expect(tag).toContain('max-md:min-h-11');
    }
  });
  it('has the words that announce how many lines came for how many people, in both languages', () => {
    expect(en.meetings.commitments.found).toContain('plural');
    expect(viMessages.meetings.commitments.found).toBe('{lines, plural, other {# dòng}} của {speakers, plural, other {# người}}');
  });
  it('has nothing on it that saves, shares or makes a task: the only buttons open the transcript', () => {
    const html = result(answer({ speakers: SPEAKERS }), 'en');
    const buttons = [...html.matchAll(/<button[^>]*data-testid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(buttons)).toEqual(new Set(['commitments-jump']));
    expect(html).toContain('Will do');
    expect(html).toContain('Decided');
  });
  it('says "no suggestion" for an empty answer, in both languages', () => {
    expect(result(answer({ state: 'none' }))).toContain('chưa có gợi ý');
    expect(result(answer({ state: 'none' }), 'en')).toContain('No suggestion this time');
  });
  it('words a failure by its fixed code, and any other code in general words', () => {
    expect(result(answer({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED' }))).toContain('Ngân sách AI');
    expect(result(answer({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED' }), 'en')).toContain('The AI budget for this period is used up.');
    expect(result(answer({ state: 'failed', errorCode: 'SOMETHING_ELSE' }), 'en')).toContain('Try again in a few minutes');
    expect(commitmentsRunCodeOf(null)).toBe('default');
    expect(commitmentsRunCodeOf('COMMITMENTS_TIMEOUT')).toBe('COMMITMENTS_TIMEOUT');
  });
});
