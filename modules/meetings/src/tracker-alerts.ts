// SPDX-License-Identifier: AGPL-3.0-only
// Alerts when a tracked keyword comes up in the transcript of a new meeting (#4873, builds on the keyword trackers of #4818). The contract is packages/kernel-contract/src/meeting-tracker-alerts.ts.
//
// meetings.tracker.alert_set     a member turns their own alert on or off (off by default: no row, no alert); never another member's
// meetings.tracker.alert_get     whether the caller's alert is on
// meetings.tracker.alert         the recorder's publish, emitted by meetings.result.publish (emitTrackerAlert below) in the same transaction: the meeting's id only, no text
// meetings.tracker.alert_notice  the worker's dispatch of that event, in the system's context (the API's role cannot write a notification for a person). No text of the transcript ever reaches the worker (ADR-0047,
//                                the invariant that no meetings definer returns meeting text): the worker-only definer ludy_meetings.tracker_alert_hits COUNTS the org's tracked words over the published lines inside
//                                the database (the Trackers card's counting, written in SQL and held to the same counts by a test) and returns only term ids and numbers; ludy_meetings.tracker_alert_recipients
//                                returns, a page at a time, the opted-in members who read the meeting NOW (the reader rule is decided per recipient in the database, an owner or an admin has no extra right) and
//                                the language each chose for their mail. One notice per member and meeting is written (key `tracker:<meeting>`, so a second publish or a replay tells nobody twice). The notice holds
//                                the ids of the words and their counts and nothing else: no word, no title, no text; the app writes the words from the live term list. A mail with a fixed line and the link is queued,
//                                in the member's own language, only when the in-app notice was written, so the one switch of the notification settings (kind meetings.tracker_alert) covers the in-app line, the
//                                mail and the push. No model call.
import { sql } from 'kysely';
import { createMailMessage, notifyMembers, outboxEvent, uploaderEntity } from '@ludy/kernel';
import {
  TRACKER_ALERT_EVENT,
  TRACKER_ALERT_KIND,
  TRACKER_ALERT_MAIL_SOURCE,
  TRACKER_ALERT_MAIL_TEMPLATE,
  TRACKER_ALERT_TERMS_MAX,
  encodeTrackerAlertTerms,
  zTrackerAlertDispatch,
  zTrackerAlertEvent,
  zTrackerAlertGet,
  zTrackerAlertMail,
  zTrackerAlertSet,
  type TrackerAlertState,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@ludy/kernel-runtime';
import { ROLES, userOf } from './transcript.ts';

// Members read a page at a time: the definer returns at most this many a call, and the dispatch asks again after the last one until a page comes back short.
export const TRACKER_ALERT_PAGE = 500;

const SUBJECT = { vi: 'Từ khóa bạn theo dõi có trong bản ghi một cuộc họp mới', en: 'A word you track is in the transcript of a new meeting' } as const;

export const trackerAlertSet = defineCommand({
  name: 'meetings.tracker.alert_set',
  input: zTrackerAlertSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input): Promise<TrackerAlertState> => {
    const userId = userOf(ctx.actor);
    // A row is added or removed, never edited (no UPDATE for a login role): turning it on again replaces the row, so the language of the mail is the one chosen last.
    await ctx.trx.deleteFrom('ludy_meetings.tracker_alert').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).execute();
    if (input.on) await ctx.trx.insertInto('ludy_meetings.tracker_alert').values({ org_id: ctx.orgId, user_id: userId, language: input.language }).execute();
    // A flag only: no id of a person beyond the actor the audit row already names.
    ctx.audit({ on: input.on });
    return { on: input.on };
  },
});

export const trackerAlertGet = defineQuery({
  name: 'meetings.tracker.alert_get',
  input: zTrackerAlertGet,
  access: ROLES,
  handler: async (ctx): Promise<TrackerAlertState> => {
    const userId = userOf(ctx.actor);
    const row = await ctx.trx.selectFrom('ludy_meetings.tracker_alert').select('id').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).executeTakeFirst();
    return { on: row !== undefined };
  },
});

// Called by meetings.result.publish when a call published a summary: stores the event with the meeting's id in the same transaction. Nobody is chosen here (the caller cannot read who opted in).
export async function emitTrackerAlert(ctx: CommandContext, meetingId: string): Promise<void> {
  const row = await ctx.trx.selectFrom('ludy_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', meetingId).executeTakeFirst();
  if (!row) return;
  await ctx.emit(TRACKER_ALERT_EVENT, zTrackerAlertEvent.parse({ meetingId }));
}

// What the counting definer returned (a term id and a number each), the busiest words first (ties by id), at most TRACKER_ALERT_TERMS_MAX.
export function topTrackerHits(rows: ReadonlyArray<{ term_id: string; hits: number }>): Array<{ termId: string; count: number }> {
  return rows
    .filter((r) => r.hits > 0)
    .map((r) => ({ termId: r.term_id, count: r.hits }))
    .sort((a, b) => b.count - a.count || (a.termId < b.termId ? -1 : 1))
    .slice(0, TRACKER_ALERT_TERMS_MAX);
}

export const trackerAlertNotice = defineCommand({
  name: 'meetings.tracker.alert_notice',
  input: zTrackerAlertDispatch,
  // A mail is queued (an effect outside Ludy), so the command is R2 as the minutes-ready notice is; it runs only in the system's context.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<{ notified: number; mailed: number }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới báo từ khóa theo dõi');
    // The event is read again here, never taken from the job.
    const event = await outboxEvent(ctx, input.eventId);
    if (!event || event.type !== TRACKER_ALERT_EVENT) return { notified: 0, mailed: 0 };
    const published = zTrackerAlertEvent.parse(event.payload);
    // The words are counted inside the database over the published lines; only term ids and numbers come back (nothing of the transcript reaches the worker). Nothing to count, nobody to ask.
    const counted = await sql<{ term_id: string; hits: number }>`SELECT term_id, hits FROM ludy_meetings.tracker_alert_hits(${ctx.orgId}::uuid, ${published.meetingId}::uuid, pg_catalog.now())`.execute(ctx.trx);
    const hits = topTrackerHits(counted.rows);
    if (hits.length === 0) {
      ctx.audit({ eventId: input.eventId, meetingId: published.meetingId, words: 0 });
      return { notified: 0, mailed: 0 };
    }
    const org = await ctx.trx.selectFrom('ludy_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const detail = encodeTrackerAlertTerms(hits);
    let recipients = 0;
    let notified = 0;
    let mailed = 0;
    let after: string | null = null;
    // Every recipient, a page at a time (the definer returns at most TRACKER_ALERT_PAGE a call, in id order): none is dropped for being past a cut.
    for (;;) {
      const page: { rows: Array<{ user_id: string; english: boolean }> } = await sql<{ user_id: string; english: boolean }>`SELECT user_id, english FROM ludy_meetings.tracker_alert_recipients(${ctx.orgId}::uuid, ${published.meetingId}::uuid, pg_catalog.now(), ${after}::uuid, ${TRACKER_ALERT_PAGE}::integer)`.execute(ctx.trx);
      if (page.rows.length === 0) break;
      recipients += page.rows.length;
      const told: string[] = [];
      for (const { user_id: userId } of page.rows) {
        const sent = await notifyMembers(ctx, {
          kind: TRACKER_ALERT_KIND,
          users: [userId],
          key: `tracker:${published.meetingId}`,
          subject: { type: 'meetings.meeting', id: published.meetingId },
          detail,
          eventId: input.eventId,
          legalEntityId: await uploaderEntity(ctx, userId),
        });
        if (sent > 0) {
          notified += sent;
          told.push(userId);
        }
      }
      // The address of each member told, while they are a member with an account that is not disabled (the worker's member_emails: no name, no other account column); in the language each chose.
      if (told.length > 0) {
        const english = new Set(page.rows.filter((r) => r.english).map((r) => r.user_id));
        const emails = await sql<{ user_id: string; email: string | null }>`SELECT user_id, email FROM ludy_kernel.member_emails(${told}::uuid[])`.execute(ctx.trx);
        for (const row of emails.rows) {
          if (!row.email) continue;
          const lang = english.has(row.user_id) ? 'en' : 'vi';
          const mail = await createMailMessage(ctx, {
            stream: 'transactional',
            source: TRACKER_ALERT_MAIL_SOURCE,
            sourceId: published.meetingId,
            templateKey: TRACKER_ALERT_MAIL_TEMPLATE,
            to: row.email,
            subject: SUBJECT[lang],
            payload: zTrackerAlertMail.parse({ lang, org: (org.name.trim() || org.slug).slice(0, 200), words: hits.length, path: `/o/${org.slug}/meetings/${published.meetingId}` }),
            status: 'queued',
          });
          if (mail.status === 'queued') mailed += 1;
        }
      }
      after = page.rows[page.rows.length - 1]?.user_id ?? null;
      if (page.rows.length < TRACKER_ALERT_PAGE) break;
    }
    // Ids and counts only: no word, no address.
    ctx.audit({ eventId: input.eventId, meetingId: published.meetingId, recipients, words: hits.length, notified, mailed });
    return { notified, mailed };
  },
});

export const trackerAlertCommands = [trackerAlertSet, trackerAlertNotice];
export const trackerAlertQueries = [trackerAlertGet];
