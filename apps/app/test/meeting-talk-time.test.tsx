// SPDX-License-Identifier: AGPL-3.0-only
// Who did the talking on a meeting's page (#4765): the card with each speaker's share, talk time, turns and longest stretch, and the one line under the published summary. Both come from the
// transcript lines already in the query cache (the lines the reader may read), neither shows with fewer than two speakers or when no line has text left, and names are plain text.
// Rendered on the server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcript } from '@ludy/kernel-contract';
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

const { MeetingTalkTime, TalkTimeLine } = await import('../src/components/meeting-talk-time.tsx');

let n = 0;
const segment = (speakerLabel: string, startSeconds: number, endSeconds: number, text = 'Nội dung') => ({
  id: `s${(n += 1)}`,
  startSeconds,
  endSeconds,
  speakerLabel,
  text,
  stage: 'published' as const,
  corrected: false,
  source: 'ludy' as const,
});
const transcript = (segments: Transcript['segments']): Transcript => ({ meetingId: 'm1', isRecorder: false, stage: 'published', segments });
const TWO = transcript([segment('Lan', 0, 10), segment('Hùng', 10, 15), segment('Lan', 15, 25)]);

const wrap = (node: React.ReactNode, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const card = (data: Transcript | null, locale: 'en' | 'vi' = 'en') => {
  if (data) client.current.setQueryData(['meetings', 'transcript', 'get'], data);
  return wrap(<MeetingTalkTime meetingId="m1" />, locale);
};
const lineOf = (data: Transcript | null, locale: 'en' | 'vi' = 'en') => {
  if (data) client.current.setQueryData(['meetings', 'transcript', 'get'], data);
  return wrap(<TalkTimeLine meetingId="m1" />, locale);
};
// The text of a piece of markup, by a scan (no pattern is used to strip tags): everything outside a tag.
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
const rows = (html: string) => [...html.matchAll(/<tr[^>]*data-testid="talk-time-row"[^>]*>((?:(?!<\/tr>).)*)<\/tr>/g)].map((m) => [...(m[1] ?? '').matchAll(/<t[hd][^>]*>((?:(?!<\/t[hd]>).)*)<\/t[hd]>/g)].map((c) => textOf(c[1] ?? '')));

beforeEach(() => client.current.clear());

describe('the card', () => {
  it('shows each speaker with the share, talk time, turns and longest stretch, the most talk first', () => {
    const html = card(TWO);
    expect(html).toContain('data-testid="meeting-talk-time"');
    expect(html).toContain(en.meetings.talkTime.title);
    expect(html).toContain(en.meetings.talkTime.desc.replace("'", '&#x27;'));
    expect(rows(html)).toEqual([
      ['Lan', '80%', '0:20', '2', '0:10'],
      ['Hùng', '20%', '0:05', '1', '0:05'],
    ]);
  });

  it('shows nothing before the transcript is read, with one speaker, with no lines, or when no line has text left', () => {
    expect(card(null)).toBe('');
    expect(card(transcript([segment('Lan', 0, 10), segment('Lan', 10, 20)]))).toBe('');
    expect(card(transcript([]))).toBe('');
    expect(card(transcript([segment('Lan', 0, 10, ''), segment('Hùng', 10, 20, '  ')]))).toBe('');
  });

  it('leaves out a speaker whose lines have no text left', () => {
    expect(card(transcript([segment('Lan', 0, 10), segment('Hùng', 10, 20, ''), segment('An', 20, 25)])).includes('Hùng')).toBe(false);
  });

  it('writes a speaker name as plain text, never as markup', () => {
    const html = card(transcript([segment('<img src=x onerror=alert(1)> & <b>Lan</b>', 0, 10), segment('Hùng', 10, 15)]));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &lt;b&gt;Lan&lt;/b&gt;');
  });

  it('has Vietnamese words for everything it shows', () => {
    const html = card(TWO, 'vi');
    expect(html).toContain(viMessages.meetings.talkTime.title);
    expect(html).toContain(viMessages.meetings.talkTime.speaker);
    expect(html).toContain(viMessages.meetings.talkTime.longest);
    expect(Object.keys(viMessages.meetings.talkTime).sort()).toEqual(Object.keys(en.meetings.talkTime).sort());
  });
});

describe('the line under the summary', () => {
  it('names each speaker with a whole percentage', () => {
    expect(textOf(lineOf(TWO))).toBe('Talk time: Lan 80%, Hùng 20%');
    expect(textOf(lineOf(TWO, 'vi'))).toBe('Thời gian nói: Lan 80%, Hùng 20%');
  });

  it('lists the three biggest shares and says how many others there are', () => {
    const four = transcript([segment('An', 0, 40), segment('Bình', 40, 70), segment('Chi', 70, 90), segment('Dũng', 90, 100)]);
    expect(textOf(lineOf(four))).toBe('Talk time: An 40%, Bình 30%, Chi 20% and 1 other');
    const five = transcript([...four.segments, segment('Em', 100, 110)]);
    expect(textOf(lineOf(five))).toContain('and 2 others');
  });

  it('shows nothing for one speaker or when no line has text left', () => {
    expect(lineOf(null)).toBe('');
    expect(lineOf(transcript([segment('Lan', 0, 10)]))).toBe('');
    expect(lineOf(transcript([segment('Lan', 0, 10, ''), segment('Hùng', 10, 20, '')]))).toBe('');
  });
});
