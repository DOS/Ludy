// SPDX-License-Identifier: AGPL-3.0-only
// Transcription as the recorder's own Vy, the copy of a finished result (the one command here that reads the private result; #2941) (issue #2578, M4b, ADR-0049 stage B and decision 8, ADR-0047). The shape, as decided on #2578 and #2756:
//
//   meetings.transcript.start        (transcribe-run.ts) the recorder's own action: starts the recorder's Vy run for this meeting (kernel.member_vy.run.start, which checks
//                                    vy.use, the four kill switches and the budget) and asks the worker for the job through an event that carries ids only.
//   (the worker)                     enters the recorder's member-scoped context for that one run (memberVyRuntime), reads the audio through
//                                    kernel.member_vy.meeting_audio.open, transcribes it metered by audio length, and writes ONLY kernel.member_vy_result.
//   meetings.transcript.copy_result  the recorder's own action again, in their user context: copies a finished result into the draft transcript
//                                    (crove_meetings.transcript_segment). Only the recorder can run it; no member-scoped context writes a meeting table.
//   meetings.transcript.status       (transcribe-run.ts) what the recorder's screen shows: switched on or not, and the state of the latest run.
//
// Transcription is off unless the deployment turns it on (MEETINGS_TRANSCRIBE, with a provider): the module works with it off, and `start` refuses
// with TRANSCRIBE_OFF. A kill switch or a spent budget refuses with the kernel's AI_BUDGET_EXHAUSTED, as for every use of Vy. The audit rows and the
// event carry ids and counts, never text.
import { zTranscriptCopy, zTranscriptResult, zTranscriptSegmentInput, type TranscriptSegmentInput } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { TRANSCRIBE_FEATURE as FEATURE } from './transcribe-run.ts';
import { ROLES, openMeeting, replaceDraft, userOf } from './transcript.ts';

// The most a result row holds (member_vy_result.body, a database check). A transcript longer than this is a failed run, never a cut one.
export const TRANSCRIPT_RESULT_MAX = 100_000;

// What a run stores in its result: a compact JSON, `{"v":1,"p":[speakers],"s":[[start,end,speaker index,text],...]}` (see zTranscriptResult for the room it has).
export function encodeTranscriptResult(segments: readonly TranscriptSegmentInput[]): string {
  const speakers: string[] = [];
  const index = new Map<string, number>();
  const rows = segments.map((s) => {
    let at = index.get(s.speakerLabel);
    if (at === undefined) {
      at = speakers.length;
      speakers.push(s.speakerLabel);
      index.set(s.speakerLabel, at);
    }
    return [s.startSeconds, s.endSeconds, at, s.text];
  });
  return JSON.stringify({ v: 1, p: speakers, s: rows });
}

// The segments a result holds, validated as the draft store validates them: a body that does not parse is data nobody trusts, so it is refused.
export function decodeTranscriptResult(body: string): TranscriptSegmentInput[] {
  const refuse = () => new DomainError('TRANSCRIPT_RESULT_INVALID', 422, 'The transcription result cannot be read');
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw refuse();
  }
  const parsed = zTranscriptResult.safeParse(raw);
  if (!parsed.success) throw refuse();
  const out: TranscriptSegmentInput[] = [];
  for (const [startSeconds, endSeconds, speaker, text] of parsed.data.s) {
    const speakerLabel = parsed.data.p[speaker];
    if (speakerLabel === undefined) throw refuse();
    const segment = zTranscriptSegmentInput.safeParse({ startSeconds, endSeconds, speakerLabel, text });
    if (!segment.success) throw refuse();
    out.push(segment.data);
  }
  return out;
}

export const transcriptCopyResult = defineCommand({
  name: 'meetings.transcript.copy_result',
  input: zTranscriptCopy,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can copy its transcription');
    // The recorder's own result, read in the recorder's own context (the row is sealed to its member). A run of another meeting or feature is not this one.
    const found = await ctx.query<{ status: string; feature: string; subjectType: string; subjectId: string; body: string | null }>('kernel.member_vy.result.get', { runId: input.runId });
    if (found.status !== 'ok') throw new DomainError('TRANSCRIPT_RESULT_NOT_FOUND', 404, 'No transcription result for this meeting');
    const result = found.value;
    if (result.feature !== FEATURE || result.subjectType !== 'meeting' || result.subjectId !== input.meetingId) {
      throw new DomainError('TRANSCRIPT_RESULT_NOT_FOUND', 404, 'No transcription result for this meeting');
    }
    if (result.status !== 'ready' || result.body === null) throw new DomainError('TRANSCRIPT_RESULT_NOT_READY', 409, 'The transcription is not finished');
    const segments = decodeTranscriptResult(result.body);
    await replaceDraft(ctx, input.meetingId, segments, { tainted: true, sourceRunId: input.runId });
    ctx.audit({ meetingId: input.meetingId, runId: input.runId, stored: segments.length });
    return { meetingId: input.meetingId, stored: segments.length };
  },
});

export const transcribeCommandList = [transcriptCopyResult];
