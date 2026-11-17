// SPDX-License-Identifier: AGPL-3.0-only
// The in-app recorder as an app-level controller (Meetings, #3197). The microphone, the MediaRecorder, the on-device chunk
// writer, the wake lock, the live-notes capture and the upload all live here, in a module-level singleton, so moving between
// app screens does not stop a recording. The recorder screen (routes/meeting-record.tsx) and the header bar
// (components/recording-chip.tsx) are only views of it. A full page unload still ends the devices, so a recording asks first
// (beforeunload). The recording stops by itself at the longest meeting the server takes (MAX_MEETING_SECONDS). No AI here.
import { MAX_MEETING_SECONDS, type LiveConsentMethod, type MeetingLanguage, type BuiltInSummaryTemplate, type MeetingVisibility } from '@crove/kernel-contract';
import {
  assembleRecording,
  beginRecording,
  createBrowserLiveRecorder,
  createClock,
  pickRecorderMime,
  prepareCapture,
  RECORDING_NOTICE,
  startLiveCapture,
  stopReasonForUpload,
  uploadAfterLive,
  type ChunkStore,
  type LiveCapture,
  type RecordingKind,
  type RecordingMeta,
  type RecordingWriter,
} from '@crove/meeting-recorder';
import { errorMessage, orpc, queryClient, sendLiveChunk, uploadMeetingMedia } from './api.ts';
import { setLocalRecording } from './recording-indicator.ts';
import { toast } from './toast.ts';

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'uploading';

export interface RecorderSnapshot {
  phase: RecorderPhase;
  // The last thing worth telling on the recorder screen, already in words; null when there is none.
  error: string | null;
  // The recording being uploaded (a recovered one or the one just stopped).
  busyId: string | null;
  withVideo: boolean;
  // The org the running recording belongs to; null when none runs.
  slug: string | null;
  // Only while a recording with video runs: the recorder screen shows it as a preview.
  stream: MediaStream | null;
}

export interface StartInput {
  store: ChunkStore;
  scope: string;
  slug: string;
  title: string;
  language: MeetingLanguage;
  visibility: MeetingVisibility;
  summaryTemplate: BuiltInSummaryTemplate;
  withVideo: boolean;
  liveNotes: boolean;
  consentMethod: LiveConsentMethod;
  // A booking opens the recorder with its contact, calendar event and agenda (L1, #2587).
  prefill: { partyId?: string | undefined; calendarEventId?: string | undefined; agendaId?: string | undefined };
}

type Translate = (key: string, params?: Record<string, string>) => string;

// Everything a running recording holds; one object so cleanup stops all of it.
interface Live {
  stream: MediaStream;
  recorder: MediaRecorder;
  writer: RecordingWriter;
  pending: Set<Promise<void>>;
  wakeLock: { release(): Promise<void> } | null;
  failed: boolean;
  // The audio-only recorder that sends pieces to the server when live notes were ticked (ADR-0052 L4a); null otherwise.
  liveCapture: LiveCapture | null;
  // Where the finished upload goes: the device store it is read from and the org it opens in.
  ctx: { store: ChunkStore; slug: string };
}

type WakeLockApi = { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
const requestWakeLock = async (): Promise<{ release(): Promise<void> } | null> =>
  (await (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock?.request('screen').catch(() => null)) ?? null;

const IDLE: RecorderSnapshot = { phase: 'idle', error: null, busyId: null, withVideo: false, slug: null, stream: null };
// The longest a sign-out or an org switch waits for the recording to be saved; the copy stays on the device if the upload is still running.
const SAVE_WAIT_MS = 60_000;
const MAX_MS = MAX_MEETING_SECONDS * 1000;
const RECORD_PATH = /\/meetings\/record\/?$/;

let state: RecorderSnapshot = IDLE;
const listeners = new Set<() => void>();
const clock = createClock();
let live: Live | null = null;
let title = '';
// The meeting created for the current start, reused if a later local step fails, so a retry makes no second meeting.
let createdMeetingId: string | null = null;
// What that meeting was made for: a start with other details (another title, org or consent) makes its own.
let createdFor = '';
let linkedMeetingId: string | null = null;
// Recordings this tab wrote: shown in the recovery list at once; another tab's only once its heartbeat is stale.
const ownIds = new Set<string>();
// Whether Stop was pressed on the recorder screen (where the finished upload opens the meeting) or elsewhere (a toast with a button).
let stoppedOnRecordScreen = true;
// Set while the member is leaving (sign-out): the finished upload says nothing and goes nowhere, the member is on the way out.
let quiet = false;
// Set to give up a start that is still waiting for the microphone or the meeting.
let abortStart = false;
let ticker: ReturnType<typeof setInterval> | null = null;
let tick = 0;
let translate: Translate = (key) => key;
let navigateToMeeting: ((slug: string, meetingId: string) => void) | null = null;

// The host (components/recording-host.tsx) keeps these current: the words in the member's language, and how to open a meeting.
export const setRecorderTranslator = (next: Translate): void => void (translate = next);
export const setRecorderNavigator = (next: ((slug: string, meetingId: string) => void) | null): void => void (navigateToMeeting = next);

export const subscribeRecorder = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const getRecorderSnapshot = (): RecorderSnapshot => state;
export const recorderElapsedMs = (): number => clock.elapsedMs(Date.now());
export const isOwnRecording = (id: string): boolean => ownIds.has(id);
export const clearRecorderError = (): void => patch({ error: null });

function patch(next: Partial<RecorderSnapshot>): void {
  const merged = { ...state, ...next };
  if ((Object.keys(next) as Array<keyof RecorderSnapshot>).every((key) => merged[key] === state[key])) return;
  state = merged;
  syncSideEffects();
  for (const listener of listeners) listener();
}

// What follows the phase: the header bar, the timers, the unload guard and the wake lock's return.
function syncSideEffects(): void {
  const active = state.phase === 'recording' || state.phase === 'paused';
  if (active && live) {
    setLocalRecording({
      meetingId: live.writer.meta().meetingId,
      title,
      paused: state.phase === 'paused',
      slug: live.ctx.slug,
      elapsedMs: recorderElapsedMs,
      stop: () => stop(),
    });
  } else {
    setLocalRecording(null);
  }
  if (active && ticker === null) {
    ticker = setInterval(onTick, 500);
  } else if (!active && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
  const guarded = state.phase !== 'idle';
  if (typeof window === 'undefined') return;
  if (guarded) {
    window.addEventListener('beforeunload', warnBeforeLeaving);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', takeWakeLockAgain);
  } else {
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', takeWakeLockAgain);
  }
}

// Closing or reloading the tab ends the microphone: ask first. (What was saved stays on the device and is offered again.)
function warnBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}

function flush(): void {
  if (live && live.recorder.state === 'recording') live.recorder.requestData();
}

// The browser drops the wake lock when the tab is hidden: take it again when the tab is back.
function takeWakeLockAgain(): void {
  const l = live;
  if (document.visibilityState !== 'visible' || !l || l.recorder.state === 'inactive') return;
  void requestWakeLock().then((lock) => {
    if (lock && live === l) l.wakeLock = lock;
    else void lock?.release().catch(() => undefined);
  });
}

// Every half second while recording or paused: the longest length, and every tenth tick (5 s) the heartbeat that tells
// another tab this recording is live (a pause writes no chunk).
function onTick(): void {
  const l = live;
  if (!l) return;
  const elapsed = clock.elapsedMs(Date.now());
  tick += 1;
  if (tick % 10 === 0) void l.writer.touch(elapsed).catch(() => undefined);
  if (state.phase === 'recording' && elapsed >= MAX_MS) {
    toast(translate('record.maxLength'), 'error');
    stop();
  }
}

function releaseDevices(l: Live | null, stopRecorder: boolean): void {
  if (!l) return;
  if (stopRecorder) l.liveCapture?.abandon();
  if (stopRecorder && l.recorder.state !== 'inactive') {
    try {
      l.recorder.stop();
    } catch {
      // already stopped
    }
  }
  for (const track of l.stream.getTracks()) track.stop();
  void l.wakeLock?.release().catch(() => undefined);
  if (live === l) live = null;
}

export async function startRecording(input: StartInput): Promise<void> {
  if (state.phase !== 'idle') return;
  const { store, scope, slug, withVideo } = input;
  const kind: RecordingKind = withVideo ? 'video' : 'audio';
  title = input.title.trim();
  abortStart = false;
  patch({ phase: 'starting', error: null, withVideo, slug });
  const result = await prepareCapture<MediaStream, MediaRecorder>({
    openStore: async () => void (await store.list(scope)),
    getStream: () =>
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      }),
    createMeeting: async () => {
      // The meeting row stores who confirmed the notice and how; the server refuses media for a meeting without it.
      const key = JSON.stringify([scope, title, input.language, input.visibility, input.summaryTemplate, input.consentMethod, withVideo, input.liveNotes]);
      if (createdFor !== key) {
        createdMeetingId = null;
        linkedMeetingId = null;
        createdFor = key;
      }
      createdMeetingId ??= (
        await orpc.meetings.create.call({
          title,
          language: input.language,
          visibility: input.visibility,
          keepVideo: withVideo,
          summaryTemplate: input.summaryTemplate,
          consentMethod: input.consentMethod,
          consentNoticeVersion: RECORDING_NOTICE.version,
          liveNotes: input.liveNotes,
        })
      ).meetingId;
      const meetingId = createdMeetingId;
      if (linkedMeetingId !== meetingId) {
        linkedMeetingId = meetingId;
        // A failed link never blocks the recording (the recorder can link on the meeting page).
        const targets = [
          ...(input.prefill.partyId ? [{ kind: 'party' as const, targetId: input.prefill.partyId }] : []),
          ...(input.prefill.calendarEventId ? [{ kind: 'calendar_event' as const, targetId: input.prefill.calendarEventId }] : []),
        ];
        const results = await Promise.allSettled([
          ...targets.map((target) => orpc.meetings.links.add.call({ meetingId, ...target })),
          // "Ghi cuộc họp này" from the member's own calendar list: the meeting is linked to that event once it exists (B1).
          ...(input.prefill.agendaId ? [orpc.meetings.agenda.link.call({ agendaId: input.prefill.agendaId, meetingId })] : []),
        ]);
        if (results.some((r) => r.status === 'rejected')) toast(translate('links.prefillFailed'), 'error');
      }
      return meetingId;
    },
    makeRecorder: (stream) => {
      const mimeType = pickRecorderMime((type) => MediaRecorder.isTypeSupported(type), kind);
      return new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64_000,
        ...(withVideo ? { videoBitsPerSecond: 1_500_000 } : {}),
      });
    },
    begin: async (meetingId, recorder) => {
      const mimeType = pickRecorderMime((type) => MediaRecorder.isTypeSupported(type), kind);
      const writer = await beginRecording(store, {
        id: crypto.randomUUID(),
        scope,
        meetingId,
        title,
        kind,
        mimeType: recorder.mimeType || mimeType || (withVideo ? 'video/webm' : 'audio/webm'),
        startedAt: Date.now(),
      });
      ownIds.add(writer.meta().id);
      return writer;
    },
    wakeLock: requestWakeLock,
    // Leaving the recorder screen does not abort a start; only stopAndSave (sign-out, another org) does.
    unmounted: () => abortStart,
  });
  if (result.status === 'aborted') {
    patch({ phase: 'idle', slug: null });
    return;
  }
  if (result.status === 'failed') {
    patch({
      phase: 'idle',
      slug: null,
      error: result.reason === 'store' ? translate('record.unsupported') : result.reason === 'device' ? translate(withVideo ? 'record.deviceDeniedVideo' : 'record.deviceDenied') : errorMessage(result.error),
    });
    return;
  }
  const { stream, recorder, writer } = result;
  // A device that goes away mid-recording (microphone unplugged, permission taken back) ends its tracks: say why it stopped.
  for (const track of stream.getTracks()) track.addEventListener('ended', () => void writer.markStopped('mic_lost'));
  const l: Live = { stream, recorder, writer, pending: new Set(), wakeLock: result.wakeLock, failed: false, liveCapture: null, ctx: { store, slug } };
  live = l;
  recorder.ondataavailable = (event) => {
    const write = writer.addChunk(event.data, clock.elapsedMs(Date.now())).catch(() => {
      // The device refused a chunk (storage full): keep what is saved, stop, and say so.
      if (!l.failed) {
        l.failed = true;
        void l.writer.markStopped('storage_full');
        patch({ error: translate('record.saveFailed') });
        if (l.recorder.state !== 'inactive') l.recorder.stop();
      }
    });
    l.pending.add(write);
    void write.finally(() => l.pending.delete(write));
  };
  recorder.onstop = () => void onStopped(l);
  try {
    clock.start(Date.now());
    tick = 0;
    // A chunk every 5 seconds is written to the device while recording.
    recorder.start(5000);
    // A second, audio-only recorder sends pieces of about 15 seconds; none is made without the tick, and a failure
    // here never stops the recording.
    l.liveCapture = startLiveCapture({
      enabled: input.liveNotes,
      makeRecorder: () => createBrowserLiveRecorder(stream),
      send: (piece) => sendLiveChunk({ meetingId: writer.meta().meetingId, ...piece }),
      now: () => Date.now(),
    });
    // The meeting made for this start is now the recording's: a later start makes its own.
    createdMeetingId = null;
    linkedMeetingId = null;
    patch({ phase: 'recording', stream: withVideo ? stream : null });
  } catch (err) {
    releaseDevices(l, true);
    patch({ phase: 'idle', slug: null, error: errorMessage(err), stream: null });
  }
}

export function pauseOrResume(): void {
  const l = live;
  if (!l) return;
  if (l.recorder.state === 'recording') {
    l.recorder.pause();
    l.liveCapture?.pause();
    clock.pause(Date.now());
    patch({ phase: 'paused' });
  } else if (l.recorder.state === 'paused') {
    l.recorder.resume();
    l.liveCapture?.resume();
    clock.resume(Date.now());
    patch({ phase: 'recording' });
  }
}

export function stop(): void {
  const l = live;
  if (!l || (state.phase !== 'recording' && state.phase !== 'paused')) return;
  clock.pause(Date.now());
  // The result goes to the member where they pressed Stop: the recorder screen opens the meeting, another screen gets a toast.
  stoppedOnRecordScreen = typeof window === 'undefined' || RECORD_PATH.test(window.location.pathname);
  patch({ phase: 'uploading' });
  // The recorder's own click: no stop reason goes with the upload (A1, #3159).
  void l.writer.markStopped('user');
  // The live recorder stops first; its last piece is taken in onStopped before the devices are released.
  void l.liveCapture?.halt();
  // A recorder the browser or the device already ended (its stop event is still being handled) is not stopped twice.
  if (l.recorder.state !== 'inactive') l.recorder.stop();
}

// The browser fires the last chunk before `stop`: wait for every write, then upload what the device holds.
async function onStopped(l: Live): Promise<void> {
  await Promise.all(l.pending);
  await l.liveCapture?.halt();
  // The recorder stopped and nobody clicked, or the device filled: the browser or the device ended it.
  await l.writer.markStopped('unknown');
  const meta = l.writer.meta();
  releaseDevices(l, false);
  if (state.phase !== 'uploading') {
    clock.pause(Date.now());
    patch({ phase: 'uploading' });
  }
  patch({ stream: null });
  if (meta.stopped !== 'user') {
    const message = translate('record.stoppedEarly', {
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reason: translate(`stopReason.${meta.stopped ?? 'unknown'}`),
    });
    patch({ error: message });
    // The member may be on another screen now.
    if (!quiet) toast(message, 'error');
    stoppedOnRecordScreen = false;
  }
  // The live pieces are refused once the final recording is stored: they finish (or give up) first, then the upload.
  await uploadAfterLive(l.liveCapture, () => uploadRecording(l.ctx.store, l.ctx.slug, meta, l.failed, true));
}

// Uploads a recording from the device (the one just stopped or one recovered), clears the device copy once it is stored.
export async function uploadRecording(store: ChunkStore, slug: string, meta: RecordingMeta, partial = false, justStopped = false): Promise<boolean> {
  patch({ busyId: meta.id });
  try {
    const recording = await assembleRecording(store, meta);
    if (!recording) {
      await store.remove(meta.id);
      patch({ error: translate('record.nothingSaved') });
      return false;
    }
    await uploadMeetingMedia(meta.meetingId, meta.kind, recording.file, recording.lengthSeconds, stopReasonForUpload(meta));
    // Uploaded: the device copy is cleared at once.
    await store.remove(meta.id);
    await queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
    patch({ error: null });
    const message = translate(partial ? 'record.uploadedPartial' : 'record.uploaded');
    const onRecordScreen = typeof window === 'undefined' || RECORD_PATH.test(window.location.pathname);
    if (quiet) {
      // Leaving: nothing to say here, and nowhere to go.
    } else if (navigateToMeeting && (!justStopped || stoppedOnRecordScreen) && onRecordScreen) {
      toast(message, 'success');
      navigateToMeeting(slug, meta.meetingId);
    } else {
      const open = navigateToMeeting;
      toast(message, 'success', open ? { action: { label: translate('record.openMeeting'), run: () => open(slug, meta.meetingId) } } : {});
    }
    return true;
  } catch (err) {
    // The copy stays on the device, and the screen offers the upload again.
    const message = `${translate('record.uploadFailed')} ${errorMessage(err)}`;
    patch({ error: message });
    if (justStopped && !quiet) toast(message, 'error');
    return false;
  } finally {
    patch({ busyId: null, ...(justStopped ? { phase: 'idle' as const, slug: null } : {}) });
    if (justStopped) quiet = false;
  }
}

// True when the org now open is not the one a running recording belongs to (an org switch): the recording then ends and is saved.
export const recordingLeftItsOrg = (openSlug: string | undefined, snapshot: Pick<RecorderSnapshot, 'slug' | 'phase'>): boolean =>
  openSlug !== undefined && snapshot.slug !== null && snapshot.slug !== openSlug && snapshot.phase !== 'uploading' && snapshot.phase !== 'idle';

// Stops what runs and saves it, like the Stop button, and answers once the upload has finished (or failed: the copy stays on the
// device and the recorder screen offers it again). A sign-out or a switch to another org calls this first, so the microphone never
// runs on past the person's leaving. A start still waiting for the microphone is given up. Waits at most SAVE_WAIT_MS.
export async function stopAndSave(options: { quiet?: boolean } = {}): Promise<void> {
  if (state.phase === 'idle') return;
  if (options.quiet) quiet = true;
  if (state.phase === 'starting') abortStart = true;
  else if (state.phase === 'recording' || state.phase === 'paused') stop();
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, SAVE_WAIT_MS);
    const off = subscribeRecorder(() => {
      if (state.phase === 'idle') done();
    });
    if (state.phase === 'idle') done();
  });
}

// Used by tests to start from a clean controller.
export function resetRecorderForTests(): void {
  if (live) live.recorder.onstop = null;
  releaseDevices(live, true);
  live = null;
  createdMeetingId = null;
  linkedMeetingId = null;
  createdFor = '';
  quiet = false;
  abortStart = false;
  ownIds.clear();
  title = '';
  state = IDLE;
  syncSideEffects();
  for (const listener of listeners) listener();
}
