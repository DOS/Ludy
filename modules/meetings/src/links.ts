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
  MEETING_LINK_SUGGEST_MAX,
  type MeetingLinkSuggested,
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

function toLink(row: LinkRow, label: string | null = null): MeetingLink {
  const kind = kindOf(row);
  return {
    id: row.id,
    meetingId: row.meeting_id,
    kind,
    targetId: (row[COLUMN[kind]] as string),
    label,
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
    const links = rows as unknown as LinkRow[];
    // Names for display. A party is read under the caller's own policies. A calendar event title is shared on purpose with every reader of this meeting: the recorder
    // linked their own event (link.add takes no other), and the meeting's readers are the people the recorder chose.
    const partyIds = links.flatMap((l) => (l.party_id ? [l.party_id] : []));
    const eventIds = links.flatMap((l) => (l.calendar_event_id ? [l.calendar_event_id] : []));
    const parties = partyIds.length ? await ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name']).where('org_id', '=', ctx.orgId).where('id', 'in', partyIds).execute() : [];
    const events = eventIds.length ? await ctx.trx.selectFrom('crove_kernel.calendar_event').select(['id', 'title']).where('org_id', '=', ctx.orgId).where('id', 'in', eventIds).execute() : [];
    const names = new Map<string, string | null>([...parties.map((p) => [p.id, p.name] as const), ...events.map((e) => [e.id, e.title] as const)]);
    return links.map((l) => toLink(l, names.get((l.party_id ?? l.calendar_event_id) ?? '') ?? null));
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

// The text of a name or a transcript as the search folds it (no marks, lower case, single spaces), so "Công ty Á Châu" is found in "công ty a chau,".
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const mentionsOf = (body: string, name: string): number => (name.length < 3 ? 0 : body.split(` ${name} `).length - 1);

// Vy's suggestion (L1, #2587), for the recorder only: the contacts whose name the transcript says and the deals (of those contacts and of the linked ones) whose title it
// says, each with how often. It is TAINTED (the transcript is what people said, and the matching is a plain reading of it) and it reads only: nothing is linked
// here, and a contact or deal already linked is left out. The recorder links with a click on meetings.link.add, which checks the target again. It calls no model, so the
// AI budget meter has nothing to meter and the core works with AI off. The transcript is read under the recorder's own policies and audited like its own read.
export const meetingLinkSuggest = defineQuery({
  name: 'meetings.link.suggest',
  input: zMeetingRef,
  access: READERS,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx: QueryContext, input): Promise<MeetingLinkSuggested> => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx.selectFrom('crove_meetings.meeting').select('recorder_user_id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirst();
    if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder gets suggestions');
    const none: MeetingLinkSuggested = { tainted: true, ai: 'off', parties: [], deals: [] };
    const segments = await ctx.trx.selectFrom('crove_meetings.transcript_segment').select('text').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).orderBy('start_seconds').orderBy('id').execute();
    const body = ` ${fold(segments.map((r) => r.text).join(' '))} `;
    if (body.trim() === '') return none;
    const linked = await ctx.trx.selectFrom('crove_meetings.meeting_link').select(['party_id', 'deal_id']).where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).execute();
    const linkedParties = new Set(linked.flatMap((l) => (l.party_id ? [l.party_id] : [])));
    const hasDeal = linked.some((l) => l.deal_id !== null);

    // Contacts: the folded name, as a whole phrase, of at least three characters. The kernel party table is read under the recorder's own policies.
    const { rows } = await sql<{ id: string; name: string; folded: string }>`
      SELECT p.id, p.name, crove_kernel.search_fold(p.name) AS folded FROM crove_kernel.party p
      WHERE p.org_id = ${ctx.orgId}::uuid AND p.duplicate_of IS NULL AND pg_catalog.length(crove_kernel.search_fold(p.name)) >= 3
        AND pg_catalog.strpos(${body}, ' ' || crove_kernel.search_fold(p.name) || ' ') > 0
      ORDER BY p.name, p.id LIMIT 50`.execute(ctx.trx);
    const found = rows.map((r) => ({ partyId: r.id, name: r.name, mentions: mentionsOf(body, r.folded) })).filter((p) => p.mentions > 0);
    found.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));
    const parties = found.filter((p) => !linkedParties.has(p.partyId)).slice(0, MEETING_LINK_SUGGEST_MAX);

    // Deals: of the suggested and the linked contacts, by title; a meeting holds one deal, so none is suggested once it has one.
    const deals: MeetingLinkSuggested['deals'] = [];
    if (!hasDeal) {
      for (const partyId of [...new Set([...linkedParties, ...parties.map((p) => p.partyId)])].slice(0, 10)) {
        let answer;
        try {
          answer = await ctx.query<Array<{ id: string; title: string; partyId: string; partyName: string; stageKind: string }>>('crm.party.deals', { partyId });
        } catch {
          continue;
        }
        if (answer.status !== 'ok') break;
        for (const d of answer.value) if (d.stageKind === 'open' && mentionsOf(body, fold(d.title)) > 0) deals.push({ dealId: d.id, title: d.title, partyId: d.partyId, partyName: d.partyName });
      }
    }
    return { tainted: true, ai: 'off', parties, deals: deals.slice(0, MEETING_LINK_SUGGEST_MAX) };
  },
});

export const linkCommands = [meetingLinkAdd, meetingLinkRemove];
export const linkQueries = [meetingLinkList, meetingsOfTarget, meetingLinkSuggest];
