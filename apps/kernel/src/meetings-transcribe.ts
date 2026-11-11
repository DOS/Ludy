// SPDX-License-Identifier: AGPL-3.0-only
// The worker's side of transcription as the recorder's own Vy (issue #2578, M4b, ADR-0049 stage B). One job per run the recorder started:
//   1. the run is the recorder's member-scoped agent context (memberVyRuntime): each call below enters it afresh, so the member being active, vy.use, the
//      org, module and agent kill switches, the global `ai` switch, a spent hard-stop budget and the run being live are re-checked at every step;
//   2. kernel.member_vy.meeting_audio.open answers the audio's ids and the wrapped key (never plaintext), and it is called again before EACH chunk, so a meeting
//      deleted, shredded or taken from the recorder mid-run stops the run before the next chunk; the worker fetches that chunk's ciphertext, checks its hash and
//      decrypts it with the meeting's key, which it wipes at once. (A deleted meeting also cancels its live run and deletes its result: a database trigger.)
//   3. transcribeChunks sends the chunks to the provider, each admitted first by RunMeter.admit, which enters the member context again (the admit of
//      ADR-0049 decision 6) and refuses on a switch or a spent budget; the call is recorded by its measured audio seconds;
//   4. kernel.member_vy.result.store writes the transcript as the run's own result (the only thing a member-scoped context writes);
//   5. kernel.member_vy.run.finish, the system command of this worker login, closes the run.
// The job writes no meeting table: the recorder's own action copies the result into the draft (meetings.transcript.copy_result). A failed run stores a fixed
// code, never a message. Logs carry ids and codes. A job is never retried by the queue: another try would send the audio to the provider again; the recorder
// starts it again if they want to.
import { AiBudgetExhaustedError, aiCost, mergeChunkTranscripts, transcribeChunks, withAiScope, TranscriptionError, type AiCall, type AiMeter, type AiUsage, type TranscribeConfig, type TranscribeInput, type TranscriptSegment } from '@crove/agent';
import {
  DomainError,
  decryptBlobBuffer,
  memberVyRuntime,
  readVerified,
  unwrapMediaKeyWithSubkey,
  type BlobStore,
  type CredentialBroker,
  type MemberVyRuntime,
  type Runtime,
  type SystemActor,
} from '@crove/kernel-runtime';
import type { MediaMeasurer } from './meetings-measure.ts';
import { MEMBER_VY_RUN_ERROR_CODES, type MemberVyRunErrorCode } from '@crove/kernel';
import { decodeTranscriptResult, encodeTranscriptResult, TRANSCRIPT_RESULT_MAX } from '@crove/mod-meetings';

export interface MeetingsTranscribeJob {
  orgId: string;
  meetingId: string;
  runId: string;
  agentId: string;
}

export interface MeetingsTranscribeDeps {
  runtime: Runtime;
  store: BlobStore;
  broker: CredentialBroker;
  // Measures every chunk it decrypts in crove-media before the meter sees it (#2985): the stored length is never what is charged.
  measurer: MediaMeasurer;
  provider: TranscribeConfig;
  // The deployment's prices (AI_PRICE_*): a transcription call is priced by its audio minutes.
  price: { inputPerMTok: string; outputPerMTok: string; audioPerMinute: string };
}

const SYSTEM: SystemActor = { type: 'system', component: 'meetings.transcribe' };
// One audio object the sandbox made is at most a 10 minute chunk; the cap keeps a wrong row from filling memory.
const SEGMENT_CIPHERTEXT_MAX = 64 * 1024 * 1024;
// About what a 100000 character result row holds (an hour and a half of speech); longer meetings are refused before any call.
export const TRANSCRIPT_MAX_SECONDS = 90 * 60;

interface RunAudio {
  language: string;
  keyId: string;
  wrappedKey: Buffer | Uint8Array;
  segments: Array<{ order: number; startOffsetSeconds: number; lengthSeconds: number; fileId: string; storageKey: string; generation: string | null; sizeBytes: number; sha256: string; contentType: string }>;
}

// The meter of one run: admission enters the member's context again, which checks everything decision 1 and 6 name; the record is the system's row for the
// run's agent (ids, the feature, the cost in the deployment's unit; never text).
class RunMeter implements AiMeter {
  private readonly deps: MeetingsTranscribeDeps;
  private readonly vy: MemberVyRuntime;
  private readonly job: MeetingsTranscribeJob;

  constructor(deps: MeetingsTranscribeDeps, vy: MemberVyRuntime, job: MeetingsTranscribeJob) {
    this.deps = deps;
    this.vy = vy;
    this.job = job;
  }

  async admit(): Promise<void> {
    try {
      await this.vy.query('kernel.member_vy.run.check', {});
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'BUDGET_EXHAUSTED') throw new AiBudgetExhaustedError('module', null);
      throw error;
    }
  }

  async record(call: AiCall, usage: AiUsage): Promise<void> {
    await this.deps.runtime.execute(
      'kernel.ai.usage.record',
      { feature: call.feature, module: call.module, agentId: this.job.agentId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: aiCost([usage], this.deps.price) },
      { actor: SYSTEM, orgId: this.job.orgId },
    );
  }
}

// The fixed code a failure is stored under: a word from the kernel's list (MEMBER_VY_RUN_ERROR_CODES, the same one the database checks), never the error's text. A failure
// with no word of its own on the list is TRANSCRIBE_FAILED, so a run is always closed and never left running by a code the database would refuse.
export function failureCode(error: unknown): MemberVyRunErrorCode {
  let code: string = 'TRANSCRIBE_FAILED';
  if (error instanceof AiBudgetExhaustedError) code = 'AI_BUDGET_EXHAUSTED';
  else if (error instanceof TranscriptionError) code = `TRANSCRIBE_${error.kind.toUpperCase()}`;
  else if (error instanceof DomainError) {
    if (error.code === 'KILL_SWITCH_ON') code = 'AI_STOPPED';
    else if (error.code === 'BUDGET_EXHAUSTED') code = 'AI_BUDGET_EXHAUSTED';
    else if (error.code === 'MEDIA_PROBE_UNAVAILABLE') code = 'TRANSCRIBE_UNAVAILABLE';
    else if (error.code === 'MEDIA_TOO_LONG') code = 'TRANSCRIPT_TOO_LONG';
    else code = error.code;
  }
  return (MEMBER_VY_RUN_ERROR_CODES as readonly string[]).includes(code) ? (code as MemberVyRunErrorCode) : 'TRANSCRIBE_FAILED';
}

// One chunk of the recording, fetched and decrypted. The audio door is opened again for every chunk: it re-checks the whole gate (the meeting still exists, its key is
// not shredded, the recorder still reads it, the run is live), so a meeting deleted, shredded or taken from the recorder mid-run stops the run before the next chunk
// is read, let alone sent. The key and the plaintext live only as long as this call.
async function openChunk(deps: MeetingsTranscribeDeps, job: MeetingsTranscribeJob, vy: MemberVyRuntime, order: number): Promise<{ input: TranscribeInput; chunks: number }> {
  const audio = await vy.execute<RunAudio>('kernel.member_vy.meeting_audio.open', { meetingId: job.meetingId });
  const segment = audio.segments.find((s) => s.order === order);
  if (!segment) throw new DomainError('AUDIO_NOT_FOUND', 404, 'Meeting audio not found');
  const info = 'crove.meetings.v1|wrap';
  const { broker } = deps;
  const subkey = broker.deriveKey ? broker.deriveKey(audio.keyId, info) : broker.derive && broker.keyId === audio.keyId ? broker.derive(info) : null;
  if (!subkey) throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media decryption key unavailable');
  const binding = { orgId: job.orgId, meetingId: job.meetingId, kind: 'audio' as const };
  let dataKey: Buffer | null = null;
  try {
    dataKey = unwrapMediaKeyWithSubkey(Buffer.from(audio.wrappedKey), { ...binding, keyId: audio.keyId }, subkey);
    const ciphertext = await readVerified(deps.store, { key: segment.storageKey, generation: segment.generation, sha256: segment.sha256 }, SEGMENT_CIPHERTEXT_MAX);
    const plain = decryptBlobBuffer(Buffer.from(ciphertext), dataKey, binding);
    const copy = new Uint8Array(plain);
    plain.fill(0);
    // The length the meter charges is what crove-media measures in these bytes, never the stored one: a row written before the sandbox
    // measured uploads (or any wrong row) carries a length nobody checked. A sandbox that is down fails the run before a call is made.
    let measured: number;
    try {
      measured = await deps.measurer.measureBytes('audio', copy);
    } catch (error) {
      copy.fill(0);
      throw error;
    }
    return { input: { audio: copy, mimeType: segment.contentType, language: audio.language === 'en' ? 'en' : 'vi', lengthSeconds: measured, offsetSeconds: segment.startOffsetSeconds }, chunks: audio.segments.length };
  } finally {
    dataKey?.fill(0);
    subkey.fill(0);
  }
}

// One run, start to end. Returns the state it left the run in; never throws for a failed run (the failure is stored), only for a lost database.
export async function runMeetingsTranscribe(deps: MeetingsTranscribeDeps, job: MeetingsTranscribeJob): Promise<'succeeded' | 'failed'> {
  const vy = memberVyRuntime(deps.runtime, job.orgId, { agentId: job.agentId, runId: job.runId });
  let code: string | null = null;
  try {
    const audio = await vy.execute<RunAudio>('kernel.member_vy.meeting_audio.open', { meetingId: job.meetingId });
    // A transcript past what one result row holds fails whatever is done, so it is refused before any chunk is sent and charged.
    if (audio.segments.reduce((n, seg) => n + seg.lengthSeconds, 0) > TRANSCRIPT_MAX_SECONDS) throw new DomainError('TRANSCRIPT_TOO_LONG', 422, 'The meeting is too long to transcribe in one go');
    const scope = { orgId: job.orgId, agentId: job.agentId, memberRunId: job.runId, meter: new RunMeter(deps, vy, job) };
    // One chunk at a time, the gate of the audio door passed again before each one (openChunk), then the chunk behind the meter (its admit enters the context once more).
    const done: TranscriptSegment[][] = [];
    let measuredTotal = 0;
    for (const { order } of [...audio.segments].sort((a, b) => a.order - b.order)) {
      const { input } = await openChunk(deps, job, vy, order);
      try {
        // The same limit as above, on the measured seconds, before the chunk is sent and charged.
        measuredTotal += input.lengthSeconds;
        if (measuredTotal > TRANSCRIPT_MAX_SECONDS) throw new DomainError('TRANSCRIPT_TOO_LONG', 422, 'The meeting is too long to transcribe in one go');
        done.push(await withAiScope(scope, () => transcribeChunks(deps.provider, [input])));
      } finally {
        // The plaintext chunk is zeroed whether the provider answered or not.
        input.audio.fill(0);
      }
    }
    const segments = mergeChunkTranscripts(done);
    const body = encodeTranscriptResult(segments);
    if (segments.length === 0) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'The recording holds no speech');
    if (body.length > TRANSCRIPT_RESULT_MAX) throw new DomainError('TRANSCRIPT_TOO_LONG', 422, 'The transcript is longer than a result holds');
    // What is stored is exactly what the recorder's copy accepts: a result that would fail the copy fails the run here, with a fixed code.
    decodeTranscriptResult(body);
    const stored = await vy.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId: job.runId, outcome: { status: 'ready', body } });
    // A kill switch or a spent budget that appeared since the last admit makes the store keep a failed result, not the text: the run is failed too.
    if (!stored.stored) code = 'AI_STOPPED';
  } catch (error: unknown) {
    code = failureCode(error);
    // Best effort: when the context itself is refused (the member left, a switch is on) there is nothing to write and the finish below fails the result.
    await vy.execute('kernel.member_vy.result.store', { runId: job.runId, outcome: { status: 'failed', errorCode: code } }).catch(() => undefined);
  }
  await deps.runtime.execute('kernel.member_vy.run.finish', { runId: job.runId, errorCode: code }, { actor: SYSTEM, orgId: job.orgId }).catch((error: unknown) => {
    console.error(`[meetings-transcribe] org ${job.orgId.slice(0, 8)} could not close run ${job.runId.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
  });
  console.log(`[meetings-transcribe] org ${job.orgId.slice(0, 8)} run ${job.runId.slice(0, 8)} ${code === null ? 'succeeded' : `failed ${code}`}`);
  return code === null ? 'succeeded' : 'failed';
}
