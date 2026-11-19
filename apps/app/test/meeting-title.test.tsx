// SPDX-License-Identifier: AGPL-3.0-only
// "Gợi ý tên" on a meeting's page (#3947), rendered on the server with no network: with no status answer (AI off, not the recorder, no transcript) there is no button and no word about it; the answer
// shows the candidates as plain text (markup in a title stays text), each with its own pick, a way to pick none, "no suggestion" and the fixed words of a failure, in Vietnamese and English.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { TitleAnswer } from '@crove/kernel-contract';
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

const { MeetingTitleSuggest, TitleResult, titleRunCodeOf } = await import('../src/components/meeting-title.tsx');

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
  if (enabled !== null) client.current.setQueryData(['meetings', 'title', 'status'], { meetingId: 'm1', enabled, reason: enabled ? null : 'off' });
  return wrap(<MeetingTitleSuggest meetingId="m1" {...props} />, locale);
};
const answer = (over: Partial<TitleAnswer>): TitleAnswer => ({ state: 'suggested', errorCode: null, titles: [], dropped: 0, ...over });
const result = (a: TitleAnswer, locale: 'en' | 'vi' = 'vi', picking: string | null = null) => wrap(<TitleResult answer={a} picking={picking} onPick={() => undefined} onDismiss={() => undefined} />, locale);

describe('who sees the button', () => {
  it('shows "Gợi ý tên" to the recorder of a meeting with a transcript when AI is on, and "Suggest a title" in English', () => {
    const props = { isRecorder: true, hasTranscript: true };
    expect(gate(true, props)).toContain('Gợi ý tên');
    expect(gate(true, props, 'en')).toContain('Suggest a title');
    expect(gate(true, props)).toContain('data-testid="title-suggest-run"');
  });
  it('shows nothing when AI is off, to a reader, with no transcript, or before the status is known', () => {
    expect(gate(false, { isRecorder: true, hasTranscript: true })).toBe('');
    expect(gate(true, { isRecorder: false, hasTranscript: true })).toBe('');
    expect(gate(true, { isRecorder: true, hasTranscript: false })).toBe('');
    expect(gate(null, { isRecorder: true, hasTranscript: true })).toBe('');
  });
});

describe('the answer', () => {
  it('lists each candidate as plain text with its own pick, and a way to pick none', () => {
    const html = result(answer({ titles: ['Chốt báo giá tháng 12', '<b>Họp</b> giao hàng'], dropped: 1 }));
    expect([...html.matchAll(/data-testid="title-candidate"/g)]).toHaveLength(2);
    expect([...html.matchAll(/data-testid="title-pick"/g)]).toHaveLength(2);
    expect(html).toContain('Dùng tên này');
    expect(html).toContain('data-testid="title-dismiss"');
    expect(html).toContain('Chốt báo giá tháng 12');
    // Markup in a candidate stays text.
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;Họp&lt;/b&gt; giao hàng');
    expect(html).toContain('Đã bỏ 1 gợi ý');
  });
  it('locks the picks while one is being applied', () => {
    const html = result(answer({ titles: ['A title', 'Another title'] }), 'en', 'A title');
    expect([...html.matchAll(/disabled/g)].length).toBeGreaterThanOrEqual(3);
  });
  it('says "no suggestion" for an empty answer, in both languages', () => {
    expect(result(answer({ state: 'none' }))).toContain('chưa có gợi ý');
    expect(result(answer({ state: 'none' }), 'en')).toContain('No suggestion this time');
  });
  it('words a failure by its fixed code, and any other code in general words', () => {
    expect(result(answer({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED' }))).toContain('Ngân sách AI');
    expect(result(answer({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED' }), 'en')).toContain('The AI budget for this period is used up.');
    expect(result(answer({ state: 'failed', errorCode: 'SOMETHING_ELSE' }), 'en')).toContain('Try again in a few minutes');
    expect(titleRunCodeOf(null)).toBe('default');
    expect(titleRunCodeOf('TITLE_TIMEOUT')).toBe('TITLE_TIMEOUT');
  });
});
