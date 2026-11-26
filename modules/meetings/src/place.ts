// SPDX-License-Identifier: AGPL-3.0-only
// The place of a meeting (#5013, refs #3162): one line the recorder sets once, printed on the biên bản ("Địa điểm"). An ordinary command of the recorder, the way a rename is: the recorder
// only (the table's UPDATE policy admits the recorder alone too), cleaned the way a title is (control, bidi, zero-width and separator characters out, spaces folded, one line) and kept to 1 to
// 200 characters (code points, as the database counts them); text that is empty once cleaned, or null, clears the place. Readers see it where they see the title (the meeting's own read). It is never given to a model (no Vy feature
// reads it) and the audit row holds the meeting's id only: never the old or the new place.
import { MEETING_PLACE_MAX, cleanTemplateText, zMeetingPlaceSet, zMeetingSetPlace } from '@ludy/kernel-contract';
import { DomainError, defineCommand } from '@ludy/kernel-runtime';
import { sql } from 'kysely';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const meetingSetPlace = defineCommand({
  name: 'meetings.meeting.set_place',
  input: zMeetingSetPlace,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can set its place');
    const cleaned = input.place === null ? '' : cleanTemplateText(input.place);
    if ([...cleaned].length > MEETING_PLACE_MAX) throw new DomainError('MEETING_PLACE_TOO_LONG', 422, 'A meeting place holds at most 200 characters');
    const place = cleaned === '' ? null : cleaned;
    await ctx.trx
      .updateTable('ludy_meetings.meeting')
      .set({ place, updated_at: sql<Date>`pg_catalog.now()` })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .execute();
    ctx.audit({ meetingId: input.meetingId });
    return zMeetingPlaceSet.parse({ meetingId: input.meetingId, place });
  },
});

export const placeCommands = [meetingSetPlace];
