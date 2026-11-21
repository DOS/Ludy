// SPDX-License-Identifier: AGPL-3.0-only
// The app-level recorder (#3197): a recording started on the recorder screen keeps running with no screen mounted, the header
// bar's Stop ends and uploads it, leaving or closing the tab asks first (beforeunload), and it stops by itself at the longest
// meeting length. The browser's MediaRecorder, microphone and the device store are fakes; the controller's logic is real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MEETING_SECONDS } from '@crove/kernel-contract';
import type { ChunkStore, RecordingMeta } from '@crove/meeting-recorder';

const api = vi.hoisted(() => ({
  create: vi.fn(async (..._args: unknown[]) => ({ meetingId: 'm1' })),
  heartbeat: vi.fn(async (..._args: unknown[]) => ({ open: true })),
  upload: vi.fn(async (..._args: unknown[]) => undefined),
  invalidate: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/api.ts', () => ({
  orpc: { meetings: { key: () => ['meetings'], create: { call: api.create }, captureHeartbeat: { call: api.heartbeat }, links: { add: { call: vi.fn() } }, agenda: { link: { call: vi.fn() } } } },
  queryClient: { invalidateQueries: api.invalidate },
  errorMessage: (e: unknown) => String(e),
  uploadMeetingMedia: api.upload,
  sendLiveChunk: vi.fn(),
}));

const toasts = vi.hoisted(() => [] as Array<{ message: string; tone: string }>);
vi.mock('../src/lib/toast.ts', () => ({ toast: (message: string, tone: string) => void toasts.push({ message, tone }) }));

const { getRecorderSnapshot, pauseOrResume, recordingLeftItsOrg, resetRecorderForTests, setRecorderNavigator, startRecording, stop, stopAndSave, subscribeRecorder } = await import('../src/lib/recording-controller.ts');
const { getLocalRecording } = await import('../src/lib/recording-indicator.ts');

function memoryStore(): ChunkStore {
  const metas = new Map<string, RecordingMeta>();
  const chunks = new Map<string, Blob[]>();
  return {
    put: (m) => Promise.resolve(void metas.set(m.id, m)),
    append: (id, seq, chunk) => Promise.resolve(void chunks.set(id, Object.assign([...(chunks.get(id) ?? [])], { [seq]: chunk }))),
    list: (scope) => Promise.resolve([...metas.values()].filter((m) => m.scope === scope)),
    chunks: (id) => Promise.resolve(chunks.get(id) ?? []),
    remove: (id) => Promise.resolve(void (metas.delete(id), chunks.delete(id))),
  };
}

class FakeRecorder {
  static last: FakeRecorder | null = null;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  static isTypeSupported = () => true;
  constructor() {
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  requestData() {}
  stop() {
    this.state = 'inactive';
    // The browser fires the last chunk, then `stop`.
    this.ondataavailable?.({ data: new Blob(['audio']) });
    queueMicrotask(() => this.onstop?.());
  }
}

const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const windowEvents = new EventTarget();
const input = (store: ChunkStore) => ({
  store, scope: 'acme:u1', slug: 'acme', title: 'Họp', language: 'vi' as const, visibility: 'attendees' as const, summaryTemplate: 'general' as const,
  withVideo: false, liveNotes: false, consentMethod: 'in_invite' as const, prefill: {},
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', Object.assign(windowEvents, { location: { pathname: '/o/acme/meetings/record' } }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
  track.stopped = false;
  toasts.length = 0;
  api.upload.mockClear();
  api.heartbeat.mockClear();
  api.create.mockClear();
});
afterEach(() => {
  resetRecorderForTests();
  setRecorderNavigator(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the app-level recorder', () => {
  it('keeps recording with no screen mounted, and shows the bar with the elapsed time', async () => {
    await startRecording(input(memoryStore()));
    expect(getRecorderSnapshot().phase).toBe('recording');
    expect(getLocalRecording()).toMatchObject({ meetingId: 'm1', paused: false, slug: 'acme' });
    // Nothing subscribes (the recorder screen is gone): time passes and the microphone is still open.
    vi.advanceTimersByTime(60_000);
    expect(FakeRecorder.last?.state).toBe('recording');
    expect(track.stopped).toBe(false);
    expect(getLocalRecording()?.elapsedMs()).toBeGreaterThanOrEqual(60_000);
  });

  it('pauses and resumes, and the bar says so', async () => {
    await startRecording(input(memoryStore()));
    pauseOrResume();
    expect(getRecorderSnapshot().phase).toBe('paused');
    expect(getLocalRecording()?.paused).toBe(true);
    pauseOrResume();
    expect(getLocalRecording()?.paused).toBe(false);
  });

  it('asks before the tab is closed while it records, and not when nothing records', async () => {
    const asked = () => {
      const event = new Event('beforeunload', { cancelable: true });
      windowEvents.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(asked()).toBe(false);
    await startRecording(input(memoryStore()));
    expect(asked()).toBe(true);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(getRecorderSnapshot().phase).toBe('idle');
    expect(asked()).toBe(false);
  });

  it('the bar\'s Stop ends the recording, uploads it from the device and opens the meeting', async () => {
    const store = memoryStore();
    const open = vi.fn();
    setRecorderNavigator(open);
    await startRecording(input(store));
    vi.advanceTimersByTime(5_000);
    getLocalRecording()?.stop?.();
    expect(getRecorderSnapshot().phase).toBe('uploading');
    expect(getLocalRecording()).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.upload.mock.calls[0]?.slice(0, 2)).toEqual(['m1', 'audio']);
    expect(api.upload.mock.calls[0]?.[4]).toBeUndefined(); // the recorder's own click: no stop reason
    expect(track.stopped).toBe(true);
    expect(getRecorderSnapshot().phase).toBe('idle');
    expect(open).toHaveBeenCalledWith('acme', 'm1');
    expect(await store.list('acme:u1')).toHaveLength(0);
  });

  it('stopped from another screen, it uploads and offers the meeting instead of jumping there', async () => {
    const open = vi.fn();
    setRecorderNavigator(open);
    await startRecording(input(memoryStore()));
    (window as unknown as { location: { pathname: string } }).location.pathname = '/o/acme/overview';
    stop();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(toasts.at(-1)?.tone).toBe('success');
  });

  it('stops by itself at the longest meeting length and says why', async () => {
    await startRecording(input(memoryStore()));
    await vi.advanceTimersByTimeAsync(MAX_MEETING_SECONDS * 1000 + 1000);
    await flush();
    expect(toasts.some((t) => t.message === 'record.maxLength')).toBe(true);
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(getRecorderSnapshot().phase).toBe('idle');
  });

  it('a device that refuses the microphone ends the start with the words, and no bar', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => Promise.reject(new Error('denied')) } });
    await startRecording(input(memoryStore()));
    expect(getRecorderSnapshot()).toMatchObject({ phase: 'idle', error: 'record.deviceDenied' });
    expect(getLocalRecording()).toBeNull();
  });

  it('two starts at the same moment make one recording', async () => {
    const store = memoryStore();
    await Promise.all([startRecording(input(store)), startRecording(input(store))]);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(getRecorderSnapshot().phase).toBe('recording');
  });

  it('a start with other details makes its own meeting, not the one a failed start left behind', async () => {
    api.create.mockClear();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
    const broken = { ...memoryStore(), put: () => Promise.reject(new Error('full')) };
    await startRecording(input(broken));
    expect(getRecorderSnapshot().phase).toBe('idle');
    await startRecording({ ...input(memoryStore()), title: 'Họp khác' });
    expect(api.create).toHaveBeenCalledTimes(2);
  });

  it('Stop while the browser already ended the recorder does not throw', async () => {
    await startRecording(input(memoryStore()));
    if (FakeRecorder.last) FakeRecorder.last.state = 'inactive';
    expect(() => stop()).not.toThrow();
  });

  it('a second start while one runs does nothing, and subscribers hear each change', async () => {
    const seen: string[] = [];
    const off = subscribeRecorder(() => seen.push(getRecorderSnapshot().phase));
    await startRecording(input(memoryStore()));
    await startRecording(input(memoryStore()));
    off();
    expect(seen).toEqual(['starting', 'recording']);
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it('stopAndSave (sign-out, another org) stops, uploads and answers when it is saved, with nothing said or opened', async () => {
    const open = vi.fn();
    setRecorderNavigator(open);
    await startRecording(input(memoryStore()));
    let saved = false;
    const leaving = stopAndSave({ quiet: true }).then(() => void (saved = true));
    expect(getRecorderSnapshot().phase).toBe('uploading');
    expect(saved).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    await leaving;
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(track.stopped).toBe(true);
    expect(getRecorderSnapshot().phase).toBe('idle');
    expect(open).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
    // Quiet is for that one leaving: the next recording speaks again.
    await startRecording(input(memoryStore()));
    stop();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(toasts.at(-1)?.tone).toBe('success');
  });

  it('stopAndSave with nothing running answers at once', async () => {
    await expect(stopAndSave({ quiet: true })).resolves.toBeUndefined();
  });

  it('stopAndSave gives up a start still waiting for the microphone and releases it', async () => {
    let grant: (stream: unknown) => void = () => undefined;
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise((resolve) => void (grant = resolve)) } });
    const starting = startRecording(input(memoryStore()));
    expect(getRecorderSnapshot().phase).toBe('starting');
    await flush();
    const leaving = stopAndSave({ quiet: true });
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    await starting;
    await leaving;
    expect(getRecorderSnapshot().phase).toBe('idle');
    expect(track.stopped).toBe(true);
    expect(FakeRecorder.last?.state ?? 'inactive').not.toBe('recording');
  });

  it('stopAndSave does not wait for ever on an upload that hangs', async () => {
    api.upload.mockImplementationOnce(() => new Promise(() => undefined));
    await startRecording(input(memoryStore()));
    const leaving = stopAndSave({ quiet: true });
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(leaving).resolves.toBeUndefined();
  });

  it('an org switch ends a recording of the other org, and nothing else does', () => {
    const running = { slug: 'acme', phase: 'recording' as const };
    expect(recordingLeftItsOrg('acme', running)).toBe(false);
    expect(recordingLeftItsOrg('other', running)).toBe(true);
    expect(recordingLeftItsOrg('other', { slug: 'acme', phase: 'paused' })).toBe(true);
    // Outside any org (the org list, the account screens) the recording goes on, with the bar.
    expect(recordingLeftItsOrg(undefined, running)).toBe(false);
    expect(recordingLeftItsOrg('other', { slug: 'acme', phase: 'uploading' })).toBe(false);
    expect(recordingLeftItsOrg('other', { slug: null, phase: 'idle' })).toBe(false);
  });
});

// One meeting, one live capture (ADR-0055 slice 1, #4123): the recorder says it is a capture, keeps the server told it is alive, ends the capture when it stops, and words a refusal.
describe('the capture of a call', () => {
  it('starts the meeting as a capture, naming the calendar event it was started from', async () => {
    await startRecording(input(memoryStore()));
    expect(api.create.mock.calls[0]?.[0]).toMatchObject({ capture: {} });
    resetRecorderForTests();
    await startRecording({ ...input(memoryStore()), prefill: { agendaId: '0195f2b0-0000-7000-8000-000000000009' } });
    expect(api.create.mock.calls[1]?.[0]).toMatchObject({ capture: { agendaId: '0195f2b0-0000-7000-8000-000000000009' } });
  });

  it('beats every 30 seconds while it records, whatever the server answers, and ends the capture at once on the member\'s stop', async () => {
    await startRecording(input(memoryStore()));
    expect(api.heartbeat).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(api.heartbeat).toHaveBeenLastCalledWith({ meetingId: 'm1' });
    // A beat that fails, and one answered "not open", leave the recording running.
    api.heartbeat.mockImplementationOnce(async () => Promise.reject(new Error('offline')));
    vi.advanceTimersByTime(30_000);
    api.heartbeat.mockImplementationOnce(async () => ({ open: false }));
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(api.heartbeat).toHaveBeenCalledTimes(3);
    expect(getRecorderSnapshot().phase).toBe('recording');
    expect(FakeRecorder.last?.state).toBe('recording');
    stop();
    expect(api.heartbeat).toHaveBeenLastCalledWith({ meetingId: 'm1', end: true });
    const beats = api.heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    // The end is sent once, and nothing beats after it.
    vi.advanceTimersByTime(120_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(beats);
  });

  it('ends the capture too when the recording stops by itself', async () => {
    await startRecording(input(memoryStore()));
    FakeRecorder.last!.stop();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(api.heartbeat).toHaveBeenLastCalledWith({ meetingId: 'm1', end: true });
    expect(api.heartbeat.mock.calls.filter((c) => (c[0] as { end?: boolean }).end).length).toBe(1);
  });

  it('frees the call at once when the recorder never started after the meeting was made, and a retry opens a fresh capture', async () => {
    const store = memoryStore();
    // The device store refuses the first write, after the meeting exists: the start fails, and the capture of the call is ended with it.
    const failing: ChunkStore = { ...store, put: () => Promise.reject(new Error('store full')) };
    const agendaPrefill = { agendaId: '0195f2b0-0000-7000-8000-000000000009' };
    await startRecording({ ...input(failing), prefill: agendaPrefill });
    expect(getRecorderSnapshot().phase).toBe('idle');
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(api.heartbeat).toHaveBeenLastCalledWith({ meetingId: 'm1', end: true });
    // Nothing beats afterwards.
    vi.advanceTimersByTime(120_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    // Retrying with the exact same inputs asks the server again (never reusing the permanently stopped capture) and beats while recording.
    await startRecording({ ...input(store), prefill: agendaPrefill });
    expect(getRecorderSnapshot().phase).toBe('recording');
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create.mock.calls[1]?.[0]).toMatchObject({ capture: agendaPrefill });
    vi.advanceTimersByTime(30_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    expect(api.heartbeat).toHaveBeenLastCalledWith({ meetingId: 'm1' });
  });

  it('says in words which kind of client holds a call that is already recorded and since when, and starts nothing', async () => {
    const refusal = Object.assign(new Error('This meeting is already being recorded'), { code: 'CAPTURE_ALREADY_RUNNING', status: 409, data: { kind: 'extension', since: '2027-01-20T07:02:00.000Z' } });
    api.create.mockImplementationOnce(async () => Promise.reject(refusal));
    FakeRecorder.last = null;
    await startRecording(input(memoryStore()));
    const snapshot = getRecorderSnapshot();
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.error).toContain('record.captureRunning');
    expect(snapshot.error).not.toContain('This meeting is already being recorded');
    expect(FakeRecorder.last).toBeNull();
    expect(api.heartbeat).not.toHaveBeenCalled();
    // Any other refusal keeps its own message.
    api.create.mockImplementationOnce(async () => Promise.reject(Object.assign(new Error('boom'), { code: 'INTERNAL' })));
    await startRecording(input(memoryStore()));
    expect(getRecorderSnapshot().error).toBe('Error: boom');
    // Unreadable capture refusal details fall back to errorMessage rather than formatting raw placeholders.
    api.create.mockImplementationOnce(async () => Promise.reject(Object.assign(new Error('fallback'), { code: 'CAPTURE_ALREADY_RUNNING', status: 409 })));
    await startRecording(input(memoryStore()));
    expect(getRecorderSnapshot().error).toBe('Error: fallback');
  });

  it('does not reuse a cached failed-start meeting across different calendar events', async () => {
    const broken = { ...memoryStore(), put: () => Promise.reject(new Error('full')) };
    await startRecording({ ...input(broken), prefill: { agendaId: '0195f2b0-0000-7000-8000-000000000001' } });
    expect(getRecorderSnapshot().phase).toBe('idle');
    await startRecording({ ...input(memoryStore()), prefill: { agendaId: '0195f2b0-0000-7000-8000-000000000002' } });
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create.mock.calls[1]?.[0]).toMatchObject({ capture: { agendaId: '0195f2b0-0000-7000-8000-000000000002' } });
  });
});
