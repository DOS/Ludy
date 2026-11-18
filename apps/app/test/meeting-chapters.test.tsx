// SPDX-License-Identifier: AGPL-3.0-only
// The chapters (table of contents) on a meeting's page (#3844): every reader sees the published set with the time of each line (a click takes the transcript there), a reader of a meeting with none
// sees no card, the recorder also sees their own draft editor (a title and the line it starts at, picked from the transcript), titles are plain text, and the transcript marks the line that starts at the second it is given (the click, the audio seek and the
// save are not run here). Rendered on the server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { Chapter, Chapters, Transcript } from '@crove/kernel-contract';
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

const { MeetingChapters } = await import('../src/components/meeting-chapters.tsx');
const { MeetingTranscript } = await import('../src/components/meeting-transcript.tsx');

const chapter = (id: string, position: number, title: string, startSeconds: number, tainted = false): Chapter => ({ id, position, title, startSeconds, tainted });
const segment = (id: string, startSeconds: number, text: string) => ({ id, startSeconds, endSeconds: startSeconds + 5, speakerLabel: 'Lan', text, stage: 'published' as const, corrected: false, source: 'ludy' as const });
const TRANSCRIPT: Transcript = {
  meetingId: 'm1',
  isRecorder: true,
  stage: 'published',
  segments: [segment('s1', 0, 'Chào mọi người'), segment('s2', 10.4, 'Bàn về báo giá'), segment('s3', 3725.4, 'Kế hoạch giao hàng')],
};
const wrap = (node: React.ReactNode, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const show = (data: Chapters, isRecorder: boolean, locale: 'en' | 'vi' = 'en') => {
  client.current.setQueryData(['meetings', 'results', 'chaptersGet'], data);
  client.current.setQueryData(['meetings', 'transcript', 'get'], TRANSCRIPT);
  return wrap(<MeetingChapters meetingId="m1" isRecorder={isRecorder} onJump={() => undefined} />, locale);
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
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>((?:(?!<\/button>).)*)<\/button>/g)].map((m) => ({ attrs: m[1] ?? '', text: textOf(m[2] ?? '') }));
const isDisabled = (attrs: string) => /\sdisabled(=|\s|>|$)/.test(attrs);

const PUBLISHED = [chapter('c1', 1, 'Mở đầu', 0), chapter('c2', 2, 'Báo giá', 10), chapter('c3', 3, 'Giao hàng', 3725)];

describe('what a reader sees', () => {
  it('lists the published chapters, each a button with the time of its line, and nothing of any editor', () => {
    const html = show({ meetingId: 'm1', draft: [], published: PUBLISHED }, false);
    expect(html).toContain('data-testid="meeting-chapters"');
    expect(html).toContain(en.meetings.chapters.readerNote);
    const list = buttons(html).filter((b) => b.attrs.includes(`title="${en.meetings.chapters.jump}"`));
    expect(list.map((b) => b.text)).toEqual(['0:00Mở đầu', '0:10Báo giá', '1:02:05Giao hàng']);
    expect(html).not.toContain('data-testid="chapter-editor"');
    expect(html).not.toContain(en.meetings.chapters.draftTitle);
  });

  it('shows no card at all when no chapters are published', () => {
    expect(show({ meetingId: 'm1', draft: [], published: [] }, false)).toBe('');
  });

  it('writes a title as plain text, never as markup', () => {
    const html = show({ meetingId: 'm1', draft: [], published: [chapter('c1', 1, '<img src=x onerror=alert(1)> & <b>đậm</b>', 0)] }, false);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &lt;b&gt;đậm&lt;/b&gt;');
  });

  it('has Vietnamese words for everything it shows', () => {
    const html = show({ meetingId: 'm1', draft: [], published: PUBLISHED }, false, 'vi');
    expect(html).toContain(viMessages.meetings.chapters.title);
    expect(html).toContain(viMessages.meetings.chapters.readerNote);
    expect(Object.keys(viMessages.meetings.chapters.errors).sort()).toEqual(Object.keys(en.meetings.chapters.errors).sort());
  });
});

describe('what the recorder sees', () => {
  it('shows the editor with the way to add a chapter, and nothing to save until something changes', () => {
    const html = show({ meetingId: 'm1', draft: [], published: [] }, true);
    expect(html).toContain('data-testid="chapter-editor"');
    expect(html).toContain(en.meetings.chapters.draftNote);
    expect(html).toContain(en.meetings.chapters.none);
    const add = buttons(html).find((b) => b.text === en.meetings.chapters.add);
    expect(add).toBeDefined();
    expect(isDisabled(add?.attrs ?? '')).toBe(false);
    expect(isDisabled(buttons(html).find((b) => b.text === en.meetings.chapters.save)?.attrs ?? '')).toBe(true);
  });

  it('shows the draft rows with their titles and the line each starts at, picked from the transcript', () => {
    const html = show({ meetingId: 'm1', draft: [chapter('d1', 1, 'Mở đầu', 0, false), chapter('d2', 2, 'Báo giá', 10, false)], published: PUBLISHED }, true);
    expect(html.match(/data-testid="chapter-row"/g)).toHaveLength(2);
    expect(html).toContain('value="Mở đầu"');
    expect(html).toContain('value="Báo giá"');
    // The lines of the transcript, at their whole second, with the start of their text.
    expect(html).toContain('0:00 · Chào mọi người');
    expect(html).toContain('0:10 · Bàn về báo giá');
    expect(html).toContain('1:02:05 · Kế hoạch giao hàng');
    // The published set is read above the draft, with its own heading.
    expect(html).toContain(en.meetings.chapters.publishedTitle);
    expect(html).toContain(en.meetings.chapters.draftTitle);
  });

  it('starts the editor from the published set when there is no draft, so the next publish replaces it', () => {
    const html = show({ meetingId: 'm1', draft: [], published: PUBLISHED }, true);
    expect(html.match(/data-testid="chapter-row"/g)).toHaveLength(3);
    expect(html).toContain('value="Giao hàng"');
  });
});

describe('a click on a chapter', () => {
  it('marks the transcript line that starts at its second, and only that line', () => {
    client.current.setQueryData(['meetings', 'transcript', 'get'], TRANSCRIPT);
    const html = wrap(<MeetingTranscript meetingId="m1" focusSecond={{ second: 10, token: 1 }} />);
    const lines = html.split('data-testid="transcript-line"').slice(1);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.includes('data-focused'))).toEqual([false, true, false]);
    // A second no line starts at marks none.
    const none = wrap(<MeetingTranscript meetingId="m1" focusSecond={{ second: 11, token: 2 }} />);
    expect(none).not.toContain('data-focused');
  });
});
