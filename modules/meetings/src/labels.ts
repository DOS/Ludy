// SPDX-License-Identifier: AGPL-3.0-only
// Labels on a meeting (#4955, plan docs/plan/meetings.md L28): the recorder puts up to five short plain-text labels on a meeting, and the meetings list filters by them, so a business with no CRM data can group
// "everything about this client". A label is meant to hold no transcript text and no name of a person: the text is checked by code (`labelProblem`: no line break, no "@", no run of seven digits), but that is a first line only, and a label is personal data like a meeting title (#4964): the finder and the erasure reach it. Who may read, add
// and remove is decided by the row policies of ludy_meetings.meeting_label (user context only; the recorder and the readers read; the recorder adds and removes; nobody edits), and these commands check it again.
// A label goes with its meeting because the row cascades. At most five labels a meeting, counted under a transaction advisory lock keyed on the meeting (`label:<meeting id>`; not a lock on the meeting row, and the comment of 20270326270000, an applied file, says "a lock on the meeting" loosely), and the same label twice (whatever the case) is one label. An audit row carries the
// meeting id and the label id, never the text.
import {
  MEETING_LABELS_MAX,
  cleanLabelText,
  labelKey,
  labelProblem,
  zLabelAdd,
  zLabelAdded,
  zLabelRemove,
  zLabelRemoved,
  zMeetingLabels,
  zMeetingLabelsInUse,
  zMeetingLabelsInUseInput,
  zMeetingRef,
  type LabelAdded,
  type LabelRemoved,
  type MeetingLabels,
  type MeetingLabelsInUse,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
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

// The labels of the given meetings, by meeting id, in the order they were added (#4966): one read for a page of meetings, so the meetings list answers with each row's labels and no read per meeting. Under
// the caller's own row security (the recorder and the readers of a meeting read its labels), so a meeting the caller cannot read has none here. At most five a meeting (the table's rule, checked on add).
export async function labelsOfMeetings(trx: QueryContext['trx'], orgId: string, meetingIds: readonly string[]): Promise<Map<string, string[]>> {
  const byMeeting = new Map<string, string[]>();
  if (meetingIds.length === 0) return byMeeting;
  const rows = await trx
    .selectFrom('ludy_meetings.meeting_label')
    .select(['meeting_id', 'label'])
    .where('org_id', '=', orgId)
    .where('meeting_id', 'in', meetingIds)
    .orderBy('meeting_id')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  for (const r of rows) {
    const list = byMeeting.get(r.meeting_id);
    if (list) list.push(r.label);
    else byMeeting.set(r.meeting_id, [r.label]);
  }
  return byMeeting;
}

// Most recent readable non-expired meetings scanned when collecting labels in use (matches the former meeting.list(200) window; #5039).
const LABEL_IN_USE_MEETINGS_MAX = 200;

// Distinct labels in use on the most recent non-expired meetings the caller can read, most used first (#5039):
// one grouped read under the caller's own row security (meeting and meeting_label RLS) instead of listing 200 full meeting rows.
export const labelInUse = defineQuery({
  name: 'meetings.label.in_use',
  input: zMeetingLabelsInUseInput,
  access: ROLES,
  handler: async (ctx, input): Promise<MeetingLabelsInUse> => {
    userOf(ctx.actor);
    const today = vnDay(new Date());
    const { rows } = await sql<{ label: string; uses: number; first_ord: number }>`
      WITH recent AS (
        SELECT
          m.id,
          pg_catalog.row_number() OVER (ORDER BY m.started_at DESC, m.id DESC) AS meeting_ord
        FROM ludy_meetings.meeting m
        WHERE m.org_id = ${ctx.orgId}::uuid
          AND (m.text_retention_date IS NULL OR m.text_retention_date > ${today}::date)
        ORDER BY m.started_at DESC, m.id DESC
        LIMIT ${LABEL_IN_USE_MEETINGS_MAX}::int
      ),
      seen AS (
        SELECT
          l.label,
          pg_catalog.row_number() OVER (ORDER BY r.meeting_ord ASC, l.created_at ASC, l.id ASC) AS first_ord
        FROM recent r
        INNER JOIN ludy_meetings.meeting_label l
          ON l.org_id = ${ctx.orgId}::uuid AND l.meeting_id = r.id
      )
      SELECT
        s.label,
        pg_catalog.count(*)::int AS uses,
        pg_catalog.min(s.first_ord)::int AS first_ord
      FROM seen s
      GROUP BY s.label`.execute(ctx.trx);
    // Fold case variants in JS with labelKey() so every PostgreSQL locale (C, C.UTF-8, en_US, tr_TR) groups identically
    // to labelsInUse(), keeping the earliest-seen spelling and appearance order.
    const byKey = new Map<string, { label: string; count: number; firstOrd: number }>();
    for (const r of rows) {
      const key = labelKey(r.label);
      const seen = byKey.get(key);
      if (!seen) {
        byKey.set(key, { label: r.label, count: r.uses, firstOrd: r.first_ord });
      } else {
        seen.count += r.uses;
        if (r.first_ord < seen.firstOrd) {
          seen.firstOrd = r.first_ord;
          seen.label = r.label;
        }
      }
    }
    const labels = [...byKey.values()]
      .sort((a, b) => b.count - a.count || a.firstOrd - b.firstOrd)
      .slice(0, input.limit)
      .map(({ label, count }) => ({ label, count }));
    return zMeetingLabelsInUse.parse({ labels });
  },
});

export const labelsCommands = [labelAdd, labelRemove];
export const labelsQueries = [labelList, labelInUse];
