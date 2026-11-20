// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in morning notice of the day's meetings, the module's side (#3955, part B). A member who turns it on gets, once a day at the time they chose in their own time zone, one in-app notice and one mail
// that say how many meetings they have today and link to the meetings page: no title, no name, no word of a brief. Nothing runs Vy, and nothing is read from the member's mailbox.
//
// meetings.morning.get      the caller's own setting (off until they turn it on). Private: the row policy shows a member their own row only.
// meetings.morning.set      the caller turns the notice on (a time of day, their time zone, their language) or off (the row is deleted). Their own row only, in a user context.
// meetings.morning.notice   the worker's dispatch, in the system's context: the ids the sweep found are not trusted, so it derives the row again through the worker-only definer
//                           crove_meetings.morning_notices_due (the member's opt-in, the count of their events that day on a calendar that reads events, not muted, not told yet) and writes one notice
//                           keyed by the day ('morning:<day>'), then one mail. The mail is queued only when the in-app notice was written, so the one switch (the notification settings: the kind's mute)
//                           covers both, and a second dispatch for the same day writes and sends nothing. On a day with no meeting the definer returns nothing: no notice and no mail.
import { sql } from 'kysely';
import { createMailMessage, notifyMembers, uploaderEntity } from '@crove/kernel';
import { MORNING_COUNT_MAX, MORNING_DEFAULT_MINUTE, MORNING_KIND, MORNING_MAIL_SOURCE, MORNING_MAIL_TEMPLATE, zMorningEmpty, zMorningMail, zMorningNotice, zMorningSet, zMorningState, type MorningState } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { ROLES, userOf } from './transcript.ts';

// The mail's subject, one line, fixed: no title and no count.
const SUBJECT = { vi: 'Hôm nay bạn có cuộc họp', en: 'You have meetings today' } as const;
const DEFAULT_ZONE = 'Asia/Ho_Chi_Minh';

export const morningGet = defineQuery({
  name: 'meetings.morning.get',
  input: zMorningEmpty,
  access: ROLES,
  handler: async (ctx): Promise<MorningState> => {
    const userId = userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('crove_meetings.morning_notice')
      .select(['send_minute', 'time_zone', 'language'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return zMorningState.parse({
      enabled: row !== undefined,
      minute: row?.send_minute ?? MORNING_DEFAULT_MINUTE,
      timeZone: row?.time_zone ?? DEFAULT_ZONE,
      language: row?.language === 'en' ? 'en' : 'vi',
    });
  },
});

export const morningSet = defineCommand({
  name: 'meetings.morning.set',
  input: zMorningSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input): Promise<MorningState> => {
    const userId = userOf(ctx.actor);
    if (!input.enabled) {
      await ctx.trx.deleteFrom('crove_meetings.morning_notice').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).execute();
      ctx.audit({ enabled: false });
      return zMorningState.parse({ enabled: false, minute: input.minute, timeZone: input.timeZone, language: input.language });
    }
    // The member's own membership row, locked FOR KEY SHARE until this command commits: a removal of the member (a DELETE of that row, whose trigger deletes the setting) waits for the save, so the save cannot land
    // after the trigger and leave a setting for a departed member; and a save that meets a removal already committed finds no row and is refused. (A role change or a removal waits for the save to commit, for a moment; another save does not wait.)
    const member = await ctx.trx
      .selectFrom('crove_kernel.tenant_member')
      .select('user_id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .forKeyShare()
      .executeTakeFirst();
    if (member === undefined) throw new DomainError('FORBIDDEN', 403, 'Bạn không còn là thành viên của tổ chức này');
    await ctx.trx
      .insertInto('crove_meetings.morning_notice')
      .values({ org_id: ctx.orgId, user_id: userId, send_minute: input.minute, time_zone: input.timeZone, language: input.language })
      .onConflict((oc) => oc.columns(['org_id', 'user_id']).doUpdateSet({ send_minute: input.minute, time_zone: input.timeZone, language: input.language, updated_at: new Date() }))
      .execute();
    // The minute and the language, never the zone's name beside the member: an audit row names the setting, not where the member is.
    ctx.audit({ enabled: true, minute: input.minute, language: input.language });
    return zMorningState.parse({ enabled: true, minute: input.minute, timeZone: input.timeZone, language: input.language });
  },
});

export const morningNotice = defineCommand({
  name: 'meetings.morning.notice',
  input: zMorningNotice,
  // A mail is queued (an effect outside Ludy), so the command is R2 as the weekly status mail is; it runs only in the system's context.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<{ notified: boolean; mailed: boolean }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới báo cuộc họp trong ngày');
    const { rows: found } = await sql<{ events: number; english: boolean }>`
      SELECT events, english FROM crove_meetings.morning_notices_due(1::int, ${ctx.orgId}::uuid, ${input.userId}::uuid, ${input.day}::date)`.execute(ctx.trx);
    const due = found[0];
    // Nothing due any more (no meeting that day, turned off, muted, told already): nothing is written, not even an audit row.
    if (!due) return { notified: false, mailed: false };
    // The count the notice and the mail carry never passes the mail's own bound, so a day with more events than that is still told (and the mail still parses) instead of rolling back and being retried.
    const events = Math.min(due.events, MORNING_COUNT_MAX);
    const sent = await notifyMembers(ctx, {
      kind: MORNING_KIND,
      users: [input.userId],
      key: `morning:${input.day}`,
      // Nothing but the count: no title, no event, no subject (the line opens the meetings page).
      detail: { count: String(events) },
      legalEntityId: await uploaderEntity(ctx, input.userId),
    });
    // Turned off, left the org, or told already for this day: no in-app line, so no mail either.
    if (sent === 0) return { notified: false, mailed: false };
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    // The member's address while they are a member with an account that is not disabled (the worker's member_emails: no name, no other account column).
    const { rows } = await sql<{ email: string | null }>`SELECT email FROM crove_kernel.member_emails(${[input.userId]}::uuid[])`.execute(ctx.trx);
    const email = rows[0]?.email ?? null;
    // The function returns a flag, not the language's text (no text leaves a definer of crove_meetings, meetings-readers.db.test.ts).
    const lang = due.english ? 'en' : 'vi';
    const mail = email
      ? await createMailMessage(ctx, {
          stream: 'transactional',
          source: MORNING_MAIL_SOURCE,
          templateKey: MORNING_MAIL_TEMPLATE,
          to: email,
          subject: SUBJECT[lang],
          payload: zMorningMail.parse({ lang, org: (org.name.trim() || org.slug).slice(0, 200), count: events, path: `/o/${org.slug}/meetings` }),
          status: 'queued',
        })
      : null;
    const mailed = mail?.status === 'queued';
    // A day and a count and a flag: no address in the audit row.
    ctx.audit({ day: input.day, count: events, mailed });
    return { notified: true, mailed };
  },
});

export const morningCommands = [morningSet, morningNotice];
export const morningQueries = [morningGet];
