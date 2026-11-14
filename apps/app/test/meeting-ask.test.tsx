// SPDX-License-Identifier: AGPL-3.0-only
// "Hỏi về các cuộc họp" on the meetings screen (Meetings A3, #3161), in English and Vietnamese: the box, why it cannot ask Vy (and that it then searches), the cost and the budget left
// before the question, the answer with a chip on every sentence that opens the transcript at its line, the "nothing found" words with the plain hit list, the failed answer in fixed words,
// and that a sentence is shown as text only (never as a link or markup). Rendered on the server.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AskAnswer, AskStatus, MeetingSearchHit } from '@crove/kernel-contract';
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
vi.mock('../src/i18n/provider.tsx', () => ({ useFormat: () => ({ date: (v: string) => `date:${v.slice(0, 10)}`, aiAmount: (v: string) => `$${v}`, number: (v: number | bigint | string) => String(v) }) }));
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, search, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string> } & Record<string, unknown>) =>
      createElement('a', { href: `${to.replace('$slug', params?.slug ?? '').replace('$id', params?.id ?? '')}?seg=${search?.seg ?? ''}`, ...rest }, children),
  };
});

const { AskResult, MeetingAsk, askBlocked, failureKey } = await import('../src/components/meeting-ask.tsx');

const M1 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const S1 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c';
const S2 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5d';
const hit = (over: Partial<MeetingSearchHit> = {}): MeetingSearchHit => ({ meetingId: M1, meetingTitle: 'Họp giao ban', heldAt: '2026-11-14T05:31:00.000Z', segmentId: S1, startSeconds: 754, speakerLabel: 'Lan', text: 'Khách A đồng ý chiết khấu 8%', stage: 'published', ...over });
const answered: AskAnswer = {
  state: 'answered',
  errorCode: null,
  sentences: [
    { text: 'Khách A đồng ý chiết khấu 8%.', sources: [0] },
    { text: 'Giao hàng trước ngày 20/11.', sources: [1, 0] },
  ],
  sources: [hit(), hit({ segmentId: S2, startSeconds: 61, meetingTitle: 'Họp khách', text: 'Giao hàng trước ngày 20/11' })],
  hits: [],
  dropped: 0,
};

function render(node: ReactNode, locale: 'en' | 'vi' = 'en') {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}
// The text of a piece of markup, by a scan (no pattern is used to strip tags): everything outside a tag.
const textOf = (html: string): string => {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  // The few characters markup writes as entities.
  return out.split('&#x27;').join("'").split('&quot;').join('"').split('&amp;').join('&');
};
const count = (html: string, needle: string) => html.split(needle).length - 1;
const box = (status: AskStatus | undefined, meter: { aiOn: boolean; state: 'none' | 'ok' | 'warn' | 'stop'; percent: number | null } | undefined, locale: 'en' | 'vi' = 'en') => {
  client.current.clear();
  if (status) client.current.setQueryData(['meetings', 'ask', 'status'], status);
  if (meter) client.current.setQueryData(['ai', 'meter'], { ...meter, scope: null, resetAt: '2026-12-01T00:00:00.000Z' });
  return render(<MeetingAsk slug="acme" />, locale);
};
const ON: AskStatus = { enabled: true, reason: null, estimate: { inputTokens: 6800, outputTokens: 600, cost: '0.0294' } };

describe('askBlocked', () => {
  it('says why Vy cannot be asked, from the status first and then from the org meter', () => {
    expect(askBlocked(undefined, undefined)).toBe('off');
    expect(askBlocked({ enabled: false, reason: 'forbidden' }, undefined)).toBe('forbidden');
    expect(askBlocked({ enabled: false, reason: 'paused' }, undefined)).toBe('paused');
    expect(askBlocked({ enabled: false, reason: 'budget' }, undefined)).toBe('budget');
    expect(askBlocked({ enabled: false, reason: null }, undefined)).toBe('off');
    expect(askBlocked({ enabled: true, reason: null }, { aiOn: false, state: 'none' })).toBe('noModel');
    expect(askBlocked({ enabled: true, reason: null }, { aiOn: true, state: 'stop' })).toBe('budget');
    expect(askBlocked({ enabled: true, reason: null }, { aiOn: true, state: 'warn' })).toBeNull();
    expect(askBlocked({ enabled: true, reason: null }, undefined)).toBeNull();
  });

  it('reads a fixed code of a failed answer by its words, and any other code by the general ones', () => {
    expect(failureKey('ASK_TIMEOUT')).toBe('ASK_TIMEOUT');
    expect(failureKey('ASK_BUSY')).toBe('ASK_BUSY');
    expect(failureKey('AI_BUDGET_EXHAUSTED')).toBe('AI_BUDGET_EXHAUSTED');
    expect(failureKey('SUMMARY_FAILED')).toBe('default');
    expect(failureKey(null)).toBe('default');
  });
});

describe('AskResult', () => {
  it('shows each sentence with a chip for every line it rests on: the meeting, the date, the time, opening the transcript at that line', () => {
    const html = render(<AskResult slug="acme" answer={answered} typed="khách" />);
    expect(count(html, 'data-testid="meeting-ask-sentence"')).toBe(2);
    expect(count(html, 'data-testid="meeting-ask-chip"')).toBe(3);
    expect(html).toContain(`href="/o/acme/meetings/${M1}?seg=${S1}"`);
    expect(html).toContain(`?seg=${S2}"`);
    const text = textOf(html);
    expect(text).toContain('Khách A đồng ý chiết khấu 8%.');
    expect(text).toContain('Họp giao ban, date:2026-11-14, 12:34');
    expect(text).toContain('Họp khách, date:2026-11-14, 1:01');
    expect(text).toContain(en.meetings.ask.private);
    expect(html).not.toContain('Left out');
  });

  it('says how many sentences code left out', () => {
    const text = textOf(render(<AskResult slug="acme" answer={{ ...answered, dropped: 2 }} typed="" />));
    expect(text).toContain('Left out 2 sentence(s) that no transcript line backs.');
    expect(textOf(render(<AskResult slug="acme" answer={{ ...answered, dropped: 2 }} typed="" />, 'vi'))).toContain('Đã bỏ 2 câu vì không có dòng bản ghi nào xác nhận.');
  });

  it('shows a sentence as text only: markup and an address in it are escaped, never a link', () => {
    const wicked: AskAnswer = { ...answered, sentences: [{ text: '<img src=x onerror=alert(1)> xem https://evil.example/pay', sources: [0] }] };
    const html = render(<AskResult slug="acme" answer={wicked} typed="" />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('href="https://evil.example');
    // The only links on the screen are the chips.
    expect(count(html, '<a ')).toBe(1);
  });

  it('says "nothing found" in the exact words and shows the plain hit list under it', () => {
    const none: AskAnswer = { state: 'none', errorCode: null, sentences: [], sources: [], hits: [hit()], dropped: 3 };
    const text = textOf(render(<AskResult slug="acme" answer={none} typed="chiết khấu" />, 'vi'));
    expect(text).toContain('Không tìm thấy trong các cuộc họp bạn đọc được');
    expect(text).toContain(viMessages.meetings.ask.noneHits);
    expect(text).toContain('Khách A đồng ý chiết khấu 8%');
    expect(textOf(render(<AskResult slug="acme" answer={none} typed="" />))).toContain('Nothing found in the meetings you can read');
    // No hit: just the words.
    const empty = render(<AskResult slug="acme" answer={{ ...none, hits: [] }} typed="" />);
    expect(empty).not.toContain(en.meetings.ask.noneHits);
  });

  it('says a failure in fixed words, never the code, and keeps the plain hit list', () => {
    const failed = (errorCode: string): AskAnswer => ({ state: 'failed', errorCode, sentences: [], sources: [], hits: [hit()], dropped: 0 });
    const timeout = textOf(render(<AskResult slug="acme" answer={failed('ASK_TIMEOUT')} typed="" />));
    expect(timeout).toContain(`${en.meetings.ask.failed} ${en.meetings.ask.codes.ASK_TIMEOUT}`);
    expect(timeout).not.toContain('ASK_TIMEOUT');
    expect(textOf(render(<AskResult slug="acme" answer={failed('SOMETHING_NEW')} typed="" />))).toContain(en.meetings.ask.codes.default);
    expect(textOf(render(<AskResult slug="acme" answer={failed('AI_BUDGET_EXHAUSTED')} typed="" />, 'vi'))).toContain(viMessages.meetings.ask.codes.AI_BUDGET_EXHAUSTED);
    expect(timeout).toContain('Khách A đồng ý chiết khấu 8%');
  });
});

describe('MeetingAsk', () => {
  it('shows nothing before the server has answered', () => {
    expect(box(undefined, undefined)).toBe('');
  });

  it('offers "Ask Vy" with the cost of one question and the budget left, and a textarea bounded to the question length', () => {
    const html = box(ON, { aiOn: true, state: 'ok', percent: 40 });
    const text = textOf(html);
    expect(html).toContain('data-testid="meeting-ask"');
    expect(text).toContain(en.meetings.ask.label);
    expect(text).toContain('Ask Vy');
    expect(text).toContain('Each question costs about $0.0294.');
    expect(text).toContain("About 60% of this month's AI budget is left.");
    expect(text).toContain(en.meetings.ask.hint);
    expect(html).toContain('maxLength="300"');
    expect(html).not.toContain('data-testid="meeting-ask-blocked"');
  });

  it('shows the size of the call when the deployment sets no price, and warns when the budget is almost used up', () => {
    const unpriced = textOf(box({ ...ON, estimate: { inputTokens: 6800, outputTokens: 600, cost: null } }, { aiOn: true, state: 'warn', percent: 90 }));
    expect(unpriced).toContain('Each question is one AI call of about 7400 tokens.');
    expect(unpriced).toContain("This month's AI budget is almost used up: about 10% is left.");
  });

  it('in Vietnamese reads "Hỏi về các cuộc họp" and "Hỏi Vy"', () => {
    const text = textOf(box(ON, { aiOn: true, state: 'ok', percent: 10 }, 'vi'));
    expect(text).toContain('Hỏi về các cuộc họp');
    expect(text).toContain('Hỏi Vy');
    expect(text).toContain('Ngân sách AI tháng này còn khoảng 90%.');
  });

  it('with Vy unavailable says why and becomes a plain search of the transcripts', () => {
    for (const [status, key] of [
      [{ enabled: false, reason: 'off', estimate: null }, 'off'],
      [{ enabled: false, reason: 'forbidden', estimate: null }, 'forbidden'],
      [{ enabled: false, reason: 'paused', estimate: null }, 'paused'],
      [{ enabled: false, reason: 'budget', estimate: null }, 'budget'],
    ] as const) {
      const html = box(status, { aiOn: true, state: 'ok', percent: 10 });
      const text = textOf(html);
      expect(html).toContain('data-testid="meeting-ask-blocked"');
      expect(text).toContain(en.meetings.ask.blocked[key]);
      expect(text).toContain('Search transcripts');
      expect(text).not.toContain('Ask Vy');
      expect(text).not.toContain('Each question');
    }
    // No model on this system.
    expect(textOf(box(ON, { aiOn: false, state: 'none', percent: null }))).toContain(en.meetings.ask.blocked.noModel);
    expect(textOf(box({ enabled: false, reason: 'off', estimate: null }, undefined, 'vi'))).toContain('Tìm trong bản ghi');
  });
});
