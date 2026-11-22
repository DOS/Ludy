// SPDX-License-Identifier: AGPL-3.0-only
// Naming a speaker after one of the people in the meeting (#3502). The recorder's Vy may suggest which attendee a speaker label is (the summary run, read back by
// meetings.speaker.suggestions in summary.ts); what renames anything is this command, the recorder's own click, and it needs nothing of Vy's: the name must be one of the meeting's people
// (the recorder and the readers they added, by display name) and the label must still be on a draft line. This file never reads a member's private Vy result. The helpers
// below are shared with the suggestions query.
import { sql } from 'kysely';
import { TRANSCRIPT_SPEAKER_MAX, zSpeakerName, zSpeakerNamed } from '@ludy/kernel-contract';
import { DomainError, defineCommand, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { plainName } from './plain-name.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

// The people of a meeting a speaker may be named after (#3502): the recorder first, then the readers they added, by the display name the org knows them by (member_profiles answers for
// members only). A member with no display name has no name to offer, and an email address is never one.
export async function attendeeNames(ctx: CommandContext | QueryContext, meetingId: string, recorderId: string): Promise<Array<{ userId: string; name: string }>> {
  const readers = await ctx.trx.selectFrom('crove_meetings.meeting_reader').select('user_id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', meetingId).execute();
  const ids = [recorderId, ...readers.map((r) => r.user_id).filter((id) => id !== recorderId)];
  const { rows } = await sql<{ user_id: string; display_name: string | null }>`SELECT user_id, display_name FROM ludy_kernel.member_profiles(${ids}::uuid[])`.execute(ctx.trx);
  const names = new Map(rows.map((r) => [r.user_id, cleanName(r.display_name)]));
  return ids.flatMap((id) => {
    const name = names.get(id) ?? '';
    return name === '' ? [] : [{ userId: id, name }];
  });
}

// A display name as the summary run is told it and a speaker is named after it: one line, control and invisible characters turned into spaces, at most the label's 80 characters. The agent's own
// cleaning of the names it offers gives the same text, so what Vy suggests and what is compared here match; a name that is empty or too long is no name.
export function cleanName(raw: string | null | undefined): string {
  const name = (raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(name).length > TRANSCRIPT_SPEAKER_MAX ? '' : name;
}

// The distinct speaker labels the recorder's DRAFT lines carry now (a published line is never renamed here).
export async function draftLabels(ctx: CommandContext | QueryContext, meetingId: string): Promise<Set<string>> {
  const rows = await ctx.trx
    .selectFrom('crove_meetings.transcript_segment')
    .select('speaker_label')
    .distinct()
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'draft')
    .execute();
  return new Set(rows.map((r) => r.speaker_label));
}

// The recorder's click: every DRAFT line of the meeting that carries the label takes the attendee's name as its speaker, as a correction (the lines are marked corrected). The name must be
// one of the meeting's people and the label must still be on a draft line; nothing renames anyone without this click, a published line is never touched, and the audit names the meeting
// and a count, never a name.
export const speakerName = defineCommand({
  name: 'meetings.speaker.name',
  input: zSpeakerName,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can name its speakers');
    const people = await attendeeNames(ctx, input.meetingId, userId);
    if (!people.some((p) => p.name === input.name)) throw new DomainError('SPEAKER_NOT_ATTENDEE', 409, 'This name is not one of the people in the meeting');
    // Another speaker already has this name: the click would merge two speakers' lines under one label, which cannot be undone. A person who means it renames the lines by hand.
    const labels = await draftLabels(ctx, input.meetingId);
    if (!labels.has(input.label)) throw new DomainError('SPEAKER_LABEL_GONE', 409, 'No draft line has this speaker any more');
    if ([...labels].some((l) => l !== input.label && plainName(l) === plainName(input.name)) || plainName(input.label) === plainName(input.name)) {
      throw new DomainError('SPEAKER_NAME_TAKEN', 409, 'Another speaker of this meeting already has this name');
    }
    const renamed = await ctx.trx
      .updateTable('crove_meetings.transcript_segment')
      .set({ speaker_label: input.name, corrected: true, updated_at: sql<Date>`pg_catalog.now()` })
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('stage', '=', 'draft')
      .where('speaker_label', '=', input.label)
      .returning('id')
      .execute();
    if (renamed.length === 0) throw new DomainError('SPEAKER_LABEL_GONE', 409, 'No draft line has this speaker any more');
    ctx.audit({ meetingId: input.meetingId, lines: renamed.length });
    return zSpeakerNamed.parse({ meetingId: input.meetingId, label: input.label, name: input.name, lines: renamed.length });
  },
});

export const speakerCommands = [speakerName];
