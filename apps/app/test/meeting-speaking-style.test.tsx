// SPDX-License-Identifier: AGPL-3.0-only
// How each speaker spoke on a meeting's page (#4919): the card with each speaker's pace, filler words (count, share, the most used) and longest stretch, from the answer of meetings.speaking_style.get.
// It shows nothing while there is no answer, with no speaker or when the read failed, shows a missing pace as a dash, writes names as plain text and works in vi and en.
// Rendered on the server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { SpeakingStyle } from '@ludy/kernel-contract';
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

const { MeetingSpeakingStyle } = await import('../src/components/meeting-speaking-style.tsx');

const speaker = (name: string, over: Partial<SpeakingStyle['speakers'][number]> = {}): SpeakingStyle['speakers'][number] => ({
  speaker: name,
  seconds: 120,
  words: 240,
  wordsPerMinute: 120,
  fillerWords: 8,
  fillerShare: 8 / 240,
  fillerTop: [
    { word: 'ờ', count: 5 },
    { word: 'you know', count: 3 },
  ],
  longestStretchSeconds: 75,
  ...over,
});
const answer = (speakers: SpeakingStyle['speakers']): SpeakingStyle => ({ meetingId: 'm1', stage: 'published', speakers });

const card = (data: SpeakingStyle | null, locale: 'en' | 'vi' = 'en') => {
  if (data) client.current.setQueryData(['meetings', 'speakingStyle', 'get'], data);
  else client.current.removeQueries({ queryKey: ['meetings', 'speakingStyle', 'get'] });
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingSpeakingStyle meetingId="m1" />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

describe('MeetingSpeakingStyle', () => {
  it('shows each speaker with their pace, filler words with the share and the most used, and the longest stretch', () => {
    const html = card(answer([speaker('Lan'), speaker('Hùng', { wordsPerMinute: 95, fillerWords: 0, fillerShare: 0, fillerTop: [], longestStretchSeconds: 5 })]));
    expect(html).toContain('data-testid="meeting-speaking-style"');
    expect(html).toContain(en.meetings.speakingStyle.title);
    expect(html.match(/data-testid="speaking-style-row"/g)).toHaveLength(2);
    expect(html).toContain('Lan');
    expect(html).toContain('120');
    expect(html).toContain('(3.3%)');
    expect(html).toContain('ờ ×5, you know ×3');
    expect(html).toContain('1:15');
    expect(html).toContain('Hùng');
    expect(html).toContain('(0.0%)');
    expect(html).toContain('0:05');
    expect(html).toContain(en.meetings.speakingStyle.note);
  });

  it('shows a dash for a pace that was not given and for no filler word', () => {
    const html = card(answer([speaker('Lan', { wordsPerMinute: null, fillerWords: 0, fillerShare: 0, fillerTop: [] })]));
    expect(html.match(/>-</g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('shows nothing with no answer, with no speaker or when the answer is gone', () => {
    expect(card(null)).toBe('');
    expect(card(answer([]))).toBe('');
  });

  it('writes a name as plain text, never as markup', () => {
    const html = card(answer([speaker('<img src=x onerror=alert(1)>')]));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('is worded in Vietnamese with the decimal comma and the card title "Cách nói"', () => {
    const html = card(answer([speaker('Lan')]), 'vi');
    expect(html).toContain(viMessages.meetings.speakingStyle.title);
    expect(viMessages.meetings.speakingStyle.title).toBe('Cách nói');
    expect(html).toContain('(3,3%)');
    expect(html).toContain(viMessages.meetings.speakingStyle.note);
    expect(html).not.toContain('Pace');
  });

  it('has the same keys in both languages', () => {
    expect(Object.keys(viMessages.meetings.speakingStyle).sort()).toEqual(Object.keys(en.meetings.speakingStyle).sort());
  });
});
