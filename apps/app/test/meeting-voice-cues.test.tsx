// SPDX-License-Identifier: AGPL-3.0-only
// Cues spoken to Vy on a meeting's page (#4807): the card with the recorder's click shows only to the recorder and only when the meeting has a transcript, what a click did is said in words (items added,
// then what was left out and why), an item drafted from a cue carries the "Nói với Vy" badge, and everything has Vietnamese and English words. Rendered on the server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingResults, Transcript, VoiceCueDrafted } from '@ludy/kernel-contract';
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
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) };
});

const { MeetingVoiceCues, useVoiceCueSummary } = await import('../src/components/meeting-voice-cues.tsx');
const { MeetingResults: Results } = await import('../src/components/meeting-results.tsx');

const segment = { id: 's1', startSeconds: 12, endSeconds: 20, speakerLabel: 'Lan', text: 'Vy ơi, ghi lại gửi báo giá', stage: 'draft' as const, corrected: false, source: 'ludy' as const };
const transcript = (segments: Transcript['segments']): Transcript => ({ meetingId: 'm1', isRecorder: true, stage: segments.length === 0 ? 'none' : 'draft', segments });

const wrap = (node: React.ReactNode, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
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

beforeEach(() => client.current.clear());

describe('the card', () => {
  it('shows with a transcript, says what it does and that no AI is used', () => {
    client.current.setQueryData(['meetings', 'transcript', 'get'], transcript([segment]));
    const html = wrap(<MeetingVoiceCues meetingId="m1" />);
    expect(html).toContain('data-testid="voice-cues"');
    expect(html).toContain('data-testid="voice-cues-find"');
    expect(textOf(html)).toContain(en.meetings.results.voiceCues.find);
    expect(textOf(html)).toContain('no AI');
  });

  it('is not there before the transcript is read, without a transcript, or when reading it failed', () => {
    expect(wrap(<MeetingVoiceCues meetingId="m1" />)).toBe('');
    client.current.setQueryData(['meetings', 'transcript', 'get'], transcript([]));
    expect(wrap(<MeetingVoiceCues meetingId="m1" />)).toBe('');
    client.current.setQueryData(['meetings', 'transcript', 'get'], transcript([segment]));
    client.current.getQueryCache().find({ queryKey: ['meetings', 'transcript', 'get'] })?.setState({ status: 'error', error: new Error('MEETING_NOT_FOUND'), fetchStatus: 'idle' });
    expect(wrap(<MeetingVoiceCues meetingId="m1" />)).toBe('');
  });

  it('has Vietnamese words, with the same keys as English', () => {
    client.current.setQueryData(['meetings', 'transcript', 'get'], transcript([segment]));
    const html = wrap(<MeetingVoiceCues meetingId="m1" />, 'vi');
    expect(textOf(html)).toContain(viMessages.meetings.results.voiceCues.find);
    expect(Object.keys(viMessages.meetings.results.voiceCues).sort()).toEqual(Object.keys(en.meetings.results.voiceCues).sort());
    expect(viMessages.meetings.results.flagAskedAloud).toBeTruthy();
    expect(en.meetings.results.flagAskedAloud).toBeTruthy();
  });
});

describe('what a click did, in words', () => {
  const said = (r: Partial<VoiceCueDrafted>, locale: 'en' | 'vi' = 'en') => {
    function Probe() {
      return <>{useVoiceCueSummary()({ meetingId: 'm1', found: 0, created: 0, duplicate: 0, empty: 0, full: 0, ...r })}</>;
    }
    return textOf(wrap(<Probe />, locale));
  };

  it('says there is no cue when the transcript has none', () => {
    expect(said({})).toBe(en.meetings.results.voiceCues.none);
  });

  it('counts the items added, then what was left out and why', () => {
    expect(said({ found: 1, created: 1 })).toBe('1 draft item added from the cues.');
    expect(said({ found: 5, created: 3, duplicate: 1, empty: 1 })).toBe('3 draft items added from the cues. Left out: 1 cue already had an item, 1 cue with nothing to write down.');
    expect(said({ found: 2, duplicate: 2 })).toBe('No new draft items. Left out: 2 cues already had an item.');
    expect(said({ found: 4, created: 1, full: 3 })).toBe('1 draft item added from the cues. Left out: 3 cues because the meeting has all the items it may hold.');
    expect(said({ found: 2, created: 2 }, 'vi')).toBe('Đã thêm 2 việc nháp từ lệnh đã nói.');
  });
});

describe('an item drafted from a cue', () => {
  const results = (flags: Array<'contact_in_title' | 'asked_aloud'>): MeetingResults => ({
    meetingId: 'm1',
    isRecorder: true,
    draft: null,
    published: null,
    items: [{ id: 'i1', stage: 'draft', status: 'suggested', title: 'Gửi báo giá', who: 'anh Nam', whoUserId: null, when: 'thứ Sáu', whenDate: '2026-11-27', transcriptSeconds: 12, flags, tainted: true, taskId: null, positions: [], clean: false, suggestion: null }],
  });
  const render = (flags: Array<'contact_in_title' | 'asked_aloud'>) => {
    client.current.setQueryData(['meetings', 'results', 'get'], results(flags));
    return wrap(
      <Results meetingId="m1" slug="acme" visibility="attendees" readers={[]} template="general" minutesTemplate={null} title="Họp" minutesLink={null} />,
    );
  };

  it('carries the badge, the second it was said and the taint badge of any Vy item', () => {
    const text = textOf(render(['asked_aloud']));
    expect(text).toContain(en.meetings.results.flagAskedAloud);
    expect(text).toContain('0:12');
    expect(text).toContain(en.meetings.results.fromVy);
  });

  it('has no such badge on an ordinary item', () => {
    expect(textOf(render([]))).not.toContain(en.meetings.results.flagAskedAloud);
  });
});
