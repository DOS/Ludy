// SPDX-License-Identifier: AGPL-3.0-only
// "Gợi ý nhãn" on a meeting's page (#5010), rendered on the server with no network: no button for a reader, with AI off, before the status is known or once the meeting has five labels; the answer shows each suggestion as a
// chip of plain text (markup in a suggestion stays text, never an element or a link), a real button of at least 44 px with a name that says what it does; a click runs the existing label add and reads the labels again.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { LabelSuggestAnswer } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const api = vi.hoisted(() => ({ client: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as Array<{ path: string[]; input: unknown }> }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  api.client = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        if (prop === 'call') return async (input: unknown) => void api.calls.push({ path, input });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: api.client, errorMessage: String };
});

const { MeetingLabelSuggest, LabelSuggestResult, addSuggestedLabel, labelChips } = await import('../src/components/meeting-label-suggest.tsx');

const wrap = (node: React.ReactNode, locale: 'en' | 'vi' = 'vi') =>
  renderToStaticMarkup(
    <QueryClientProvider client={api.client}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const gate = (enabled: boolean | null, labels: string[] | null, props: { isRecorder: boolean }, locale: 'en' | 'vi' = 'vi') => {
  api.client.clear();
  if (enabled !== null) api.client.setQueryData(['meetings', 'label', 'suggestStatus'], { meetingId: 'm1', enabled, reason: enabled ? null : 'off' });
  if (labels !== null) api.client.setQueryData(['meetings', 'label', 'list'], { meetingId: 'm1', labels: labels.map((label, i) => ({ id: `l${i}`, label })) });
  return wrap(<MeetingLabelSuggest meetingId="m1" {...props} />, locale);
};
const answer = (over: Partial<LabelSuggestAnswer>): LabelSuggestAnswer => ({ state: 'suggested', errorCode: null, labels: [], dropped: 0, ...over });
const result = (a: LabelSuggestAnswer, shown: readonly string[] = a.labels, locale: 'en' | 'vi' = 'vi', picking: string | null = null) =>
  wrap(<LabelSuggestResult answer={a} shown={shown} picking={picking} onPick={() => undefined} onDismiss={() => undefined} />, locale);

describe('who sees the button', () => {
  it('shows "Gợi ý nhãn" to the recorder when AI is on and the meeting has room, and "Suggest labels" in English', () => {
    const props = { isRecorder: true };
    expect(gate(true, ['Họp tuần'], props)).toContain('Gợi ý nhãn');
    expect(gate(true, ['Họp tuần'], props, 'en')).toContain('Suggest labels');
    expect(gate(true, [], props)).toContain('data-testid="label-suggest-run"');
    // Four labels: there is room for one.
    expect(gate(true, ['a', 'b', 'c', 'd'], props)).toContain('data-testid="label-suggest-run"');
  });
  it('shows nothing when AI is off, to a reader, with five labels, or before the status or the labels are known', () => {
    expect(gate(false, ['Họp tuần'], { isRecorder: true })).toBe('');
    expect(gate(true, ['Họp tuần'], { isRecorder: false })).toBe('');
    expect(gate(true, ['a', 'b', 'c', 'd', 'e'], { isRecorder: true })).toBe('');
    expect(gate(null, [], { isRecorder: true })).toBe('');
    expect(gate(true, null, { isRecorder: true })).toBe('');
  });
});

describe('the answer', () => {
  it('shows each suggestion as a chip of plain text with its own button, and a way to take none', () => {
    const html = result(answer({ labels: ['Khách Hoa Sen', 'Dự án website'], dropped: 1 }));
    expect([...html.matchAll(/data-testid="label-suggest-pick"/g)]).toHaveLength(2);
    expect(html).toContain('Khách Hoa Sen');
    expect(html).toContain('Dự án website');
    expect(html).toContain('data-testid="label-suggest-dismiss"');
    expect(html).toContain('Đã bỏ 1 gợi ý');
  });

  it('keeps markup in a suggestion as text: no element is made of it and nothing is a link', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = result(answer({ labels: [hostile, '<a href="https://evil.example">x</a>', '<b>đậm</b>'] }));
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<a[\s>]/i);
    expect(html).not.toContain('<b>');
    expect(html).not.toMatch(/\shref="/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;đậm&lt;/b&gt;');
    // The accessible name carries the text too, escaped.
    expect(html).toContain('aria-label="Gắn nhãn &lt;img src=x onerror=alert(1)&gt;"');
  });

  it('makes each chip a real button of at least 44 px with a name that says what it does, in both languages', () => {
    const html = result(answer({ labels: ['Khách Hoa Sen'] }));
    const button = /<button[^>]*data-testid="label-suggest-pick"[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).toMatch(/class="[^"]*\bmin-h-11\b[^"]*"/);
    expect(button).toMatch(/class="[^"]*\bmin-w-11\b[^"]*"/);
    expect(button).toContain('aria-label="Gắn nhãn Khách Hoa Sen"');
    expect(result(answer({ labels: ['Khách Hoa Sen'] }), ['Khách Hoa Sen'], 'en')).toContain('aria-label="Add the label Khách Hoa Sen"');
    const dismiss = /<button[^>]*data-testid="label-suggest-dismiss"[^>]*>/.exec(html)?.[0] ?? '';
    expect(dismiss).toMatch(/class="[^"]*\bmin-h-11\b[^"]*"/);
  });

  it('shows only the suggestions not taken yet, and locks the chips while one is being added', () => {
    const a = answer({ labels: ['Một', 'Hai', 'Ba'] });
    const html = result(a, ['Hai', 'Ba'], 'vi', 'Hai');
    expect([...html.matchAll(/data-testid="label-suggest-pick"/g)]).toHaveLength(2);
    expect(html).not.toContain('>Một<');
    expect([...html.matchAll(/disabled/g)].length).toBeGreaterThanOrEqual(3);
  });

  it('says "no suggestion" for an empty answer, in both languages', () => {
    expect(result(answer({ state: 'none' }))).toContain('chưa có gợi ý');
    expect(result(answer({ state: 'none' }), [], 'en')).toContain('No suggestion this time');
  });

  it('words a failure by its fixed code, and any other code in general words', () => {
    expect(result(answer({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED' }))).toContain('Ngân sách AI');
    expect(result(answer({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED' }), [], 'en')).toContain('The AI budget for this period is used up.');
    expect(result(answer({ state: 'failed', errorCode: 'LABEL_SUGGEST_BUSY' }), [], 'en')).toContain('A suggestion is already running');
    expect(result(answer({ state: 'failed', errorCode: 'SOMETHING_ELSE' }), [], 'en')).toContain('Try again in a few minutes');
  });

  it('has the same words in both languages', () => {
    const keys = (value: unknown, prefix = ''): string[] =>
      Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`)));
    expect(keys(en.meetings.labelSuggest).sort()).toEqual(keys(viMessages.meetings.labelSuggest).sort());
    expect(viMessages.meetings.labelSuggest.found).toBe('Có {count, plural, other {# gợi ý nhãn}}');
  });
});

describe('a click on a chip', () => {
  const buttonOf = (chip: ReactElement) => (chip.props as { children: ReactElement }).children;

  it('calls the pick with that label and nothing else', () => {
    const picked: string[] = [];
    const chips = labelChips(['Khách Hoa Sen', 'Dự án website'], null, (label) => picked.push(label), (label) => `Gắn nhãn ${label}`);
    expect(chips).toHaveLength(2);
    const second = buttonOf(chips[1] as ReactElement).props as { onClick: () => void; 'aria-label': string; children: string; type: string };
    second.onClick();
    expect(picked).toEqual(['Dự án website']);
    expect(second['aria-label']).toBe('Gắn nhãn Dự án website');
    expect(second.type).toBe('button');
  });

  it('adds the label with the existing label add command, then reads the labels and the meetings list again', async () => {
    api.calls.length = 0;
    const invalidate = vi.spyOn(api.client, 'invalidateQueries');
    await addSuggestedLabel('m1', 'Khách Hoa Sen');
    expect(api.calls).toEqual([{ path: ['meetings', 'label', 'add'], input: { meetingId: 'm1', label: 'Khách Hoa Sen' } }]);
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: string[] }).queryKey);
    expect(keys).toEqual(expect.arrayContaining([['meetings', 'label'], ['meetings', 'list']]));
    invalidate.mockRestore();
  });
});
