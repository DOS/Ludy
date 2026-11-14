// SPDX-License-Identifier: AGPL-3.0-only
// Live notes capture, the client side (ADR-0052 L4a, #3109): the sender keeps order and sends one piece at a time, retries
// a retryable failure and gives up on a permanent one, never grows past its queue, and always lets the caller go on to the
// final upload; the live recorder is made only when ticked; the final upload runs whatever became of the live sender.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_TIMESLICE_MS,
  createLiveSender,
  isPermanentLiveError,
  liveLengthSeconds,
  startLiveCapture,
  uploadAfterLive,
  type LiveMediaRecorder,
  type LivePiece,
} from '../src/index.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}
const blob = (text = 'x') => new Blob([text]);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const noSleep = () => Promise.resolve();

describe('liveLengthSeconds', () => {
  it('rounds up, at least 1, at most 120', () => {
    expect(liveLengthSeconds(15_000)).toBe(15);
    expect(liveLengthSeconds(15_001)).toBe(16);
    expect(liveLengthSeconds(10)).toBe(1);
    expect(liveLengthSeconds(0)).toBe(1);
    expect(liveLengthSeconds(500_000)).toBe(120);
    expect(liveLengthSeconds(Number.NaN)).toBe(1);
  });
});

describe('isPermanentLiveError', () => {
  it.each([400, 403, 404, 409, 413])('%i is permanent', (status) => expect(isPermanentLiveError(new HttpError(status))).toBe(true));
  it.each([429, 500, 502, 503])('%i is retried', (status) => expect(isPermanentLiveError(new HttpError(status))).toBe(false));
  it('a network error, or anything with no status, is retried', () => {
    expect(isPermanentLiveError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isPermanentLiveError('boom')).toBe(false);
    expect(isPermanentLiveError(null)).toBe(false);
  });
});

describe('createLiveSender', () => {
  it('sends in order with seq from 0, one at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: LivePiece[] = [];
    const sender = createLiveSender({
      async send(piece) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        seen.push(piece);
        inFlight -= 1;
      },
    });
    sender.push(blob('a'), 15_000);
    sender.push(blob('b'), 14_200);
    sender.push(blob('c'), 100);
    await sender.finish();
    expect(seen.map((p) => [p.seq, p.lengthSeconds])).toEqual([[0, 15], [1, 15], [2, 1]]);
    expect(peak).toBe(1);
    expect(sender.status()).toEqual({ sent: 3, dropped: 0, stopped: true });
  });

  it('ignores an empty piece without using a seq', async () => {
    const seen: number[] = [];
    const sender = createLiveSender({ send: (p) => Promise.resolve(void seen.push(p.seq)) });
    sender.push(new Blob([]), 1000);
    sender.push(blob(), 1000);
    await sender.finish();
    expect(seen).toEqual([0]);
  });

  it('retries a retryable failure with 1 s, 2 s and 4 s waits, then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const sender = createLiveSender({
      sleep: (ms) => Promise.resolve(void waits.push(ms)),
      send: () => (++calls < 4 ? Promise.reject(new HttpError(503)) : Promise.resolve()),
    });
    sender.push(blob(), 15_000);
    await sender.finish();
    expect(calls).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(sender.status().sent).toBe(1);
  });

  it('drops only the piece whose retries ran out, and carries on', async () => {
    const attempts = new Map<number, number>();
    const sent: number[] = [];
    const sender = createLiveSender({
      sleep: noSleep,
      send(piece) {
        attempts.set(piece.seq, (attempts.get(piece.seq) ?? 0) + 1);
        if (piece.seq === 0) return Promise.reject(new TypeError('network'));
        sent.push(piece.seq);
        return Promise.resolve();
      },
    });
    sender.push(blob(), 15_000);
    sender.push(blob(), 15_000);
    await sender.finish();
    expect(attempts.get(0)).toBe(4);
    expect(sent).toEqual([1]);
    expect(sender.status()).toEqual({ sent: 1, dropped: 1, stopped: true });
  });

  it('a permanent error stops for good and later pushes are dropped silently', async () => {
    const send = vi.fn((piece: LivePiece) => (piece.seq === 1 ? Promise.reject(new HttpError(409)) : Promise.resolve()));
    const sender = createLiveSender({ send, sleep: noSleep });
    sender.push(blob(), 1000);
    sender.push(blob(), 1000);
    sender.push(blob(), 1000);
    await tick();
    await tick();
    expect(sender.status().stopped).toBe(true);
    expect(() => sender.push(blob(), 1000)).not.toThrow();
    await sender.finish();
    // seq 0 went, seq 1 was refused once (no retry), seq 2 and the later push were never sent.
    expect(send.mock.calls.map(([p]) => p.seq)).toEqual([0, 1]);
    expect(sender.status()).toEqual({ sent: 1, dropped: 2, stopped: true });
  });

  it('keeps at most 8 pieces waiting and drops the oldest when the server is down', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: number[] = [];
    const sender = createLiveSender({
      send: async (piece) => {
        await gate;
        seen.push(piece.seq);
      },
    });
    // The first is in flight, 20 more queue up behind it.
    for (let i = 0; i < 21; i += 1) sender.push(blob(), 1000);
    release();
    await sender.finish();
    // Piece 0 was in flight; of the rest only the newest 8 waited.
    expect(seen).toEqual([0, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(sender.status()).toEqual({ sent: 9, dropped: 12, stopped: true });
  });

  it('stops taking pieces past seq 999', async () => {
    const seen: number[] = [];
    const sender = createLiveSender({ send: (p) => Promise.resolve(void seen.push(p.seq)), maxQueue: 2000 });
    for (let i = 0; i < 1002; i += 1) sender.push(blob(), 1000);
    await sender.finish();
    expect(seen.length).toBe(1000);
    expect(seen.at(-1)).toBe(999);
    expect(sender.status().dropped).toBe(2);
  });

  it('never throws or rejects, whatever send does', async () => {
    const sender = createLiveSender({
      sleep: noSleep,
      send: () => {
        throw new Error('sync throw');
      },
    });
    expect(() => sender.push(blob(), 1000)).not.toThrow();
    await expect(sender.finish()).resolves.toBeUndefined();
    expect(sender.status().dropped).toBe(1);
  });

  describe('finish', () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    it('resolves at once when nothing is waiting', async () => {
      const sender = createLiveSender({ send: () => Promise.resolve() });
      await expect(sender.finish()).resolves.toBeUndefined();
    });

    it('waits for the queue to drain', async () => {
      let release: () => void = () => undefined;
      const sender = createLiveSender({ send: () => new Promise<void>((resolve) => (release = resolve)) });
      sender.push(blob(), 1000);
      let done = false;
      void sender.finish({ timeoutMs: 10_000 }).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(3000);
      expect(done).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(sender.status().sent).toBe(1);
    });

    it('resolves at the timeout (default 10 s) when the server hangs, and drops what is left', async () => {
      const sender = createLiveSender({ send: () => new Promise<void>(() => undefined) });
      sender.push(blob(), 1000);
      sender.push(blob(), 1000);
      let done = false;
      void sender.finish().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(9999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(done).toBe(true);
      expect(sender.status()).toEqual({ sent: 0, dropped: 1, stopped: true });
      expect(() => sender.push(blob(), 1000)).not.toThrow();
    });

    it('resolves at the timeout while a retry is waiting', async () => {
      const sender = createLiveSender({ send: () => Promise.reject(new HttpError(503)), baseDelayMs: 60_000 });
      sender.push(blob(), 1000);
      let done = false;
      void sender.finish({ timeoutMs: 2000 }).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(2001);
      expect(done).toBe(true);
    });
  });
});

// A MediaRecorder stand-in that hands out its pieces when told to.
function fakeRecorder() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const recorder = {
    state: 'inactive',
    started: null as number | null,
    start(timeslice?: number) {
      recorder.state = 'recording';
      recorder.started = timeslice ?? null;
    },
    stop() {
      recorder.state = 'inactive';
      // The last piece fires before `stop`, as a real recorder does.
      queueMicrotask(() => {
        recorder.emit('dataavailable', { data: new Blob(['last']) });
        recorder.emit('stop', {});
      });
    },
    pause() {
      recorder.state = 'paused';
    },
    resume() {
      recorder.state = 'recording';
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  return recorder satisfies LiveMediaRecorder & Record<string, unknown>;
}

describe('startLiveCapture', () => {
  it('creates no recorder and sends nothing when live notes are not ticked', () => {
    const makeRecorder = vi.fn(() => fakeRecorder());
    const send = vi.fn(() => Promise.resolve());
    expect(startLiveCapture({ enabled: false, makeRecorder, send, now: () => 0 })).toBeNull();
    expect(makeRecorder).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('carries on without live notes when the recorder cannot be made or started', () => {
    const base = { enabled: true, send: () => Promise.resolve(), now: () => 0 };
    expect(startLiveCapture({ ...base, makeRecorder: () => { throw new Error('NotSupportedError'); } })).toBeNull();
    expect(startLiveCapture({ ...base, makeRecorder: () => null })).toBeNull();
    const broken = fakeRecorder();
    broken.start = () => {
      throw new Error('InvalidStateError');
    };
    expect(startLiveCapture({ ...base, makeRecorder: () => broken })).toBeNull();
  });

  it('starts with a 15 second slice and sends each piece with its measured length, pauses not counted', async () => {
    const recorder = fakeRecorder();
    const sent: LivePiece[] = [];
    let now = 1_000_000;
    const live = startLiveCapture({ enabled: true, makeRecorder: () => recorder, send: (p) => Promise.resolve(void sent.push(p)), now: () => now })!;
    expect(recorder.started).toBe(LIVE_TIMESLICE_MS);
    now += 15_000;
    recorder.emit('dataavailable', { data: new Blob(['one']) });
    // 10 s recording, 40 s paused, 5 s recording: a 15 s piece, not 55 s.
    now += 10_000;
    live.pause();
    now += 40_000;
    live.resume();
    now += 5_000;
    recorder.emit('dataavailable', { data: new Blob(['two']) });
    await live.stopAndFinish();
    expect(sent.map((p) => [p.seq, p.lengthSeconds])).toEqual([[0, 15], [1, 15], [2, 1]]);
    expect(live.status().sent).toBe(3);
  });

  it('stops the live recorder and takes its last piece before it finishes', async () => {
    const recorder = fakeRecorder();
    const order: string[] = [];
    const live = startLiveCapture({
      enabled: true,
      makeRecorder: () => recorder,
      send: async () => void order.push('piece'),
      now: () => 0,
    })!;
    await live.stopAndFinish();
    order.push('finished');
    expect(order).toEqual(['piece', 'finished']);
    expect(recorder.state).toBe('inactive');
    // Twice is safe.
    await expect(live.halt()).resolves.toBeUndefined();
  });

  it('does not wait forever for a stop event that never comes', async () => {
    vi.useFakeTimers();
    try {
      const recorder = fakeRecorder();
      recorder.stop = () => {
        recorder.state = 'inactive';
      };
      const live = startLiveCapture({ enabled: true, makeRecorder: () => recorder, send: () => Promise.resolve(), now: () => 0, stopGraceMs: 1000 })!;
      let done = false;
      void live.stopAndFinish().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(1001);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('uploadAfterLive', () => {
  it('finishes the live pieces before the final upload starts', async () => {
    const order: string[] = [];
    const recorder = fakeRecorder();
    const live = startLiveCapture({
      enabled: true,
      makeRecorder: () => recorder,
      send: async () => {
        await tick();
        order.push('live piece');
      },
      now: () => 0,
    });
    const result = await uploadAfterLive(live, async () => {
      order.push('final upload');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(order).toEqual(['live piece', 'final upload']);
  });

  it('still uploads when the live sender failed for good', async () => {
    const live = startLiveCapture({ enabled: true, makeRecorder: () => fakeRecorder(), send: () => Promise.reject(new HttpError(409)), now: () => 0 });
    const upload = vi.fn(() => Promise.resolve('ok'));
    await expect(uploadAfterLive(live, upload)).resolves.toBe('ok');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(live?.status().stopped).toBe(true);
  });

  it('still uploads when the live sender hangs past its time', async () => {
    vi.useFakeTimers();
    try {
      const live = startLiveCapture({ enabled: true, makeRecorder: () => fakeRecorder(), send: () => new Promise<void>(() => undefined), now: () => 0 });
      const upload = vi.fn(() => Promise.resolve('ok'));
      const result = uploadAfterLive(live, upload, { timeoutMs: 2000 });
      await vi.advanceTimersByTimeAsync(2001);
      await expect(result).resolves.toBe('ok');
      expect(upload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uploads at once for a recording without live notes', async () => {
    await expect(uploadAfterLive(null, () => Promise.resolve(7))).resolves.toBe(7);
  });
});
