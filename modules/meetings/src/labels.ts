// SPDX-License-Identifier: AGPL-3.0-only
// Labels on a meeting (#4955, plan docs/plan/meetings.md L28): the recorder puts up to five short plain-text labels on a meeting, and the meetings list filters by them, so a business with no CRM data can group
// "everything about this client". A label is meant to hold no transcript text and no name of a person: the text is checked by code (`labelProblem`: no line break, no "@", no run of seven digits), but that is a first line only, and a label is personal data like a meeting title (#4964): the finder and the erasure reach it. Who may read, add
// and remove is decided by the row policies of ludy_meetings.meeting_label (user context only; the recorder and the readers read; the recorder adds and removes; nobody edits), and these commands check it again.
// A label goes with its meeting because the row cascades. At most five labels a meeting, counted under a lock on the meeting, and the same label twice (whatever the case) is one label. An audit row carries the
// meeting id and the label id, never the text.
import {
  LABEL_INDEX_LABELS_MAX,
  LABEL_INDEX_MEETINGS_MAX,
  MEETING_LABELS_MAX,
  cleanLabelText,
  labelKey,
  labelProblem,
  zLabelAdd,
  zLabelAdded,
  zLabelIndex,
  zLabelIndexInput,
  zLabelRemove,
  zLabelRemoved,
  zMeetingLabels,
  zMeetingRef,
  type LabelAdded,
  type LabelIndex,
  type LabelRemoved,
  type MeetingLabels,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { sql } from 'kysely';
import { vnDay } from './retention.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

const PROBLEM_TEXT = {
  empty: 'A label needs some text',
  too_long: 'A label is at most 40 characters',
  control: 'A label is one line of plain text',
  address: 'A label is not a place for an e-mail address',
  digits: 'A label is not a place for a phone number or an ID',
} as const;

export const labelAdd = defineCommand({
  name: 'meetings.label.add',
  input: zLabelAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<LabelAdded> => {
    const userId = userOf(ctx.actor);
    // 404 when the caller cannot read the meeting or its text period has ended; only the recorder labels it.
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the recorder can label a meeting');
    const problem = labelProblem(input.label);
    if (problem !== null) throw new DomainError('MEETING_LABEL_INVALID', 422, PROBLEM_TEXT[problem]);
    const label = cleanLabelText(input.label);
    // One recorder's adds to one meeting are one after the other, so two tabs cannot both pass the count below at four.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`label:${input.meetingId}`}, 0))`.execute(ctx.trx);
    const have = await ctx.trx
      .selectFrom('ludy_meetings.meeting_label')
      .select(['id', 'label'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .execute();
    const again = have.find((r) => labelKey(r.label) === labelKey(label));
    if (again) return zLabelAdded.parse({ meetingId: input.meetingId, labelId: again.id, label: again.label, created: false });
    if (have.length >= MEETING_LABELS_MAX) throw new DomainError('MEETING_LABEL_LIMIT', 422, `A meeting can have at most ${MEETING_LABELS_MAX} labels`);
    // The unique index on the lower-cased text is the last word on "the same label": a spelling the code's comparison misses (a rare case fold) still lands on it, and is answered as "already there", not as a failure.
    const row = await ctx.trx
      .insertInto('ludy_meetings.meeting_label')
      .values({ org_id: ctx.orgId, meeting_id: input.meetingId, label, created_by: userId })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) {
      const existing = await ctx.trx
        .selectFrom('ludy_meetings.meeting_label')
        .select(['id', 'label'])
        .where('org_id', '=', ctx.orgId)
        .where('meeting_id', '=', input.meetingId)
        .where(sql<boolean>`pg_catalog.lower(label) = pg_catalog.lower(${label})`)
        .executeTakeFirst();
      if (!existing) throw new DomainError('MEETING_LABEL_INVALID', 422, 'This text cannot be used as a label');
      return zLabelAdded.parse({ meetingId: input.meetingId, labelId: existing.id, label: existing.label, created: false });
    }
    ctx.audit({ meetingId: input.meetingId, labelId: row.id, created: true });
    return zLabelAdded.parse({ meetingId: input.meetingId, labelId: row.id, label, created: true });
  },
});

export const labelRemove = defineCommand({
  name: 'meetings.label.remove',
  input: zLabelRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<LabelRemoved> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const row = await ctx.trx
      .selectFrom('ludy_meetings.meeting_label')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('id', '=', input.labelId)
      .executeTakeFirst();
    // A label the caller cannot read is a label that is not there, whatever its id.
    if (!row) throw new DomainError('MEETING_LABEL_NOT_FOUND', 404, 'Label not found');
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the recorder can take a label off a meeting');
    await ctx.trx.deleteFrom('ludy_meetings.meeting_label').where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    ctx.audit({ meetingId: input.meetingId, labelId: row.id });
    return zLabelRemoved.parse({ meetingId: input.meetingId, labelId: row.id });
  },
});

// The labels of the meeting the caller may read (the table's row policy decides), in the order they were added. Not a sensitive read: a label is a short plain text that carries no transcript.
export const labelList = defineQuery({
  name: 'meetings.label.list',
  input: zMeetingRef,
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MeetingLabels> => {
    userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.meeting_label')
      .select(['id', 'label'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('created_at')
      .orderBy('id')
      .limit(MEETING_LABELS_MAX)
      .execute();
    return zMeetingLabels.parse({ meetingId: input.meetingId, labels: rows });
  },
});

// The labels across the meetings the caller may read: each distinct label with the number of meetings that carry it (the most used first), and the labels of each meeting, newest meeting first. Rows the caller
// cannot read are not there (the row policy), and a meeting past its text date is left out. Bounded: the 200 most used labels and the labels of the 500 most recent labelled meetings.
export const labelIndex = defineQuery({
  name: 'meetings.label.index',
  input: zLabelIndexInput,
  access: ROLES,
  handler: async (ctx): Promise<LabelIndex> => {
    userOf(ctx.actor);
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.meeting_label as l')
      .innerJoin('ludy_meetings.meeting as m', (join) => join.onRef('m.org_id', '=', 'l.org_id').onRef('m.id', '=', 'l.meeting_id'))
      .select(['l.meeting_id', 'l.label'])
      .where('l.org_id', '=', ctx.orgId)
      .where((eb) => eb.or([eb('m.text_retention_date', 'is', null), eb('m.text_retention_date', '>', vnDay(new Date()))]))
      .orderBy(sql`coalesce(m.started_at, m.created_at)`, 'desc')
      .orderBy('l.meeting_id')
      .orderBy('l.created_at')
      .orderBy('l.id')
      .limit(LABEL_INDEX_MEETINGS_MAX * MEETING_LABELS_MAX)
      .execute();
    const byMeeting = new Map<string, string[]>();
    for (const r of rows) {
      const list = byMeeting.get(r.meeting_id);
      if (list) list.push(r.label);
      else if (byMeeting.size < LABEL_INDEX_MEETINGS_MAX) byMeeting.set(r.meeting_id, [r.label]);
    }
    const counts = new Map<string, { label: string; count: number }>();
    for (const labels of byMeeting.values()) {
      for (const label of labels) {
        const key = labelKey(label);
        const seen = counts.get(key);
        if (seen) seen.count += 1;
        else counts.set(key, { label, count: 1 });
      }
    }
    const labels = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, LABEL_INDEX_LABELS_MAX);
    return zLabelIndex.parse({ labels, meetings: [...byMeeting].map(([meetingId, list]) => ({ meetingId, labels: list })) });
  },
});

export const labelsCommands = [labelAdd, labelRemove];
export const labelsQueries = [labelList, labelIndex];
