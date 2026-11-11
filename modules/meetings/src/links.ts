// SPDX-License-Identifier: AGPL-3.0-only
// Links of a meeting to a party, to at most one deal and to the calendar event it came from (L1, issue #2587, plan docs/plan/meetings.md section 15, ADR-0024).
// The meetings module owns the write path. The recorder sets and removes links; a link is read only by the readers of its meeting (the table's policy runs the
// meeting's own reader check), so a deal page, a viewer and an agent get no row and no title of an attendees-only meeting they do not read. A deal belongs to the
// CRM module, so it is checked through that module's query (a deployment without CRM cannot link one) and has no foreign key: modules name no other module's schema.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import {
  zMeetingLinkAdd,
  zMeetingLinkRemove,
  zMeetingRef,
  zMeetingsOfTargetInput,
  MEETING_LINK_PAGE,
  type MeetingLink,
  type MeetingLinkKind,
  type MeetingLinkRemoved,
  type MeetingOfTarget,
  type MeetingStatus,
  type MeetingVisibility,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { vnDay } from './retention.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

interface LinkRow {
  id: string;
  meeting_id: string;
  party_id: string | null;
  deal_id: string | null;
  calendar_event_id: string | null;
  created_by: string;
  created_at: Date | string;
}

const COLUMN: Record<MeetingLinkKind, 'party_id' | 'deal_id' | 'calendar_event_id'> = {
  party: 'party_id',
  deal: 'deal_id',
  calendar_event: 'calendar_event_id',
};

function kindOf(row: LinkRow): MeetingLinkKind {
  if (row.party_id !== null) return 'party';
  if (row.deal_id !== null) return 'deal';
  return 'calendar_event';
}

function toLink(row: LinkRow): MeetingLink {
  const kind = kindOf(row);
  return {
    id: row.id,
    meetingId: row.meeting_id,
    kind,
    targetId: (row[COLUMN[kind]] as string),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function userOf(actor: CommandContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Only authenticated members can perform this action');
  return actor.userId;
}

// The meeting, as the caller may read it (the table's own policy): one the caller does not read is not found, so a link cannot tell that it exists.
async function recordedMeeting(ctx: CommandContext, meetingId: string, userId: string): Promise<void> {
  const meeting = await ctx.trx.selectFrom('crove_meetings.meeting').select(['id', 'recorder_user_id']).where('org_id', '=', ctx.orgId).where('id', '=', meetingId).executeTakeFirst();
  if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
  if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can change its links');
}

const targetMissing = () => new DomainError('LINK_TARGET_NOT_FOUND', 404, 'The party, deal or calendar event to link was not found');

// The target exists and the caller may read it: a party by the caller's own read (its policy decides), a calendar event only the caller's own and of kind manual or
// booking (a synced busy block is deleted and rewritten by every calendar sync, and would take the link with it), a deal by the CRM module's query.
async function checkTarget(ctx: CommandContext, kind: MeetingLinkKind, targetId: string, userId: string): Promise<void> {
  if (kind === 'party') {
    const found = await ctx.trx.selectFrom('crove_kernel.party').select('id').where('org_id', '=', ctx.orgId).where('id', '=', targetId).executeTakeFirst();
    if (!found) throw targetMissing();
    return;
  }
  if (kind === 'calendar_event') {
    const found = await ctx.trx.selectFrom('crove_kernel.calendar_event').select('id').where('org_id', '=', ctx.orgId).where('id', '=', targetId).where('status', '=', 'active').where('user_id', '=', userId).where('kind', 'in', ['manual', 'booking']).executeTakeFirst();
    if (!found) throw targetMissing();
    return;
  }
  let answer;
  try {
    answer = await ctx.query<{ id: string }>('crm.deal.get', { dealId: targetId });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'DEAL_NOT_FOUND') throw targetMissing();
    throw error;
  }
  if (answer.status === 'not_installed') {
    throw new DomainError('DEAL_LINK_UNAVAILABLE', 400, 'This deployment has no CRM module, so a meeting cannot be linked to a deal');
  }
}

// Whether a deal is gone: the CRM module answers that it does not have it. Any other answer (found, no CRM, another error) is not "gone".
async function dealIsGone(ctx: CommandContext, dealId: string): Promise<boolean> {
  try {
    await ctx.query('crm.deal.get', { dealId });
    return false;
  } catch (error) {
    return error instanceof DomainError && error.code === 'DEAL_NOT_FOUND';
  }
}

export const meetingLinkAdd = defineCommand({
  name: 'meetings.link.add',
  input: zMeetingLinkAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MeetingLink> => {
    const userId = userOf(ctx.actor);
    await recordedMeeting(ctx, input.meetingId, userId);
    await checkTarget(ctx, input.kind, input.targetId, userId);

    const column = COLUMN[input.kind];
    const same = await ctx.trx.selectFrom('crove_meetings.meeting_link').selectAll().where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where(column, '=', input.targetId).executeTakeFirst();
    // The same link again is the same link: nothing is written or audited twice.
    if (same) return toLink(same as unknown as LinkRow);
    if (input.kind === 'deal') {
      const other = await ctx.trx.selectFrom('crove_meetings.meeting_link').select(['id', 'deal_id']).where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('deal_id', 'is not', null).executeTakeFirst();
      if (other) {
        // A deal that was deleted left its link behind (a deal has no foreign key): such a link is dropped, not a reason to refuse the new one.
        if (await dealIsGone(ctx, other.deal_id as string)) {
          await ctx.trx.deleteFrom('crove_meetings.meeting_link').where('org_id', '=', ctx.orgId).where('id', '=', other.id).execute();
          ctx.audit({ meetingId: input.meetingId, linkId: other.id, kind: 'deal', targetId: other.deal_id, removed: true, reason: 'DEAL_DELETED' });
        } else {
          throw new DomainError('MEETING_HAS_DEAL', 409, 'This meeting is already linked to a deal; remove that link first');
        }
      }
    }

    const row = await ctx.trx
      .insertInto('crove_meetings.meeting_link')
      .values({ org_id: ctx.orgId, id: randomUUID(), meeting_id: input.meetingId, [column]: input.targetId, created_by: userId } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    // Ids only: the audit row names no title.
    ctx.audit({ meetingId: input.meetingId, linkId: row.id, kind: input.kind, targetId: input.targetId });
    return toLink(row as unknown as LinkRow);
  },
});

export const meetingLinkRemove = defineCommand({
  name: 'meetings.link.remove',
  input: zMeetingLinkRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MeetingLinkRemoved> => {
    const userId = userOf(ctx.actor);
    await recordedMeeting(ctx, input.meetingId, userId);
    const row = await ctx.trx.selectFrom('crove_meetings.meeting_link').selectAll().where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('id', '=', input.linkId).executeTakeFirst();
    if (!row) throw new DomainError('LINK_NOT_FOUND', 404, 'Link not found');
    await ctx.trx.deleteFrom('crove_meetings.meeting_link').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('id', '=', input.linkId).execute();
    const removed = toLink(row as unknown as LinkRow);
    // Removing a link is audited (L1): who, which meeting, which target (ids only).
    ctx.audit({ meetingId: input.meetingId, linkId: input.linkId, kind: removed.kind, targetId: removed.targetId, removed: true });
    return { meetingId: input.meetingId, linkId: input.linkId, removed: true };
  },
});

// The links of one meeting: its readers see them all, anyone else sees none (the table's policy).
export const meetingLinkList = defineQuery({
  name: 'meetings.link.list',
  input: zMeetingRef,
  access: READERS,
  handler: async (ctx: QueryContext, input): Promise<MeetingLink[]> => {
    const rows = await ctx.trx.selectFrom('crove_meetings.meeting_link').selectAll().where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).orderBy('created_at').orderBy('id').execute();
    return rows.map((r) => toLink(r as unknown as LinkRow));
  },
});

// The meetings linked to one party, deal or calendar event, as the caller may read them. The join runs under the policies of both tables, so a meeting the
// caller does not read (attendees-only, someone else's) is not a row here, and neither is its title.
export const meetingsOfTarget = defineQuery({
  name: 'meetings.link.by_target',
  input: zMeetingsOfTargetInput,
  access: READERS,
  handler: async (ctx: QueryContext, input): Promise<MeetingOfTarget[]> => {
    const column = COLUMN[input.kind];
    const rows = await ctx.trx
      .selectFrom('crove_meetings.meeting_link as l')
      .innerJoin('crove_meetings.meeting as m', (join) => join.onRef('m.org_id', '=', 'l.org_id').onRef('m.id', '=', 'l.meeting_id'))
      .select(['l.id as link_id', 'm.id as meeting_id', 'm.title', 'm.started_at', 'm.status', 'm.visibility', 'm.recorder_user_id'])
      .where('l.org_id', '=', ctx.orgId)
      .where(`l.${column}`, '=', input.targetId)
      // A meeting past its text date is gone from its day, not from the nightly job's run (#2579).
      .where((eb) => eb.or([eb('m.text_retention_date', 'is', null), eb('m.text_retention_date', '>', vnDay(new Date()))]))
      .orderBy(sql`coalesce(m.started_at, m.created_at)`, 'desc')
      .orderBy('m.id', 'desc')
      .limit(input.limit ?? MEETING_LINK_PAGE)
      .execute();
    return rows.map((r) => ({
      linkId: r.link_id,
      meetingId: r.meeting_id,
      title: r.title,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      status: r.status as MeetingStatus,
      visibility: r.visibility as MeetingVisibility,
      recorderUserId: r.recorder_user_id,
    }));
  },
});

export const linkCommands = [meetingLinkAdd, meetingLinkRemove];
export const linkQueries = [meetingLinkList, meetingsOfTarget];
