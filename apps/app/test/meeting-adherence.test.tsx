// SPDX-License-Identifier: AGPL-3.0-only
// "Cuộc họp đã bàn đủ chưa?" (#3959), rendered on the server from the query cache with no network. Only the recorder of a meeting with a transcript sees the card; it lists the open items of the previous meeting
// (with AI off too) and a box for typed lines; the button is absent when AI is off and says why when it is blocked; the answer shows each agenda line as it was given, "covered" with the transcript lines it cites
// (their time and words) or "not heard", with no score, no percentage and nothing about a person; a failure shows fixed words; the typed lines are one per line, trimmed and cut.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AdherenceAgenda, AdherenceAnswer, AdherenceStatus } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

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

const { MeetingAdherence, AdherenceResult, adherenceFailureKey, typedLines, typedOverflow } = await import('../src/components/meeting-adherence.tsx');

const M = '00000000-0000-4000-8000-000000000001';
const agenda = (over: Partial<AdherenceAgenda> = {}): AdherenceAgenda => ({
  meetingId: M,
  previous: { meetingId: '00000000-0000-4000-8000-000000000002', title: 'Họp tuần 12', startedAt: '2026-11-12T02:00:00.000Z' },
  items: [{ text: 'Gửi báo giá cho khách A' }, { text: 'Chốt lịch giao hàng đợt 2' }],
  transcriptLines: 120,
  transcriptFits: true,
  ...over,
});
const status = (over: Partial<AdherenceStatus> = {}): AdherenceStatus => ({ meetingId: M, enabled: true, reason: null, estimate: { inputTokens: 30000, outputTokens: 400, cost: null }, ...over });
const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
};
const show = (data: AdherenceAgenda, st: AdherenceStatus | null, isRecorder = true, locale: 'vi' | 'en' = 'vi'): string => {
  client.current.clear();
  client.current.setQueryData(['meetings', 'adherence', 'agenda'], data);
  if (st) client.current.setQueryData(['meetings', 'adherence', 'status'], st);
  client.current.setQueryData(['ai', 'meter'], { aiOn: true, state: 'ok' });
  return render(<MeetingAdherence meetingId={M} isRecorder={isRecorder} onJump={() => undefined} />, locale);
};

describe('the card', () => {
  it('shows the open items of the previous meeting, the box for typed lines and the button to the recorder of a meeting with a transcript', () => {
    const html = show(agenda(), status());
    expect(html).toContain('data-testid="meeting-adherence"');
    expect(html).toContain('Họp tuần 12');
    expect(html).toContain('Gửi báo giá cho khách A');
    expect(html).toContain('data-testid="adherence-typed"');
    expect(html).toContain('data-testid="adherence-check"');
    expect(html).not.toContain('data-testid="adherence-blocked"');
  });

  it('links the hint to the box and keeps the "more than eight lines" status in the page, empty until it applies (WCAG 3.3.2, 4.1.3; #4055)', () => {
    const html = show(agenda(), status());
    expect(html).toMatch(/<textarea[^>]*aria-describedby="adherence-typed-hint"/);
    expect(html).toMatch(/<p id="adherence-typed-hint"[^>]*>/);
    expect(html).toMatch(/<p[^>]*role="status"[^>]*data-testid="adherence-typed-overflow-status"[^>]*><\/p>/);
  });

  it('shows nothing to a reader, nothing while there is no transcript, and keeps the list (and no button) with AI off', () => {
    expect(show(agenda(), status(), false)).toBe('');
    expect(show(agenda({ transcriptLines: 0, transcriptFits: false }), status())).toBe('');
    const off = show(agenda(), status({ enabled: false, reason: 'off', estimate: null }));
    expect(off).toContain('Gửi báo giá cho khách A');
    expect(off).not.toContain('data-testid="adherence-vy"');
    expect(off).not.toContain('data-testid="adherence-check"');
  });

  it('says why the button is blocked and disables it; says a transcript that is too long cannot be checked', () => {
    const budget = show(agenda(), status({ enabled: false, reason: 'budget', estimate: null }));
    expect(budget).toContain('data-testid="adherence-blocked"');
    expect(budget).toMatch(/data-testid="adherence-check"[^>]*disabled|disabled[^>]*data-testid="adherence-check"/u);
    const long = show(agenda({ transcriptFits: false }), status());
    expect(long).toContain('data-testid="adherence-too-long"');
  });

  it('says there is nothing to check when there is no open item (the recorder can type lines), in vi and en', () => {
    const empty = agenda({ previous: null, items: [] });
    expect(show(empty, status())).toContain('data-testid="adherence-no-agenda"');
    expect(show(empty, status(), true, 'en')).toContain('There is nothing to check yet');
  });
});

describe('the answer', () => {
  const answer = (over: Partial<AdherenceAnswer> = {}): AdherenceAnswer => ({
    state: 'checked',
    errorCode: null,
    reason: null,
    dropped: 0,
    items: [
      { n: 1, text: 'Gửi báo giá cho khách A', source: 'open_item', covered: true, cites: [{ n: 4, startSeconds: 125, text: 'Báo giá khách A mình gửi chiều nay.' }] },
      { n: 2, text: 'Chốt giá gói bảo trì', source: 'typed', covered: false, cites: [] },
    ],
    ...over,
  });

  it('shows each agenda line as given with covered or not heard, and the cited transcript line with its time', () => {
    const html = render(<AdherenceResult answer={answer()} onJump={() => undefined} />);
    expect(html).toContain('data-testid="adherence-answer"');
    expect(html).toContain('data-testid="adherence-covered"');
    expect(html).toContain('data-testid="adherence-not-heard"');
    expect(html).toContain('Gửi báo giá cho khách A');
    expect(html).toContain('Chốt giá gói bảo trì');
    expect(html).toContain('>2:05<');
    expect(html).toContain('Báo giá khách A mình gửi chiều nay.');
  });

  it('carries no score, percentage or per-person figure, and says what was moved back to not heard', () => {
    const html = render(<AdherenceResult answer={answer({ dropped: 2 })} onJump={() => undefined} />);
    // The note says there is no score; what must be absent is a figure: a percentage, a "1/2" or a count of covered lines.
    expect(html).not.toMatch(/\d+\s?%|\b\d+\s?\/\s?\d+\b|đã bàn\s*:?\s*\d/iu);
    expect(html).toContain('Đã chuyển 2 mục');
  });

  it('shows the fixed words of a failure, nothing to check with its reason, and the same in English', () => {
    expect(render(<AdherenceResult answer={{ state: 'failed', errorCode: 'ADHERENCE_TIMEOUT', reason: null, items: [], dropped: 0 }} onJump={() => undefined} />)).toContain('mất quá lâu');
    expect(render(<AdherenceResult answer={{ state: 'none', errorCode: null, reason: 'too_long', items: [], dropped: 0 }} onJump={() => undefined} />)).toContain('quá dài');
    expect(render(<AdherenceResult answer={answer()} onJump={() => undefined} />, 'en')).toContain('Not heard');
    expect(adherenceFailureKey('ADHERENCE_BUSY')).toBe('ADHERENCE_BUSY');
    expect(adherenceFailureKey('SOMETHING_ELSE')).toBe('default');
    expect(adherenceFailureKey(null)).toBe('default');
  });
});

describe('typedLines', () => {
  it('takes one line per line, trimmed, with the empty ones dropped, each cut at 200 characters, at most eight', () => {
    expect(typedLines('  Giá  \n\n   \r\nLịch giao\n')).toEqual(['Giá', 'Lịch giao']);
    expect(typedLines('a'.repeat(300))[0]).toHaveLength(200);
    expect(typedLines(Array.from({ length: 12 }, (_, i) => `Mục ${i + 1}`).join('\n'))).toHaveLength(8);
    expect(typedLines('')).toEqual([]);
    // The ninth line and the rest are left out, and the box says so.
    expect(typedOverflow(Array.from({ length: 9 }, (_, i) => `Mục ${i + 1}`).join('\n'))).toBe(true);
    expect(typedOverflow(Array.from({ length: 8 }, (_, i) => `Mục ${i + 1}`).join('\n') + '\n\n')).toBe(false);
  });
});
