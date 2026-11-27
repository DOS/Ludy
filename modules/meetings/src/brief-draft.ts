// SPDX-License-Identifier: AGPL-3.0-only
// Per-member private pre-meeting facts drafts (#4991 PM1):
// - meetings.brief_draft.list: reads the caller's own drafts for an agenda event, booking, or meeting (including any linked agenda draft on a meeting page).
// - meetings.brief_draft.save: stores or updates the caller's private draft for a readable target and contact; nothing is shared or sent.
// - meetings.brief_draft.remove: deletes the caller's private draft for one target and contact.
// - meetings.brief_draft.put_to_notes: copies one private draft into ludy_meetings.meeting_note for the meeting recorder.
import { sql } from 'kysely';
import {
  MEETING_BRIEF_DRAFT_MAX,
  NOTES_BODY_MAX,
  zMeetingBriefDraftListInput,
  zMeetingBriefDraftListOutput,
  zMeetingBriefDraftPutToNotesInput,
  zMeetingBriefDraftPutToNotesOutput,
  zMeetingBriefDraftRemovedOutput,
  zMeetingBriefDraftRemoveInput,
  zMeetingBriefDraftSaveInput,
  zMeetingBriefDraftSaveOutput,
  type MeetingBriefDraft,
  type MeetingBriefDraftListOutput,
  type MeetingBriefDraftPutToNotesOutput,
  type MeetingBriefTargetKind,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@ludy/kernel-runtime';
import { recorderMeeting } from './results.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

function sliceCodePoints(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

async function assertTargetReadable(ctx: CommandContext, userId: string, targetKind: MeetingBriefTargetKind, targetId: string): Promise<void> {
  if (targetKind === 'agenda') {
    const agenda = await ctx.trx
      .selectFrom('ludy_meetings.calendar_agenda as a')
      .innerJoin('ludy_kernel.calendar_connection as c', (join) => join.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.connection_id'))
      .select('a.id')
      .where('a.org_id', '=', ctx.orgId)
      .where('a.id', '=', targetId)
      .where('a.user_id', '=', userId)
      .where('c.status', '=', 'active')
      .where('c.read_events', '=', true)
      .executeTakeFirst();
    if (!agenda) throw new DomainError('AGENDA_NOT_FOUND', 404, 'Không tìm thấy sự kiện lịch');
    return;
  }
  if (targetKind === 'meeting') {
    await openMeeting(ctx.trx, ctx.orgId, targetId);
    return;
  }
  const res = await ctx.query<{ readable: boolean; calendarEventId: string | null }>('crm.booking.brief_target', { bookingId: targetId });
  if (res.status !== 'ok' || !res.value.readable) {
    throw new DomainError('BOOKING_NOT_FOUND', 404, 'Không tìm thấy lịch hẹn');
  }
}

export const briefDraftList = defineQuery({
  name: 'meetings.brief_draft.list',
  input: zMeetingBriefDraftListInput,
  access: ROLES,
  handler: async (ctx, input): Promise<MeetingBriefDraftListOutput> => {
    const userId = userOf(ctx.actor);
    const linkedAgendaIds =
      input.targetKind === 'meeting'
        ? (
            await ctx.trx
              .selectFrom('ludy_meetings.calendar_agenda as a')
              .innerJoin('ludy_kernel.calendar_connection as c', (join) => join.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.connection_id'))
              .select('a.id')
              .where('a.org_id', '=', ctx.orgId)
              .where('a.user_id', '=', userId)
              .where('a.meeting_id', '=', input.targetId)
              .where('c.status', '=', 'active')
              .where('c.read_events', '=', true)
              .execute()
          ).map((r) => r.id)
        : [];

    const rows = await ctx.trx
      .selectFrom('ludy_meetings.meeting_brief_draft')
      .select(['id', 'party_id', 'target_kind', 'target_id', 'body', sql<string>`updated_at::text`.as('updated_at')])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where((eb) => {
        const direct = eb.and([eb('target_kind', '=', input.targetKind), eb('target_id', '=', input.targetId)]);
        if (linkedAgendaIds.length === 0) return direct;
        return eb.or([direct, eb.and([eb('target_kind', '=', 'agenda'), eb('target_id', 'in', linkedAgendaIds)])]);
      })
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(20)
      .execute();

    // When both a direct meeting draft and an earlier agenda draft exist for the same party, prefer the meeting draft.
    const seenParties = new Set<string>();
    const drafts: MeetingBriefDraft[] = [];
    const sorted = [...rows].sort((a, b) => {
      if (a.target_kind !== b.target_kind) {
        if (a.target_kind === input.targetKind) return -1;
        if (b.target_kind === input.targetKind) return 1;
      }
      return 0;
    });
    for (const r of sorted) {
      if (seenParties.has(r.party_id)) continue;
      seenParties.add(r.party_id);
      drafts.push({
        id: r.id,
        partyId: r.party_id,
        targetKind: r.target_kind,
        targetId: r.target_id,
        body: r.body,
        updatedAt: new Date(r.updated_at).toISOString(),
      });
    }

    return zMeetingBriefDraftListOutput.parse({ drafts });
  },
});

export const briefDraftSave = defineCommand({
  name: 'meetings.brief_draft.save',
  input: zMeetingBriefDraftSaveInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await assertTargetReadable(ctx, userId, input.targetKind, input.targetId);

    const party = await ctx.trx
      .selectFrom('ludy_kernel.party')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.partyId)
      .executeTakeFirst();
    if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy liên hệ');

    const body = sliceCodePoints(input.body.trim(), MEETING_BRIEF_DRAFT_MAX);
    if (body === '') throw new DomainError('INVALID', 422, 'Nội dung bản nháp không được trống');

    const saved = await ctx.trx
      .insertInto('ludy_meetings.meeting_brief_draft')
      .values({
        org_id: ctx.orgId,
        user_id: userId,
        target_kind: input.targetKind,
        target_id: input.targetId,
        party_id: input.partyId,
        body,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'user_id', 'target_kind', 'target_id', 'party_id']).doUpdateSet({
          body,
          updated_at: ctx.now,
        }),
      )
      .returning(['id', 'party_id', 'target_kind', 'target_id', 'body', sql<string>`updated_at::text`.as('updated_at')])
      .executeTakeFirstOrThrow();

    ctx.audit({ targetKind: input.targetKind, targetId: input.targetId, partyId: input.partyId, length: body.length });
    return zMeetingBriefDraftSaveOutput.parse({
      draft: {
        id: saved.id,
        partyId: saved.party_id,
        targetKind: saved.target_kind,
        targetId: saved.target_id,
        body: saved.body,
        updatedAt: new Date(saved.updated_at).toISOString(),
      },
    });
  },
});

export const briefDraftRemove = defineCommand({
  name: 'meetings.brief_draft.remove',
  input: zMeetingBriefDraftRemoveInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const result = await ctx.trx
      .deleteFrom('ludy_meetings.meeting_brief_draft')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('target_kind', '=', input.targetKind)
      .where('target_id', '=', input.targetId)
      .where('party_id', '=', input.partyId)
      .executeTakeFirst();
    const removed = Number(result.numDeletedRows ?? 0) > 0;
    ctx.audit({ targetKind: input.targetKind, targetId: input.targetId, partyId: input.partyId, removed });
    return zMeetingBriefDraftRemovedOutput.parse({ removed });
  },
});

export const briefDraftPutToNotes = defineCommand({
  name: 'meetings.brief_draft.put_to_notes',
  input: zMeetingBriefDraftPutToNotesInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MeetingBriefDraftPutToNotesOutput> => {
    const userId = userOf(ctx.actor);
    await recorderMeeting(ctx, input.meetingId, 'write its notes');

    if (input.targetKind === 'meeting' && input.targetId !== input.meetingId) {
      throw new DomainError('BRIEF_DRAFT_TARGET_MISMATCH', 400, 'Bản nháp không thuộc cuộc họp này');
    }
    if (input.targetKind === 'agenda') {
      const agenda = await ctx.trx
        .selectFrom('ludy_meetings.calendar_agenda')
        .select('meeting_id')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.targetId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!agenda || agenda.meeting_id !== input.meetingId) {
        throw new DomainError('BRIEF_DRAFT_TARGET_MISMATCH', 400, 'Sự kiện lịch chưa được gắn vào cuộc họp này');
      }
    }

    if (input.targetKind === 'booking') {
      const bookingRes = await ctx.query<{ readable: boolean; calendarEventId: string | null }>('crm.booking.brief_target', {
        bookingId: input.targetId,
      });
      if (bookingRes.status !== 'ok' || !bookingRes.value.readable) {
        throw new DomainError('BOOKING_NOT_FOUND', 404, 'Không tìm thấy lịch hẹn');
      }
      if (!bookingRes.value.calendarEventId) {
        throw new DomainError('BRIEF_DRAFT_TARGET_MISMATCH', 400, 'Lịch hẹn chưa được gắn vào cuộc họp này');
      }
      const linkedMeeting = await ctx.trx
        .selectFrom('ludy_meetings.meeting_link')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('meeting_id', '=', input.meetingId)
        .where('calendar_event_id', '=', bookingRes.value.calendarEventId)
        .executeTakeFirst();
      if (!linkedMeeting) {
        throw new DomainError('BRIEF_DRAFT_TARGET_MISMATCH', 400, 'Lịch hẹn chưa được gắn vào cuộc họp này');
      }
    }

    // Lock the meeting row so concurrent put_to_notes calls across multiple contacts append sequentially.
    await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .forUpdate()
      .executeTakeFirst();

    const draft = await ctx.trx
      .selectFrom('ludy_meetings.meeting_brief_draft')
      .select('body')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('target_kind', '=', input.targetKind)
      .where('target_id', '=', input.targetId)
      .where('party_id', '=', input.partyId)
      .executeTakeFirst();
    if (!draft) {
      throw new DomainError('BRIEF_DRAFT_NOT_FOUND', 404, 'Không tìm thấy bản nháp tóm tắt');
    }

    const existingRow = await ctx.trx
      .selectFrom('ludy_meetings.meeting_note')
      .select('body')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();

    const existing = existingRow?.body.trim() ?? '';
    const combined =
      existing === ''
        ? draft.body
        : existing.includes(draft.body)
          ? existing
          : `${existing}\n\n${draft.body}`;
    const nextBody = sliceCodePoints(combined, NOTES_BODY_MAX);
    const truncated = Array.from(combined).length > NOTES_BODY_MAX;

    await ctx.trx
      .insertInto('ludy_meetings.meeting_note')
      .values({ org_id: ctx.orgId, meeting_id: input.meetingId, body: nextBody })
      .onConflict((oc) =>
        oc.columns(['org_id', 'meeting_id']).doUpdateSet({
          body: nextBody,
          updated_at: ctx.now,
        }),
      )
      .execute();

    ctx.audit({ meetingId: input.meetingId, partyId: input.partyId, length: nextBody.length });
    return zMeetingBriefDraftPutToNotesOutput.parse({
      meetingId: input.meetingId,
      partyId: input.partyId,
      length: nextBody.length,
      truncated,
    });
  },
});

export const briefDraftCommands = [briefDraftSave, briefDraftRemove, briefDraftPutToNotes];
export const briefDraftQueries = [briefDraftList];
