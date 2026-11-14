// SPDX-License-Identifier: AGPL-3.0-only
// The in-app meeting recorder (AI Meeting Notes M7, #2581; plan section 5.5 (b), ADR-0047). Pure logic and the on-device
// store: which MediaRecorder type each browser gets, the timer that stops while paused, the consent gate, and the chunk
// store that keeps a recording on the device as it goes, so a reload or a closed tab does not lose it. The screen
// (routes/meeting-record.tsx) owns the browser APIs; nothing here calls a model, and nothing leaves the device.

export type RecordingKind = 'audio' | 'video';

// Browsers differ: Chrome, Edge and Firefox record WebM (Opus; Firefox audio may be Ogg Opus), Safari records MP4 (AAC).
// The first type the browser supports wins. The kernel sniffs WebM, Ogg and MP4 and crove-media normalizes all of them.
const AUDIO_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
] as const;
const VIDEO_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
] as const;

// The type to ask MediaRecorder for, or undefined when none of the known types is supported (the browser then picks its
// own, and the recording keeps the type the recorder reports).
export function pickRecorderMime(isTypeSupported: (type: string) => boolean, kind: RecordingKind): string | undefined {
  return (kind === 'video' ? VIDEO_TYPES : AUDIO_TYPES).find((type) => isTypeSupported(type));
}

export function recordingExtension(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.endsWith('/mp4')) return 'mp4';
  if (base.endsWith('/ogg')) return 'ogg';
  return 'webm';
}

// Why a recording cannot start yet, or null. The same facts the server records on the meeting row; the screen checks them
// before it creates the meeting, and creating the meeting is what stores the consent, so no capture precedes it.
export function startBlocker(input: { title: string; consentMethod: string; consentAgreed: boolean }): 'title' | 'consentMethod' | 'consentAgreed' | null {
  if (input.title.trim().length === 0) return 'title';
  if (input.consentMethod === '') return 'consentMethod';
  if (!input.consentAgreed) return 'consentAgreed';
  return null;
}

// A stopwatch that does not run while paused. `now` is injected so it tests without timers.
export interface Clock {
  start(now: number): void;
  pause(now: number): void;
  resume(now: number): void;
  elapsedMs(now: number): number;
  // Restores the time a recovered recording had reached.
  restore(elapsedMs: number): void;
}

export function createClock(): Clock {
  let banked = 0;
  let runningSince: number | null = null;
  return {
    start(now) {
      banked = 0;
      runningSince = now;
    },
    pause(now) {
      if (runningSince === null) return;
      banked += Math.max(0, now - runningSince);
      runningSince = null;
    },
    resume(now) {
      if (runningSince === null) runningSince = now;
    },
    elapsedMs(now) {
      return banked + (runningSince === null ? 0 : Math.max(0, now - runningSince));
    },
    restore(elapsedMs) {
      banked = elapsedMs;
      runningSince = null;
    },
  };
}

export function formatClock(elapsedMs: number): string {
  const total = Math.floor(Math.max(0, elapsedMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

// The upload carries a positive whole number of seconds (the server refuses 0).
export function lengthSecondsOf(elapsedMs: number): number {
  return Math.max(1, Math.round(elapsedMs / 1000));
}

export interface RecordingMeta {
  id: string;
  // The org slug and member the recording belongs to: another member on the same device never sees it.
  scope: string;
  meetingId: string;
  title: string;
  kind: RecordingKind;
  mimeType: string;
  startedAt: number;
  elapsedMs: number;
  chunkCount: number;
  // Touched while the recording is live (every chunk and a heartbeat), so another tab can tell it is still being written.
  updatedAt: number;
}

// Where the chunks live. The screen uses IndexedDB; tests use a map.
export interface ChunkStore {
  put(meta: RecordingMeta): Promise<void>;
  append(id: string, seq: number, chunk: Blob): Promise<void>;
  list(scope: string): Promise<RecordingMeta[]>;
  chunks(id: string): Promise<Blob[]>;
  remove(id: string): Promise<void>;
}

const DB_NAME = 'crove-meeting-recordings';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function createIndexedDbChunkStore(factory: IDBFactory = indexedDB): ChunkStore {
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('recordings', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['id', 'seq'] });
    };
    open.onsuccess = () => {
      // A newer version of the app in another tab may upgrade the database: let it.
      open.result.onversionchange = () => open.result.close();
      resolve(open.result);
    };
    open.onerror = () => reject(open.error ?? new Error('IndexedDB is not available'));
  });
  // A refused open is reported by the first call that needs the database, not as an unhandled rejection.
  opened.catch(() => undefined);
  const run = async (stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => void): Promise<void> => {
    const tx = (await opened).transaction(stores, mode);
    work(tx);
    await done(tx);
  };
  return {
    put: (meta) => run(['recordings'], 'readwrite', (tx) => void tx.objectStore('recordings').put(meta)),
    append: (id, seq, chunk) => run(['chunks'], 'readwrite', (tx) => void tx.objectStore('chunks').put({ id, seq, chunk })),
    async list(scope) {
      const tx = (await opened).transaction(['recordings'], 'readonly');
      const all = (await request(tx.objectStore('recordings').getAll())) as RecordingMeta[];
      return all.filter((m) => m.scope === scope).sort((a, b) => a.startedAt - b.startedAt);
    },
    async chunks(id) {
      const tx = (await opened).transaction(['chunks'], 'readonly');
      const rows = (await request(tx.objectStore('chunks').getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])))) as Array<{ chunk: Blob }>;
      return rows.map((r) => r.chunk);
    },
    remove: (id) =>
      run(['recordings', 'chunks'], 'readwrite', (tx) => {
        tx.objectStore('recordings').delete(id);
        tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      }),
  };
}

// A recording being written to the store. Each chunk is awaited in order, so the meta's chunk count never runs ahead of
// the chunks that are really on the device; a failed write is thrown to the screen, which stops and keeps what is saved.
export interface RecordingWriter {
  meta: () => RecordingMeta;
  addChunk(chunk: Blob, elapsedMs: number): Promise<void>;
  touch(elapsedMs: number): Promise<void>;
}

export async function beginRecording(store: ChunkStore, meta: Omit<RecordingMeta, 'chunkCount' | 'elapsedMs' | 'updatedAt'>): Promise<RecordingWriter> {
  let current: RecordingMeta = { ...meta, chunkCount: 0, elapsedMs: 0, updatedAt: Date.now() };
  await store.put(current);
  // Writes queue up behind each other: the browser may deliver a chunk while the last one is still being stored.
  let queue: Promise<void> = Promise.resolve();
  return {
    meta: () => current,
    addChunk(chunk, elapsedMs) {
      const next = queue.then(async () => {
        if (chunk.size === 0) return;
        await store.append(current.id, current.chunkCount, chunk);
        current = { ...current, chunkCount: current.chunkCount + 1, elapsedMs, updatedAt: Date.now() };
        await store.put(current);
      });
      queue = next.catch(() => undefined);
      return next;
    },
    touch(elapsedMs) {
      const next = queue.then(async () => {
        current = { ...current, elapsedMs: Math.max(current.elapsedMs, elapsedMs), updatedAt: Date.now() };
        await store.put(current);
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

// The whole recording as one file, read back from the device, for the upload. null when nothing was saved.
export async function assembleRecording(store: ChunkStore, meta: RecordingMeta): Promise<{ file: File; lengthSeconds: number } | null> {
  const parts = await store.chunks(meta.id);
  if (parts.length === 0) return null;
  const type = meta.mimeType.split(';')[0]?.trim() || (meta.kind === 'video' ? 'video/webm' : 'audio/webm');
  const file = new File(parts, `meeting-${meta.meetingId}.${recordingExtension(meta.mimeType)}`, { type });
  return { file, lengthSeconds: lengthSecondsOf(meta.elapsedMs) };
}

export interface CaptureStream {
  getTracks(): Array<{ stop(): void }>;
}
export interface CaptureRecorder {
  state: string;
  stop(): void;
}
export interface CaptureDeps<S extends CaptureStream, R extends CaptureRecorder> {
  // Opens the device store: a failure here must leave no meeting behind.
  openStore(): Promise<void>;
  getStream(): Promise<S>;
  // The meeting row stores the consent; the caller reuses an already created one on a retry.
  createMeeting(): Promise<string>;
  makeRecorder(stream: S): R;
  begin(meetingId: string, recorder: R): Promise<RecordingWriter>;
  wakeLock(): Promise<{ release(): Promise<void> } | null>;
  // True once the screen has been left: nothing may keep capturing with no controls.
  unmounted(): boolean;
}
export type CaptureResult<S extends CaptureStream, R extends CaptureRecorder> =
  | { status: 'ready'; stream: S; recorder: R; writer: RecordingWriter; wakeLock: { release(): Promise<void> } | null }
  | { status: 'aborted' }
  | { status: 'failed'; reason: 'store' | 'device' | 'setup'; error?: unknown };

// The order of setup, and its cleanup: store, then devices, then the meeting, the recorder, the device copy and the wake
// lock. After every await the screen may have been left (aborted: devices released, the recorder never started); a
// failure releases whatever was taken so far. The recorder is started by the caller, only on `ready`.
export async function prepareCapture<S extends CaptureStream, R extends CaptureRecorder>(deps: CaptureDeps<S, R>): Promise<CaptureResult<S, R>> {
  try {
    await deps.openStore();
  } catch {
    return { status: 'failed', reason: 'store' };
  }
  let stream: S;
  try {
    stream = await deps.getStream();
  } catch {
    return { status: 'failed', reason: 'device' };
  }
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  let wakeLock: { release(): Promise<void> } | null = null;
  try {
    if (deps.unmounted()) return (stopTracks(), { status: 'aborted' });
    const meetingId = await deps.createMeeting();
    if (deps.unmounted()) return (stopTracks(), { status: 'aborted' });
    const recorder = deps.makeRecorder(stream);
    const writer = await deps.begin(meetingId, recorder);
    wakeLock = await deps.wakeLock();
    if (deps.unmounted()) {
      stopTracks();
      void wakeLock?.release().catch(() => undefined);
      return { status: 'aborted' };
    }
    return { status: 'ready', stream, recorder, writer, wakeLock };
  } catch (error) {
    stopTracks();
    void wakeLock?.release().catch(() => undefined);
    return { status: 'failed', reason: 'setup', error };
  }
}

// Live notes (ADR-0052 L4a): the sender, the audio-only live recorder wrapper and the stop order.
export * from './live.ts';
export * from './notice.ts';
