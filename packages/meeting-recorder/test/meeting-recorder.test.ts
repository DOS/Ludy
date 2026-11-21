// SPDX-License-Identifier: AGPL-3.0-only
// The in-app meeting recorder's logic (AI Meeting Notes M7, #2581): the MediaRecorder type each browser gets, the consent
// gate, the timer that stops while paused, and a recording that survives a reload because every chunk is on the device.
import { describe, expect, it } from 'vitest';
import {
  LEGACY_RECORDINGS_DB_NAME,
  RECORDINGS_DB_NAME,
  assembleRecording,
  beginRecording,
  createClock,
  createIndexedDbChunkStore,
  formatClock,
  lengthSecondsOf,
  pickRecorderMime,
  prepareCapture,
  recordingExtension,
  startBlocker,
  type ChunkStore,
  type RecordingMeta,
} from '../src/index.ts';

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

describe('heartbeat', () => {
  it('touch refreshes updatedAt and never moves the elapsed time back', async () => {
    const store = memoryStore();
    const writer = await beginRecording(store, { id: 'r2', scope: 's', meetingId: 'm', title: 't', kind: 'audio', mimeType: 'audio/webm', startedAt: 1 });
    await writer.addChunk(new Blob(['a']), 5000);
    const before = writer.meta().updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await writer.touch(3000);
    expect(writer.meta().elapsedMs).toBe(5000);
    expect(writer.meta().updatedAt).toBeGreaterThan(before);
  });
});

describe('prepareCapture (setup order and cleanup, issue #2581 review finding 1)', () => {
  function rig(opts: { unmountAfter?: 'stream' | 'meeting' | 'begin'; failAt?: 'store' | 'stream' | 'meeting' | 'recorder' | 'begin' } = {}) {
    const log: string[] = [];
    let gone = false;
    const maybeLeave = (at: string) => {
      if (opts.unmountAfter === at) gone = true;
    };
    const track = { stop: () => void log.push('track.stop') };
    const stream = { getTracks: () => [track] };
    const recorder = { state: 'inactive', stop: () => void log.push('recorder.stop') };
    const writer = { meta: () => ({}) as RecordingMeta, addChunk: () => Promise.resolve(), touch: () => Promise.resolve(), markStopped: () => Promise.resolve() };
    const deps = {
      openStore: () => (opts.failAt === 'store' ? Promise.reject(new Error('idb')) : Promise.resolve()),
      getStream: async () => {
        if (opts.failAt === 'stream') throw new Error('denied');
        log.push('stream');
        maybeLeave('stream');
        return stream;
      },
      createMeeting: async () => {
        log.push('meeting');
        if (opts.failAt === 'meeting') throw new Error('409');
        maybeLeave('meeting');
        return 'm1';
      },
      makeRecorder: () => {
        if (opts.failAt === 'recorder') throw new Error('mime');
        log.push('recorder');
        return recorder;
      },
      begin: async () => {
        if (opts.failAt === 'begin') throw new Error('quota');
        log.push('begin');
        maybeLeave('begin');
        return writer;
      },
      wakeLock: () => Promise.resolve({ release: () => (log.push('wake.release'), Promise.resolve()) }),
      unmounted: () => gone,
    };
    return { deps, log };
  }

  it('hands back a ready capture and releases nothing', async () => {
    const { deps, log } = rig();
    expect((await prepareCapture(deps)).status).toBe('ready');
    expect(log).toEqual(['stream', 'meeting', 'recorder', 'begin']);
  });

  it('leaving the screen after the microphone is open creates no meeting and stops the tracks', async () => {
    const { deps, log } = rig({ unmountAfter: 'stream' });
    expect((await prepareCapture(deps)).status).toBe('aborted');
    expect(log).toEqual(['stream', 'track.stop']);
  });

  it('leaving the screen while the meeting is being created stops the tracks and never builds a recorder', async () => {
    const { deps, log } = rig({ unmountAfter: 'meeting' });
    expect((await prepareCapture(deps)).status).toBe('aborted');
    expect(log).toEqual(['stream', 'meeting', 'track.stop']);
  });

  it('leaving the screen at the last step releases the tracks and the wake lock', async () => {
    const { deps, log } = rig({ unmountAfter: 'begin' });
    expect((await prepareCapture(deps)).status).toBe('aborted');
    expect(log).toContain('track.stop');
    expect(log).toContain('wake.release');
  });

  it('a store that cannot open fails before the microphone or a meeting', async () => {
    const { deps, log } = rig({ failAt: 'store' });
    expect(await prepareCapture(deps)).toMatchObject({ status: 'failed', reason: 'store' });
    expect(log).toEqual([]);
  });

  it('a refused microphone fails before any meeting exists', async () => {
    const { deps, log } = rig({ failAt: 'stream' });
    expect(await prepareCapture(deps)).toMatchObject({ status: 'failed', reason: 'device' });
    expect(log).toEqual([]);
  });

  it.each(['meeting', 'recorder', 'begin'] as const)('a failure at %s stops the tracks', async (failAt) => {
    const { deps, log } = rig({ failAt });
    expect(await prepareCapture(deps)).toMatchObject({ status: 'failed', reason: 'setup' });
    expect(log).toContain('track.stop');
  });
});

interface FakeDbData {
  recordings: Map<string, RecordingMeta>;
  chunks: Map<string, { id: string; seq: number; chunk: Blob }>;
}

function createFakeIdbFactory(initial: Record<string, FakeDbData> = {}) {
  const databases = new Map<string, FakeDbData>();
  for (const [name, content] of Object.entries(initial)) {
    databases.set(name, {
      recordings: new Map(content.recordings),
      chunks: new Map(content.chunks),
    });
  }
  const deleted: string[] = [];

  const toReq = <T>(work: () => T): IDBRequest<T> => {
    const req = { result: undefined as unknown as T, error: null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
    queueMicrotask(() => {
      req.result = work();
      req.onsuccess?.();
    });
    return req as unknown as IDBRequest<T>;
  };

  const open = (name: string) => {
    const existed = databases.has(name);
    let data = databases.get(name);
    if (!data) {
      data = { recordings: new Map(), chunks: new Map() };
      databases.set(name, data);
    }
    const storeNames = new Set(['recordings', 'chunks']);
    const db = {
      onversionchange: null as (() => void) | null,
      close: () => undefined,
      objectStoreNames: { contains: (s: string) => (existed ? storeNames.has(s) : false) },
      createObjectStore: (s: string) => {
        storeNames.add(s);
        return {};
      },
      transaction: (_stores: string[], _mode?: IDBTransactionMode) => {
        let pending = 0;
        const tx = {
          oncomplete: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onabort: null as (() => void) | null,
          error: null,
          objectStore: (storeName: string) => {
            const finishSoon = <T>(work: () => T): IDBRequest<T> => {
              pending++;
              const req = toReq(() => {
                const res = work();
                pending--;
                if (pending === 0) queueMicrotask(() => tx.oncomplete?.());
                return res;
              });
              return req;
            };
            return {
              getAll: (range?: { lower?: [string, number]; upper?: [string, number] }) =>
                finishSoon(() => {
                  if (storeName === 'recordings') return [...data!.recordings.values()];
                  const all = [...data!.chunks.values()];
                  if (range && Array.isArray(range.lower) && Array.isArray(range.upper)) {
                    const targetId = range.lower[0];
                    return all.filter((c) => c.id === targetId).sort((a, b) => a.seq - b.seq);
                  }
                  return all;
                }),
              put: (value: RecordingMeta | { id: string; seq: number; chunk: Blob }) =>
                finishSoon(() => {
                  if (storeName === 'recordings') {
                    const m = value as RecordingMeta;
                    data!.recordings.set(m.id, m);
                  } else {
                    const c = value as { id: string; seq: number; chunk: Blob };
                    data!.chunks.set(`${c.id}:${c.seq}`, c);
                  }
                  return undefined;
                }),
            };
          },
        };
        return tx as unknown as IDBTransaction;
      },
    };
    const req = { result: db, error: null, onupgradeneeded: null as (() => void) | null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
    queueMicrotask(() => {
      if (!existed) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req as unknown as IDBOpenDBRequest;
  };

  const factory = {
    open,
    databases: async () => [...databases.keys()].map((name) => ({ name, version: 1 })),
    deleteDatabase: (name: string) => {
      deleted.push(name);
      databases.delete(name);
      return toReq(() => undefined) as unknown as IDBOpenDBRequest;
    },
    bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
  };

  return { factory: factory as unknown as IDBFactory, databases, deleted };
}

describe('createIndexedDbChunkStore legacy migration (#3966)', () => {
  it('migrates legacy crove-meeting-recordings to ludy-meeting-recordings without overwriting existing entries', async () => {
    const originalKeyRange = globalThis.IDBKeyRange;
    const legacyMeta: RecordingMeta = {
      id: 'rec-legacy',
      scope: 'acme:u1',
      meetingId: 'm-legacy',
      title: 'Cuộc họp cũ',
      kind: 'audio',
      mimeType: 'audio/webm',
      startedAt: 100,
      elapsedMs: 5000,
      chunkCount: 1,
      updatedAt: 200,
    };
    const conflictLegacy: RecordingMeta = { ...legacyMeta, id: 'rec-new', title: 'Should not overwrite', startedAt: 150 };
    const currentMeta: RecordingMeta = { ...legacyMeta, id: 'rec-new', title: 'Existing Ludy recording', startedAt: 200 };
    const legacyBlob = new Blob(['legacy-chunk']);
    const newBlob = new Blob(['new-chunk']);

    const fake = createFakeIdbFactory({
      [LEGACY_RECORDINGS_DB_NAME]: {
        recordings: new Map([
          ['rec-legacy', legacyMeta],
          ['rec-new', conflictLegacy],
        ]),
        chunks: new Map([
          ['rec-legacy:0', { id: 'rec-legacy', seq: 0, chunk: legacyBlob }],
          ['rec-new:0', { id: 'rec-new', seq: 0, chunk: new Blob(['stale-chunk']) }],
        ]),
      },
      [RECORDINGS_DB_NAME]: {
        recordings: new Map([['rec-new', currentMeta]]),
        chunks: new Map([['rec-new:0', { id: 'rec-new', seq: 0, chunk: newBlob }]]),
      },
    });
    globalThis.IDBKeyRange = { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) } as unknown as typeof IDBKeyRange;
    try {
      const store = createIndexedDbChunkStore(fake.factory);
      const list = await store.list('acme:u1');
      expect(list.map((m) => [m.id, m.title])).toEqual([
        ['rec-legacy', 'Cuộc họp cũ'],
        ['rec-new', 'Existing Ludy recording'],
      ]);
      expect(await store.chunks('rec-legacy')).toEqual([legacyBlob]);
      expect(await store.chunks('rec-new')).toEqual([newBlob]);
      expect(fake.deleted).toEqual([LEGACY_RECORDINGS_DB_NAME]);
    } finally {
      globalThis.IDBKeyRange = originalKeyRange;
    }
  });
});
