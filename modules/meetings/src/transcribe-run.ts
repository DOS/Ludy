// SPDX-License-Identifier: AGPL-3.0-only
// Transcription as the recorder's own Vy, the part that never reads a private result row (issue #2578, M4b; #2941): the start and the status. The copy of a finished
// result, which does, is in transcribe.ts. The shape, as decided on #2578 and #2756:
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
import { zTranscribeRunRef, zTranscribeStart, type TranscribeStatus } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { vnDay } from './retention.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

// Whether this deployment transcribes (MEETINGS_TRANSCRIBE=on with a provider), set at start-up from the config like the Message-ID domain: false until set.
// False: no run starts and the screen shows no button.
let transcribeEnabled = false;
export function setTranscribeEnabled(enabled: boolean): void {
  transcribeEnabled = enabled;
}

// Whether the deployment has a credential key (CREDENTIAL_KEY or CREDENTIAL_KEY_FILE). Without it the worker cannot open the meeting's media key, so a run
// started here would only fail at its first read (MEDIA_KEY_UNAVAILABLE) after it took a run slot: refused at the start instead, with its own code (#2863 item 2),
// and the screen shows no button. True until set, so a test that does not care is unaffected; the kernel sets it from the config at start-up.
let transcribeBroker = true;
export function setTranscribeBroker(configured: boolean): void {
  transcribeBroker = configured;
}

export const TRANSCRIBE_FEATURE = 'meetings.transcribe';
const FEATURE = TRANSCRIBE_FEATURE;

async function meetingHasAudio(trx: QueryContext['trx'], orgId: string, meetingId: string): Promise<boolean> {
  const row = await trx.selectFrom('crove_meetings.audio_segment').select('id').where('org_id', '=', orgId).where('meeting_id', '=', meetingId).executeTakeFirst();
  return row !== undefined;
}

export const transcriptStart = defineCommand({
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
    if (!transcribeBroker) throw new DomainError('TRANSCRIBE_NO_BROKER', 503, 'Transcription needs the deployment credential key (CREDENTIAL_KEY or CREDENTIAL_KEY_FILE); ask the operator');
    // The meeting row is held while the run is made, so a delete that races this start waits for it (and then removes the run through the trigger) instead of
    // leaving an empty failed result row behind.
    await ctx.trx.selectFrom('crove_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forShare().execute();
    if (!(await meetingHasAudio(ctx.trx, ctx.orgId, input.meetingId))) throw new DomainError('MEETING_NO_AUDIO', 422, 'This meeting has no audio to transcribe');
    // The audio's period ends on its date, not at the nightly shred (#2579): from that day a run would only fail, so none starts (the door refuses it too, #2863 item 1).
    const audioDay = (
      await ctx.trx.selectFrom('crove_meetings.meeting').select('audio_retention_date').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirstOrThrow()
    ).audio_retention_date;
    if (String(audioDay) <= vnDay(ctx.now)) throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting media retention has ended');
    // A run of this meeting that is still going is not started over: the kernel's start would cancel it after it spent budget. (Another use of Vy by the
    // recorder, a note summary for one, also supersedes a live run: the member has one run at a time, ADR-0049 decision 1; the screen then shows the run as ended.)
    const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: FEATURE, subjectId: input.meetingId });
    if (live.status !== 'ok' || live.value.live) throw new DomainError('TRANSCRIBE_RUNNING', 409, 'This meeting is already being transcribed');
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

export const transcriptStatus = defineQuery({
  name: 'meetings.transcript.status',
  input: zTranscribeRunRef,
  access: ROLES,
  handler: async (ctx, input): Promise<TranscribeStatus> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const none: TranscribeStatus = { meetingId: input.meetingId, enabled: transcribeEnabled && transcribeBroker, state: 'none', runId: null, errorCode: null };
    if (meeting.recorder_user_id !== userId) return none;
    // The state of the recorder's own latest run for this meeting, from the kernel (no row of the private result is read here).
    const latest = await ctx.query<{ runId: string; state: 'running' | 'ready' | 'failed'; errorCode: string | null; expiresAt: string } | null>('kernel.member_vy.run.latest', {
      feature: FEATURE,
      subjectType: 'meeting',
      subjectId: input.meetingId,
    });
    if (latest.status !== 'ok' || latest.value === null) return none;
    return { meetingId: input.meetingId, enabled: transcribeEnabled && transcribeBroker, state: latest.value.state, runId: latest.value.runId, errorCode: latest.value.errorCode };
  },
});

export const transcribeRunCommands = [transcriptStart];
export const transcribeRunQueries = [transcriptStatus];
