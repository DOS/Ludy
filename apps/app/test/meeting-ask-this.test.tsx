// SPDX-License-Identifier: AGPL-3.0-only
// "Hỏi về cuộc họp này" on one meeting's page (#4815), in English and Vietnamese: the box shows only for a meeting with a transcript and once the server has answered, says why Vy cannot be asked (and
// that it then lists the lines of this meeting), the answer shows a time button under every sentence (not a link to another meeting) and the sentence only as text, "nothing found" and the fixed words
// of a failure keep the plain lines. Rendered on the server.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AskAnswer, AskStatus, MeetingSearchHit } from '@ludy/kernel-contract';
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

const { AskThisResult, MeetingAskThis } = await import('../src/components/meeting-ask-this.tsx');

const M1 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const S1 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c';
const S2 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5d';
const hit = (over: Partial<MeetingSearchHit> = {}): MeetingSearchHit => ({ meetingId: M1, meetingTitle: 'Họp giao ban', heldAt: '2026-11-14T05:31:00.000Z', segmentId: S1, startSeconds: 754, speakerLabel: 'Hà', text: 'Khách A đồng ý chiết khấu 8%', stage: 'published', ...over });
const answered: AskAnswer = {
  state: 'answered',
  errorCode: null,
  sentences: [
    { text: 'Khách A đồng ý chiết khấu 8%. <b>x</b>', sources: [0] },
    { text: 'Giao hàng trước ngày 20/11.', sources: [1, 0] },
  ],
  sources: [hit(), hit({ segmentId: S2, startSeconds: 61, text: 'Giao hàng trước ngày 20/11' })],
  hits: [],
  dropped: 0,
};
const noop = () => undefined;

function render(node: ReactNode, locale: 'en' | 'vi' = 'en') {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}
const count = (html: string, needle: string) => html.split(needle).length - 1;
const STATUS: AskStatus = { enabled: true, reason: null, estimate: { inputTokens: 6800, outputTokens: 600, cost: '0.0123' } };
const METER = { aiOn: true, state: 'ok', percent: 10, scope: null, resetAt: '2026-12-01T00:00:00Z' };
const box = (status: AskStatus | undefined, meter: Record<string, unknown> | undefined, hasTranscript = true, locale: 'en' | 'vi' = 'en') => {
  client.current.clear();
  if (status) client.current.setQueryData(['meetings', 'ask', 'status'], status);
  if (meter) client.current.setQueryData(['ai', 'meter'], meter);
  return render(<MeetingAskThis meetingId={M1} hasTranscript={hasTranscript} onJump={noop} />, locale);
};

describe('the answer', () => {
  it('shows a time button under every sentence (a button, not a link to another meeting) and the sentence only as text', () => {
    const html = render(<AskThisResult answer={answered} onJump={noop} />);
    expect(count(html, 'data-testid="ask-this-sentence"')).toBe(2);
    expect(count(html, 'data-testid="ask-this-time"')).toBe(3);
    expect(html).toContain('12:34');
    expect(html).toContain('1:01');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('Open the transcript at 12:34');
  });

  it('says "nothing found" or the fixed words of a failure, and keeps the plain lines', () => {
    const none = render(<AskThisResult answer={{ state: 'none', errorCode: null, sentences: [], sources: [], hits: [], dropped: 0 }} onJump={noop} />);
    expect(none).toContain('Nothing found in the transcript of this meeting');
    const failed = render(<AskThisResult answer={{ state: 'failed', errorCode: 'ASK_TIMEOUT', sentences: [], sources: [], hits: [hit()], dropped: 0 }} onJump={noop} />, 'vi');
    expect(failed).toContain('data-testid="ask-this-failed"');
    expect(failed).toContain('Khách A đồng ý chiết khấu 8%');
    expect(count(failed, 'data-testid="ask-this-time"')).toBe(1);
  });
});

describe('the box', () => {
  it('shows nothing for a meeting with no transcript, and nothing before the server has answered', () => {
    expect(box(STATUS, METER, false)).toBe('');
    expect(box(undefined, METER, true)).toBe('');
  });

  it('asks Vy about this meeting with the cost before the click, in both languages', () => {
    const en = box(STATUS, METER);
    expect(en).toContain('Ask about this meeting');
    expect(en).toContain('Ask Vy');
    expect(en).toContain('$0.0123');
    expect(en).not.toContain('data-testid="ask-this-blocked"');
    expect(box(STATUS, METER, true, 'vi')).toContain('Hỏi về cuộc họp này');
  });

  it('says why Vy cannot be asked and that it then lists the lines of this meeting', () => {
    const off = box({ enabled: false, reason: 'off', estimate: null }, METER);
    expect(off).toContain('data-testid="ask-this-blocked"');
    expect(off).toContain('Search this transcript');
    expect(box(STATUS, { ...METER, aiOn: false }, true, 'vi')).toContain('chưa có mô hình AI');
    expect(box(STATUS, { ...METER, state: 'stop' }, true, 'vi')).toContain('Ngân sách');
  });
});
