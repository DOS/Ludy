// SPDX-License-Identifier: AGPL-3.0-only
// "Gợi ý loại cuộc họp" on a meeting's page (#4772), rendered on the server with no network: with no answer, for a person who is not the recorder, with no transcript or a meeting already on a type there is no card and no
// word about it; code's suggestion shows the type, the reasons in plain words and one button that takes it; when code cannot tell the button of Vy appears only when Vy may work; Vy's answer shows the type, its reason as
// plain text and the time of the line it rests on, "no type fits" and the fixed words of a failure, in Vietnamese and English.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateSuggestion, TemplateVyAnswer } from '@ludy/kernel-contract';
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

const { MeetingTemplateSuggest, CodeSuggestion, VyResult, templateSuggestRunCodeOf } = await import('../src/components/meeting-template-suggest.tsx');

const wrap = (node: React.ReactNode, locale: 'en' | 'vi' = 'vi') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const MEETING = '11111111-1111-4111-8111-111111111111';
const suggestion = (over: Partial<TemplateSuggestion>): TemplateSuggestion => ({ meetingId: MEETING, state: 'suggested', template: 'customer', reasons: ['deal'], ...over });
const gate = (
  code: TemplateSuggestion | null,
  vyEnabled: boolean | null,
  props: { isRecorder?: boolean; hasTranscript?: boolean; template?: string } = {},
  locale: 'en' | 'vi' = 'vi',
) => {
  client.current.clear();
  if (code !== null) client.current.setQueryData(['meetings', 'templateSuggest', 'suggest'], code);
  if (vyEnabled !== null) client.current.setQueryData(['meetings', 'templateSuggest', 'status'], { meetingId: MEETING, enabled: vyEnabled, reason: vyEnabled ? null : 'off' });
  return wrap(<MeetingTemplateSuggest meetingId={MEETING} onJump={() => undefined} isRecorder={props.isRecorder ?? true} hasTranscript={props.hasTranscript ?? true} template={props.template ?? 'general'} />, locale);
};
const vyAnswer = (over: Partial<TemplateVyAnswer>): TemplateVyAnswer => ({ state: 'suggested', errorCode: null, template: 'supplier', reason: 'Nói về giao hàng.', seconds: 3725, dropped: 0, ...over });
const vyResult = (a: TemplateVyAnswer, locale: 'en' | 'vi' = 'vi') => wrap(<VyResult answer={a} taking={false} onTake={() => undefined} onJump={() => undefined} />, locale);

describe('who sees the card', () => {
  it('shows code\'s suggestion to the recorder of a meeting with a transcript still on the general summary, in both languages', () => {
    const html = gate(suggestion({}), null);
    expect(html).toContain('data-testid="template-suggest"');
    expect(html).toContain('Gợi ý loại cuộc họp');
    expect(html).toContain('Họp khách hàng');
    expect(html).toContain('Dùng loại này');
    expect(html).toContain('cuộc họp này gắn với một cơ hội bán hàng');
    expect(gate(suggestion({}), null, {}, 'en')).toContain('Because this meeting is linked to a deal.');
  });
  it('words every reason and joins several', () => {
    const html = gate(suggestion({ template: 'one_on_one', reasons: ['title', 'people'] }), null, {}, 'en');
    expect(html).toContain('Because the title names this kind of meeting; the recorder and the one other person who can read the meeting are the only two people.');
    for (const reason of ['series', 'deal', 'title', 'people'] as const) {
      expect(en.meetings.templateSuggest.reasons[reason]).not.toBe('');
      expect(viMessages.meetings.templateSuggest.reasons[reason]).not.toBe('');
    }
  });
  it('shows nothing for a person who is not the recorder, with no transcript, for a meeting already on a type, or when there is nothing to suggest', () => {
    expect(gate(suggestion({}), null, { isRecorder: false })).toBe('');
    expect(gate(suggestion({}), null, { hasTranscript: false })).toBe('');
    expect(gate(suggestion({}), null, { template: 'customer' })).toBe('');
    expect(gate(suggestion({ state: 'not_applicable', template: null, reasons: [] }), null)).toBe('');
    expect(gate(null, null)).toBe('');
  });
  it('offers Vy only when code cannot tell and Vy may work: otherwise no card and no word about it', () => {
    const unknown = suggestion({ state: 'unknown', template: null, reasons: [] });
    const html = gate(unknown, true);
    expect(html).toContain('data-testid="template-suggest-vy"');
    expect(html).toContain('Nhờ Vy gợi ý');
    expect(html).not.toContain('data-testid="template-suggest-take"');
    expect(gate(unknown, false)).toBe('');
    expect(gate(unknown, null)).toBe('');
  });
  it('has one button that takes code\'s suggestion, and nothing else writes', () => {
    const html = gate(suggestion({}), null);
    const buttons = [...html.matchAll(/<button[^>]*data-testid="([^"]+)"/g)].map((m) => m[1]);
    expect(buttons).toEqual(['template-suggest-take']);
  });
});

describe('code\'s suggestion', () => {
  it('names its button by the type it takes (the type is its description)', () => {
    const html = wrap(<CodeSuggestion template="supplier" reasons={['title']} taking={false} onTake={() => undefined} />, 'en');
    expect(html).toContain('Supplier meeting');
    expect(html).toMatch(/aria-describedby="template-suggest-name"/);
    expect(html).toContain('Use this type');
  });
});

describe('Vy\'s answer', () => {
  it('shows the type, the reason as plain text and the time of the line it rests on as a way to open it', () => {
    const html = vyResult(vyAnswer({ reason: 'Nói về <b>giao hàng</b>.' }));
    expect(html).toContain('Họp với nhà cung cấp');
    expect(html).toContain('1:02:05');
    expect(html).toContain('data-testid="template-suggest-vy-take"');
    expect(html).toContain('không được lưu');
    // Markup in the reason stays text.
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;giao hàng&lt;/b&gt;');
  });
  it('names the time button by what it does, at a size a finger can hit (WCAG 2.5.3, 2.5.8)', () => {
    const html = vyResult(vyAnswer({}), 'en');
    const [tag, time] = [...html.matchAll(/<button[^>]*data-testid="template-suggest-jump"[^>]*>([^<]*)<\/button>/g)][0] ?? [];
    expect(tag).toContain(`aria-label="Open the transcript at ${time}"`);
    expect(tag).toContain('min-h-6');
    expect(tag).toContain('max-md:min-h-11');
  });
  it('says "no type fits" for an empty answer, in both languages', () => {
    expect(vyResult(vyAnswer({ state: 'none', template: null, reason: null, seconds: null }))).toContain('Chưa có loại nào hợp rõ ràng');
    expect(vyResult(vyAnswer({ state: 'none', template: null, reason: null, seconds: null }), 'en')).toContain('No type fits clearly');
  });
  it('words a failure by its fixed code, and any other code in general words', () => {
    const failed = (errorCode: string) => vyAnswer({ state: 'failed', errorCode, template: null, reason: null, seconds: null });
    expect(vyResult(failed('AI_BUDGET_EXHAUSTED'))).toContain('Ngân sách AI');
    expect(vyResult(failed('AI_BUDGET_EXHAUSTED'), 'en')).toContain('The AI budget for this period is used up.');
    expect(vyResult(failed('SOMETHING_ELSE'), 'en')).toContain('Try again in a few minutes');
    expect(templateSuggestRunCodeOf(null)).toBe('default');
    expect(templateSuggestRunCodeOf('TEMPLATE_SUGGEST_TIMEOUT')).toBe('TEMPLATE_SUGGEST_TIMEOUT');
  });
});
