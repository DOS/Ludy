// SPDX-License-Identifier: AGPL-3.0-only
// The week's meeting load for an owner or an admin (#4770, plan docs/plan/meetings.md L16): how many meetings and minutes each member spent in a week, and the recurring series that may be worth trimming.
//
// meetings.load.week   for a week (this one, or up to 12 back; Monday to Sunday, Vietnam time): per member the meetings they were in (as the recorder, or a reader the recorder added) and the minutes those
//                      took (an overlap counted once), most first; and the series (the meetings of one recurring event, see series.ts) with at least 3 meetings in the last 8 weeks (the last day left out: its minutes may not be out yet) and at least one signal
//                      code decides from fixed numbers: nobody but the recorder in half of them or more (only an attendees-only meeting can be told so: an org-wide one is read by everyone and has no reader rows), published minutes in fewer than half, open published items piling up (3 or more in each of the last two).
//
// Everything is read in the caller's own transaction, so the row security every member has applies to an owner and an admin as well: a meeting the caller is no reader of is not counted, not even that it exists (an
// owner's compliance list, meetings.meeting.owner_list, is metadata for deleting a meeting and shows no reader or length). Attendance is only what Ludy knows, the recorder and the readers the recorder added to an
// attendees-only meeting; for an org-wide meeting only the recorder is counted, and who joined the call is not known. A meeting with no length (not recorded, or not ended) and one past its text date (gone for every reader) count for nothing. A series is told by its latest meeting's title and id,
// which a reader of that meeting already has; no transcript, summary, decision or item text is read into the answer. No model call, nothing stored; the read is a sensitive one, so it leaves an audit row (who asked, a hash of the input) before it runs.
import {
  LOAD_ITEMS_PILING,
  LOAD_SERIES_MAX,
  LOAD_SERIES_MIN_MEETINGS,
  LOAD_SERIES_WEEKS,
  zLoadWeek,
  zLoadWeekInput,
  type LoadMember,
  type LoadSeries,
  type LoadSignal,
  type LoadWeek,
} from '@ludy/kernel-contract';
import { defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { vnDay, vnDayStart } from './retention.ts';
import { openItemsOf } from './series.ts';
import { occupiedMinutes } from './today.ts';
import { userOf } from './transcript.ts';

type Trx = QueryContext['trx'];

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
// Most rows read for the week and for the series window: a safety cap, far above what a small business records.
const WEEK_ROWS_MAX = 5_000;
const SERIES_ROWS_MAX = 2_000;
// Most series looked at (each takes two reads of open items), the ones with most meetings first.
const SERIES_LOOKED_AT_MAX = 30;

/** A held meeting, as the figures need it. */
export interface HeldMeeting {
  id: string;
  recorderUserId: string;
  startedAt: Date;
  // How long it ran, in seconds; null when nothing says (never ended, no length).
  seconds: number | null;
}

/** The length of a meeting in seconds: the recorded length, else the end minus the start; null when neither exists or it is not positive. */
export function lengthSeconds(row: { started_at: Date | string | null; ended_at: Date | string | null; length_seconds: number | null }): number | null {
  if (row.length_seconds !== null && row.length_seconds > 0) return row.length_seconds;
  if (row.started_at === null || row.ended_at === null) return null;
  const seconds = Math.round((new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 1000);
  return seconds > 0 ? seconds : null;
}

/** The week a `weeksBack` count names, as Vietnam calendar days: the Monday, the Sunday and the Monday after (exclusive end). */
export function weekBounds(now: Date, weeksBack: number): { start: string; last: string; end: string } {
  const today = Date.parse(`${vnDay(now)}T00:00:00Z`);
  const sinceMonday = (new Date(today).getUTCDay() + 6) % WEEK_DAYS;
  const start = today - (sinceMonday + weeksBack * WEEK_DAYS) * DAY_MS;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: day(start), last: day(start + (WEEK_DAYS - 1) * DAY_MS), end: day(start + WEEK_DAYS * DAY_MS) };
}

/**
 * Each person's week: the meetings they were in (the recorder, and the readers the recorder added) and the minutes those took, an overlap counted once. A meeting with no length counts for nothing. Most minutes
 * first, then by id. Pure.
 */
export function memberFigures(meetings: readonly HeldMeeting[], readersOf: ReadonlyMap<string, readonly string[]>): LoadMember[] {
  const byMember = new Map<string, Array<{ startsAt: string; endsAt: string }>>();
  for (const meeting of meetings) {
    if (meeting.seconds === null || meeting.seconds <= 0) continue;
    const span = { startsAt: meeting.startedAt.toISOString(), endsAt: new Date(meeting.startedAt.getTime() + meeting.seconds * 1000).toISOString() };
    for (const userId of new Set([meeting.recorderUserId, ...(readersOf.get(meeting.id) ?? [])])) {
      const spans = byMember.get(userId);
      if (spans) spans.push(span);
      else byMember.set(userId, [span]);
    }
  }
  return [...byMember]
    .map(([userId, spans]): LoadMember => ({ userId, meetings: spans.length, minutes: occupiedMinutes(spans) }))
    .sort((a, b) => b.minutes - a.minutes || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/** A meeting of a series, as the signals need it. */
export interface SeriesMeeting extends HeldMeeting {
  title: string;
  // An org-wide meeting is read by everyone, so it has no reader rows and who attended is unknown: it never counts as one the recorder sat alone in.
  orgWide: boolean;
  // Readers the recorder added to an attendees-only meeting (the recorder is not counted).
  readers: number;
  // Whether anything is published for it: a summary, a decision or an action item.
  published: boolean;
}

/**
 * What the signals say about one series, or null when there are too few meetings or no signal. `openLatestTwo` is the number of open published items of its last two meetings, latest first. Pure.
 */
export function assessSeries(seriesId: string, meetings: readonly SeriesMeeting[], openLatestTwo: readonly [number, number]): LoadSeries | null {
  if (meetings.length < LOAD_SERIES_MIN_MEETINGS) return null;
  const latest = [...meetings].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : -1))[0];
  if (!latest) return null;
  const soloMeetings = meetings.filter((m) => !m.orgWide && m.readers === 0).length;
  const withMinutes = meetings.filter((m) => m.published).length;
  const signals: LoadSignal[] = [];
  if (soloMeetings * 2 >= meetings.length) signals.push('few_people');
  if (withMinutes * 2 < meetings.length) signals.push('no_minutes');
  if (openLatestTwo[0] >= LOAD_ITEMS_PILING && openLatestTwo[1] >= LOAD_ITEMS_PILING) signals.push('items_piling');
  if (signals.length === 0) return null;
  const lengths = meetings.flatMap((m) => (m.seconds !== null && m.seconds > 0 ? [m.seconds] : []));
  const averageMinutes = lengths.length === 0 ? 0 : Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length / 60);
  return {
    seriesId,
    latestMeetingId: latest.id,
    title: latest.title,
    meetings: meetings.length,
    averageMinutes,
    soloMeetings,
    withMinutes,
    openItems: [openLatestTwo[0], openLatestTwo[1]],
    signals,
  };
}

// The readers of each meeting among `ids`, read under the caller's own row security (a reader row of a meeting the caller does not read is not there).
async function readersByMeeting(trx: Trx, orgId: string, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await trx.selectFrom('ludy_meetings.meeting_reader').select(['meeting_id', 'user_id']).where('org_id', '=', orgId).where('meeting_id', 'in', ids).execute();
  for (const row of rows) {
    const list = out.get(row.meeting_id);
    if (list) list.push(row.user_id);
    else out.set(row.meeting_id, [row.user_id]);
  }
  return out;
}

export const loadWeek = defineQuery({
  name: 'meetings.load.week',
  input: zLoadWeekInput,
  access: ['owner', 'admin'],
  sensitive: true,
  handler: async (ctx, input): Promise<LoadWeek> => {
    userOf(ctx.actor);
    const now = new Date();
    const week = weekBounds(now, input.weeksBack);
    // A meeting whose text period has ended is gone for every reader (as in openMeeting); the nightly purge may not have run yet.
    const today = vnDay(now);
    const base = () =>
      ctx.trx
        .selectFrom('ludy_meetings.meeting as m')
        .select(['m.id', 'm.recorder_user_id', 'm.title', 'm.visibility', 'm.series_id', 'm.started_at', 'm.ended_at', 'm.length_seconds'])
        .where('m.org_id', '=', ctx.orgId)
        .where('m.started_at', 'is not', null)
        .where((eb) => eb.or([eb('m.text_retention_date', 'is', null), eb('m.text_retention_date', '>', today)]));
    const held = (row: { id: string; recorder_user_id: string; started_at: Date | string | null; ended_at: Date | string | null; length_seconds: number | null }): HeldMeeting => ({
      id: row.id,
      recorderUserId: row.recorder_user_id,
      startedAt: new Date(row.started_at as Date | string),
      seconds: lengthSeconds(row),
    });

    const weekRows = await base()
      .where('m.started_at', '>=', new Date(vnDayStart(week.start)))
      .where('m.started_at', '<', new Date(vnDayStart(week.end)))
      .orderBy('m.started_at')
      .orderBy('m.id')
      .limit(WEEK_ROWS_MAX)
      .execute();
    const seriesRows = await base()
      .where('m.series_id', 'is not', null)
      .where('m.started_at', '>=', new Date(now.getTime() - LOAD_SERIES_WEEKS * WEEK_DAYS * DAY_MS))
      .where('m.started_at', '<=', new Date(now.getTime() - DAY_MS))
      .orderBy('m.started_at', 'desc')
      .orderBy('m.id')
      .limit(SERIES_ROWS_MAX)
      .execute();

    // The series with enough meetings, the ones with most meetings first.
    const bySeries = new Map<string, typeof seriesRows>();
    for (const row of seriesRows) {
      if (row.series_id === null) continue;
      const list = bySeries.get(row.series_id);
      if (list) list.push(row);
      else bySeries.set(row.series_id, [row]);
    }
    const candidates = [...bySeries]
      .filter(([, rows]) => rows.length >= LOAD_SERIES_MIN_MEETINGS)
      .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
      .slice(0, SERIES_LOOKED_AT_MAX);
    const seriesIds = candidates.flatMap(([, rows]) => rows.map((r) => r.id));

    const readers = await readersByMeeting(ctx.trx, ctx.orgId, [...new Set([...weekRows.map((r) => r.id), ...seriesIds])]);
    const published = new Set<string>();
    if (seriesIds.length > 0) {
      const results = await ctx.trx.selectFrom('ludy_meetings.meeting_result').select('meeting_id').distinct().where('org_id', '=', ctx.orgId).where('stage', '=', 'published').where('meeting_id', 'in', seriesIds).execute();
      const items = await ctx.trx.selectFrom('ludy_meetings.action_item').select('meeting_id').distinct().where('org_id', '=', ctx.orgId).where('stage', '=', 'published').where('meeting_id', 'in', seriesIds).execute();
      for (const r of [...results, ...items]) published.add(r.meeting_id);
    }

    const weekMeetings = weekRows.map(held);
    const members = memberFigures(weekMeetings, readers);
    const series: LoadSeries[] = [];
    for (const [seriesId, rows] of candidates) {
      const meetings: SeriesMeeting[] = rows.map((row) => ({ ...held(row), title: row.title, orgWide: row.visibility === 'org', readers: new Set(readers.get(row.id) ?? []).size, published: published.has(row.id) }));
      const [first, second] = [...meetings].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : -1));
      const open: [number, number] = [first ? (await openItemsOf(ctx.trx, ctx.orgId, first.id)).length : 0, second ? (await openItemsOf(ctx.trx, ctx.orgId, second.id)).length : 0];
      const assessed = assessSeries(seriesId, meetings, open);
      if (assessed) series.push(assessed);
    }
    series.sort((a, b) => b.signals.length - a.signals.length || b.meetings - a.meetings || (a.seriesId < b.seriesId ? -1 : 1));
    const listed = series.slice(0, LOAD_SERIES_MAX);

    return zLoadWeek.parse({
      weeksBack: input.weeksBack,
      weekStart: week.start,
      weekEnd: week.last,
      meetings: weekMeetings.filter((m) => m.seconds !== null).length,
      personMinutes: members.reduce((sum, m) => sum + m.minutes, 0),
      members,
      series: listed,
      seriesCut: series.length > LOAD_SERIES_MAX,
    });
  },
});

export const loadQueries = [loadWeek];
