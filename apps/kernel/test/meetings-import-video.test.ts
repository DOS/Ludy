// SPDX-License-Identifier: AGPL-3.0-only
// The audio of a platform's video file, in the download job of the recording import (meetings integrations C2a, #3306): a recording with only a video file is sealed as it arrives, crove-media returns
// only the audio, and only that audio is staged. The video is never held whole in the worker and never kept: the throwaway copy is deleted on every outcome. The platform and the sandbox are fakes, the
// blob store is a real one on a temporary directory (so the sealing and the reading back are the real ones).
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { minimalMp4, type MeetingPlatformAdapter, type MeetingPlatformDownload } from '@ludy/channel';
import { MEETING_PLATFORM_IMPORT_MAX_BYTES, MEETING_PLATFORM_VIDEO_MAX_BYTES } from '@ludy/kernel-contract';
import { EgressError, LocalDiskStore, type EgressStream } from '@ludy/kernel-runtime';
import { MediaClientError, type MediaExtractClient } from '@ludy/media-contract/extract';
import { createMediaAudioExtractor } from '../src/meetings-extract.ts';
import { runMeetingsImport, type MeetingsImportDeps, type MeetingsImportJob } from '../src/meetings-import.ts';

const KEY = `staging/${'b'.repeat(64)}`;
const OPUS = new Uint8Array([79, 103, 103, 83, 9, 8, 7]);
const job = (over: Partial<MeetingsImportJob> = {}): MeetingsImportJob => ({
  orgId: '00000000-0000-4000-8000-000000000001',
  id: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003',
  provider: 'sandbox',
  externalId: 'rec-video',
  hasAudio: false,
  hasVideo: true,
  sizeBytes: null,
  stagingKey: KEY,
  ...over,
});
const attempt = { retryCount: 0, retryLimit: 3 };

let dir: string;
let store: LocalDiskStore;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crove-import-video-'));
  store = new LocalDiskStore(dir);
});
// Each test starts with nothing staged and no throwaway copy of a video on disk, whatever an earlier one left.
afterEach(async () => {
  await store.delete(KEY);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Every file under the store's directory: after a job only the staged audio may be left (never a sealed video).
async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}

// A video file's bytes: the MP4 header the container check wants, then filler.
const video = (size: number): Uint8Array => {
  const out = new Uint8Array(size);
  out.set(minimalMp4());
  for (let i = 24; i < size; i++) out[i] = i % 251;
  return out;
};

interface Run {
  deps: MeetingsImportDeps;
  executed: string[];
  drained: Uint8Array[];
  opened: { n: number; iterated: number };
}

// `answer` is what the sandbox says; `download` what the platform adapter hands out; `body` the pieces of the streamed answer and `declared` its Content-Length (undefined: none).
function setup(options: { answer?: () => Promise<{ audio: Uint8Array; durationSeconds: number }>; download: Partial<MeetingPlatformDownload>; body?: Uint8Array[]; declared?: number | undefined; extractor?: boolean }): Run {
  const executed: string[] = [];
  const drained: Uint8Array[] = [];
  const opened = { n: 0, iterated: 0 };
  const client: MeetingExtractClient = {
    extractAudio: async (source) => {
      for await (const piece of source) drained.push(piece);
      return (options.answer ?? (async () => ({ audio: OPUS, durationSeconds: 2 })))();
    },
  };
  const adapter: MeetingPlatformAdapter = {
    provider: 'sandbox',
    hosts: ['platform.test'],
    list: async () => [],
    prepareDownload: async () => ({ url: 'https://platform.test/file', headers: {}, format: 'video', hosts: ['platform.test'], hostSuffixes: [], ...options.download }),
  };
  const stream = async (): Promise<EgressStream> => {
    opened.n += 1;
    const pieces = options.body ?? [];
    return {
      url: 'https://platform.test/file',
      status: 200,
      headers: options.declared === undefined ? {} : { 'content-length': String(options.declared) },
      body: (async function* () {
        for (const piece of pieces) {
          opened.iterated += 1;
          yield piece;
        }
      })(),
      destroy: () => undefined,
    };
  };
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
    adapters: { sandbox: adapter },
    extractor: options.extractor === false ? null : createMediaAudioExtractor(client),
    stream,
  } as unknown as MeetingsImportDeps;
  return { deps, executed, drained, opened };
}
type MeetingExtractClient = MediaExtractClient;

const failedWith = (code: string) => `kernel.meeting_platform.import_failed:${code}`;
const STAGED = 'kernel.meeting_platform.import_staged:';

describe('a video-only recording', () => {
  it('stages only the audio crove-media returns, reads the video back whole and leaves no copy of it (inline, as the offline sandbox hands it out)', async () => {
    const mp4 = video(3000);
    const run = setup({ download: { inline: { bytes: mp4, contentType: 'video/mp4' }, url: 'sandbox://local/rec-video', hosts: [] } });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('staged');
    expect(run.executed).toEqual([STAGED]);
    expect(Buffer.concat(run.drained)).toEqual(Buffer.from(mp4));
    expect(new Uint8Array((await store.get(KEY)) as Uint8Array)).toEqual(OPUS);
    // Only the staged audio is on disk: the sealed video was deleted.
    expect((await files(dir)).filter((f) => !f.includes('staging'))).toEqual([]);
    await store.delete(KEY);
  });

  it('streams the download: several pieces arrive, the sandbox gets the whole video, and only the audio is staged', async () => {
    const mp4 = video(70_000);
    const pieces = [mp4.slice(0, 20_000), mp4.slice(20_000, 50_000), mp4.slice(50_000)];
    const run = setup({ download: {}, body: pieces, declared: mp4.byteLength });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('staged');
    expect(run.opened.iterated).toBe(3);
    expect(Buffer.concat(run.drained)).toEqual(Buffer.from(mp4));
    expect(new Uint8Array((await store.get(KEY)) as Uint8Array)).toEqual(OPUS);
    expect((await files(dir)).filter((f) => !f.includes('staging'))).toEqual([]);
    await store.delete(KEY);
  });

  it('refuses it before any network call when no sandbox is configured, as before', async () => {
    const run = setup({ download: {}, extractor: false });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual([failedWith('no_audio')]);
    expect(run.opened.n).toBe(0);
  });

  it('has its own cap: a declared size over the video cap fails too_large before a call, one over the audio cap but under the video cap is let through', async () => {
    const over = setup({ download: {} });
    expect(await runMeetingsImport(over.deps, job({ sizeBytes: MEETING_PLATFORM_VIDEO_MAX_BYTES + 1 }), attempt)).toBe('failed');
    expect(over.executed).toEqual([failedWith('too_large')]);
    expect(over.opened.n).toBe(0);
    // 500 MB is more than the audio cap and less than the video cap: the job goes on to ask the platform (here it answers with a short, real video).
    expect(MEETING_PLATFORM_IMPORT_MAX_BYTES).toBeLessThan(500 * 1024 * 1024);
    const mp4 = video(2000);
    const through = setup({ download: {}, body: [mp4], declared: mp4.byteLength });
    expect(await runMeetingsImport(through.deps, job({ sizeBytes: 500 * 1024 * 1024 }), attempt)).toBe('staged');
    await store.delete(KEY);
  });

  it('fails too_large before reading a byte when the platform declares more than the video cap', async () => {
    const run = setup({ download: {}, body: [video(100)], declared: MEETING_PLATFORM_VIDEO_MAX_BYTES + 1 });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual([failedWith('too_large')]);
    expect(run.opened.iterated).toBe(0);
  });

  it('uses the size the platform listed when the answer declares no length (a chunked answer), and refuses the recording when it has neither', async () => {
    const mp4 = video(4000);
    const listed = setup({ download: {}, body: [mp4.slice(0, 1500), mp4.slice(1500)], declared: undefined });
    expect(await runMeetingsImport(listed.deps, job({ sizeBytes: mp4.byteLength }), attempt)).toBe('staged');
    expect(Buffer.concat(listed.drained)).toEqual(Buffer.from(mp4));
    // A listed size that is wrong is caught by the seal (the body ends longer than declared): retried, never staged.
    const wrong = setup({ download: {}, body: [mp4], declared: undefined });
    await expect(runMeetingsImport(wrong.deps, job({ sizeBytes: mp4.byteLength - 10 }), { retryCount: 0, retryLimit: 3 })).rejects.toThrow(/not staged/);
    const neither = setup({ download: {}, body: [mp4], declared: undefined });
    expect(await runMeetingsImport(neither.deps, job({ sizeBytes: null }), attempt)).toBe('failed');
    expect(neither.executed).toEqual([failedWith('platform_refused')]);
    expect(neither.drained).toEqual([]);
  });

  it('records the platform\'s connection breaking mid-stream, and keeps no copy of the video', async () => {
    const mp4 = video(4000);
    const run = setup({ download: {}, body: [mp4.slice(0, 1000)], declared: mp4.byteLength });
    // The body fails after its first piece, as a connection over the byte cap or past the deadline does.
    const original = run.deps.stream as unknown as () => Promise<EgressStream>;
    (run.deps as unknown as { stream: () => Promise<EgressStream> }).stream = async () => {
      const response = await original();
      return {
        ...response,
        body: (async function* () {
          yield mp4.slice(0, 1000);
          throw new EgressError('too_large', 'over the cap');
        })(),
      };
    };
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual([failedWith('too_large')]);
    expect(await files(dir)).toEqual([]);
  });

  it('keeps the order of the checks of the audio path: a listed size over the cap is refused before a recording with nothing to take', async () => {
    const run = setup({ download: {}, extractor: false });
    expect(await runMeetingsImport(run.deps, job({ sizeBytes: MEETING_PLATFORM_IMPORT_MAX_BYTES + 1 }), attempt)).toBe('failed');
    expect(run.executed).toEqual([failedWith('too_large')]);
  });

  it('retries a body that ends short of what it declared, deletes the throwaway copy, and records download_failed on the last try', async () => {
    const mp4 = video(5000);
    const short = () => setup({ download: {}, body: [mp4.slice(0, 3000)], declared: mp4.byteLength });
    await expect(runMeetingsImport(short().deps, job(), { retryCount: 0, retryLimit: 3 })).rejects.toThrow(/not staged/);
    const last = short();
    expect(await runMeetingsImport(last.deps, job(), { retryCount: 3, retryLimit: 3 })).toBe('failed');
    expect(last.executed).toEqual([failedWith('download_failed')]);
    expect(last.drained).toEqual([]);
    expect(await files(dir)).toEqual([]);
  });

  it('refuses a file that is not a video container, and keeps nothing', async () => {
    const junk = new Uint8Array(2000).fill(7);
    const run = setup({ download: {}, body: [junk], declared: junk.byteLength });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual([failedWith('invalid_media')]);
    expect(await files(dir)).toEqual([]);
  });

  it('records what the sandbox says as a short code: no audio track, unreadable, out of time (no retry), and retries a sandbox that is busy', async () => {
    const mp4 = video(2000);
    const answering = (error: unknown) => setup({ download: {}, body: [mp4], declared: mp4.byteLength, answer: async () => Promise.reject(error) });
    for (const [error, code] of [
      [new MediaClientError('no_audio_stream', 422, 'none'), 'no_audio'],
      [new MediaClientError('malformed_media', 422, 'bad'), 'invalid_media'],
      [new MediaClientError('too_large', 413, 'big'), 'too_large'],
      [new MediaClientError('timeout', 504, 'slow'), 'timeout'],
    ] as const) {
      const run = answering(error);
      expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
      expect(run.executed).toEqual([failedWith(code)]);
      expect(await files(dir)).toEqual([]);
    }
    const busy = answering(new MediaClientError('busy', 503, 'busy'));
    await expect(runMeetingsImport(busy.deps, job(), { retryCount: 0, retryLimit: 3 })).rejects.toThrow(/not staged/);
    const last = answering(new MediaClientError('busy', 503, 'busy'));
    expect(await runMeetingsImport(last.deps, job(), { retryCount: 3, retryLimit: 3 })).toBe('failed');
    expect(last.executed).toEqual([failedWith('normalize_failed')]);
    expect(await files(dir)).toEqual([]);
  });

  it('stages a recording that has audio exactly as before, never asking the sandbox', async () => {
    const run = setup({ download: { format: 'audio', inline: { bytes: new Uint8Array(100).fill(1), contentType: 'audio/wav' }, url: 'sandbox://local/a', hosts: [] } });
    expect(await runMeetingsImport(run.deps, job({ hasAudio: true, hasVideo: false }), attempt)).toBe('staged');
    expect(run.drained).toEqual([]);
    expect((await store.get(KEY))?.byteLength).toBe(100);
    await store.delete(KEY);
  });
});
