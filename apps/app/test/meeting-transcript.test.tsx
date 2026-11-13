// SPDX-License-Identifier: AGPL-3.0-only
// The transcript panel on a meeting's page (#2578, M4a): the recorder sees a draft with times, speakers and a way to correct
// each line; another reader sees only what was published, with no edit control; nobody else sees an empty box. Rendered on the
// server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { Transcript } from '@crove/kernel-contract';
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

const { MeetingTranscript, clock } = await import('../src/components/meeting-transcript.tsx');

const segment = (id: string, startSeconds: number, text: string, over: Partial<Transcript['segments'][number]> = {}) => ({
  id,
  startSeconds,
  endSeconds: startSeconds + 5,
  speakerLabel: 'Lan',
  text,
  stage: 'draft' as const,
  corrected: false,
  ...over,
});

function render(transcript: Transcript, locale: 'en' | 'vi' = 'en') {
  client.current.setQueryData(['meetings', 'transcript', 'get'], transcript);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingTranscript meetingId="m1" />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('clock', () => {
  it('writes seconds as m:ss under an hour and h:mm:ss from an hour', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65.9)).toBe('1:05');
    expect(clock(3599)).toBe('59:59');
    expect(clock(3725.4)).toBe('1:02:05');
    expect(clock(-3)).toBe('0:00');
  });
});

describe('MeetingTranscript', () => {
  const draft: Transcript = {
    meetingId: 'm1',
    isRecorder: true,
    stage: 'draft',
    segments: [segment('a', 0, 'Xin chào mọi người'), segment('b', 3725, 'Hẹn gặp lại', { speakerLabel: 'Anh Nam', corrected: true })],
  };

  it('shows the recorder the draft with times, speakers, the private note and a correct button per line', () => {
    const html = render(draft);
    expect(html).toContain(en.meetings.transcript.draftTitle);
    expect(html).toContain('Only you see this draft');
    expect(html).toContain('Xin chào mọi người');
    expect(html).toContain('0:00');
    expect(html).toContain('1:02:05');
    expect(html).toContain('Anh Nam');
    expect(html.match(/data-testid="transcript-line"/g)).toHaveLength(2);
    expect(html).toContain('Correct the line at 0:00');
    expect(html).toContain(en.meetings.transcript.corrected);
  });

  it('shows another reader published lines only, with no edit control and no draft wording', () => {
    const html = render({ meetingId: 'm1', isRecorder: false, stage: 'published', segments: [segment('c', 10, 'Đã công bố', { stage: 'published' })] });
    expect(html).toContain('Đã công bố');
    expect(html).toContain(en.meetings.transcript.title);
    expect(html).not.toContain(en.meetings.transcript.draftTitle);
    expect(html).not.toContain('Correct the line');
  });

  it('says nothing to a reader when no transcript is shared, and tells the recorder the meeting works without one', () => {
    expect(render({ meetingId: 'm1', isRecorder: false, stage: 'none', segments: [] })).toBe('');
    const html = render({ meetingId: 'm1', isRecorder: true, stage: 'none', segments: [] });
    expect(html).toContain('No transcript yet');
    expect(html).toContain('work without one');
  });

  it('is worded in Vietnamese too', () => {
    const html = render(draft, 'vi');
    expect(html).toContain(viMessages.meetings.transcript.draftTitle);
    expect(html).toContain('Chỉ bạn thấy bản nháp này');
  });
});

describe('the recorder\'s transcription card (#3033)', () => {
  const none: Transcript = { meetingId: 'm1', isRecorder: true, stage: 'none', segments: [] };
  const withStatus = (status: { state: string; runId: string | null; errorCode: string | null }, locale: 'en' | 'vi' = 'en') => {
    client.current.setQueryData(['meetings', 'transcript', 'status'], { meetingId: 'm1', enabled: true, ...status });
    try {
      return render(none, locale);
    } finally {
      client.current.removeQueries({ queryKey: ['meetings', 'transcript', 'status'] });
    }
  };

  it('offers a way to stop a run that is going, with its hint, in both languages, and no start button meanwhile', () => {
    const html = withStatus({ state: 'running', runId: 'r1', errorCode: null });
    expect(html).toContain(en.meetings.transcript.vy.running);
    expect(html).toContain(en.meetings.transcript.vy.stop);
    expect(html).toContain(en.meetings.transcript.vy.stopHint);
    expect(html).not.toContain(en.meetings.transcript.vy.start);
    const vn = withStatus({ state: 'running', runId: 'r1', errorCode: null }, 'vi');
    expect(vn).toContain(viMessages.meetings.transcript.vy.stop);
    expect(vn).toContain(viMessages.meetings.transcript.vy.stopHint);
  });

  it('shows no stop button when nothing is running, and says in words that the recorder stopped a run', () => {
    expect(withStatus({ state: 'none', runId: null, errorCode: null })).not.toContain(en.meetings.transcript.vy.stop);
    expect(withStatus({ state: 'ready', runId: 'r1', errorCode: null })).not.toContain(en.meetings.transcript.vy.stop);
    const stopped = withStatus({ state: 'failed', runId: 'r1', errorCode: 'RUN_CANCELLED' });
    expect(stopped).toContain(en.meetings.transcript.vy.codes.RUN_CANCELLED);
    expect(stopped).not.toContain(en.meetings.transcript.vy.stopHint);
    expect(withStatus({ state: 'failed', runId: 'r1', errorCode: 'RUN_CANCELLED' }, 'vi')).toContain(viMessages.meetings.transcript.vy.codes.RUN_CANCELLED);
  });
});
