// SPDX-License-Identifier: AGPL-3.0-only
// Live notes in the offscreen capture (ADR-0052 L4a, #3109): a recording without the tick makes no second recorder and
// sends no live request; a ticked one sends its pieces and finishes them before the final upload, which still runs when
// the live requests fail. The browser's recorder and audio context are stubs.
import type { ChunkStore, RecordingMeta } from '@crove/meeting-recorder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LudyError, type Client } from '../src/api.ts';
import { reportEnded, startCapture, type CaptureDeps, type CaptureParams } from '../src/capture-run.ts';

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
    createMeeting: vi.fn((_input: Parameters<Client['createMeeting']>[0]) => Promise.resolve({ meetingId: 'm1' })),
    captureHeartbeat: vi.fn((_input: Parameters<Client['captureHeartbeat']>[0]) => Promise.resolve({ open: true })),
    sendLiveChunk: vi.fn(async (input: Parameters<Client['sendLiveChunk']>[0]) => {
      calls.push(`live ${input.seq}`);
      await sendLiveChunk(input);
    }),
    uploadMedia: vi.fn(() => {
      calls.push('final upload');
      return Promise.resolve({ fileId: 'f' });
    }),
    recordingStopped: vi.fn((_input: Parameters<Client['recordingStopped']>[0]) => Promise.resolve()),
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

// A recording that ends with no media reaching the server tells the server, so the app's recording chip lets go (#3196).
describe('ending a recording with no media', () => {
  const started = async (deps: CaptureDeps) => {
    const result = await startCapture(params(false), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('did not start');
    return result.running;
  };

  it('reports the end when nothing was saved, with no code for the member\'s own stop', async () => {
    const { client, deps } = setup();
    const running = await started({ ...deps, store: { ...memoryStore(), chunks: () => Promise.resolve([]) } });
    const stopped = await running.stop();
    expect(stopped.uploaded).toBe(false);
    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(client.recordingStopped).toHaveBeenCalledTimes(1);
    expect(client.recordingStopped).toHaveBeenCalledWith({ meetingId: 'm1', lengthSeconds: expect.any(Number) });
  });

  it('reports the end with the code when the upload fails, and the copy stays on the device for a retry', async () => {
    const { client, deps } = setup();
    client.uploadMedia.mockImplementationOnce(() => Promise.reject(new LudyError('OFFLINE', 0, 'offline')));
    const running = await started(deps);
    FakeRecorder.instances[0]!.piece('five seconds');
    const stopped = await running.stop('mic_lost');
    expect(stopped.uploaded).toBe(false);
    expect(client.recordingStopped).toHaveBeenCalledWith({ meetingId: 'm1', reason: 'mic_lost', lengthSeconds: expect.any(Number) });
    expect(await deps.store.list('o')).toHaveLength(1);
  });

  it('says nothing when the upload worked: the media ended the recording', async () => {
    const { client, deps } = setup();
    const running = await started(deps);
    FakeRecorder.instances[0]!.piece('five seconds');
    expect((await running.stop()).uploaded).toBe(true);
    expect(client.recordingStopped).not.toHaveBeenCalled();
  });

  it('reports the end when the capture fails after the meeting was made', async () => {
    const { client, deps } = setup();
    const result = await startCapture(params(false), { ...deps, store: { ...memoryStore(), put: () => Promise.reject(new Error('device full')) } });
    expect(result).toEqual({ ok: false, reason: 'setup' });
    expect(client.recordingStopped).toHaveBeenCalledWith({ meetingId: 'm1', reason: 'unknown', lengthSeconds: 0 });
  });

  it('never fails the stop because the report failed', async () => {
    const { client, deps } = setup();
    client.recordingStopped.mockImplementation(() => Promise.reject(new LudyError('OFFLINE', 0, 'offline')));
    const running = await started({ ...deps, store: { ...memoryStore(), chunks: () => Promise.resolve([]) } });
    await expect(running.stop()).resolves.toMatchObject({ uploaded: false, message: 'Không có âm thanh nào được lưu' });
  });

  it('sends the report to the one route and only the codes and ids', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), body: String(init.body) });
      return new Response('{}', { status: 200 });
    }) as unknown as Parameters<typeof import('../src/api.ts').createClient>[2];
    const { createClient } = await import('../src/api.ts');
    await createClient('https://app.ludy.vn', 'crx_t', fetchImpl).recordingStopped({ meetingId: '11111111-1111-4111-8111-111111111111', reason: 'tab_closed', lengthSeconds: 42 });
    expect(seen).toEqual([{ url: 'https://app.ludy.vn/api/rpc/meetings/recordingStopped', body: JSON.stringify({ json: { meetingId: '11111111-1111-4111-8111-111111111111', reason: 'tab_closed', lengthSeconds: 42 } }) }]);
  });

  it('reports at most a day, and a stop the member did not ask for with its code (a discarded left-over copy too)', async () => {
    const { client } = setup();
    const meta = { id: 'r', scope: 'o', meetingId: 'm1', title: 'Họp', kind: 'audio' as const, mimeType: 'audio/webm', startedAt: 0, elapsedMs: 100 * 3600 * 1000, chunkCount: 1, updatedAt: 0, stopped: 'tab_closed' as const };
    await reportEnded(client as unknown as Client, meta);
    expect(client.recordingStopped).toHaveBeenCalledWith({ meetingId: 'm1', reason: 'tab_closed', lengthSeconds: 86_400 });
    // Nobody saw it end (a closed tab, a crash): 'unknown'.
    const { stopped: _stopped, ...unseen } = meta;
    await reportEnded(client as unknown as Client, unseen);
    expect(client.recordingStopped).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'unknown' }));
  });
});

// One meeting, one live capture (ADR-0055 slice 1, #4123): the tab's address is a hint to the server, a capture of a call that is already held is refused in words, and the recording keeps the server told it is alive.
describe('the capture of a call', () => {
  it('sends the tab address with the meeting, and nothing when the browser gave none', async () => {
    const { client, deps } = setup();
    const first = await startCapture({ ...params(false), joinUrl: 'https://meet.google.com/abc-defg-hij' }, deps);
    expect(first.ok).toBe(true);
    expect(client.createMeeting).toHaveBeenCalledWith(expect.objectContaining({ joinUrl: 'https://meet.google.com/abc-defg-hij' }));
    if (first.ok) await first.running.stop();
    const again = setup();
    const second = await startCapture(params(false), again.deps);
    expect(second.ok).toBe(true);
    expect(again.client.createMeeting.mock.calls[0]?.[0]).not.toHaveProperty('joinUrl');
    if (second.ok) await second.running.stop();
  });

  it('is refused in words when the call is already held: the kind and the time, no meeting made, nothing to report as ended', async () => {
    const { client, deps } = setup();
    client.createMeeting.mockImplementationOnce(() => Promise.reject(new LudyError('CAPTURE_ALREADY_RUNNING', 409, 'This meeting is already being recorded', { kind: 'app', since: '2027-01-20T07:02:00.000Z' })));
    const started = await startCapture(params(false), deps);
    expect(started).toEqual({ ok: false, reason: 'captureRunning', held: { kind: 'app', since: '2027-01-20T07:02:00.000Z' } });
    expect(client.recordingStopped).not.toHaveBeenCalled();
    expect(client.uploadMedia).not.toHaveBeenCalled();
  });

  it('is still refused when the refusal carries no readable details, and any other failure stays a failed setup', async () => {
    const { client, deps } = setup();
    client.createMeeting.mockImplementationOnce(() => Promise.reject(new LudyError('CAPTURE_ALREADY_RUNNING', 409, 'x')));
    expect(await startCapture(params(false), deps)).toEqual({ ok: false, reason: 'captureRunning' });
    client.createMeeting.mockImplementationOnce(() => Promise.reject(new LudyError('INTERNAL', 500, 'down')));
    expect(await startCapture(params(false), deps)).toEqual({ ok: false, reason: 'setup' });
  });

  it('never waits for the end of the capture: a stalled network does not hold up the stop or the upload', async () => {
    const { client, deps, calls } = setup();
    client.captureHeartbeat.mockImplementation(() => new Promise<{ open: boolean }>(() => undefined));
    const started = await startCapture(params(false), deps);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    FakeRecorder.instances[0]!.piece('five seconds');
    const stopped = await started.running.stop();
    expect(stopped.uploaded).toBe(true);
    expect(calls).toEqual(['final upload']);
    expect(client.captureHeartbeat).toHaveBeenLastCalledWith({ meetingId: 'm1', end: true });
  });

  it('beats every 30 seconds while recording and ends the capture at once when the member stops, whatever the server answers', async () => {
    vi.useFakeTimers();
    try {
      const { client, deps } = setup();
      const started = await startCapture(params(false), deps);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(client.captureHeartbeat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.captureHeartbeat).toHaveBeenCalledTimes(1);
      expect(client.captureHeartbeat).toHaveBeenLastCalledWith({ meetingId: 'm1' });
      // A beat the server cannot take, and one it answers "not open", never stop the recording.
      client.captureHeartbeat.mockImplementationOnce(() => Promise.reject(new LudyError('OFFLINE', 0, 'offline')));
      await vi.advanceTimersByTimeAsync(30_000);
      client.captureHeartbeat.mockImplementationOnce(() => Promise.resolve({ open: false }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.captureHeartbeat).toHaveBeenCalledTimes(3);
      client.captureHeartbeat.mockImplementationOnce(() => Promise.reject(new LudyError('OFFLINE', 0, 'offline')));
      const stopped = await started.running.stop();
      expect(stopped.uploaded).toBe(true);
      expect(client.captureHeartbeat).toHaveBeenLastCalledWith({ meetingId: 'm1', end: true });
      // No beat after the stop.
      const beats = client.captureHeartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(client.captureHeartbeat).toHaveBeenCalledTimes(beats);
    } finally {
      vi.useRealTimers();
    }
  });
});
