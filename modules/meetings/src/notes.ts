// SPDX-License-Identifier: AGPL-3.0-only
// "Ghi chú của tôi" (Meetings A5, #3163, plan docs/plan/meetings-integrations.md section 4.4): the recorder's own rough notes of a meeting. They are theirs alone to read and write (row
// security on crove_meetings.meeting_note says so for every other member, owner and admin included, and for any agent context), typed by hand and never the model's, so there is no
// taint here and nothing needs AI. Saving an empty text deletes them. The notes go with the meeting (cascade: the recorder's delete, an owner's delete, the retention shred, the org purge).
// Vy's expansion of them is a separate run of the recorder's own Vy (apps/kernel member-vy-ports.ts) and lands in a Vy result the recorder copies into their draft, as the summary does.
// Audit rows carry the meeting id and a length, never the text.
import { NOTES_BODY_MAX, zMeetingRef, zNotes, zNotesSave, zNotesSaved, type Notes } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { sql } from 'kysely';
import { recorderMeeting } from './results.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const notesSave = defineCommand({
  name: 'meetings.notes.save',
  input: zNotesSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    await recorderMeeting(ctx, input.meetingId, 'write its notes');
    const body = input.body.trim();
    if (body === '') {
      await ctx.trx.deleteFrom('crove_meetings.meeting_note').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).execute();
      ctx.audit({ meetingId: input.meetingId, length: 0 });
      return zNotesSaved.parse({ meetingId: input.meetingId, saved: false });
    }
    if (body.length > NOTES_BODY_MAX) throw new DomainError('NOTES_TOO_LONG', 422, 'The notes are too long');
    // One row a meeting: a second save at the same moment waits on the first's row and then replaces it.
    await ctx.trx
      .insertInto('crove_meetings.meeting_note')
      .values({ org_id: ctx.orgId, meeting_id: input.meetingId, body })
      .onConflict((oc) => oc.columns(['org_id', 'meeting_id']).doUpdateSet({ body, updated_at: ctx.now }))
      .execute();
    ctx.audit({ meetingId: input.meetingId, length: body.length });
    return zNotesSaved.parse({ meetingId: input.meetingId, saved: true });
  },
});

// The recorder's own notes of the meeting; any other member is refused (the table shows them none either), and the read leaves an audit row naming the meeting.
export const notesGet = defineQuery({
  name: 'meetings.notes.get',
  input: zMeetingRef,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<Notes> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can read its notes');
    const row = await ctx.trx
      .selectFrom('crove_meetings.meeting_note')
      .select(['body', sql<string>`updated_at::text`.as('updated_at')])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();
    return zNotes.parse({ meetingId: input.meetingId, body: row?.body ?? '', updatedAt: row ? new Date(row.updated_at).toISOString() : null });
  },
});

export const notesCommands = [notesSave];
export const notesQueries = [notesGet];
