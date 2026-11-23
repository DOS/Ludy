// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy writing the table of contents of a meeting, the parts that never read a private result row (#3844): the start and the status. The copy of a finished result into the draft, which
// does, is in summary.ts (the one consumer file of the Vy results). The same switch as the summary (MEETINGS_SUMMARY), the same guards, its own feature key so it never cuts off a transcription,
// a summary, a translation or live notes (#3029).
import { zSummaryRef, zSummaryStart, zSummaryStarted, zSummaryStatus } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { lockMeetingMedia, markAudioUsed } from './media-record.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const CHAPTERS_FEATURE = 'meetings.chapters';

// Starts the recorder's own Vy run for this meeting's chapters: the recorder only, with the deployment's switch on and a transcript to read, not while this meeting is being transcribed. The kernel's
// run.start then checks vy.use, the kill switches, the global ai switch and the budget, makes the member's Vy and this run, and binds the run's subject to this meeting. Nothing is read or sent here.
export const chaptersStart = defineCommand({
  name: 'meetings.chapters.start',
  input: zSummaryStart,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here; type the chapters by hand');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy for its chapters');
    // The meeting's media lock and a FOR SHARE hold on the meeting, as the summary's start takes them (#3187).
    await lockMeetingMedia(ctx, input.meetingId);
    await ctx.trx.selectFrom('ludy_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forShare().execute();
    const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: 'meetings.transcribe', subjectId: input.meetingId });
    if (live.status !== 'ok' || live.value.live) throw new DomainError('TRANSCRIBE_RUNNING', 409, 'This meeting is still being transcribed; wait for it to finish');
    const any = await ctx.trx.selectFrom('ludy_meetings.transcript_segment').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).limit(1).executeTakeFirst();
    if (!any) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'There is no transcript to write chapters from yet');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: CHAPTERS_FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    // The chapters rest on the transcript of the recording: it is in use from here on (#3187), under the media lock a replacement takes.
    await markAudioUsed(ctx, input.meetingId);
    ctx.audit({ meetingId: input.meetingId, runId: started.runId });
    return zSummaryStarted.parse({ meetingId: input.meetingId, runId: started.runId });
  },
});

// Whether this deployment lets the recorder's Vy write chapters, for the button.
export const chaptersStatus = defineQuery({
  name: 'meetings.chapters.status',
  input: zSummaryRef,
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const reason = !isSummaryEnabled() ? ('off' as const) : meeting.recorder_user_id !== userId ? ('not_recorder' as const) : null;
    return zSummaryStatus.parse({ meetingId: input.meetingId, enabled: reason === null, reason });
  },
});

export const chaptersRunCommands = [chaptersStart];
export const chaptersRunQueries = [chaptersStatus];
