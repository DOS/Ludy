// SPDX-License-Identifier: AGPL-3.0-only
// Highlights on a meeting's page (#4819): the card lists the marks the caller may read with their time, who marked them and the lines they cover (read from the transcript in the query cache), shows
// the time alone when the lines are gone or the transcript cannot be read, offers remove on the caller's own marks (any mark for the recorder), is absent with no marks, and the transcript's line
// buttons show which lines are covered and which the caller has marked. Rendered on the server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Highlights, Transcript } from '@ludy/kernel-contract';
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

const { MeetingHighlights } = await import('../src/components/meeting-highlights.tsx');
const { MeetingTranscript } = await import('../src/components/meeting-transcript.tsx');

const LIST_KEY = ['meetings', 'highlight', 'list'];
const TRANSCRIPT_KEY = ['meetings', 'transcript', 'get'];
let n = 0;
const segment = (speakerLabel: string, startSeconds: number, text: string) => ({
  id: `s${(n += 1)}`,
  startSeconds,
  endSeconds: startSeconds + 5,
  speakerLabel,
  text,
  stage: 'published' as const,
  corrected: false,
  source: 'ludy' as const,
});
const TRANSCRIPT: Transcript = {
  meetingId: 'm1',
  isRecorder: false,
  stage: 'published',
  segments: [segment('Lan', 10, 'Chào mọi người'), segment('Hùng', 20, 'Báo giá cho khách Á Châu'), segment('Lan', 30, 'Chốt hạn thứ Sáu'), segment('Hùng', 40, 'Xong buổi họp'), segment('Lan', 50, 'Cảm ơn')],
};
const marks = (highlights: Highlights['highlights']): Highlights => ({ meetingId: 'm1', highlights });
const mark = (id: string, startSeconds: number, endSeconds: number, mine: boolean, markedBy: string | null) => ({ id, startSeconds, endSeconds, mine, markedBy });

const wrap = (node: React.ReactNode, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const card = (list: Highlights | null, transcript: Transcript | null = TRANSCRIPT, isRecorder = false, locale: 'en' | 'vi' = 'en') => {
  if (list) client.current.setQueryData(LIST_KEY, list);
  if (transcript) client.current.setQueryData(TRANSCRIPT_KEY, transcript);
  return wrap(<MeetingHighlights meetingId="m1" isRecorder={isRecorder} onJump={() => undefined} />, locale);
};
const textOf = (html: string): string => {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
};
const items = (html: string) => html.split('data-testid="highlight"').slice(1);

beforeEach(() => client.current.clear());

describe('the highlights card', () => {
  it('lists each mark with its time, who made it and the lines it covers', () => {
    const html = card(marks([mark('h1', 20, 20, false, 'Phạm Quang Minh'), mark('h2', 30, 40, true, null)]));
    const [first, second] = items(html);
    expect(html).toContain('data-testid="meeting-highlights"');
    expect(textOf(first ?? '')).toContain('0:20');
    expect(textOf(first ?? '')).toContain('Marked by Phạm Quang Minh');
    expect(textOf(first ?? '')).toContain('Hùng: Báo giá cho khách Á Châu');
    expect(textOf(second ?? '')).toContain('0:30 - 0:40');
    expect(textOf(second ?? '')).toContain('Marked by you');
    expect(textOf(second ?? '')).toContain('Lan: Chốt hạn thứ Sáu');
    expect(textOf(second ?? '')).toContain('Hùng: Xong buổi họp');
  });

  it('says "a member" for a name that is not known, and lists a long range as three lines and "more"', () => {
    const html = card(marks([mark('h1', 10, 50, false, null)]));
    expect(textOf(html)).toContain('Marked by a member');
    expect(textOf(html)).toContain('and 2 more lines');
    expect(textOf(html)).not.toContain('Cảm ơn');
  });

  it('shows the time alone when the lines are gone, or when the transcript could not be read', () => {
    const gone = card(marks([mark('h1', 200, 200, true, null)]));
    expect(textOf(gone)).toContain('These lines are no longer in the transcript.');
    client.current.clear();
    client.current.setQueryData(LIST_KEY, marks([mark('h1', 20, 20, true, null)]));
    // A transcript read that failed leaves the earlier lines in the cache; they are not shown.
    client.current.getQueryCache().build(client.current, { queryKey: TRANSCRIPT_KEY }).setState({ data: TRANSCRIPT, error: new Error('404'), status: 'error', fetchStatus: 'idle' } as never);
    const failed = wrap(<MeetingHighlights meetingId="m1" isRecorder={false} onJump={() => undefined} />);
    expect(textOf(failed)).toContain('0:20');
    expect(textOf(failed)).not.toContain('Báo giá');
  });

  it('offers remove on the caller\'s own marks, and on every mark to the recorder', () => {
    const list = marks([mark('h1', 20, 20, false, 'Lan'), mark('h2', 30, 30, true, null)]);
    const asReader = items(card(list));
    expect(textOf(asReader[0] ?? '')).not.toContain('Remove highlight');
    expect(textOf(asReader[1] ?? '')).toContain('Remove highlight');
    client.current.clear();
    const asRecorder = items(card(list, TRANSCRIPT, true));
    expect(asRecorder.every((i) => textOf(i).includes('Remove highlight'))).toBe(true);
  });

  it('is absent with no marks and when the list cannot be read', () => {
    expect(card(marks([]))).toBe('');
    client.current.clear();
    expect(card(null, null)).toBe('');
  });

  it('shows line text as plain text and speaks Vietnamese', () => {
    const evil: Transcript = { ...TRANSCRIPT, segments: [segment('<b>Lan</b>', 20, '<img src=x onerror=alert(1)>')] };
    const html = card(marks([mark('h1', 20, 20, true, null)]), evil, false, 'vi');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Lan');
    expect(textOf(html)).toContain('Đoạn nổi bật');
    expect(textOf(html)).toContain('Đánh dấu bởi bạn');
  });
});

describe('the transcript lines', () => {
  const transcript = (data: Transcript, list: Highlights) => {
    client.current.setQueryData(TRANSCRIPT_KEY, data);
    client.current.setQueryData(LIST_KEY, list);
    return wrap(<MeetingTranscript meetingId="m1" />);
  };
  const lineHtml = (html: string) => html.split('data-testid="transcript-line"').slice(1);

  it('shades the lines a mark covers, and presses the button of a line the caller marked alone', () => {
    const html = transcript(TRANSCRIPT, marks([mark('h1', 20, 30, false, 'Lan'), mark('h2', 40, 40, true, null)]));
    const lines = lineHtml(html);
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.includes('data-highlighted="true"'))).toEqual([false, true, true, true, false]);
    expect(lines.map((l) => l.includes('aria-pressed="true"'))).toEqual([false, false, false, true, false]);
    expect(lines.every((l) => l.includes('data-testid="transcript-highlight"'))).toBe(true);
    expect(lines[3]).toContain('Remove your highlight of the line at 0:40');
    expect(lines[0]).toContain('Highlight the line at 0:10');
  });
});
