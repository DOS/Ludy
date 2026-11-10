// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy summarizing a meeting, the parts that never read a private result row (#2580, M6 part B; #2941): the start, the status and the recorder's review
// of a draft. The copy of a finished result into the draft, which does, is in summary.ts. A feature that must not cut off a paid transcription asks the kernel
// (kernel.member_vy.run.live) instead of reading the private rows itself.
import { sql } from 'kysely';
import { zDraftReview, zDraftReviewed, zSummaryStart, zSummaryStarted, zSummaryStatus, zSummaryRef } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const SUMMARY_FEATURE = 'meetings.summary';
const FEATURE = SUMMARY_FEATURE;

// Whether this deployment lets the recorder's Vy summarize (MEETINGS_SUMMARY=on), set at start-up from the config: false until set.
let summaryEnabled = false;
export function setSummaryEnabled(enabled: boolean): void {
  summaryEnabled = enabled;
}
export function isSummaryEnabled(): boolean {
  return summaryEnabled;
}

// Starts the recorder's own Vy run for this meeting's summary: the recorder only, with the deployment's switch on and a transcript to read. The kernel's
// run.start then checks vy.use, the org, module and agent kill switches, the global ai switch and the budget, makes the member's Vy and this run, and binds the
// run's subject to this meeting; nothing is read or sent here. The route that calls the model (apps/kernel) runs this first and reads the transcript after.
export const summaryStart = defineCommand({
  name: 'meetings.summary.start',
  input: zSummaryStart,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!summaryEnabled) throw new DomainError('SUMMARY_OFF', 422, 'Summaries by Vy are not turned on here; type the summary by hand');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy to summarize it');
    // The meeting is held FOR SHARE, so a concurrent erase or retention change waits for this start (as transcribe does).
    await ctx.trx.selectFrom('crove_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forShare().execute();
    // The member has one Vy run at a time and the kernel's start supersedes a live one: a transcription of any meeting that is still going (paid for) is not cut off.
    const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: 'meetings.transcribe' });
    if (live.status !== 'ok' || live.value.live) throw new DomainError('TRANSCRIBE_RUNNING', 409, 'A transcription of yours is still running; wait for it to finish');
    const any = await ctx.trx.selectFrom('crove_meetings.transcript_segment').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).limit(1).executeTakeFirst();
    if (!any) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'There is no transcript to summarize yet');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    ctx.audit({ meetingId: input.meetingId, runId: started.runId });
    return zSummaryStarted.parse({ meetingId: input.meetingId, runId: started.runId });
  },
});

// Whether this deployment lets the recorder's Vy summarize, for the button.
export const summaryStatus = defineQuery({
  name: 'meetings.summary.status',
  input: zSummaryRef,
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const reason = !summaryEnabled ? ('off' as const) : meeting.recorder_user_id !== userId ? ('not_recorder' as const) : null;
    return zSummaryStatus.parse({ meetingId: input.meetingId, enabled: reason === null, reason });
  },
});

// The recorder's explicit "I read this": the draft rows of their meeting lose the mark that says the model wrote them, so they can be shared. The database
// function checks again that the caller is the recorder, in a user context.
export const draftReview = defineCommand({
  name: 'meetings.draft.review',
  input: zDraftReview,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userOf(ctx.actor)) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can review its draft');
    const { rows } = await sql<{ n: number }>`SELECT crove_meetings.draft_review(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${sql.val(input.ids)}::uuid[]) AS n`.execute(ctx.trx);
    const cleared = rows[0]?.n ?? 0;
    ctx.audit({ meetingId: input.meetingId, count: cleared });
    return zDraftReviewed.parse({ meetingId: input.meetingId, cleared });
  },
});

export const summaryRunCommands = [draftReview, summaryStart];
export const summaryRunQueries = [summaryStatus];
