// SPDX-License-Identifier: AGPL-3.0-only
// The platform's own transcript, in the download job of the recording import (meetings integrations C2, #3174): a recording with neither an audio nor a video file is not downloaded; the adapter reads the
// transcript through its own API, the job bounds every line again (the platform's text is tainted) and stages JSON `{ segments }` under the row's staging key. The platform is a fake, the blob store a real
// one on a temporary directory.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MeetingPlatformError, type MeetingPlatformAdapter, type MeetingPlatformTranscript, type MeetingPlatformTranscriptEntry } from '@crove/channel';
import { TRANSCRIPT_SEGMENTS_MAX, TRANSCRIPT_SPEAKER_MAX, TRANSCRIPT_TEXT_MAX, zMeetingTranscriptImport } from '@crove/kernel-contract';
import { LocalDiskStore } from '@crove/kernel-runtime';
import { runMeetingsImport, stageTranscript, UNKNOWN_SPEAKER, type MeetingsImportDeps, type MeetingsImportJob } from '../src/meetings-import.ts';

const KEY = `staging/${'d'.repeat(64)}`;
const job = (over: Partial<MeetingsImportJob> = {}): MeetingsImportJob => ({
  orgId: '00000000-0000-4000-8000-000000000001',
  id: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003',
  provider: 'sandbox',
  externalId: 'rec-transcript',
  hasAudio: false,
  hasVideo: false,
  sizeBytes: null,
  stagingKey: KEY,
  ...over,
});
const attempt = { retryCount: 0, retryLimit: 3 };
const entry = (over: Partial<MeetingPlatformTranscriptEntry> = {}): MeetingPlatformTranscriptEntry => ({ startSeconds: 1, endSeconds: 4, speaker: 'Trần Thị Lan', text: 'Chào mọi người.', ...over });
const transcript = (entries: MeetingPlatformTranscriptEntry[]): MeetingPlatformTranscript => ({ source: 'google_meet', language: 'vi', truncated: false, entries });

let dir: string;
let store: LocalDiskStore;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crove-import-transcript-'));
  store = new LocalDiskStore(dir);
});
afterEach(async () => {
  await store.delete(KEY);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const staged = async () => JSON.parse(new TextDecoder().decode((await store.get(KEY)) as Uint8Array)) as { segments: unknown[] };

function setup(adapter: Partial<MeetingPlatformAdapter>) {
  const executed: string[] = [];
  const calls = { transcript: 0, prepareDownload: 0 };
  const full: MeetingPlatformAdapter = {
    provider: 'sandbox',
    hosts: [],
    list: async () => [],
    prepareDownload: async () => {
      calls.prepareDownload += 1;
      throw new MeetingPlatformError('platform_refused');
    },
    ...adapter,
  };
  if (full.transcript) {
    const inner = full.transcript.bind(full);
    full.transcript = async (...args) => {
      calls.transcript += 1;
      return inner(...args);
    };
  }
  const deps = {
    runtime: {
      query: async (name: string) => (name === 'kernel.meeting_platform.credential' ? { keyId: 'k', envelope: Buffer.from('x').toString('base64'), provider: 'sandbox', externalAccount: 'a@b' } : 'importing'),
      execute: async (name: string, input: Record<string, unknown>) => {
        executed.push(`${name}:${String(input.code ?? '')}`);
        return { applied: 1 };
      },
    },
    broker: { id: 'test', open: () => JSON.stringify({ accessToken: 't' }) },
    store,
    adapters: { sandbox: full },
    extractor: null,
  } as unknown as MeetingsImportDeps;
  return { deps, executed, calls };
}

const failedWith = (code: string) => `kernel.meeting_platform.import_failed:${code}`;
const STAGED = 'kernel.meeting_platform.import_staged:';

describe('stageTranscript', () => {
  it('keeps the lines the draft takes and bounds the rest: text and speaker are cut, an empty line is dropped, times are clamped and a missing speaker gets a neutral label', () => {
    const bytes = stageTranscript(
      transcript([
        entry(),
        entry({ speaker: null, text: '  Không rõ ai nói.  ' }),
        entry({ text: '   ' }),
        entry({ text: 'x'.repeat(TRANSCRIPT_TEXT_MAX + 50), speaker: 'S'.repeat(TRANSCRIPT_SPEAKER_MAX + 20) }),
        entry({ startSeconds: -5, endSeconds: 999_999 }),
        entry({ startSeconds: 9, endSeconds: 3 }),
        entry({ startSeconds: Number.NaN }),
        entry({ text: 'a\u0000b', speaker: '\u0000Lan\u0000' }),
      ]),
    );
    const { segments } = JSON.parse(new TextDecoder().decode(bytes)) as { segments: Array<{ startSeconds: number; endSeconds: number; speakerLabel: string; text: string }> };
    expect(segments).toHaveLength(6);
    expect(segments[1]).toMatchObject({ speakerLabel: UNKNOWN_SPEAKER, text: 'Không rõ ai nói.' });
    expect(segments[2]?.text).toHaveLength(TRANSCRIPT_TEXT_MAX);
    expect(segments[2]?.speakerLabel).toHaveLength(TRANSCRIPT_SPEAKER_MAX);
    expect(segments[3]).toMatchObject({ startSeconds: 0, endSeconds: 86_400 });
    expect(segments[4]).toMatchObject({ startSeconds: 9, endSeconds: 9 });
    // A NUL byte is dropped from text and speaker (Postgres refuses it in a text column).
    expect(segments[5]).toMatchObject({ speakerLabel: 'Lan', text: 'ab' });
    // What is staged is exactly what the command's own schema takes, so the import route can validate it again.
    expect(zMeetingTranscriptImport.safeParse({ meetingId: '00000000-0000-4000-8000-000000000009', segments }).success).toBe(true);
  });

  it('reads at most as many lines as a draft holds, and refuses a transcript with no usable line or one too big to stage', () => {
    const many = Array.from({ length: TRANSCRIPT_SEGMENTS_MAX + 10 }, (_, i) => entry({ startSeconds: i, endSeconds: i + 1, text: `dòng ${i}` }));
    expect((JSON.parse(new TextDecoder().decode(stageTranscript(transcript(many)))) as { segments: unknown[] }).segments).toHaveLength(TRANSCRIPT_SEGMENTS_MAX);
    expect(() => stageTranscript(transcript([]))).toThrow(MeetingPlatformError);
    expect(() => stageTranscript(transcript([entry({ text: '' })]))).toThrow(/no_transcript/);
    // 5000 lines of 4000 two-byte characters are about 40 MB, over the staged cap.
    const huge = Array.from({ length: TRANSCRIPT_SEGMENTS_MAX }, () => entry({ text: 'é'.repeat(TRANSCRIPT_TEXT_MAX) }));
    expect(() => stageTranscript(transcript(huge))).toThrow(/too_large/);
  });
});

describe('a transcript-only recording in the import job', () => {
  it('asks the adapter for the transcript (never for a download) and stages the lines under the row\'s key', async () => {
    const run = setup({ transcript: async () => transcript([entry(), entry({ speaker: null, text: 'Vâng.' })]) });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('staged');
    expect(run.executed).toEqual([STAGED]);
    expect(run.calls).toEqual({ transcript: 1, prepareDownload: 0 });
    expect((await staged()).segments).toEqual([
      { startSeconds: 1, endSeconds: 4, speakerLabel: 'Trần Thị Lan', text: 'Chào mọi người.' },
      { startSeconds: 1, endSeconds: 4, speakerLabel: UNKNOWN_SPEAKER, text: 'Vâng.' },
    ]);
  });

  it('fails with a short code and stages nothing when no line is usable, the administrator turned transcripts off, or the recording is gone', async () => {
    for (const [reply, code] of [
      [async () => transcript([entry({ text: '' })]), 'no_transcript'],
      [async () => Promise.reject(new MeetingPlatformError('transcripts_disabled')), 'transcripts_disabled'],
      [async () => Promise.reject(new MeetingPlatformError('recording_gone')), 'recording_gone'],
    ] as const) {
      const run = setup({ transcript: reply });
      expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
      expect(run.executed).toEqual([failedWith(code)]);
      expect(await store.get(KEY).catch(() => null)).toBeNull();
    }
  });

  it('retries a platform that is down (the queue tries again) and records the failure on the last try', async () => {
    const run = setup({ transcript: async () => Promise.reject(new MeetingPlatformError('platform_unavailable')) });
    await expect(runMeetingsImport(run.deps, job(), attempt)).rejects.toThrow(/not staged/);
    expect(run.executed).toEqual([]);
    expect(await runMeetingsImport(run.deps, job(), { retryCount: 3, retryLimit: 3 })).toBe('failed');
    expect(run.executed).toEqual([failedWith('platform_unavailable')]);
  });

  it('is only for a row with neither file: an adapter without a transcript path fails no_audio, and a video-only row without an extractor never reads the transcript', async () => {
    const without = setup({});
    expect(await runMeetingsImport(without.deps, job(), attempt)).toBe('failed');
    expect(without.executed).toEqual([failedWith('no_audio')]);
    expect(without.calls).toEqual({ transcript: 0, prepareDownload: 0 });
    const videoOnly = setup({ transcript: async () => transcript([entry()]) });
    expect(await runMeetingsImport(videoOnly.deps, job({ hasVideo: true }), attempt)).toBe('failed');
    expect(videoOnly.executed).toEqual([failedWith('no_audio')]);
    expect(videoOnly.calls).toEqual({ transcript: 0, prepareDownload: 0 });
  });
});
