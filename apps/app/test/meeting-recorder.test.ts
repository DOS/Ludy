// SPDX-License-Identifier: AGPL-3.0-only
// The in-app meeting recorder's logic (AI Meeting Notes M7, #2581): the MediaRecorder type each browser gets, the consent
// gate, the timer that stops while paused, and a recording that survives a reload because every chunk is on the device.
import { describe, expect, it } from 'vitest';
import {
  assembleRecording,
  beginRecording,
  createClock,
  formatClock,
  lengthSecondsOf,
  pickRecorderMime,
  recordingExtension,
  startBlocker,
  type ChunkStore,
  type RecordingMeta,
} from '../src/lib/meeting-recorder.ts';

function memoryStore(): ChunkStore & { failAfter: number | null } {
  const metas = new Map<string, RecordingMeta>();
  const chunks = new Map<string, Blob[]>();
  const store = {
    failAfter: null as number | null,
    put: (m: RecordingMeta) => Promise.resolve(void metas.set(m.id, m)),
    append: (id: string, seq: number, chunk: Blob) => {
      if (store.failAfter !== null && seq >= store.failAfter) return Promise.reject(new Error('QuotaExceededError'));
      const list = chunks.get(id) ?? [];
      list[seq] = chunk;
      chunks.set(id, list);
      return Promise.resolve();
    },
    list: (scope: string) => Promise.resolve([...metas.values()].filter((m) => m.scope === scope)),
    chunks: (id: string) => Promise.resolve(chunks.get(id) ?? []),
    remove: (id: string) => Promise.resolve(void (metas.delete(id), chunks.delete(id))),
  };
  return store;
}

// What each browser's MediaRecorder.isTypeSupported answers.
const supports = (...types: string[]) => (type: string) => types.includes(type);
const CHROME = supports('audio/webm;codecs=opus', 'audio/webm', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4');
const FIREFOX = supports('audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'video/webm;codecs=vp8,opus', 'video/webm');
const SAFARI = supports('audio/mp4', 'video/mp4', 'audio/mp4;codecs=mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2');

describe('pickRecorderMime', () => {
  it('Chrome and Edge record WebM Opus, and VP9 for video', () => {
    expect(pickRecorderMime(CHROME, 'audio')).toBe('audio/webm;codecs=opus');
    expect(pickRecorderMime(CHROME, 'video')).toBe('video/webm;codecs=vp9,opus');
  });
  it('Firefox records WebM Opus, and VP8 for video', () => {
    expect(pickRecorderMime(FIREFOX, 'audio')).toBe('audio/webm;codecs=opus');
    expect(pickRecorderMime(FIREFOX, 'video')).toBe('video/webm;codecs=vp8,opus');
  });
  it('an older Firefox with Ogg only gets Ogg Opus', () => {
    expect(pickRecorderMime(supports('audio/ogg;codecs=opus'), 'audio')).toBe('audio/ogg;codecs=opus');
  });
  it('Safari records MP4 with AAC', () => {
    expect(pickRecorderMime(SAFARI, 'audio')).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(pickRecorderMime(SAFARI, 'video')).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  });
  it('returns undefined when nothing known is supported, so the browser picks its own', () => {
    expect(pickRecorderMime(() => false, 'audio')).toBeUndefined();
  });
});

describe('recordingExtension', () => {
  it('names the file by its container', () => {
    expect(recordingExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(recordingExtension('video/webm')).toBe('webm');
    expect(recordingExtension('audio/ogg;codecs=opus')).toBe('ogg');
    expect(recordingExtension('audio/mp4;codecs=mp4a.40.2')).toBe('mp4');
    expect(recordingExtension('video/mp4')).toBe('mp4');
  });
});

describe('startBlocker (the consent gate)', () => {
  const ok = { title: 'Họp tuần', consentMethod: 'told_at_start', consentAgreed: true };
  it('lets a recording start only with a title, a notice method and the confirmation', () => {
    expect(startBlocker(ok)).toBeNull();
  });
  it('blocks without the confirmation', () => {
    expect(startBlocker({ ...ok, consentAgreed: false })).toBe('consentAgreed');
  });
  it('blocks without how participants were told', () => {
    expect(startBlocker({ ...ok, consentMethod: '' })).toBe('consentMethod');
  });
  it('blocks without a title', () => {
    expect(startBlocker({ ...ok, title: '   ' })).toBe('title');
  });
});

describe('clock', () => {
  it('does not count while paused', () => {
    const c = createClock();
    c.start(1_000);
    c.pause(11_000);
    expect(c.elapsedMs(500_000)).toBe(10_000);
    c.resume(600_000);
    expect(c.elapsedMs(605_000)).toBe(15_000);
  });
  it('restores the time a recovered recording had reached', () => {
    const c = createClock();
    c.restore(3_600_000);
    expect(c.elapsedMs(9_999_999)).toBe(3_600_000);
  });
  it('formats mm:ss and h:mm:ss, and reports whole seconds of at least one', () => {
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(lengthSecondsOf(0)).toBe(1);
    expect(lengthSecondsOf(3_599_600)).toBe(3600);
  });
});

describe('a recording on the device', () => {
  const base = { id: 'r1', scope: 'acme:u1', meetingId: 'm1', title: 'Họp', kind: 'audio' as const, mimeType: 'audio/webm;codecs=opus', startedAt: 1 };

  it('a 60-minute recording survives a reload: every 5-second chunk is read back in order from a new session', async () => {
    const store = memoryStore();
    const writer = await beginRecording(store, base);
    const CHUNKS = 720; // 60 minutes at one chunk per 5 seconds
    for (let i = 0; i < CHUNKS; i++) await writer.addChunk(new Blob([new Uint8Array([i % 256])]), (i + 1) * 5000);
    // The page reloads: nothing of the writer survives, only the store.
    const [meta] = await store.list('acme:u1');
    expect(meta?.chunkCount).toBe(CHUNKS);
    expect(meta?.elapsedMs).toBe(3_600_000);
    const recovered = await assembleRecording(store, meta!);
    expect(recovered?.lengthSeconds).toBe(3600);
    expect(recovered?.file.size).toBe(CHUNKS);
    expect(recovered?.file.type).toBe('audio/webm');
    expect(recovered?.file.name).toBe('meeting-m1.webm');
    const bytes = new Uint8Array(await recovered!.file.arrayBuffer());
    expect(bytes[0]).toBe(0);
    expect(bytes[300]).toBe(300 % 256);
  });

  it('keeps writes in order when chunks arrive faster than they are stored', async () => {
    const store = memoryStore();
    const writer = await beginRecording(store, base);
    await Promise.all([1, 2, 3, 4].map((n) => writer.addChunk(new Blob([new Uint8Array([n])]), n * 5000)));
    const bytes = new Uint8Array(await (await assembleRecording(store, writer.meta()))!.file.arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it('ignores an empty chunk', async () => {
    const store = memoryStore();
    const writer = await beginRecording(store, base);
    await writer.addChunk(new Blob([]), 5000);
    expect(writer.meta().chunkCount).toBe(0);
    expect(await assembleRecording(store, writer.meta())).toBeNull();
  });

  it('a refused write is thrown, and the count stays at what is really saved', async () => {
    const store = memoryStore();
    store.failAfter = 2;
    const writer = await beginRecording(store, base);
    await writer.addChunk(new Blob(['a']), 5000);
    await writer.addChunk(new Blob(['b']), 10_000);
    await expect(writer.addChunk(new Blob(['c']), 15_000)).rejects.toThrow('QuotaExceededError');
    expect(writer.meta().chunkCount).toBe(2);
    expect((await assembleRecording(store, writer.meta()))?.file.size).toBe(2);
  });

  it('is listed only for the member and org it belongs to, and gone once removed after the upload', async () => {
    const store = memoryStore();
    await beginRecording(store, base);
    expect(await store.list('acme:u2')).toHaveLength(0);
    expect(await store.list('other:u1')).toHaveLength(0);
    expect(await store.list('acme:u1')).toHaveLength(1);
    await store.remove('r1');
    expect(await store.list('acme:u1')).toHaveLength(0);
    expect(await store.chunks('r1')).toHaveLength(0);
  });
});
