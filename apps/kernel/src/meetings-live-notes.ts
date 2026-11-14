// SPDX-License-Identifier: AGPL-3.0-only
// The worker's side of the live notes of a meeting being recorded (issue #3110, ADR-0052 L4a-2, ADR-0049 stage B). One job per window the recorder's tick
// started, and a window is one or two pieces (LIVE_WINDOW_PIECES) of about fifteen seconds:
//   1. the run is the recorder's member-scoped agent context (memberVyRuntime): every call enters it afresh, so the member being active, vy.use, the org,
//      module and agent kill switches, the global `ai` switch, a spent hard-stop budget and the run being live are re-checked at every step;
//   2. kernel.member_vy.meeting_audio.open, in its live mode, answers the ids and the per-piece wrapped keys of the pieces after the one the preview reached (never plaintext), and
//      it is called again before EACH piece, so a meeting deleted, shredded or taken from the recorder mid-window stops the window before the next piece;
//   3. each piece is transcribed behind RunMeter, whose admit enters the member context again with the call's projected cost, so a piece that would cross a
//      hard-stop budget is refused before the provider call;
//   4. kernel.member_vy.result.store writes the window's lines as the run's own result, the only thing a member-scoped context writes;
//   5. kernel.member_vy.run.finish closes the run.
// It writes no meeting table: the recorder's own tick copies the result into the preview (meetings.live.tick). A piece that is gone (the final recording landed
// and the sweep took its file) is skipped, not an error: the live notes end cleanly and the batch transcript takes over. The job is never retried by the queue.
import { aiCost, transcribeChunks, withAiScope, type AiCall, type AiMeter, type AiUsage, type TranscribeConfig, type TranscribeInput } from '@crove/agent';
import { AiBudgetExhaustedError } from '@crove/agent';
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
import { LIVE_LINE_TEXT_MAX, LIVE_WINDOW_PIECES, zLiveResult } from '@crove/kernel-contract';
import { TRANSCRIPT_RESULT_MAX, liveContainerHeader, livePieceFile } from '@crove/mod-meetings';
import { failureCode } from './meetings-transcribe.ts';
import type { MediaMeasurer } from './meetings-measure.ts';

export interface MeetingsLiveNotesJob {
  orgId: string;
  meetingId: string;
  runId: string;
  agentId: string;
  // The piece the preview has reached; this window takes the ones after it.
  afterSeq: number;
  pieces: number;
}

export interface MeetingsLiveNotesDeps {
  runtime: Runtime;
  store: BlobStore;
  broker: CredentialBroker;
  measurer: MediaMeasurer;
  provider: TranscribeConfig;
  price: { inputPerMTok: string; outputPerMTok: string; audioPerMinute: string };
}

const SYSTEM: SystemActor = { type: 'system', component: 'meetings.live_notes' };
// One live piece is at most a mebibyte of ciphertext (#3109); the cap keeps a wrong row from filling memory.
const PIECE_CIPHERTEXT_MAX = 4 * 1024 * 1024;

interface OpenPiece {
  seq: number;
  lengthSeconds: number;
  startOffsetSeconds: number;
  keyId: string;
  wrappedKey: Buffer | Uint8Array;
  fileId: string;
  storageKey: string;
  generation: string | null;
  sizeBytes: number;
  sha256: string;
  contentType: string;
}
interface OpenWindow {
  language: string;
  pieces: OpenPiece[];
}

// The meter of one window: admission enters the member's context again (a spent budget or a switch refuses there), and the record is the system's row for the
// run's agent. The same shape as the transcription run's meter.
class WindowMeter implements AiMeter {
  private readonly deps: MeetingsLiveNotesDeps;
  private readonly vy: MemberVyRuntime;
  private readonly job: MeetingsLiveNotesJob;

  constructor(deps: MeetingsLiveNotesDeps, vy: MemberVyRuntime, job: MeetingsLiveNotesJob) {
    this.deps = deps;
    this.vy = vy;
    this.job = job;
  }

  async admit(call: AiCall): Promise<void> {
    const projected = call.expected ? aiCost([call.expected], this.deps.price) : '0';
    try {
      await this.vy.query('kernel.member_vy.run.check', /^0+(?:\.0+)?$/.test(projected) ? {} : { projectedCost: projected });
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

// One piece, fetched and decrypted under its own key. The door is opened again for every piece, so the whole gate is re-checked before each one.
async function fetchPiece(deps: MeetingsLiveNotesDeps, job: MeetingsLiveNotesJob, vy: MemberVyRuntime, seq: number): Promise<{ bytes: Uint8Array; piece: OpenPiece; language: string } | null> {
  const window = await vy.execute<OpenWindow>('kernel.member_vy.meeting_audio.open', { meetingId: job.meetingId, live: { afterSeq: seq - 1, limit: 1 } });
  const piece = window.pieces.find((p) => p.seq === seq);
  // Gone since the window was listed (the final recording landed and the sweep took it): the window simply ends here.
  if (!piece) return null;
  const info = 'crove.meetings.v1|wrap';
  const { broker } = deps;
  const subkey = broker.deriveKey ? broker.deriveKey(piece.keyId, info) : broker.derive && broker.keyId === piece.keyId ? broker.derive(info) : null;
  if (!subkey) throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media decryption key unavailable');
  const binding = { orgId: job.orgId, meetingId: job.meetingId, kind: `live:${piece.seq}` as const };
  let dataKey: Buffer | null = null;
  try {
    dataKey = unwrapMediaKeyWithSubkey(Buffer.from(piece.wrappedKey), { ...binding, keyId: piece.keyId }, subkey);
    const ciphertext = await readVerified(deps.store, { key: piece.storageKey, generation: piece.generation, sha256: piece.sha256 }, PIECE_CIPHERTEXT_MAX);
    const plain = decryptBlobBuffer(Buffer.from(ciphertext), dataKey, binding);
    const bytes = new Uint8Array(plain);
    plain.fill(0);
    return { bytes, piece, language: window.language };
  } finally {
    dataKey?.fill(0);
    subkey.fill(0);
  }
}

// One piece as a file the provider and the sandbox can read, and its measured length. A piece after the first is the middle of a stream, so the header of the first piece
// goes in front of it (liveContainerHeader); that header is read once per window and wiped with the rest. What the meter charges is what crove-media measures in the file, never
// the length the sender claimed, and a sandbox that is down fails the window before a call is made.
async function openPiece(
  deps: MeetingsLiveNotesDeps,
  job: MeetingsLiveNotesJob,
  vy: MemberVyRuntime,
  seq: number,
  header: { value: Uint8Array | null | undefined },
): Promise<{ input: TranscribeInput; piece: OpenPiece } | null> {
  const fetched = await fetchPiece(deps, job, vy, seq);
  if (!fetched) return null;
  if (seq > 0 && header.value === undefined) {
    const first = await fetchPiece(deps, job, vy, 0);
    header.value = first ? liveContainerHeader(first.bytes) : null;
    first?.bytes.fill(0);
  }
  const file = livePieceFile(seq, fetched.bytes, header.value ?? null);
  const copy = new Uint8Array(file);
  fetched.bytes.fill(0);
  let measured: number;
  try {
    measured = await deps.measurer.measureBytes('audio', copy);
  } catch (error) {
    copy.fill(0);
    throw error;
  }
  return {
    input: { audio: copy, mimeType: fetched.piece.contentType, language: fetched.language === 'en' ? 'en' : 'vi', lengthSeconds: measured, offsetSeconds: 0 },
    piece: fetched.piece,
  };
}

// One window, start to end. Returns the state it left the run in; never throws for a failed window (the failure is stored), only for a lost database.
export async function runMeetingsLiveNotes(deps: MeetingsLiveNotesDeps, job: MeetingsLiveNotesJob): Promise<'succeeded' | 'failed'> {
  const vy = memberVyRuntime(deps.runtime, job.orgId, { agentId: job.agentId, runId: job.runId });
  let code: string | null = null;
  try {
    const listed = await vy.execute<OpenWindow>('kernel.member_vy.meeting_audio.open', {
      meetingId: job.meetingId,
      live: { afterSeq: job.afterSeq, limit: Math.min(Math.max(job.pieces, 1), LIVE_WINDOW_PIECES) },
    });
    const scope = { orgId: job.orgId, agentId: job.agentId, memberRunId: job.runId, meter: new WindowMeter(deps, vy, job) };
    const lines: Array<[number, number, number, string]> = [];
    // The header of the first piece, read when the first later piece needs it.
    const header: { value: Uint8Array | null | undefined } = { value: undefined };
    for (const listedPiece of listed.pieces) {
      const opened = await openPiece(deps, job, vy, listedPiece.seq, header);
      if (!opened) break;
      const piece = opened.piece;
      try {
        const seconds = opened.input.lengthSeconds;
        const segments = await withAiScope(scope, () => transcribeChunks(deps.provider, [opened.input]));
        const text = segments
          .map((s) => s.text.trim())
          .filter((t) => t !== '')
          .join(' ')
          .slice(0, LIVE_LINE_TEXT_MAX);
        // Where the piece sits in the recording: the lengths of the pieces before it (the recorder's clock), and its own length as measured.
        // A silent piece is a line with no text: the window reports how far it read, so the next one starts after it.
        lines.push([piece.seq, piece.startOffsetSeconds, piece.startOffsetSeconds + Math.max(1, seconds), text]);
      } finally {
        opened.input.audio.fill(0);
      }
    }
    header.value?.fill(0);
    const body = JSON.stringify(zLiveResult.parse({ v: 1, lines }));
    if (body.length > TRANSCRIPT_RESULT_MAX) throw new DomainError('TRANSCRIPT_TOO_LONG', 422, 'The window is longer than a result holds');
    const stored = await vy.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId: job.runId, outcome: { status: 'ready', body } });
    // A kill switch or a spent budget that appeared since the last admit makes the store keep a failed result, not the text.
    if (!stored.stored) code = 'AI_STOPPED';
  } catch (error: unknown) {
    code = failureCode(error);
    await vy.execute('kernel.member_vy.result.store', { runId: job.runId, outcome: { status: 'failed', errorCode: code } }).catch(() => undefined);
  }
  await deps.runtime.execute('kernel.member_vy.run.finish', { runId: job.runId, errorCode: code }, { actor: SYSTEM, orgId: job.orgId }).catch((error: unknown) => {
    console.error(`[meetings-live-notes] org ${job.orgId.slice(0, 8)} could not close run ${job.runId.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
  });
  console.log(`[meetings-live-notes] org ${job.orgId.slice(0, 8)} run ${job.runId.slice(0, 8)} ${code === null ? 'succeeded' : `failed ${code}`}`);
  return code === null ? 'succeeded' : 'failed';
}
