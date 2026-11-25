// SPDX-License-Identifier: AGPL-3.0-only
// Alerts when a tracked keyword comes up in the minutes of a new meeting (#4873, builds on the keyword trackers of #4818). The contract is packages/kernel-contract/src/meeting-tracker-alerts.ts.
//
// meetings.tracker.alert_set     a member turns their own alert on or off (off by default: no row, no alert); never another member's
// meetings.tracker.alert_get     whether the caller's alert is on
// meetings.tracker.alert         the recorder's publish, emitted by meetings.result.publish (emitTrackerAlert below) in the same transaction: the meeting's id and language only, no text
// meetings.tracker.alert_notice  the worker's dispatch of that event, in the system's context (the API's role cannot write a notification for a person): it asks the worker-only definer
//                                ludy_meetings.tracker_alert_input for the opted-in members who read the meeting NOW (the reader rule is decided per recipient in the database, an owner or an admin has no extra
//                                right), the org's tracked words and the published minutes text, counts the words in code (the same counting as the Trackers card), and writes one notice per member and meeting
//                                (key `tracker:<meeting>`, so a second publish or a replay tells nobody twice). The notice holds the ids of the words and their counts and nothing else: no word, no title, no
//                                text; the app writes the words from the live term list. A mail with a fixed line and the link is queued only when the in-app notice was written, so the one switch of the
//                                notification settings (kind meetings.tracker_alert) covers the in-app line, the mail and the push. No model call.
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
import { countNeedle, lineWords, needleOf } from './tracker-count.ts';
import { ROLES, userOf } from './transcript.ts';

const SUBJECT = { vi: 'Từ khóa bạn theo dõi có trong biên bản một cuộc họp mới', en: 'A word you track is in the minutes of a new meeting' } as const;

export const trackerAlertSet = defineCommand({
  name: 'meetings.tracker.alert_set',
  input: zTrackerAlertSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input): Promise<TrackerAlertState> => {
    const userId = userOf(ctx.actor);
    if (input.on) {
      await ctx.trx.insertInto('ludy_meetings.tracker_alert').values({ org_id: ctx.orgId, user_id: userId }).onConflict((oc) => oc.columns(['org_id', 'user_id']).doNothing()).execute();
    } else {
      await ctx.trx.deleteFrom('ludy_meetings.tracker_alert').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).execute();
    }
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

// Called by meetings.result.publish when a call published a summary: stores the event with the meeting's id and language in the same transaction. Nobody is chosen here (the caller cannot read who opted in).
export async function emitTrackerAlert(ctx: CommandContext, meetingId: string): Promise<void> {
  const row = await ctx.trx.selectFrom('ludy_meetings.meeting').select('language').where('org_id', '=', ctx.orgId).where('id', '=', meetingId).executeTakeFirst();
  if (!row) return;
  await ctx.emit(TRACKER_ALERT_EVENT, zTrackerAlertEvent.parse({ meetingId, language: row.language }));
}

interface AlertInput {
  recipients: string[];
  terms: Array<{ id: string; term: string }>;
  texts: string[];
}

// The words of the org's list that the texts hold, with how many times each, the busiest first (ties by id), at most TRACKER_ALERT_TERMS_MAX.
export function countTrackerHits(terms: ReadonlyArray<{ id: string; term: string }>, texts: readonly string[]): Array<{ termId: string; count: number }> {
  const lines = texts.map(lineWords);
  const hits: Array<{ termId: string; count: number }> = [];
  for (const t of terms) {
    const needle = needleOf(t.term);
    if (!needle) continue;
    let count = 0;
    for (const line of lines) count += countNeedle(line, needle);
    if (count > 0) hits.push({ termId: t.id, count });
  }
  return hits.sort((a, b) => b.count - a.count || (a.termId < b.termId ? -1 : 1)).slice(0, TRACKER_ALERT_TERMS_MAX);
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
    const { rows } = await sql<{ input: AlertInput | null }>`SELECT ludy_meetings.tracker_alert_input(${ctx.orgId}::uuid, ${published.meetingId}::uuid, pg_catalog.now()) AS input`.execute(ctx.trx);
    const found = rows[0]?.input ?? null;
    if (!found || found.recipients.length === 0 || found.terms.length === 0) return { notified: 0, mailed: 0 };
    const hits = countTrackerHits(found.terms, found.texts);
    if (hits.length === 0) {
      ctx.audit({ eventId: input.eventId, meetingId: published.meetingId, recipients: found.recipients.length, words: 0 });
      return { notified: 0, mailed: 0 };
    }
    const org = await ctx.trx.selectFrom('ludy_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const detail = encodeTrackerAlertTerms(hits);
    let notified = 0;
    const told: string[] = [];
    for (const userId of found.recipients) {
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
    // The address of each member told, while they are a member with an account that is not disabled (the worker's member_emails: no name, no other account column).
    let mailed = 0;
    if (told.length > 0) {
      const emails = await sql<{ user_id: string; email: string | null }>`SELECT user_id, email FROM ludy_kernel.member_emails(${told}::uuid[])`.execute(ctx.trx);
      for (const row of emails.rows) {
        if (!row.email) continue;
        const mail = await createMailMessage(ctx, {
          stream: 'transactional',
          source: TRACKER_ALERT_MAIL_SOURCE,
          sourceId: published.meetingId,
          templateKey: TRACKER_ALERT_MAIL_TEMPLATE,
          to: row.email,
          subject: SUBJECT[published.language],
          payload: zTrackerAlertMail.parse({ lang: published.language, org: (org.name.trim() || org.slug).slice(0, 200), words: hits.length, path: `/o/${org.slug}/meetings/${published.meetingId}` }),
          status: 'queued',
        });
        if (mail.status === 'queued') mailed += 1;
      }
    }
    // Ids and counts only: no word, no address.
    ctx.audit({ eventId: input.eventId, meetingId: published.meetingId, recipients: found.recipients.length, words: hits.length, notified, mailed });
    return { notified, mailed };
  },
});

export const trackerAlertCommands = [trackerAlertSet, trackerAlertNotice];
export const trackerAlertQueries = [trackerAlertGet];
