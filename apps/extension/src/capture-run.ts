// SPDX-License-Identifier: AGPL-3.0-only
// One recording in the offscreen document: the meeting tab's sound mixed with the microphone (and the tab's picture only
// with the tick), written chunk by chunk to the device through the app recorder's chunk store, and uploaded on stop.
// The order and the cleanup are the app recorder's `prepareCapture` (devices, then the meeting with its consent, then the
// recorder), so a refused device leaves no meeting behind. Nothing here calls a model: AI off still records.
import {
  assembleRecording,
  beginRecording,
  createClock,
  createBrowserLiveRecorder,
  createIndexedDbChunkStore,
  prepareCapture,
  RECORDING_NOTICE,
  stopReasonForUpload,
  type RecordingStopReason,
  startLiveCapture,
  uploadAfterLive,
  type ChunkStore,
  type RecordingMeta,
} from '@crove/meeting-recorder';
import { capturePlan } from './capture-plan.ts';
import { createClient, type Client } from './api.ts';
import { consentBlocker, type ConsentMethod } from './consent.ts';

export interface CaptureParams {
  address: string;
  token: string;
  orgId: string;
  uploads: 'presigned' | 'direct';
  title: string;
  consentMethod: ConsentMethod;
  consentAgreed: boolean;
  keepVideo: boolean;
  // Live notes (ADR-0052 L4a): a second, audio-only recorder sends pieces while recording; the final upload stays as it is.
  liveNotes: boolean;
  streamId: string;
}

export interface CaptureDeps {
  store: ChunkStore;
  client: (address: string, token: string) => Client;
  // The tab's stream for the constraints of the plan.
  getTabStream(constraints: object): Promise<MediaStream>;
  // The microphone, or null when the member did not allow it.
  getMicStream(): Promise<MediaStream | null>;
  now(): number;
}

export const browserDeps = (): CaptureDeps => ({
  store: createIndexedDbChunkStore(),
  client: (address, token) => createClient(address, token),
  getTabStream: (constraints) => navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints),
  getMicStream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } }).catch(() => null),
  now: () => Date.now(),
});

export type Failure = 'title' | 'consentMethod' | 'consentAgreed' | 'device' | 'store' | 'setup';

export interface Running {
  meetingId: string;
  startedAt: number;
  micMissing: boolean;
  elapsedMs(): number;
  // Stops, saves the last chunk on the device and uploads; the copy is deleted only after the upload succeeded. `stopReason`
  // is given only for a stop the member did not ask for (A1, #3159): the server keeps the code on the meeting.
  stop(stopReason?: RecordingStopReason): Promise<{ uploaded: boolean; meetingId: string; message?: string }>;
  // Called once when the recording ends without the member's click: the meeting tab closed or its capture was taken away, the
  // recorder failed, or the device refused a chunk. The caller then stops with the reason, which uploads what was saved.
  onLost(listener: (reason: RecordingStopReason) => void): void;
}

export async function startCapture(params: CaptureParams, deps: CaptureDeps = browserDeps()): Promise<{ ok: true; running: Running } | { ok: false; reason: Failure }> {
  const blocker = consentBlocker({ title: params.title, consentMethod: params.consentMethod, consentAgreed: params.consentAgreed });
  if (blocker) return { ok: false, reason: blocker };
  const plan = capturePlan({ streamId: params.streamId, keepVideo: params.keepVideo, isTypeSupported: (t) => MediaRecorder.isTypeSupported(t) });
  const client = deps.client(params.address, params.token);
  const clock = createClock();
  const cleanups: Array<() => void> = [];
  let micMissing = false;
  // A1 (#3159): a recording that ends without the member's click is reported once, with a code.
  let stopRequested = false;
  let lost: RecordingStopReason | null = null;
  const lostListeners: Array<(reason: RecordingStopReason) => void> = [];
  const fireLost = (reason: RecordingStopReason) => {
    if (stopRequested || lost !== null) return;
    lost = reason;
    for (const listener of lostListeners) listener(reason);
  };
  const prepared = await prepareCapture<MediaStream & { getTracks(): MediaStreamTrack[] }, MediaRecorder>({
    openStore: async () => void (await deps.store.list(params.orgId)),
    async getStream() {
      const tab = await deps.getTabStream(plan.tabConstraints);
      // The tab's own tracks end when the tab is closed or its capture is taken away; the mix below would keep recording silence.
      for (const track of tab.getTracks()) track.addEventListener?.('ended', () => fireLost('tab_closed'));
      const mic = await deps.getMicStream();
      micMissing = mic === null;
      // The tab goes quiet for the member when captured; it is played again through the mix's context.
      const context = new AudioContext();
      const mix = context.createMediaStreamDestination();
      if (tab.getAudioTracks().length > 0) {
        const source = context.createMediaStreamSource(tab);
        source.connect(mix);
        source.connect(context.destination);
      }
      if (mic) context.createMediaStreamSource(mic).connect(mix);
      cleanups.push(() => {
        for (const stream of [tab, mic]) for (const track of stream?.getTracks() ?? []) track.stop();
        void context.close();
      });
      // A video track exists only when the plan asked the tab for one.
      return new MediaStream([...mix.stream.getAudioTracks(), ...(plan.kind === 'video' ? tab.getVideoTracks() : [])]);
    },
    createMeeting: async () => (await client.createMeeting({ title: params.title, keepVideo: params.keepVideo, consentMethod: params.consentMethod, consentNoticeVersion: RECORDING_NOTICE.version, liveNotes: params.liveNotes })).meetingId,
    makeRecorder: (stream) => new MediaRecorder(stream, plan.mimeType ? { mimeType: plan.mimeType } : undefined),
    async begin(meetingId, recorder) {
      return beginRecording(deps.store, {
        id: crypto.randomUUID(),
        scope: params.orgId,
        meetingId,
        title: params.title.trim(),
        kind: plan.kind,
        mimeType: recorder.mimeType || plan.mimeType || (plan.kind === 'video' ? 'video/webm' : 'audio/webm'),
        startedAt: deps.now(),
      });
    },
    wakeLock: async () => null,
    unmounted: () => false,
  });
  if (prepared.status !== 'ready') {
    for (const cleanup of cleanups) cleanup();
    return { ok: false, reason: prepared.status === 'aborted' ? 'setup' : prepared.reason };
  }
  const { recorder, writer, stream } = prepared;
  const startedAt = deps.now();
  clock.start(startedAt);
  const meetingId = writer.meta().meetingId;
  recorder.ondataavailable = (event) => void writer.addChunk(event.data, clock.elapsedMs(deps.now())).catch(() => fireLost('storage_full'));
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener(
      'stop',
      () => {
        // A stop nobody asked for (the browser or the device ended it).
        fireLost('unknown');
        resolve();
      },
      { once: true },
    ),
  );
  recorder.addEventListener('error', () => fireLost('unknown'));
  recorder.start(5000);
  // Live notes: never fails the recording; null when not ticked or when the live recorder cannot start.
  const live = startLiveCapture({
    enabled: params.liveNotes,
    makeRecorder: () => createBrowserLiveRecorder(stream),
    send: (piece) => client.sendLiveChunk({ meetingId, ...piece }),
    now: () => deps.now(),
  });
  return {
    ok: true,
    running: {
      meetingId,
      startedAt,
      micMissing,
      elapsedMs: () => clock.elapsedMs(deps.now()),
      onLost(listener) {
        if (lost !== null) listener(lost);
        else lostListeners.push(listener);
      },
      async stop(stopReason) {
        stopRequested = true;
        // How it ended is saved with the recording, so even a retry from the popup later carries the right code.
        await writer.markStopped(stopReason ?? 'user');
        clock.pause(deps.now());
        // The live recorder stops first and its last piece is taken before the devices are released.
        await live?.halt();
        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;
        for (const track of stream.getTracks()) track.stop();
        for (const cleanup of cleanups) cleanup();
        // The last chunk fires before `stop`; the writer queue is drained by touching it.
        await writer.touch(clock.elapsedMs(deps.now()));
        // The live pieces are refused once the final recording is stored, so they finish (or give up) first.
        const uploaded = await uploadAfterLive(live, () => uploadSaved(deps, client, params.uploads, writer.meta()));
        return { uploaded: uploaded.ok, meetingId, ...(uploaded.ok ? {} : { message: uploaded.message }) };
      },
    },
  };
}

// The reason code goes with the upload only when the recording did not end by the member's click.
const stopReasonOf = (meta: RecordingMeta): { stopReason?: RecordingStopReason } => {
  const stopReason = stopReasonForUpload(meta);
  return stopReason ? { stopReason } : {};
};

// The saved recording to the meeting; the device copy goes only after the server has it.
export async function uploadSaved(deps: Pick<CaptureDeps, 'store'>, client: Client, uploads: 'presigned' | 'direct', meta: RecordingMeta): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const recording = await assembleRecording(deps.store, meta);
    if (!recording) {
      await deps.store.remove(meta.id);
      return { ok: false, message: 'Không có âm thanh nào được lưu' };
    }
    await client.uploadMedia({ meetingId: meta.meetingId, kind: meta.kind, file: recording.file, lengthSeconds: recording.lengthSeconds, uploads, ...stopReasonOf(meta) });
    await deps.store.remove(meta.id);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không tải lên được' };
  }
}
