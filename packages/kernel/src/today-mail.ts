// SPDX-License-Identifier: AGPL-3.0-only
// The daily "Hôm nay cần bạn" brief by email (issue #2406, follow-up of #2383), opt-in per member. A member turns it on and off in
// their own notification settings (kernel.today_mail.set: an opted-in member has a row in crove_kernel.today_mail, turning it off
// deletes it, nobody touches another member's). The worker's sweep (crove_kernel.today_mail_due, then kernel.today_mail.send per org)
// queues one mail per opted-in member whose day has not been sent yet.
//
// What the mail says is counts and a link to Home, never an amount, a name or a message: the proposals the member may approve, the
// member's unread work notifications and the conversations waiting for a reply that the member may read. They are the kernel's own
// tables, counted per member by the same rules the member's own screens use (a worker has no member's context, so the rules are
// restated here in SQL and the database's row-level security does not apply to the system context). The other lines of Home (the
// finance, social and ads reads) need a member's context and stay out of the mail. No model is called, so the AI budget meter is not
// involved, and a member who is owed nothing is sent nothing.
//
// One mail per member per Vietnam calendar day: the command claims the day with one UPDATE of last_sent_day, which only the
// system context may write, before it queues anything. A mail that cannot be written is skipped to a savepoint and its member is
// tried again the next day; the queue's suppressions and bounces apply like for any mail.
import { sql } from 'kysely';
import { z } from 'zod';
import { zTodayMailSetting, type TodayMailSetting } from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { createMailMessage } from './mail.ts';
import { APPROVAL_WAITING, NOTIFICATION_UNREAD_CAP } from './notifications.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const TODAY_MAIL_TEMPLATE = 'kernel.today_mail';
export const TODAY_MAIL_SOURCE = 'kernel.today_mail.day';
export const TODAY_MAIL_ZONE = 'Asia/Ho_Chi_Minh';
// The sweep: how often it looks, how many orgs it reads a page, and the most pages it walks (a bound, not a limit anyone meets).
export const TODAY_MAIL_SWEEP_MS = 10 * 60_000;
export const TODAY_MAIL_PAGE = 200;
export const TODAY_MAIL_MAX_PAGES = 500;
// The mail goes out from 07:30 in Vietnam; the due-orgs function holds the same hour.
const SEND_FROM_MINUTE = 7 * 60 + 30;

export type TodayMailState = 'not_due' | 'sent';
export interface TodayMailCounts {
  proposals: number;
  notifications: number;
  messages: number;
}

function requireUser(ctx: Pick<CommandContext, 'actor'>): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

export const todayMailGet = defineQuery({
  name: 'kernel.today_mail.get',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<TodayMailSetting> => {
    if (ctx.actor.type !== 'user') return { enabled: false };
    const row = await ctx.trx.selectFrom('crove_kernel.today_mail').select('id').where('org_id', '=', ctx.orgId).where('user_id', '=', ctx.actor.userId).executeTakeFirst();
    return { enabled: row !== undefined };
  },
});

export const todayMailSet = defineCommand({
  name: 'kernel.today_mail.set',
  input: zTodayMailSetting,
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input): Promise<TodayMailSetting> => {
    const me = requireUser(ctx);
    if (input.enabled) {
      // Already on keeps its row, and with it the day of its last mail.
      await ctx.trx
        .insertInto('crove_kernel.today_mail')
        .values({ org_id: ctx.orgId, user_id: me, created_at: ctx.now })
        .onConflict((oc) => oc.columns(['org_id', 'user_id']).doNothing())
        .execute();
    } else {
      await ctx.trx.deleteFrom('crove_kernel.today_mail').where('org_id', '=', ctx.orgId).where('user_id', '=', me).execute();
    }
    ctx.audit({ enabled: input.enabled });
    return { enabled: input.enabled };
  },
});

// The Vietnam calendar day and minute of the day of an instant.
async function vietnamNow(ctx: CommandContext): Promise<{ day: string; minute: number }> {
  const { rows } = await sql<{ day: string; minute: number }>`
    SELECT to_char(l, 'YYYY-MM-DD') AS day, (extract(hour FROM l) * 60 + extract(minute FROM l))::int AS minute
    FROM (SELECT timezone(${TODAY_MAIL_ZONE}::text, ${ctx.now}::timestamptz) AS l) t`.execute(ctx.trx);
  const row = rows[0];
  if (!row) throw new Error('no time');
  return row;
}

// What is waiting for each given member, by the rules of the member's own screens:
//   proposals       pending ones of their entities whose approver snapshot holds the member, a viewer none: an approximation of the
//                   approval screen's list (it also asks the member's role and the org's preset now), never more than the member's own
//                   entities and snapshot;
//   notifications   their unread notifications of the work kinds in their entities, the approval-waiting ones left to the proposals count, up to
//                   NOTIFICATION_UNREAD_CAP each;
//   messages        conversations waiting for a reply (New, unassigned or assigned to them), as conversation_access lets the role read
//                   them: owners and admins every one, a member the comment threads of the channels they may use (every channel when
//                   they have no channel list; direct messages stay with owners and admins until the permission that reads them is
//                   held by a role), a viewer none (a viewer cannot answer).
async function countsFor(ctx: CommandContext, members: ReadonlyArray<{ user_id: string; role: string }>): Promise<Map<string, TodayMailCounts>> {
  const out = new Map<string, TodayMailCounts>();
  for (const m of members) {
    // The legal entities the member reads, as enter_context seals them (roles migration): owners and admins, a member with an org-wide
    // assignment and a member with none read every entity; any other member only the entities of their assignments. Proposals and
    // notifications carry an entity, and the row-level policy that hides another entity's from the member does not apply to the
    // system context, so the counts apply it here.
    const { rows: assigned } = await sql<{ legal_entity_id: string | null }>`
      SELECT DISTINCT legal_entity_id FROM crove_kernel.role_assignment WHERE org_id = ${ctx.orgId}::uuid AND user_id = ${m.user_id}::uuid`.execute(ctx.trx);
    const everyEntity = m.role === 'owner' || m.role === 'admin' || assigned.length === 0 || assigned.some((a) => a.legal_entity_id === null);
    const entities = assigned.flatMap((a) => (a.legal_entity_id === null ? [] : [a.legal_entity_id]));
    const inScope = (column: string) => sql`(${everyEntity}::boolean OR ${sql.ref(column)}::uuid = ANY (${entities}::uuid[]))`;
    const proposals = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM crove_kernel.proposal p
      WHERE p.org_id = ${ctx.orgId}::uuid AND p.status = 'pending' AND ${m.role !== 'viewer'}::boolean AND p.eligible_approvers @> ARRAY[${m.user_id}::uuid]
        AND ${inScope('p.legal_entity_id')}`.execute(ctx.trx);
    const notifications = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM crove_kernel.notification n
        WHERE n.org_id = ${ctx.orgId}::uuid AND n.user_id = ${m.user_id}::uuid AND n.read_at IS NULL AND n.kind <> ${APPROVAL_WAITING}
          AND ${inScope('n.legal_entity_id')}
        LIMIT ${NOTIFICATION_UNREAD_CAP}
      ) u`.execute(ctx.trx);
    let messages = 0;
    if (m.role !== 'viewer') {
      const admin = m.role === 'owner' || m.role === 'admin';
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM crove_kernel.conversation c
        WHERE c.org_id = ${ctx.orgId}::uuid AND c.status = 'new' AND (c.assignee_user_id IS NULL OR c.assignee_user_id = ${m.user_id}::uuid)
          AND (${admin}::boolean OR (
            c.kind = 'comment_thread'
            AND (NOT EXISTS (SELECT 1 FROM crove_kernel.channel_access a WHERE a.org_id = c.org_id AND a.user_id = ${m.user_id}::uuid)
                 OR EXISTS (SELECT 1 FROM crove_kernel.channel_access a WHERE a.org_id = c.org_id AND a.user_id = ${m.user_id}::uuid AND a.channel_connection_id = c.channel_connection_id))))`.execute(ctx.trx);
      messages = rows[0]?.n ?? 0;
    }
    out.set(m.user_id, { proposals: proposals.rows[0]?.n ?? 0, notifications: notifications.rows[0]?.n ?? 0, messages });
  }
  return out;
}

export const todayMailSend = defineCommand({
  name: 'kernel.today_mail.send',
  input: z.strictObject({}),
  // Queues mail through the kernel pipeline in its transaction: a send, an effect outside Crove (#1578).
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx): Promise<{ state: TodayMailState; day: string; members: number; mails: number; suppressed: number }> => {
    const now = await vietnamNow(ctx);
    const none = { day: now.day, members: 0, mails: 0, suppressed: 0 };
    if (now.minute < SEND_FROM_MINUTE) return { state: 'not_due', ...none };
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name', 'status']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (org?.status !== 'active') return { state: 'not_due', ...none };
    // The claim: one statement takes every opted-in member whose day is not today and marks it, so a second command (a retry, a
    // second worker) finds none left and sends nothing twice. It commits with the mails below or not at all.
    const claimed = await ctx.trx
      .updateTable('crove_kernel.today_mail')
      .set({ last_sent_day: now.day })
      .where('org_id', '=', ctx.orgId)
      .where((eb) => eb.or([eb('last_sent_day', 'is', null), eb('last_sent_day', '<', now.day)]))
      // Opted in before today: turning it off and on again after a mail does not bring a second one the same day, and a new opt-in
      // is first mailed the next morning (the due-orgs function holds the same rule).
      .where(sql<boolean>`pg_catalog.timezone(${TODAY_MAIL_ZONE}::text, created_at)::date < ${now.day}::date`)
      .returning(['id', 'user_id'])
      .execute();
    if (claimed.length === 0) return { state: 'not_due', ...none };
    const ids = claimed.map((c) => c.user_id).sort();
    const { rows: roles } = await sql<{ user_id: string; role: string }>`
      SELECT user_id, role FROM crove_kernel.tenant_member WHERE org_id = ${ctx.orgId}::uuid AND user_id = ANY (${ids}::uuid[]) ORDER BY user_id`.execute(ctx.trx);
    const { rows: people } = await sql<{ user_id: string; email: string | null }>`SELECT user_id, email FROM crove_kernel.member_emails(${ids}::uuid[])`.execute(ctx.trx);
    const emails = new Map(people.filter((p) => p.email).map((p) => [p.user_id, p.email as string]));
    const rowOf = new Map(claimed.map((c) => [c.user_id, c.id]));
    const counts = await countsFor(ctx, roles);
    let mails = 0;
    let suppressed = 0;
    let skipped = 0;
    for (const m of roles) {
      const email = emails.get(m.user_id);
      const c = counts.get(m.user_id);
      // Nothing waits for the member: no mail, and the day is spent.
      if (!email || !c || c.proposals + c.notifications + c.messages === 0) continue;
      // One member whose mail cannot be written is skipped, rolled back to the savepoint, rather than losing the whole org's mails.
      await sql`SAVEPOINT today_mail`.execute(ctx.trx);
      try {
        const mail = await createMailMessage(ctx, {
          stream: 'transactional',
          source: TODAY_MAIL_SOURCE,
          sourceId: rowOf.get(m.user_id) ?? null,
          templateKey: TODAY_MAIL_TEMPLATE,
          to: email,
          payload: {
            org: org.name,
            language: 'vi',
            day: now.day,
            counts: { proposals: c.proposals, notifications: c.notifications, messages: c.messages },
            home: `/o/${org.slug}/overview`,
            settings: `/o/${org.slug}/notifications?todayMail=off`,
          },
          status: 'queued',
        });
        await sql`RELEASE SAVEPOINT today_mail`.execute(ctx.trx);
        if (mail.status === 'queued') mails += 1;
        else suppressed += 1;
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT today_mail`.execute(ctx.trx);
        await sql`RELEASE SAVEPOINT today_mail`.execute(ctx.trx);
        skipped += 1;
        console.warn(`[today-mail] org ${ctx.orgId.slice(0, 8)}: a member's mail was skipped`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
      }
    }
    // Counts only: no address, no member.
    ctx.audit({ members: claimed.length, mails, suppressed, skipped });
    return { state: 'sent', day: now.day, members: claimed.length, mails, suppressed };
  },
});

const ACTOR: SystemActor = { type: 'system', component: 'kernel.today_mail' };

// One pass over the orgs that have a member to mail today; returns how many orgs sent. The due list is the worker login's alone
// (a definer ids-only read); each org is then its own command in its own transaction, so one org's failure costs only itself.
export async function sweepTodayMail(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  let after: string | null = null;
  let sent = 0;
  for (let page = 0; page < TODAY_MAIL_MAX_PAGES; page++) {
    const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_kernel.today_mail_due(${after}::uuid, ${TODAY_MAIL_PAGE}::int)`.execute(deps.workerDb);
    for (const row of rows) {
      try {
        const done = await deps.runtime.execute<{ state: TodayMailState }>('kernel.today_mail.send', {}, { actor: ACTOR, orgId: row.org_id });
        if (done.state === 'sent') sent += 1;
      } catch (error) {
        console.warn(`[today-mail] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
      }
    }
    const last = rows.at(-1);
    if (rows.length < TODAY_MAIL_PAGE || !last) break;
    after = last.org_id;
  }
  return sent;
}

export const todayMailCommands = [todayMailSet, todayMailSend];
export const todayMailQueries = [todayMailGet];
