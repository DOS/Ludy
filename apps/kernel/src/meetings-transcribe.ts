// SPDX-License-Identifier: AGPL-3.0-only
// The worker's side of transcription as the recorder's own Vy (issue #2578, M4b, ADR-0049 stage B). One job per run the recorder started:
//   1. the run is the recorder's member-scoped agent context (memberVyRuntime): each call below enters it afresh, so the member being active, vy.use, the
//      org, module and agent kill switches, the global `ai` switch, a spent hard-stop budget and the run being live are re-checked at every step;
//   2. kernel.member_vy.meeting_audio.open answers the audio's ids and the wrapped key (never plaintext); the worker fetches each ciphertext object, checks its
//      hash and decrypts it with the meeting's key, which it wipes when done;
//   3. transcribeChunks sends the chunks to the provider, each admitted first by RunMeter.admit, which enters the member context again (the admit of
//      ADR-0049 decision 6) and refuses on a switch or a spent budget; the call is recorded by its measured audio seconds;
//   4. kernel.member_vy.result.store writes the transcript as the run's own result (the only thing a member-scoped context writes);
//   5. kernel.member_vy.run.finish, the system command of this worker login, closes the run.
// The job writes no meeting table: the recorder's own action copies the result into the draft (meetings.transcript.copy_result). A failed run stores a fixed
// code, never a message. Logs carry ids and codes. A job is never retried by the queue: another try would send the audio to the provider again; the recorder
// starts it again if they want to.
import { AiBudgetExhaustedError, aiCost, transcribeChunks, withAiScope, TranscriptionError, type AiCall, type AiMeter, type AiUsage, type TranscribeConfig, type TranscribeInput } from '@crove/agent';
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
import { encodeTranscriptResult, TRANSCRIPT_RESULT_MAX } from '@crove/mod-meetings';

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
  provider: TranscribeConfig;
  // The deployment's prices (AI_PRICE_*): a transcription call is priced by its audio minutes.
  price: { inputPerMTok: string; outputPerMTok: string; audioPerMinute: string };
}

const SYSTEM: SystemActor = { type: 'system', component: 'meetings.transcribe' };
// One audio object the sandbox made is at most a 10 minute chunk; the cap keeps a wrong row from filling memory.
const SEGMENT_CIPHERTEXT_MAX = 64 * 1024 * 1024;
// About what a 100000 character result row holds (an hour and a half of speech); longer meetings are refused before any call.
export const TRANSCRIPT_MAX_SECONDS = 90 * 60;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

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

// The fixed code a failure is stored under: a word, never the error's text.
export function failureCode(error: unknown): string {
  if (error instanceof AiBudgetExhaustedError) return 'AI_BUDGET_EXHAUSTED';
  if (error instanceof TranscriptionError) return `TRANSCRIBE_${error.kind.toUpperCase()}`;
  if (error instanceof DomainError) {
    if (error.code === 'KILL_SWITCH_ON') return 'AI_STOPPED';
    if (error.code === 'BUDGET_EXHAUSTED') return 'AI_BUDGET_EXHAUSTED';
    if (CODE.test(error.code)) return error.code;
  }
  return 'TRANSCRIBE_FAILED';
}

async function openAudio(deps: MeetingsTranscribeDeps, job: MeetingsTranscribeJob, audio: RunAudio): Promise<TranscribeInput[]> {
  const info = 'crove.meetings.v1|wrap';
  const { broker } = deps;
  const subkey = broker.deriveKey ? broker.deriveKey(audio.keyId, info) : broker.derive && broker.keyId === audio.keyId ? broker.derive(info) : null;
  if (!subkey) throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media decryption key unavailable');
  const binding = { orgId: job.orgId, meetingId: job.meetingId, kind: 'audio' as const };
  const language = audio.language === 'en' ? 'en' : 'vi';
  let dataKey: Buffer | null = null;
  try {
    dataKey = unwrapMediaKeyWithSubkey(Buffer.from(audio.wrappedKey), { ...binding, keyId: audio.keyId }, subkey);
    const inputs: TranscribeInput[] = [];
    for (const segment of audio.segments) {
      const ciphertext = await readVerified(deps.store, { key: segment.storageKey, generation: segment.generation, sha256: segment.sha256 }, SEGMENT_CIPHERTEXT_MAX);
      const plain = decryptBlobBuffer(Buffer.from(ciphertext), dataKey, binding);
      const copy = new Uint8Array(plain);
      plain.fill(0);
      inputs.push({ audio: copy, mimeType: segment.contentType, language, lengthSeconds: segment.lengthSeconds, offsetSeconds: segment.startOffsetSeconds });
    }
    return inputs;
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
    const inputs = await openAudio(deps, job, audio);
    const segments = await withAiScope({ orgId: job.orgId, agentId: job.agentId, memberRunId: job.runId, meter: new RunMeter(deps, vy, job) }, () => transcribeChunks(deps.provider, inputs));
    const body = encodeTranscriptResult(segments);
    if (segments.length === 0) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'The recording holds no speech');
    if (body.length > TRANSCRIPT_RESULT_MAX) throw new DomainError('TRANSCRIPT_TOO_LONG', 422, 'The transcript is longer than a result holds');
    const stored = await vy.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId: job.runId, outcome: { status: 'ready', body } });
    // A kill switch or a spent budget that appeared since the last admit makes the store keep a failed result, not the text: the run is failed too.
    if (!stored.stored) code = 'AI_STOPPED';
  } catch (error: unknown) {
    code = failureCode(error);
    // Best effort: when the context itself is refused (the member left, a switch is on) there is nothing to write and the finish below fails the result.
    await vy.execute('kernel.member_vy.result.store', { runId: job.runId, outcome: { status: 'failed', errorCode: code } }).catch(() => undefined);
  }
  await deps.runtime.execute('kernel.member_vy.run.finish', { runId: job.runId, status: code === null ? 'succeeded' : 'failed', errorCode: code }, { actor: SYSTEM, orgId: job.orgId }).catch((error: unknown) => {
    console.error(`[meetings-transcribe] org ${job.orgId.slice(0, 8)} could not close run ${job.runId.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
  });
  console.log(`[meetings-transcribe] org ${job.orgId.slice(0, 8)} run ${job.runId.slice(0, 8)} ${code === null ? 'succeeded' : `failed ${code}`}`);
  return code === null ? 'succeeded' : 'failed';
}
