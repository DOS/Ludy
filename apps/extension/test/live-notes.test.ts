// SPDX-License-Identifier: AGPL-3.0-only
// Live notes in the offscreen capture (ADR-0052 L4a, #3109): a recording without the tick makes no second recorder and
// sends no live request; a ticked one sends its pieces and finishes them before the final upload, which still runs when
// the live requests fail. The browser's recorder and audio context are stubs.
import type { ChunkStore, RecordingMeta } from '@crove/meeting-recorder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LudyError, type Client } from '../src/api.ts';
import { startCapture, type CaptureDeps, type CaptureParams } from '../src/capture-run.ts';

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  slice: number | undefined;
  constructor() {
    FakeRecorder.instances.push(this);
  }
  start(slice?: number) {
    this.state = 'recording';
    this.slice = slice;
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.piece('last');
      this.emit('stop');
    });
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  piece(text: string) {
    const event = { data: new Blob([text]) };
    this.ondataavailable?.(event);
    this.emit('dataavailable', event);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeStream {
  tracks: Array<{ stop(): void }>;
  constructor(tracks: Array<{ stop(): void }> = [{ stop() {} }]) {
    this.tracks = tracks;
  }
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks;
  getVideoTracks = () => [];
}

class FakeAudioContext {
  destination = {};
  createMediaStreamDestination = () => ({ stream: new FakeStream() });
  createMediaStreamSource = () => ({ connect() {} });
  close = () => Promise.resolve();
}

function memoryStore(): ChunkStore {
  const metas = new Map<string, RecordingMeta>();
  const chunks = new Map<string, Blob[]>();
  return {
    put: (m) => Promise.resolve(void metas.set(m.id, m)),
    append: (id, seq, chunk) => Promise.resolve(void chunks.set(id, Object.assign(chunks.get(id) ?? [], { [seq]: chunk }))),
    list: () => Promise.resolve([...metas.values()]),
    chunks: (id) => Promise.resolve(chunks.get(id) ?? []),
    remove: (id) => Promise.resolve(void (metas.delete(id), chunks.delete(id))),
  };
}

const params = (liveNotes: boolean): CaptureParams => ({
  address: 'https://app.ludy.vn',
  token: 'crx_x',
  orgId: 'o',
  uploads: 'direct',
  title: 'Họp',
  consentMethod: 'told_at_start',
  consentAgreed: true,
  keepVideo: false,
  liveNotes,
  streamId: 's',
});

function setup(sendLiveChunk: Client['sendLiveChunk'] = () => Promise.resolve()) {
  const calls: string[] = [];
  const client = {
    createMeeting: vi.fn(() => Promise.resolve({ meetingId: 'm1' })),
    sendLiveChunk: vi.fn(async (input: Parameters<Client['sendLiveChunk']>[0]) => {
      calls.push(`live ${input.seq}`);
      await sendLiveChunk(input);
    }),
    uploadMedia: vi.fn(() => {
      calls.push('final upload');
      return Promise.resolve({ fileId: 'f' });
    }),
  };
  const deps: CaptureDeps = {
    store: memoryStore(),
    client: () => client as unknown as Client,
    getTabStream: () => Promise.resolve(new FakeStream() as unknown as MediaStream),
    getMicStream: () => Promise.resolve(null),
    now: () => Date.now(),
  };
  return { client, deps, calls };
}

beforeEach(() => {
  FakeRecorder.instances = [];
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});
afterEach(() => void vi.unstubAllGlobals());

describe('live notes in the offscreen capture', () => {
  it('without the tick: one recorder, no live request, and the meeting is created without live notes', async () => {
    const { client, deps, calls } = setup();
    const started = await startCapture(params(false), deps);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(client.createMeeting).toHaveBeenCalledWith(expect.objectContaining({ liveNotes: false }));
    FakeRecorder.instances[0]!.piece('five seconds');
    const stopped = await started.running.stop();
    expect(stopped.uploaded).toBe(true);
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(client.sendLiveChunk).not.toHaveBeenCalled();
    expect(calls).toEqual(['final upload']);
  });

  it('with the tick: a second 15 second recorder sends its pieces, all before the final upload', async () => {
    const { client, deps, calls } = setup();
    const started = await startCapture(params(true), deps);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(client.createMeeting).toHaveBeenCalledWith(expect.objectContaining({ liveNotes: true }));
    expect(FakeRecorder.instances).toHaveLength(2);
    const [main, live] = FakeRecorder.instances as [FakeRecorder, FakeRecorder];
    expect(main.slice).toBe(5000);
    expect(live.slice).toBe(15_000);
    main.piece('main five seconds');
    live.piece('fifteen seconds');
    const stopped = await started.running.stop();
    expect(stopped.uploaded).toBe(true);
    // The piece before stop, the last piece at stop, then the final recording.
    expect(calls).toEqual(['live 0', 'live 1', 'final upload']);
    expect(client.sendLiveChunk).toHaveBeenCalledWith(expect.objectContaining({ meetingId: 'm1', seq: 0, lengthSeconds: expect.any(Number) }));
  });

  it('the final upload still runs when the live requests are refused for good', async () => {
    const { client, deps, calls } = setup(() => Promise.reject(new LudyError('LIVE_CLOSED', 409, 'closed')));
    const started = await startCapture(params(true), deps);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    FakeRecorder.instances[0]!.piece('main');
    FakeRecorder.instances[1]!.piece('live');
    const stopped = await started.running.stop();
    expect(stopped.uploaded).toBe(true);
    expect(client.uploadMedia).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toBe('final upload');
  });

  it('records on without live notes when the live recorder cannot be made', async () => {
    const { client, deps } = setup();
    // The second recorder of this run throws on construction.
    let made = 0;
    vi.stubGlobal(
      'MediaRecorder',
      class extends FakeRecorder {
        constructor() {
          if (++made === 2) throw new Error('NotSupportedError');
          super();
        }
      },
    );
    const started = await startCapture(params(true), deps);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    FakeRecorder.instances[0]!.piece('main');
    const stopped = await started.running.stop();
    expect(stopped.uploaded).toBe(true);
    expect(client.sendLiveChunk).not.toHaveBeenCalled();
  });
});
