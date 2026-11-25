// SPDX-License-Identifier: AGPL-3.0-only
// What a meeting left open (#4768): the recorder's Vy lists, from the transcript, the questions asked and not answered and the topics where a decision was raised and not taken (the start and the status here, the
// same guards as the commitments', the chapters' and the title's runs: a switch, the recorder, a transcript, not while it is being transcribed). Nothing about the answer is stored: the lines go back to the recorder's
// browser and the run's result row holds counts only (apps/kernel member-vy-ports.ts). Nothing here publishes anything or makes a task; the recorder may append lines to their own notes (meetings.notes.save).
// The run takes a random subject, like the brief's and the agenda check's: its result row holds counts and no text, so a meeting's delete has nothing of it to drop beyond the row's own expiry.
import { randomUUID } from 'node:crypto';
import { zSummaryRef, zSummaryStart, zSummaryStarted, zSummaryStatus } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { lockMeetingMedia, markAudioUsed } from './media-record.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const OPEN_POINTS_FEATURE = 'meetings.open_points';

// Starts the recorder's own Vy run for this meeting's open points: the recorder only, with the deployment's switch on and a transcript to read, not while this meeting is being transcribed. The kernel's
// run.start then checks vy.use, the kill switches, the global ai switch and the budget, and makes the member's Vy and this run. Nothing is read or sent here.
export const openPointsStart = defineCommand({
  name: 'meetings.open_points.start',
  input: zSummaryStart,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy what the meeting left open');
    // The meeting's media lock and a FOR SHARE hold on the meeting, as the summary's, the chapters' and the commitments' start take them (#3187).
    await lockMeetingMedia(ctx, input.meetingId);
    await ctx.trx.selectFrom('ludy_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forShare().execute();
    const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: 'meetings.transcribe', subjectId: input.meetingId });
    if (live.status !== 'ok' || live.value.live) throw new DomainError('TRANSCRIBE_RUNNING', 409, 'This meeting is still being transcribed; wait for it to finish');
    const any = await ctx.trx.selectFrom('ludy_meetings.transcript_segment').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).limit(1).executeTakeFirst();
    if (!any) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'There is no transcript to read yet');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: OPEN_POINTS_FEATURE, subjectType: OPEN_POINTS_FEATURE, subjectId: randomUUID() });
    // The answer rests on the transcript of the recording: it is in use from here on (#3187), under the media lock a replacement takes.
    await markAudioUsed(ctx, input.meetingId);
    ctx.audit({ meetingId: input.meetingId, runId: started.runId });
    return zSummaryStarted.parse({ meetingId: input.meetingId, runId: started.runId });
  },
});

// Whether this deployment lets the recorder's Vy list what the meeting left open, for the button.
export const openPointsStatus = defineQuery({
  name: 'meetings.open_points.status',
  input: zSummaryRef,
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const reason = !isSummaryEnabled() ? ('off' as const) : meeting.recorder_user_id !== userId ? ('not_recorder' as const) : null;
    return zSummaryStatus.parse({ meetingId: input.meetingId, enabled: reason === null, reason });
  },
});

export const openPointsCommands = [openPointsStart];
export const openPointsQueries = [openPointsStatus];
