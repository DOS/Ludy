// SPDX-License-Identifier: AGPL-3.0-only
// The title of a meeting (#3947): the recorder's Vy suggests up to three candidates from the transcript (the start and the status here, the same guards as the chapters' run: a switch, the recorder, a
// transcript, not while it is being transcribed) and the recorder's own click sets one (the rename). Nothing about a suggestion is stored: the candidates go back to the recorder's browser and the run's result
// row holds counts only (apps/kernel member-vy-ports.ts). The rename is an ordinary command of the recorder, whatever the title came from: a pick or a title typed by hand.
import { MEETING_TITLE_MAX, cleanTemplateText, zMeetingRename, zMeetingRenamed, zSummaryRef, zSummaryStart, zSummaryStarted, zSummaryStatus } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { sql } from 'kysely';
import { lockMeetingMedia, markAudioUsed } from './media-record.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const TITLE_FEATURE = 'meetings.title';

// Starts the recorder's own Vy run for this meeting's title suggestions: the recorder only, with the deployment's switch on and a transcript to read, not while this meeting is being transcribed. The
// kernel's run.start then checks vy.use, the kill switches, the global ai switch and the budget, makes the member's Vy and this run, and binds the run's subject to this meeting. Nothing is read or sent here.
export const titleStart = defineCommand({
  name: 'meetings.title.start',
  input: zSummaryStart,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here; type the title by hand');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy for a title');
    // The meeting's media lock and a FOR SHARE hold on the meeting, as the summary's and the chapters' start take them (#3187).
    await lockMeetingMedia(ctx, input.meetingId);
    await ctx.trx.selectFrom('ludy_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forShare().execute();
    const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: 'meetings.transcribe', subjectId: input.meetingId });
    if (live.status !== 'ok' || live.value.live) throw new DomainError('TRANSCRIBE_RUNNING', 409, 'This meeting is still being transcribed; wait for it to finish');
    const any = await ctx.trx.selectFrom('ludy_meetings.transcript_segment').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).limit(1).executeTakeFirst();
    if (!any) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'There is no transcript to suggest a title from yet');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: TITLE_FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    // The suggestions rest on the transcript of the recording: it is in use from here on (#3187), under the media lock a replacement takes.
    await markAudioUsed(ctx, input.meetingId);
    ctx.audit({ meetingId: input.meetingId, runId: started.runId });
    return zSummaryStarted.parse({ meetingId: input.meetingId, runId: started.runId });
  },
});

// Whether this deployment lets the recorder's Vy suggest a title, for the button.
export const titleStatus = defineQuery({
  name: 'meetings.title.status',
  input: zSummaryRef,
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const reason = !isSummaryEnabled() ? ('off' as const) : meeting.recorder_user_id !== userId ? ('not_recorder' as const) : null;
    return zSummaryStatus.parse({ meetingId: input.meetingId, enabled: reason === null, reason });
  },
});

// The recorder gives the meeting a new title: a pick from Vy's suggestions or one typed by hand. The recorder only. The title is the recorder's own text, so it is cleaned (control, bidi, zero-width and
// separator characters out, spaces folded, one line) and kept to 1 to 200 characters, the bounds of a title at creation, but not held to the checks of a suggestion (a figure the transcript does not say is
// the recorder's to write). The audit row holds the meeting's id only: never the old or the new title.
export const meetingRename = defineCommand({
  name: 'meetings.meeting.rename',
  input: zMeetingRename,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can rename it');
    const title = cleanTemplateText(input.title);
    if (title === '') throw new DomainError('MEETING_TITLE_EMPTY', 422, 'A meeting needs a title');
    if (title.length > MEETING_TITLE_MAX) throw new DomainError('MEETING_TITLE_TOO_LONG', 422, 'A meeting title holds at most 200 characters');
    await ctx.trx
      .updateTable('ludy_meetings.meeting')
      .set({ title, updated_at: sql<Date>`pg_catalog.now()` })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .execute();
    ctx.audit({ meetingId: input.meetingId });
    return zMeetingRenamed.parse({ meetingId: input.meetingId, title });
  },
});

export const titleCommands = [titleStart, meetingRename];
export const titleQueries = [titleStatus];
