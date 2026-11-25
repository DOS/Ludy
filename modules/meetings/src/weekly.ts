// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in weekly notice of the week's meetings, the module's side (#4967, Proposal 3 of the research on #932). A member who turns it on gets, each Monday at the time they chose in their own time zone, one
// in-app notice and one mail that say how many meetings they read with something published in the last seven days, how many decisions were published, how many action items are still open and how many are
// overdue, and link to the "this week" card (meetings.digest.facts, whose counts they are): no title, no name, no word of a decision. Nothing runs Vy, and nothing is read from the member's mailbox.
//
// meetings.weekly.get      the caller's own setting (off until they turn it on). Private: the row policy shows a member their own row only.
// meetings.weekly.set      the caller turns the notice on (a Monday time of day, their time zone, their language) or off (the row is deleted). Their own row only, in a user context.
// meetings.weekly.notice   the worker's dispatch, in the system's context: the ids the sweep found are not trusted, so it derives the row again through the worker-only definer
//                          ludy_meetings.weekly_notices_due (the member's opt-in, the numbers of what they read, not muted, not told yet, a member of an active org with an account that is not disabled) and writes
//                          one notice keyed by the Monday ('weekly:<day>'), then one mail. The mail is queued only when the in-app notice was written, so the one switch (the notification settings: the kind's
//                          mute) covers both (no count is written to the audit log or any log line), and a second dispatch for the same Monday writes and sends nothing. On a week with nothing the card would show the definer returns nothing: no notice, no mail.
import { sql } from 'kysely';
import { createMailMessage, notifyMembers, uploaderEntity } from '@ludy/kernel';
import {
  WEEKLY_DEFAULT_MINUTE,
  WEEKLY_KIND,
  WEEKLY_LINK_QUERY,
  WEEKLY_MAIL_SOURCE,
  WEEKLY_MAIL_TEMPLATE,
  zWeeklyCounts,
  zWeeklyEmpty,
  zWeeklyMail,
  zWeeklyNotice,
  zWeeklySet,
  zWeeklyState,
  type WeeklyState,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { ROLES, userOf } from './transcript.ts';

// The mail's subject, one line, fixed: no title and no count.
const SUBJECT = { vi: 'Tổng kết các cuộc họp tuần qua', en: 'Your meetings this past week' } as const;
const DEFAULT_ZONE = 'Asia/Ho_Chi_Minh';

export const weeklyGet = defineQuery({
  name: 'meetings.weekly.get',
  input: zWeeklyEmpty,
  access: ROLES,
  handler: async (ctx): Promise<WeeklyState> => {
    const userId = userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('ludy_meetings.weekly_notice')
      .select(['send_minute', 'time_zone', 'language'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return zWeeklyState.parse({
      enabled: row !== undefined,
      minute: row?.send_minute ?? WEEKLY_DEFAULT_MINUTE,
      timeZone: row?.time_zone ?? DEFAULT_ZONE,
      language: row?.language === 'en' ? 'en' : 'vi',
    });
  },
});

export const weeklySet = defineCommand({
  name: 'meetings.weekly.set',
  input: zWeeklySet,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input): Promise<WeeklyState> => {
    const userId = userOf(ctx.actor);
    if (!input.enabled) {
      await ctx.trx.deleteFrom('ludy_meetings.weekly_notice').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).execute();
      ctx.audit({ enabled: false });
      return zWeeklyState.parse({ enabled: false, minute: input.minute, timeZone: input.timeZone, language: input.language });
    }
    // The member's own membership row, locked FOR KEY SHARE until this command commits, as the morning notice does: a removal of the member waits for the save, so the save cannot land after the cleanup and
    // leave a setting for a departed member; and a save that meets a removal already committed finds no row and is refused.
    const member = await ctx.trx
      .selectFrom('ludy_kernel.tenant_member')
      .select('user_id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .forKeyShare()
      .executeTakeFirst();
    if (member === undefined) throw new DomainError('FORBIDDEN', 403, 'Bạn không còn là thành viên của tổ chức này');
    await ctx.trx
      .insertInto('ludy_meetings.weekly_notice')
      .values({ org_id: ctx.orgId, user_id: userId, send_minute: input.minute, time_zone: input.timeZone, language: input.language })
      .onConflict((oc) => oc.columns(['org_id', 'user_id']).doUpdateSet({ send_minute: input.minute, time_zone: input.timeZone, language: input.language, updated_at: new Date() }))
      .execute();
    // The minute and the language, never the zone's name beside the member: an audit row names the setting, not where the member is.
    ctx.audit({ enabled: true, minute: input.minute, language: input.language });
    return zWeeklyState.parse({ enabled: true, minute: input.minute, timeZone: input.timeZone, language: input.language });
  },
});

export const weeklyNotice = defineCommand({
  name: 'meetings.weekly.notice',
  input: zWeeklyNotice,
  // A mail is queued (an effect outside Ludy), so the command is R2 as the morning notice is; it runs only in the system's context.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<{ notified: boolean; mailed: boolean; notificationId?: string | null }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới báo các cuộc họp trong tuần');
    const { rows: found } = await sql<{ meetings: number; decisions: number; open_items: number; overdue: number; cut: boolean; english: boolean }>`
      SELECT meetings, decisions, open_items, overdue, cut, english
      FROM ludy_meetings.weekly_notices_due(1::int, ${ctx.orgId}::uuid, ${input.userId}::uuid, ${input.day}::date, ${input.at ?? null}::timestamptz)`.execute(ctx.trx);
    const due = found[0];
    // Nothing due any more (a week with nothing to show, turned off, muted, left, told already): nothing is written, not even an audit row.
    if (!due) return { notified: false, mailed: false };
    // The numbers are parsed against the card's own limits before anything is written, so a definer that ever returned more would roll the dispatch back instead of storing a number the mail refuses.
    const counts = zWeeklyCounts.parse({ meetings: due.meetings, decisions: due.decisions, open: due.open_items, overdue: due.overdue, cut: due.cut });
    const sent = await notifyMembers(ctx, {
      kind: WEEKLY_KIND,
      users: [input.userId],
      key: `weekly:${input.day}`,
      // Numbers and a flag: no title, no meeting, no subject (the line opens the meetings page on the "this week" card).
      detail: { meetings: String(counts.meetings), decisions: String(counts.decisions), open: String(counts.open), overdue: String(counts.overdue), cut: counts.cut ? '1' : '0' },
      legalEntityId: await uploaderEntity(ctx, input.userId),
    });
    // Turned off, left the org, or told already for this Monday: no in-app line, so no mail either.
    if (sent === 0) return { notified: false, mailed: false };
    // Read back the newly inserted notification id in the same transaction so the worker can queue browser push.
    const notice = await ctx.trx
      .selectFrom('ludy_kernel.notification')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', input.userId)
      .where('kind', '=', WEEKLY_KIND)
      .where('dedupe_key', '=', `weekly:${input.day}`)
      .executeTakeFirst();
    const org = await ctx.trx.selectFrom('ludy_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    // The member's address while they are a member with an account that is not disabled (the worker's member_emails: no name, no other account column).
    const { rows } = await sql<{ email: string | null }>`SELECT email FROM ludy_kernel.member_emails(${[input.userId]}::uuid[])`.execute(ctx.trx);
    const email = rows[0]?.email ?? null;
    // The function returns a flag, not the language's text (no text leaves a definer of ludy_meetings, meetings-readers.db.test.ts).
    const lang = due.english ? 'en' : 'vi';
    const mail = email
      ? await createMailMessage(ctx, {
          stream: 'transactional',
          source: WEEKLY_MAIL_SOURCE,
          templateKey: WEEKLY_MAIL_TEMPLATE,
          to: email,
          subject: SUBJECT[lang],
          payload: zWeeklyMail.parse({ ...counts, lang, org: (org.name.trim() || org.slug).slice(0, 200), path: `/o/${org.slug}/meetings${WEEKLY_LINK_QUERY}` }),
          status: 'queued',
        })
      : null;
    const mailed = mail?.status === 'queued';
    // A Monday and a flag, the same shape every time: no count, no address (an owner or admin reads the audit log and could probe meetings they cannot read by the numbers; the numbers are the member's own notice and mail only).
    ctx.audit({ day: input.day, mailed });
    return { notified: true, mailed, notificationId: notice?.id ?? null };
  },
});

export const weeklyCommands = [weeklySet, weeklyNotice];
export const weeklyQueries = [weeklyGet];
