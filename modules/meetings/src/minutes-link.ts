// SPDX-License-Identifier: AGPL-3.0-only
// The link to the PUBLISHED minutes of a meeting for people outside the org (#4822, owner decision 2026-11-25; plan docs/plan/meetings.md). The recorder of a meeting with published minutes makes a
// link, copies it once, and can revoke it; the link opens a read-only page (POST /api/minutes/view, the app's /-/minutes) with the published summary, decisions and action items, never the transcript,
// the recording, the chapters or a draft, for at most 30 days. The token is 32 random bytes shown once and kept only as a SHA-256 hash; the link goes with its meeting and with the org setting.
//   meetings.minutes_link.create   (the recorder; R2, it hands a way in to people outside) refuses while the org setting is off, a meeting with no published minutes and a meeting that already has 10 live links.
//   meetings.minutes_link.revoke   (the recorder, or an owner or admin) once, in the revoker's name; a second time is the same answer.
//   meetings.minutes_link.list     (the recorder) the links of the meeting with their state and how often each was opened, never a token.
//   meetings.minutes_link.switch.get / .set   the org setting "Chia sẻ biên bản ra ngoài", off by default; every member reads it, an owner or admin changes it (a guard trigger holds every other writer).
// The audit rows hold ids only. No AI part: a person decides what to share and with whom, and the core works with AI off.
import { createHash, randomBytes } from 'node:crypto';
import type { MemberRole } from '@ludy/db';
import {
  MINUTES_LINKS_MAX,
  MINUTES_LINK_DAYS,
  MINUTES_PAGE_PATH,
  zMinutesLinkCreate,
  zMinutesLinkList,
  zMinutesLinkRevoke,
  zMinutesLinkSwitch,
  zMinutesLinkSwitchGet,
  type MinutesLinkCreated,
  type MinutesLinkItems,
  type MinutesLinkRevoked,
  type MinutesLinkSwitch,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { lockMeeting, openMeeting } from './transcript.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const DAY_MS = 86_400_000;
// The table's CHECK allows a link 30 days from its making; a minute less leaves room for the clock.
const LIFETIME_MS = MINUTES_LINK_DAYS * DAY_MS - 60_000;

export const newMinutesToken = (): string => randomBytes(32).toString('base64url');
export const minutesTokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

function userOf(actor: CommandContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

/** Whether the org lets minutes be shared with people outside; false for an org whose row cannot be read. */
export async function readMinutesLinkSwitch(trx: QueryContext['trx'], orgId: string): Promise<boolean> {
  const row = await trx.selectFrom('ludy_kernel.tenant').select(['meeting_minutes_link']).where('org_id', '=', orgId).executeTakeFirst();
  return row?.meeting_minutes_link === true;
}

export const meetingMinutesLinkSwitchGet = defineQuery({
  name: 'meetings.minutes_link.switch.get',
  input: zMinutesLinkSwitchGet,
  access: WRITERS,
  handler: async (ctx): Promise<MinutesLinkSwitch> => ({ enabled: await readMinutesLinkSwitch(ctx.trx, ctx.orgId) }),
});

// Only an owner or admin. Turning it off does not delete a link, but no link opens while it is off (the page's database check reads it) and none can be made. The audit row holds the two values.
export const meetingMinutesLinkSwitchSet = defineCommand({
  name: 'meetings.minutes_link.switch.set',
  input: zMinutesLinkSwitch,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input): Promise<MinutesLinkSwitch> => {
    userOf(ctx.actor);
    const previous = await readMinutesLinkSwitch(ctx.trx, ctx.orgId);
    await ctx.trx.updateTable('ludy_kernel.tenant').set({ meeting_minutes_link: input.enabled }).where('org_id', '=', ctx.orgId).execute();
    ctx.audit({ enabled: input.enabled, previous });
    return { enabled: input.enabled };
  },
});

export const meetingMinutesLinkCreate = defineCommand({
  name: 'meetings.minutes_link.create',
  input: zMinutesLinkCreate,
  risk: 'R2',
  sideEffect: 'internal',
  access: WRITERS,
  // The answer holds the token, which is shown once and kept nowhere: never stored with an idempotency key.
  noIdempotency: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MinutesLinkCreated> => {
    const userId = userOf(ctx.actor);
    if (!(await readMinutesLinkSwitch(ctx.trx, ctx.orgId))) throw new DomainError('MINUTES_LINK_OFF', 409, 'Tổ chức chưa bật chia sẻ biên bản ra ngoài');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Chỉ người ghi cuộc họp mới tạo được liên kết biên bản');
    // The meeting row is held, so a delete or a republish waits for this transaction and a link is never made for minutes that are gone.
    await lockMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const published = await ctx.trx
      .selectFrom('ludy_meetings.meeting_result')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('stage', '=', 'published')
      .executeTakeFirst();
    if (!published) throw new DomainError('MINUTES_NOT_PUBLISHED', 409, 'Cuộc họp này chưa có biên bản đã xuất bản để chia sẻ');
    const live = await ctx.trx
      .selectFrom('ludy_meetings.minutes_link')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', ctx.now)
      .executeTakeFirstOrThrow();
    if (Number(live.n) >= MINUTES_LINKS_MAX) throw new DomainError('MINUTES_LINK_LIMIT', 409, `Cuộc họp này đã có ${MINUTES_LINKS_MAX} liên kết còn hạn; hãy thu hồi bớt`);
    const token = newMinutesToken();
    const expires = new Date(ctx.now.getTime() + LIFETIME_MS);
    const row = await ctx.trx
      .insertInto('ludy_meetings.minutes_link')
      .values({ org_id: ctx.orgId, meeting_id: input.meetingId, token_sha256: minutesTokenHash(token), expires_at: expires, created_by: userId, created_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ meetingId: input.meetingId, linkId: row.id });
    return { linkId: row.id, token, expiresAt: expires.toISOString(), path: `${MINUTES_PAGE_PATH}#${token}` };
  },
});

// The recorder, or an owner or admin (who may have to kill a link a member made). A link of another meeting is not found.
export const meetingMinutesLinkRevoke = defineCommand({
  name: 'meetings.minutes_link.revoke',
  input: zMinutesLinkRevoke,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MinutesLinkRevoked> => {
    const userId = userOf(ctx.actor);
    const link = await ctx.trx
      .selectFrom('ludy_meetings.minutes_link')
      .select(['id', 'revoked_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.linkId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();
    if (!link) throw new DomainError('MINUTES_LINK_NOT_FOUND', 404, 'Không tìm thấy liên kết này');
    const meeting = await ctx.trx.selectFrom('ludy_meetings.meeting').select('recorder_user_id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirst();
    if (meeting?.recorder_user_id !== userId) {
      const member = await ctx.trx.selectFrom('ludy_kernel.tenant_member').select('role').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).executeTakeFirst();
      if (member?.role !== 'owner' && member?.role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ người ghi cuộc họp, chủ sở hữu hoặc quản trị viên mới thu hồi được liên kết này');
    }
    // Revoking twice is the same answer; only the first writes.
    if (link.revoked_at === null) {
      const result = await ctx.trx.updateTable('ludy_meetings.minutes_link').set({ revoked_at: ctx.now, revoked_by: userId }).where('org_id', '=', ctx.orgId).where('id', '=', link.id).where('revoked_at', 'is', null).executeTakeFirst();
      // Two revokes at once both read it live; only the one that wrote is audited.
      if (Number(result.numUpdatedRows) > 0) ctx.audit({ meetingId: input.meetingId, linkId: link.id });
    }
    return { linkId: link.id, revoked: true };
  },
});

// The recorder's list of a meeting's links, and an owner's or admin's (to end a link whose recorder left). Another reader of the meeting gets 403, not an empty list that would hide a link.
export const meetingMinutesLinkList = defineQuery({
  name: 'meetings.minutes_link.list',
  input: zMinutesLinkList,
  access: WRITERS,
  handler: async (ctx, input): Promise<MinutesLinkItems> => {
    const userId = userOf(ctx.actor);
    const enabled = await readMinutesLinkSwitch(ctx.trx, ctx.orgId);
    // The meeting row may be hidden from an owner or admin who is not a reader of it, so it is read as plain data (like revoke) and an owner or admin is judged by their role.
    const meeting = await ctx.trx.selectFrom('ludy_meetings.meeting').select('recorder_user_id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirst();
    if (meeting?.recorder_user_id !== userId) {
      // An owner or admin sees the links too, so they can end one (the recorder may have left the org).
      const member = await ctx.trx.selectFrom('ludy_kernel.tenant_member').select('role').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).executeTakeFirst();
      if (member?.role !== 'owner' && member?.role !== 'admin') {
        if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Không tìm thấy cuộc họp này');
        throw new DomainError('FORBIDDEN', 403, 'Chỉ người ghi cuộc họp, chủ sở hữu hoặc quản trị viên mới xem được các liên kết biên bản');
      }
    }
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.minutes_link')
      .select(['id', 'created_at', 'expires_at', 'revoked_at', 'views', 'first_viewed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(50)
      .execute();
    const now = Date.now();
    return {
      enabled,
      items: rows.map((r) => ({
        id: r.id,
        state: r.revoked_at !== null ? ('revoked' as const) : new Date(r.expires_at).getTime() <= now ? ('expired' as const) : ('live' as const),
        createdAt: new Date(r.created_at).toISOString(),
        expiresAt: new Date(r.expires_at).toISOString(),
        revokedAt: r.revoked_at === null ? null : new Date(r.revoked_at).toISOString(),
        views: r.views,
        firstViewedAt: r.first_viewed_at === null ? null : new Date(r.first_viewed_at).toISOString(),
      })),
    };
  },
});

export const minutesLinkCommands = [meetingMinutesLinkSwitchSet, meetingMinutesLinkCreate, meetingMinutesLinkRevoke];
export const minutesLinkQueries = [meetingMinutesLinkSwitchGet, meetingMinutesLinkList];
