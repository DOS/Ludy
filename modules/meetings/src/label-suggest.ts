// SPDX-License-Identifier: AGPL-3.0-only
// Vy's label suggestions for a meeting (#5010, plan docs/plan/meetings.md L28): the recorder's own Vy offers up to three short labels (the start and the status here; the one model call is in apps/kernel member-vy-ports.ts) and the
// recorder's own click on one runs the existing meetings.label.add. The guards are the title's, minus the transcript: a deployment switch, the recorder, and a meeting that still has room for a label. Nothing is read or sent here, no
// transcript is read anywhere on this path, and nothing about a suggestion is stored: the run's result row holds counts only, and the audit row holds the ids of the meeting and the run.
import { MEETING_LABELS_MAX, zSummaryRef, zSummaryStart, zSummaryStarted, zSummaryStatus } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

const LABEL_SUGGEST_FEATURE = 'meetings.label_suggest';

// Starts the recorder's own Vy run for this meeting's label suggestions: the recorder only, with the deployment's switch on and fewer than five labels on the meeting. The kernel's run.start then checks vy.use, the kill switches,
// the global ai switch and the budget, makes the member's Vy and this run, and binds the run's subject to this meeting. Nothing is read from the meeting's text and nothing is sent here.
export const labelSuggestStart = defineCommand({
  name: 'meetings.label.suggest_start',
  input: zSummaryStart,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here; type the label by hand');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy for labels');
    // A count of the labels the recorder reads (the table's row policy), at most five rows.
    const have = await ctx.trx
      .selectFrom('ludy_meetings.meeting_label')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .limit(MEETING_LABELS_MAX)
      .execute();
    if (have.length >= MEETING_LABELS_MAX) throw new DomainError('LABELS_FULL', 422, `A meeting can have at most ${MEETING_LABELS_MAX} labels`);
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: LABEL_SUGGEST_FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    ctx.audit({ meetingId: input.meetingId, runId: started.runId });
    return zSummaryStarted.parse({ meetingId: input.meetingId, runId: started.runId });
  },
});

// Whether this deployment lets the recorder's Vy suggest labels, for the button.
export const labelSuggestStatus = defineQuery({
  name: 'meetings.label.suggest_status',
  input: zSummaryRef,
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const reason = !isSummaryEnabled() ? ('off' as const) : meeting.recorder_user_id !== userId ? ('not_recorder' as const) : null;
    return zSummaryStatus.parse({ meetingId: input.meetingId, enabled: reason === null, reason });
  },
});

export const labelSuggestCommands = [labelSuggestStart];
export const labelSuggestQueries = [labelSuggestStatus];
