// SPDX-License-Identifier: AGPL-3.0-only
// Transcription as the recorder's own Vy (issue #2578, M4b, ADR-0049 stage B and decision 8, ADR-0047). The shape, as decided on #2578 and #2756:
//
//   meetings.transcript.start        the recorder's own action: starts the recorder's Vy run for this meeting (kernel.member_vy.run.start, which checks
//                                    vy.use, the four kill switches and the budget) and asks the worker for the job through an event that carries ids only.
//   (the worker)                     enters the recorder's member-scoped context for that one run (memberVyRuntime), reads the audio through
//                                    kernel.member_vy.meeting_audio.open, transcribes it metered by audio length, and writes ONLY kernel.member_vy_result.
//   meetings.transcript.copy_result  the recorder's own action again, in their user context: copies a finished result into the draft transcript
//                                    (crove_meetings.transcript_segment). Only the recorder can run it; no member-scoped context writes a meeting table.
//   meetings.transcript.status       what the recorder's screen shows: switched on or not, and the state of the latest run.
//
// Transcription is off unless the deployment turns it on (MEETINGS_TRANSCRIBE, with a provider): the module works with it off, and `start` refuses
// with TRANSCRIBE_OFF. A kill switch or a spent budget refuses with the kernel's AI_BUDGET_EXHAUSTED, as for every use of Vy. The audit rows and the
// event carry ids and counts, never text.
import { zTranscribeRunRef, zTranscribeStart, zTranscriptCopy, zTranscriptResult, zTranscriptSegmentInput, type TranscribeStatus, type TranscriptSegmentInput } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { ROLES, openMeeting, replaceDraft, userOf } from './transcript.ts';

// Whether this deployment transcribes (MEETINGS_TRANSCRIBE=on with a provider), set at start-up from the config like the Message-ID domain: false until set.
// False: no run starts and the screen shows no button.
let transcribeEnabled = false;
export function setTranscribeEnabled(enabled: boolean): void {
  transcribeEnabled = enabled;
}

const FEATURE = 'meetings.transcribe';
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

const LIVE_STATES = new Set(['running', 'ready', 'failed']);

async function meetingHasAudio(trx: QueryContext['trx'], orgId: string, meetingId: string): Promise<boolean> {
  const row = await trx.selectFrom('crove_meetings.audio_segment').select('id').where('org_id', '=', orgId).where('meeting_id', '=', meetingId).executeTakeFirst();
  return row !== undefined;
}

function build() {
  const start = defineCommand({
    name: 'meetings.transcript.start',
    input: zTranscribeStart,
    // The recorder's click sends the meeting's audio to the transcription provider and spends the AI budget: an external effect (R2, plan section 4.7),
    // the click being the person's approval of that spend.
    risk: 'R2',
    sideEffect: 'external',
    access: ROLES,
    target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
    handler: async (ctx, input) => {
      const userId = userOf(ctx.actor);
      const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
      if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can start its transcription');
      if (!transcribeEnabled) throw new DomainError('TRANSCRIBE_OFF', 422, 'Transcription is not turned on here; the meeting works as it did');
      // The meeting row is held while the run is made, so a delete that races this start waits for it (and then removes the run through the trigger) instead of
      // leaving an empty failed result row behind.
      await ctx.trx.selectFrom('crove_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forShare().execute();
      if (!(await meetingHasAudio(ctx.trx, ctx.orgId, input.meetingId))) throw new DomainError('MEETING_NO_AUDIO', 422, 'This meeting has no audio to transcribe');
      // A run of this meeting that is still going is not started over: the kernel's start would cancel it after it spent budget. (Another use of Vy by the
      // recorder, a note summary for one, also supersedes a live run: the member has one run at a time, ADR-0049 decision 1; the screen then shows the run as ended.)
      const live = await ctx.trx
        .selectFrom('crove_kernel.member_vy_result as v')
        .innerJoin('crove_kernel.ai_run as r', (j) => j.onRef('r.org_id', '=', 'v.org_id').onRef('r.id', '=', 'v.run_id'))
        .select('v.id')
        .where('v.org_id', '=', ctx.orgId)
        .where('v.member_user_id', '=', userId)
        .where('v.feature', '=', FEATURE)
        .where('v.subject_id', '=', input.meetingId)
        .where('v.status', '=', 'running')
        .where('r.status', '=', 'running')
        .where('r.expires_at', '>', new Date())
        .executeTakeFirst();
      if (live) throw new DomainError('TRANSCRIBE_RUNNING', 409, 'This meeting is already being transcribed');
      // The kernel's start checks vy.use, the org, module and agent kill switches, the global ai switch and the budget (AI_BUDGET_EXHAUSTED), and makes the
      // member's Vy and this run (a result row in status running, the subject this meeting).
      const started = await ctx.run<{ runId: string; resultId: string }>('kernel.member_vy.run.start', { feature: FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
      const agent = await ctx.trx
        .selectFrom('crove_kernel.agent')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('kind', '=', 'member_vy')
        .where('member_user_id', '=', userId)
        .executeTakeFirstOrThrow();
      await ctx.emit('meetings.transcript.requested', { meetingId: input.meetingId, runId: started.runId, agentId: agent.id });
      ctx.audit({ meetingId: input.meetingId, runId: started.runId });
      return { meetingId: input.meetingId, runId: started.runId };
    },
  });

  const copyResult = defineCommand({
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
      await replaceDraft(ctx, input.meetingId, segments);
      ctx.audit({ meetingId: input.meetingId, runId: input.runId, stored: segments.length });
      return { meetingId: input.meetingId, stored: segments.length };
    },
  });

  const status = defineQuery({
    name: 'meetings.transcript.status',
    input: zTranscribeRunRef,
    access: ROLES,
    handler: async (ctx, input): Promise<TranscribeStatus> => {
      const userId = userOf(ctx.actor);
      const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
      const none: TranscribeStatus = { meetingId: input.meetingId, enabled: transcribeEnabled, state: 'none', runId: null, errorCode: null };
      if (meeting.recorder_user_id !== userId) return none;
      // The recorder's own latest result for this meeting (the row is sealed to its member, so no other member sees one), and whether its run is still alive.
      const row = await ctx.trx
        .selectFrom('crove_kernel.member_vy_result as v')
        .leftJoin('crove_kernel.ai_run as r', (j) => j.onRef('r.org_id', '=', 'v.org_id').onRef('r.id', '=', 'v.run_id'))
        .select(['v.run_id', 'v.status', 'v.error_code', 'r.status as run_status', 'r.expires_at'])
        .where('v.org_id', '=', ctx.orgId)
        .where('v.member_user_id', '=', userId)
        .where('v.feature', '=', FEATURE)
        .where('v.subject_type', '=', 'meeting')
        .where('v.subject_id', '=', input.meetingId)
        .orderBy('v.created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!row || !LIVE_STATES.has(row.status)) return none;
      // A run that ended or expired without storing its result (the worker lost, the member removed and back) shows as failed, never as running for ever.
      const dead = row.status === 'running' && (row.run_status !== 'running' || (row.expires_at !== null && row.expires_at <= new Date()));
      const state = dead ? 'failed' : (row.status as 'running' | 'ready' | 'failed');
      return { meetingId: input.meetingId, enabled: transcribeEnabled, state, runId: row.run_id, errorCode: dead ? 'RUN_ENDED' : row.error_code };
    },
  });

  return { commands: [start, copyResult], queries: [status] };
}

const built = build();
export const transcribeCommandList = built.commands;
export const transcribeQueryList = built.queries;
