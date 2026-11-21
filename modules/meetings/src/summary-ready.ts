// SPDX-License-Identifier: AGPL-3.0-only
// The "minutes draft ready" notice (#3730): when Vy's summary run of a meeting is stored as ready, the RECORDER (nobody else) gets one in-app notice and one email that the draft
// is waiting for their review. The notice holds no word of the draft and no title: the in-app line is a fixed text that opens the meeting through its subject, the mail
// holds a fixed line and the link, and the detail is empty. Not a decision, not an item, not a sentence of the summary is ever read here, and no copy of a title is made that a
// retention purge or an erasure would have to chase (as the follow-up mail's, #3016).
//
// meetings.summary.ready          the recorder's own command, run by the API right after the run's result was stored as ready (apps/kernel/src/member-vy-ports.ts, never an RPC route of
//                                 its own): checks the caller is the recorder of a meeting they read and writes one outbox event with ids and the language only. A failed run never calls it.
// meetings.summary.ready_notice   the worker's dispatch of that event, in the system's context (the API's role cannot write a notification for a person): reads the event itself, never
//                                 the job's copy, and writes one notice to the recorder, keyed by the run (one per finished run). A person who turned the kind off gets neither the in-app
//                                 line nor the mail: the mail is queued only when the in-app notice was written, so the one switch (the notification settings) covers both, and a second
//                                 dispatch for the same run writes and sends nothing.
//
// meetings.summary.ready trusts the runId it is given: it is reached only from the API's own port (member-vy-ports.ts), never from an RPC route. If it is ever exposed, it must first check that the runId is a
// finished summary run of this meeting by this recorder.
//
// Push is not part of this slice: the browser push of the app belongs to Social (its own subscription table and sender), so a Meetings notice has no push path yet (follow-up).
import { sql } from 'kysely';
import { createMailMessage, notifyMembers, outboxEvent, uploaderEntity } from '@ludy/kernel';
import { SUMMARY_READY_EVENT, SUMMARY_READY_KIND, SUMMARY_READY_MAIL_SOURCE, SUMMARY_READY_MAIL_TEMPLATE, zSummaryReadyDispatch, zSummaryReadyEvent, zSummaryReadyMail, zSummaryReadyRef } from '@ludy/kernel-contract';
import { DomainError, defineCommand } from '@ludy/kernel-runtime';
import { ROLES, openMeeting, userOf } from './transcript.ts';

// The mail's subject, one line, fixed: no title.
const SUBJECT = { vi: 'Bản nháp biên bản đã sẵn sàng để bạn xem', en: 'Your minutes draft is ready for review' } as const;

export const summaryReady = defineCommand({
  name: 'meetings.summary.ready',
  input: zSummaryReadyRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<{ queued: true }> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    // Only the recorder asks for a run, and only the recorder is told.
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder is told that the draft is ready');
    const row = await ctx.trx.selectFrom('crove_meetings.meeting').select('language').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirstOrThrow();
    await ctx.emit('meetings.summary.ready', zSummaryReadyEvent.parse({ meetingId: input.meetingId, runId: input.runId, recorderUserId: userId, language: row.language }));
    ctx.audit({ meetingId: input.meetingId, runId: input.runId });
    return { queued: true };
  },
});

export const summaryReadyNotice = defineCommand({
  name: 'meetings.summary.ready_notice',
  input: zSummaryReadyDispatch,
  // A mail is queued (an effect outside Ludy), so the command is R2 as the weekly status mail is; it runs only in the system's context.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<{ notified: boolean; mailed: boolean }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới báo bản nháp biên bản đã sẵn sàng');
    // The meeting is not read again: meeting rows answer a person only, not the system's context. A meeting deleted since the event leaves a link that opens to not found, once.
    const event = await outboxEvent(ctx, input.eventId);
    if (!event || event.type !== SUMMARY_READY_EVENT) return { notified: false, mailed: false };
    const ready = zSummaryReadyEvent.parse(event.payload);
    const sent = await notifyMembers(ctx, {
      kind: SUMMARY_READY_KIND,
      users: [ready.recorderUserId],
      key: `summary:${ready.runId}`,
      subject: { type: 'meetings.meeting', id: ready.meetingId },
      // Nothing besides the subject: no title and no draft.
      detail: {},
      eventId: input.eventId,
      legalEntityId: await uploaderEntity(ctx, ready.recorderUserId),
    });
    // Turned off, left the org, or told already for this run: no in-app line, so no mail either.
    if (sent === 0) return { notified: false, mailed: false };
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    // The recorder's address while they are a member with an account that is not disabled (the worker's member_emails: no name, no other account column).
    const { rows } = await sql<{ email: string | null }>`SELECT email FROM crove_kernel.member_emails(${[ready.recorderUserId]}::uuid[])`.execute(ctx.trx);
    const email = rows[0]?.email ?? null;
    const mail = email
      ? await createMailMessage(ctx, {
          stream: 'transactional',
          source: SUMMARY_READY_MAIL_SOURCE,
          sourceId: ready.meetingId,
          templateKey: SUMMARY_READY_MAIL_TEMPLATE,
          to: email,
          subject: SUBJECT[ready.language],
          payload: zSummaryReadyMail.parse({ lang: ready.language, org: (org.name.trim() || org.slug).slice(0, 200), path: `/o/${org.slug}/meetings/${ready.meetingId}` }),
          status: 'queued',
        })
      : null;
    const mailed = mail?.status === 'queued';
    // Ids and a flag only: no address in the audit row.
    ctx.audit({ meetingId: ready.meetingId, runId: ready.runId, mailed });
    return { notified: true, mailed };
  },
});

export const summaryReadyCommands = [summaryReady, summaryReadyNotice];
