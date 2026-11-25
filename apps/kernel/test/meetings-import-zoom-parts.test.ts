// SPDX-License-Identifier: AGPL-3.0-only
// A recording the platform made in several parts (Zoom, #3175) in the download job of the recording import: every part is fetched in order through the guard, one connection at a time, sealed as it arrives
// (the parts together counted against the cap of their format), crove-media gets them in one framed call and returns ONE Opus, and only that audio is staged. A part that fails fails the whole import, no part is
// kept on any outcome, and a platform that gives one file, or a deployment with no sandbox that can join, behaves as before. The platform and the sandbox are fakes; the blob store is a real one on a temporary directory.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { minimalMp4, type MeetingPlatformAdapter, type MeetingPlatformDownload } from '@ludy/channel';
import { MEETING_PLATFORM_IMPORT_MAX_BYTES } from '@ludy/kernel-contract';
import { EgressError, LocalDiskStore, type EgressStream } from '@ludy/kernel-runtime';
import { MEDIA_LIMITS, MediaClientError, type JoinPartSource } from '@ludy/media-contract/extract';
import { ZOOM_PARTS_MAX } from '@ludy/channel';
import { createMediaAudioExtractor } from '../src/meetings-extract.ts';
import { joinPartsBudget, runMeetingsImport, type MeetingsImportDeps, type MeetingsImportJob } from '../src/meetings-import.ts';

const KEY = `staging/${'c'.repeat(64)}`;
const OPUS = new Uint8Array([79, 103, 103, 83, 1, 2, 3]);
const job = (over: Partial<MeetingsImportJob> = {}): MeetingsImportJob => ({
  orgId: '00000000-0000-4000-8000-000000000001',
  id: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003',
  provider: 'sandbox',
  externalId: 'rec-parts',
  hasAudio: true,
  hasVideo: false,
  sizeBytes: null,
  stagingKey: KEY,
  ...over,
});
const attempt = { retryCount: 0, retryLimit: 3 };

let dir: string;
let store: LocalDiskStore;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ludy-import-parts-'));
  store = new LocalDiskStore(dir);
});
afterEach(async () => {
  await store.delete(KEY);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}

// A part's bytes: an MP4 header the container check wants, then filler that differs per part so the order can be told.
const mp4 = (size: number, fill: number): Uint8Array => {
  const out = new Uint8Array(size);
  out.set(minimalMp4());
  for (let i = 24; i < size; i++) out[i] = (i + fill) % 251;
  return out;
};

interface PartSpec {
  bytes: Uint8Array;
  declared?: number | undefined;
  listed?: number | null | undefined;
  // The body fails after its first piece with this error.
  breaks?: Error;
}

interface Run {
  deps: MeetingsImportDeps;
  executed: string[];
  joined: Uint8Array[][];
  calls: { prepareParts: number; prepareDownload: number; opened: number; maxOpen: number };
}

function setup(options: { parts: PartSpec[]; mediaInputBytes?: number; format?: 'audio' | 'video'; joinAnswer?: () => Promise<{ audio: Uint8Array; durationSeconds: number }>; extractor?: 'join' | 'no-join' | 'none' }): Run {
  const executed: string[] = [];
  const joined: Uint8Array[][] = [];
  const calls = { prepareParts: 0, prepareDownload: 0, opened: 0, maxOpen: 0 };
  let open = 0;
  const format = options.format ?? 'audio';
  const downloads: MeetingPlatformDownload[] = options.parts.map((p, i) => ({ url: `https://platform.test/part-${i}`, headers: {}, format, hosts: ['platform.test'], hostSuffixes: [], sizeBytes: p.listed === undefined ? p.bytes.byteLength : p.listed }));
  const adapter: MeetingPlatformAdapter = {
    provider: 'sandbox',
    hosts: ['platform.test'],
    list: async () => [],
    prepareDownload: async () => {
      calls.prepareDownload += 1;
      return { url: 'https://platform.test/whole', headers: {}, format, hosts: ['platform.test'], hostSuffixes: [] };
    },
    prepareParts: async () => {
      calls.prepareParts += 1;
      return downloads;
    },
  };
  const stream = async (url: string): Promise<EgressStream> => {
    const index = Number(/part-(\d+)$/.exec(url)?.[1] ?? 0);
    const spec = options.parts[index] ?? options.parts[0] ?? { bytes: new Uint8Array() };
    calls.opened += 1;
    open += 1;
    calls.maxOpen = Math.max(calls.maxOpen, open);
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        open -= 1;
      }
    };
    return {
      url,
      status: 200,
      headers: spec.declared === undefined ? {} : { 'content-length': String(spec.declared) },
      body: (async function* () {
        try {
          yield spec.bytes.slice(0, Math.ceil(spec.bytes.byteLength / 2));
          if (spec.breaks) throw spec.breaks;
          yield spec.bytes.slice(Math.ceil(spec.bytes.byteLength / 2));
        } finally {
          close();
        }
      })(),
      destroy: close,
    };
  };
  const client = {
    extractAudio: async () => ({ audio: OPUS, durationSeconds: 2 }),
    joinAudio: async (parts: readonly JoinPartSource[]) => {
      const read: Uint8Array[] = [];
      for (const part of parts) {
        const chunks: Uint8Array[] = [];
        for await (const piece of part.source) chunks.push(piece);
        const whole = Buffer.concat(chunks);
        expect(whole.byteLength).toBe(part.length);
        read.push(new Uint8Array(whole));
      }
      joined.push(read);
      return (options.joinAnswer ?? (async () => ({ audio: OPUS, durationSeconds: 5 })))();
    },
  };
  const extractor = options.extractor === 'none' ? null : options.extractor === 'no-join' ? createMediaAudioExtractor({ extractAudio: client.extractAudio }) : createMediaAudioExtractor(client);
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
    extractor,
    stream,
    mediaInputBytes: options.mediaInputBytes,
  } as unknown as MeetingsImportDeps;
  return { deps, executed, joined, calls };
}

const failedWith = (code: string) => `kernel.meeting_platform.import_failed:${code}`;
const STAGED = 'kernel.meeting_platform.import_staged:';

describe('a recording in several parts', () => {
  it('has the Zoom adapter and the sandbox agree on the most parts of one join', () => {
    expect(ZOOM_PARTS_MAX).toBe(MEDIA_LIMITS.maxJoinParts);
  });

  it('refuses a count of parts the sandbox would refuse before any part is fetched, as a final failure', async () => {
    const many = Array.from({ length: MEDIA_LIMITS.maxJoinParts + 1 }, (_, i) => ({ bytes: mp4(1000, i), declared: 1000 }));
    const run = setup({ parts: many });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual([failedWith('invalid_media')]);
    expect(run.calls.opened).toBe(0);
  });

  it('joins the parts in order through the sandbox and stages only the audio it returns, keeping no part', async () => {
    const parts = [mp4(3000, 1), mp4(5000, 2), mp4(2000, 3)];
    const run = setup({ parts: parts.map((bytes) => ({ bytes, declared: bytes.byteLength })) });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('staged');
    expect(run.executed).toEqual([STAGED]);
    expect(run.joined).toHaveLength(1);
    expect(run.joined[0]?.map((p) => Buffer.from(p))).toEqual(parts.map((p) => Buffer.from(p)));
    expect(new Uint8Array((await store.get(KEY)) as Uint8Array)).toEqual(OPUS);
    // Only the staged audio is on disk: every sealed part was deleted.
    expect((await files(dir)).filter((f) => !f.includes('staging'))).toEqual([]);
    await store.delete(KEY);
  });

  it('opens one connection at a time (a part never waits open and idle behind the others)', async () => {
    const parts = [mp4(1000, 1), mp4(1000, 2), mp4(1000, 3), mp4(1000, 4)];
    const run = setup({ parts: parts.map((bytes) => ({ bytes, declared: bytes.byteLength })) });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('staged');
    expect(run.calls.opened).toBe(4);
    expect(run.calls.maxOpen).toBe(1);
    await store.delete(KEY);
  });

  it('joins the video parts of a recording that has no audio file, with the video never kept', async () => {
    const parts = [mp4(4000, 5), mp4(4000, 6)];
    const run = setup({ format: 'video', parts: parts.map((bytes) => ({ bytes, declared: bytes.byteLength })) });
    expect(await runMeetingsImport(run.deps, job({ hasAudio: false, hasVideo: true }), attempt)).toBe('staged');
    expect(run.joined[0]?.map((p) => Buffer.from(p))).toEqual(parts.map((p) => Buffer.from(p)));
    expect((await files(dir)).filter((f) => !f.includes('staging'))).toEqual([]);
    await store.delete(KEY);
  });

  it('uses the size the platform listed for a part whose answer declares no length, and refuses the recording when a part has neither', async () => {
    const parts = [mp4(2000, 1), mp4(3000, 2)];
    const listed = setup({ parts: parts.map((bytes) => ({ bytes, declared: undefined })) });
    expect(await runMeetingsImport(listed.deps, job(), attempt)).toBe('staged');
    await store.delete(KEY);
    const neither = setup({ parts: [{ bytes: parts[0] as Uint8Array, declared: undefined }, { bytes: parts[1] as Uint8Array, declared: undefined, listed: null }] });
    expect(await runMeetingsImport(neither.deps, job(), attempt)).toBe('failed');
    expect(neither.executed).toEqual([failedWith('platform_refused')]);
    expect(neither.joined).toEqual([]);
    expect((await files(dir)).filter((f) => !f.includes('staging'))).toEqual([]);
  });

  it('fails the whole import when one part breaks, stages nothing and keeps no part (a partial recording is never made)', async () => {
    const parts = [mp4(3000, 1), mp4(4000, 2)];
    const run = setup({ parts: [{ bytes: parts[0] as Uint8Array, declared: 3000 }, { bytes: parts[1] as Uint8Array, declared: 4000, breaks: new EgressError('too_large', 'over the cap') }] });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual([failedWith('too_large')]);
    expect(run.joined).toEqual([]);
    expect(await files(dir)).toEqual([]);
    // A body that ends short of what it declared is retried like any download.
    const short = setup({ parts: [{ bytes: parts[0] as Uint8Array, declared: 3000 }, { bytes: parts[1]?.slice(0, 2000) as Uint8Array, declared: 4000 }] });
    await expect(runMeetingsImport(short.deps, job(), { retryCount: 0, retryLimit: 3 })).rejects.toThrow(/not staged/);
    expect(await files(dir)).toEqual([]);
  });

  it('refuses before any connection when the listed sizes together are over the cap, and while sealing when the declared ones are', async () => {
    const half = Math.floor(MEETING_PLATFORM_IMPORT_MAX_BYTES / 2) + 1;
    const listed = setup({ parts: [{ bytes: mp4(2000, 1), listed: half }, { bytes: mp4(2000, 2), listed: half }] });
    expect(await runMeetingsImport(listed.deps, job(), attempt)).toBe('failed');
    expect(listed.executed).toEqual([failedWith('too_large')]);
    expect(listed.calls.opened).toBe(0);
    // A part with no listed size (or a zero one) adds nothing, so the known sizes alone are a lower bound: over the cap already, refused before any connection (Refs #3175).
    for (const unknown of [null, 0]) {
      const partial = setup({ parts: [{ bytes: mp4(2000, 1), listed: MEETING_PLATFORM_IMPORT_MAX_BYTES }, { bytes: mp4(2000, 2), listed: unknown }] });
      expect(await runMeetingsImport(partial.deps, job(), attempt)).toBe('failed');
      expect(partial.executed).toEqual([failedWith('too_large')]);
      expect(partial.calls.opened).toBe(0);
    }
    // Listed small, but the second answer declares more than what is left under the cap: refused as that part is opened.
    const declared = setup({ parts: [{ bytes: mp4(2000, 1), declared: 2000, listed: 1000 }, { bytes: mp4(2000, 2), declared: MEETING_PLATFORM_IMPORT_MAX_BYTES, listed: 1000 }] });
    expect(await runMeetingsImport(declared.deps, job(), attempt)).toBe('failed');
    expect(declared.executed).toEqual([failedWith('too_large')]);
  });

  it('is refused as no audio when the sandbox cannot join, or there is none, and before any connection', async () => {
    for (const extractor of ['no-join', 'none'] as const) {
      const run = setup({ extractor, parts: [{ bytes: mp4(1000, 1), declared: 1000 }, { bytes: mp4(1000, 2), declared: 1000 }] });
      expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
      expect(run.executed).toEqual([failedWith('no_audio')]);
      expect(run.calls.opened).toBe(0);
    }
  });

  it('records what the sandbox says of the join as a short code, and keeps no part', async () => {
    const parts = [{ bytes: mp4(1500, 1), declared: 1500 }, { bytes: mp4(1500, 2), declared: 1500 }];
    for (const [error, code] of [
      [new MediaClientError('no_audio_stream', 422, 'none'), 'no_audio'],
      [new MediaClientError('malformed_media', 422, 'bad'), 'invalid_media'],
      [new MediaClientError('too_large', 413, 'big'), 'too_large'],
      [new MediaClientError('timeout', 504, 'slow'), 'timeout'],
    ] as const) {
      const run = setup({ parts, joinAnswer: async () => Promise.reject(error) });
      expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
      expect(run.executed).toEqual([failedWith(code)]);
      expect(await files(dir)).toEqual([]);
    }
  });

  it('refuses a part that is not an audio container, and keeps nothing', async () => {
    const junk = new Uint8Array(2000).fill(7);
    const run = setup({ parts: [{ bytes: mp4(1000, 1), declared: 1000 }, { bytes: junk, declared: junk.byteLength }] });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual([failedWith('invalid_media')]);
    expect(await files(dir)).toEqual([]);
  });

  it('bounds the parts together by what the sandbox takes in one request (half its input limit, less the frame), refusing a recording over it before any part is opened', async () => {
    const MiB = 1024 * 1024;
    // The formula: half of the smaller of the format's cap and the sandbox's input limit, less 4 bytes of count and 8 a part.
    expect(joinPartsBudget('video', undefined, 2)).toBe(1024 * MiB - (4 + 16));
    expect(joinPartsBudget('audio', undefined, 3)).toBe(150 * MiB - (4 + 24));
    expect(joinPartsBudget('video', 100 * MiB, 2)).toBe(50 * MiB - (4 + 16));
    expect(joinPartsBudget('audio', 100 * MiB, 8)).toBe(50 * MiB - (4 + 64));
    // Two video parts of 600 MiB are 1.2 GiB: under the video cap (2 GiB) but over what /join-audio takes (1 GiB), so refused with no connection.
    const video = setup({ format: 'video', parts: [{ bytes: mp4(2000, 1), listed: 600 * MiB }, { bytes: mp4(2000, 2), listed: 600 * MiB }] });
    expect(await runMeetingsImport(video.deps, job({ hasAudio: false, hasVideo: true }), attempt)).toBe('failed');
    expect(video.executed).toEqual([failedWith('too_large')]);
    expect(video.calls.opened).toBe(0);
    // Audio: 70 MiB each fits (140 MiB under 150), 80 MiB each does not (160 MiB).
    const fits = setup({ parts: [{ bytes: mp4(2000, 1), declared: 2000, listed: 70 * MiB }, { bytes: mp4(2000, 2), declared: 2000, listed: 70 * MiB }] });
    expect(await runMeetingsImport(fits.deps, job(), attempt)).toBe('staged');
    await store.delete(KEY);
    const over = setup({ parts: [{ bytes: mp4(2000, 1), listed: 80 * MiB }, { bytes: mp4(2000, 2), listed: 80 * MiB }] });
    expect(await runMeetingsImport(over.deps, job(), attempt)).toBe('failed');
    expect(over.calls.opened).toBe(0);
    // A sandbox started with a smaller MEDIA_MAX_INPUT_BYTES: 10 MiB takes 5 MiB of parts.
    const small = setup({ mediaInputBytes: 10 * MiB, parts: [{ bytes: mp4(2000, 1), listed: 3 * MiB }, { bytes: mp4(2000, 2), listed: 3 * MiB }] });
    expect(await runMeetingsImport(small.deps, job(), attempt)).toBe('failed');
    expect(small.executed).toEqual([failedWith('too_large')]);
    expect(small.calls.opened).toBe(0);
  });

  it('fails at once, with no retry, when the sandbox has no /join-audio (a 404), so the parts are not downloaded again and again', async () => {
    const parts = [{ bytes: mp4(1500, 1), declared: 1500 }, { bytes: mp4(1500, 2), declared: 1500 }];
    const run = setup({ parts, joinAnswer: async () => Promise.reject(new MediaClientError('internal_error', 404, 'crove-media request failed')) });
    // Not thrown (a throw is the queue's retry): recorded as a final failure the member can read.
    expect(await runMeetingsImport(run.deps, job(), { retryCount: 0, retryLimit: 3 })).toBe('failed');
    expect(run.executed).toEqual([failedWith('no_audio')]);
    expect(await files(dir)).toEqual([]);
    // Another server error of the sandbox is still the retried kind.
    const down = setup({ parts, joinAnswer: async () => Promise.reject(new MediaClientError('internal_error', 502, 'bad gateway')) });
    await expect(runMeetingsImport(down.deps, job(), { retryCount: 0, retryLimit: 3 })).rejects.toThrow(/not staged/);
  });

  it('takes a recording of one file the old way: the parts step answers with none and the one download is fetched, not joined', async () => {
    const whole = mp4(3000, 9);
    const run = setup({ parts: [{ bytes: whole, declared: whole.byteLength }] });
    // The platform gives one part only: `prepareParts` is told to answer with fewer than two.
    (run.deps.adapters.sandbox as MeetingPlatformAdapter).prepareParts = async () => [];
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('staged');
    expect(run.calls.prepareDownload).toBe(1);
    expect(run.calls.opened).toBe(1);
    expect(run.joined).toEqual([]);
    await store.delete(KEY);
  });
});
