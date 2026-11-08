// SPDX-License-Identifier: AGPL-3.0-only
// One recording in the offscreen document: the meeting tab's sound mixed with the microphone (and the tab's picture only
// with the tick), written chunk by chunk to the device through the app recorder's chunk store, and uploaded on stop.
// The order and the cleanup are the app recorder's `prepareCapture` (devices, then the meeting with its consent, then the
// recorder), so a refused device leaves no meeting behind. Nothing here calls a model: AI off still records.
import {
  assembleRecording,
  beginRecording,
  createClock,
  createIndexedDbChunkStore,
  prepareCapture,
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
  // Stops, saves the last chunk on the device and uploads; the copy is deleted only after the upload succeeded.
  stop(): Promise<{ uploaded: boolean; meetingId: string; message?: string }>;
}

export async function startCapture(params: CaptureParams, deps: CaptureDeps = browserDeps()): Promise<{ ok: true; running: Running } | { ok: false; reason: Failure }> {
  const blocker = consentBlocker({ title: params.title, consentMethod: params.consentMethod, consentAgreed: params.consentAgreed });
  if (blocker) return { ok: false, reason: blocker };
  const plan = capturePlan({ streamId: params.streamId, keepVideo: params.keepVideo, isTypeSupported: (t) => MediaRecorder.isTypeSupported(t) });
  const client = deps.client(params.address, params.token);
  const clock = createClock();
  const cleanups: Array<() => void> = [];
  let micMissing = false;
  const prepared = await prepareCapture<MediaStream & { getTracks(): MediaStreamTrack[] }, MediaRecorder>({
    openStore: async () => void (await deps.store.list(params.orgId)),
    async getStream() {
      const tab = await deps.getTabStream(plan.tabConstraints);
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
    createMeeting: async () => (await client.createMeeting({ title: params.title, keepVideo: params.keepVideo, consentMethod: params.consentMethod })).meetingId,
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
  recorder.ondataavailable = (event) => void writer.addChunk(event.data, clock.elapsedMs(deps.now())).catch(() => undefined);
  const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
  recorder.start(5000);
  return {
    ok: true,
    running: {
      meetingId,
      startedAt,
      micMissing,
      elapsedMs: () => clock.elapsedMs(deps.now()),
      async stop() {
        clock.pause(deps.now());
        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;
        for (const track of stream.getTracks()) track.stop();
        for (const cleanup of cleanups) cleanup();
        // The last chunk fires before `stop`; the writer queue is drained by touching it.
        await writer.touch(clock.elapsedMs(deps.now()));
        const uploaded = await uploadSaved(deps, client, params.uploads, writer.meta());
        return { uploaded: uploaded.ok, meetingId, ...(uploaded.ok ? {} : { message: uploaded.message }) };
      },
    },
  };
}

// The saved recording to the meeting; the device copy goes only after the server has it.
export async function uploadSaved(deps: Pick<CaptureDeps, 'store'>, client: Client, uploads: 'presigned' | 'direct', meta: RecordingMeta): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const recording = await assembleRecording(deps.store, meta);
    if (!recording) {
      await deps.store.remove(meta.id);
      return { ok: false, message: 'Không có âm thanh nào được lưu' };
    }
    await client.uploadMedia({ meetingId: meta.meetingId, kind: meta.kind, file: recording.file, lengthSeconds: recording.lengthSeconds, uploads });
    await deps.store.remove(meta.id);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không tải lên được' };
  }
}
