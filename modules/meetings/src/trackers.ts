// SPDX-License-Identifier: AGPL-3.0-only
// Keyword trackers across meetings (#4818, plan docs/plan/meetings.md L22). The contract is packages/kernel-contract/src/meeting-trackers.ts.
//
// meetings.tracker.add      an owner or admin adds a keyword or phrase (at most 20 an org, one row per term whatever the case)
// meetings.tracker.remove   deletes a term
// meetings.tracker.list     the terms, for every member of the org (a viewer must know the words to read a count)
// meetings.tracker.hits     for one meeting: each term that came up, how often and the seconds of the lines; read under the caller's own row security, so a reader counts the published lines and the
//                           recorder the draft (as the transcript panel shows it); sensitive (an audit row names the meeting)
// meetings.tracker.week     for a week: each term that came up in the meetings the caller reads, with the count and the meetings (title as the caller already reads it); sensitive
//
// Everything is counted by code in the caller's own transaction from lines the caller may read: nothing about a hit is stored, no meeting text is returned (only seconds, counts and titles), no model
// is called, and an owner or an admin has no extra right to read a meeting. The audit row of a command carries the term's id and the number of terms, never the word (it can be a competitor's name).
import { sql } from 'kysely';
import {
  TRACKER_SECONDS_MAX,
  TRACKER_TERMS_MAX,
  TRACKER_WEEK_LISTED_MAX,
  TRACKER_WEEK_MEETINGS_MAX,
  zTrackerAdd,
  zTrackerDone,
  zTrackerHits,
  zTrackerList,
  zTrackerMeetingInput,
  zTrackerRemove,
  zTrackerTerms,
  zTrackerWeek,
  zTrackerWeekInput,
  type TrackerHits,
  type TrackerTerms,
  type TrackerWeek,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { weekBounds } from './load.ts';
import { vnDay, vnDayStart } from './retention.ts';
import { countNeedle, needleOf, wordsOf } from './tracker-count.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

type Trx = QueryContext['trx'];

// The lines of a week or a meeting that a caller may read are read in one go; this is the most lines a week counts.
const WEEK_LINES_MAX = 60_000;

const notFound = () => new DomainError('TRACKER_TERM_NOT_FOUND', 404, 'Term not found');
const taken = () => new DomainError('TRACKER_TERM_TAKEN', 409, 'This word is already tracked');

async function requireOwnerOrAdmin(trx: Trx, orgId: string, userId: string): Promise<void> {
  const row = await trx.selectFrom('ludy_kernel.tenant_member').select('role').where('org_id', '=', orgId).where('user_id', '=', userId).executeTakeFirst();
  if (row?.role !== 'owner' && row?.role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Only an owner or admin chooses the tracked words');
}

function termTaken(error: unknown): never {
  if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') throw taken();
  throw error;
}

async function readTerms(trx: Trx, orgId: string): Promise<Array<{ id: string; term: string }>> {
  return trx.selectFrom('ludy_meetings.tracker_term').select(['id', 'term']).where('org_id', '=', orgId).orderBy(sql`pg_catalog.lower(term)`).orderBy('id').limit(TRACKER_TERMS_MAX).execute();
}

// The needles of the terms, and the terms that have one.
function needles(terms: ReadonlyArray<{ id: string; term: string }>): Array<{ id: string; term: string; needle: string }> {
  return terms.flatMap((t) => {
    const needle = needleOf(t.term);
    return needle === null ? [] : [{ ...t, needle }];
  });
}

// The lines that count in a meeting: the draft when the caller reads one (the recorder, as the transcript panel shows it), else the published lines.
function currentLines<T extends { stage: string }>(lines: readonly T[]): T[] {
  const draft = lines.some((l) => l.stage === 'draft');
  return lines.filter((l) => l.stage === (draft ? 'draft' : 'published'));
}

export const trackerAdd = defineCommand({
  name: 'meetings.tracker.add',
  input: zTrackerAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await requireOwnerOrAdmin(ctx.trx, ctx.orgId, userId);
    // Two adds at 19 terms would both pass the count: one add at a time per org keeps the cap.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`ludy.meetings.tracker:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    const have = await ctx.trx.selectFrom('ludy_meetings.tracker_term').select(sql<number>`pg_catalog.count(*)::int`.as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (have.n >= TRACKER_TERMS_MAX) throw new DomainError('TRACKER_MAX', 422, `An organization tracks at most ${TRACKER_TERMS_MAX} words; remove one first`);
    const row = await ctx.trx
      .insertInto('ludy_meetings.tracker_term')
      .values({ org_id: ctx.orgId, term: input.term, created_by: userId })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(termTaken);
    ctx.audit({ termId: row.id, termCount: have.n + 1 });
    return zTrackerDone.parse({ termId: row.id });
  },
});

export const trackerRemove = defineCommand({
  name: 'meetings.tracker.remove',
  input: zTrackerRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await requireOwnerOrAdmin(ctx.trx, ctx.orgId, userId);
    const gone = await ctx.trx.deleteFrom('ludy_meetings.tracker_term').where('org_id', '=', ctx.orgId).where('id', '=', input.termId).returning('id').executeTakeFirst();
    if (!gone) throw notFound();
    const left = await ctx.trx.selectFrom('ludy_meetings.tracker_term').select(sql<number>`pg_catalog.count(*)::int`.as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    ctx.audit({ termId: input.termId, termCount: left.n });
    return zTrackerDone.parse({ termId: input.termId });
  },
});

export const trackerList = defineQuery({
  name: 'meetings.tracker.list',
  input: zTrackerList,
  access: ROLES,
  handler: async (ctx): Promise<TrackerTerms> => {
    userOf(ctx.actor);
    return zTrackerTerms.parse({ terms: await readTerms(ctx.trx, ctx.orgId) });
  },
});

export const trackerHits = defineQuery({
  name: 'meetings.tracker.hits',
  input: zTrackerMeetingInput,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<TrackerHits> => {
    userOf(ctx.actor);
    // 404 when the caller cannot read the meeting or its text period has ended.
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const terms = await readTerms(ctx.trx, ctx.orgId);
    const tracked = needles(terms);
    if (tracked.length === 0) return zTrackerHits.parse({ meetingId: input.meetingId, tracked: terms.length, hits: [] });
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.transcript_segment')
      .select(['stage', 'text', sql<number>`pg_catalog.floor(start_seconds)::int`.as('second')])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('start_seconds')
      .orderBy('id')
      .limit(WEEK_LINES_MAX)
      .execute();
    const lines = currentLines(rows).map((r) => ({ second: r.second, words: wordsOf(r.text) }));
    const hits = tracked.flatMap((t) => {
      let count = 0;
      let distinct = 0;
      let previous: number | null = null;
      const seconds: number[] = [];
      for (const line of lines) {
        const n = countNeedle(line.words, t.needle);
        if (n === 0) continue;
        count += n;
        // The lines are in the order of the transcript, so lines of one second are next to each other.
        if (line.second !== previous) {
          distinct += 1;
          previous = line.second;
          if (seconds.length < TRACKER_SECONDS_MAX) seconds.push(line.second);
        }
      }
      return count === 0 ? [] : [{ id: t.id, term: t.term, count, seconds, more: distinct > seconds.length }];
    });
    return zTrackerHits.parse({ meetingId: input.meetingId, tracked: terms.length, hits });
  },
});

export const trackerWeek = defineQuery({
  name: 'meetings.tracker.week',
  input: zTrackerWeekInput,
  access: ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<TrackerWeek> => {
    userOf(ctx.actor);
    const now = new Date();
    const week = weekBounds(now, input.weeksBack);
    const terms = await readTerms(ctx.trx, ctx.orgId);
    const tracked = needles(terms);
    const empty = { weekStart: week.start, weekEnd: week.last, tracked: terms.length, meetings: 0, cut: false, terms: [] };
    if (tracked.length === 0) return zTrackerWeek.parse(empty);
    // A meeting whose text period has ended is gone for every reader (as in openMeeting); the nightly purge may not have run yet. The meetings are the ones the caller reads (row security).
    const today = vnDay(now);
    const meetings = await ctx.trx
      .selectFrom('ludy_meetings.meeting as m')
      .select(['m.id', 'm.title'])
      .where('m.org_id', '=', ctx.orgId)
      .where('m.started_at', 'is not', null)
      .where((eb) => eb.or([eb('m.text_retention_date', 'is', null), eb('m.text_retention_date', '>', today)]))
      .where('m.started_at', '>=', new Date(vnDayStart(week.start)))
      .where('m.started_at', '<', new Date(vnDayStart(week.end)))
      .orderBy('m.started_at')
      .orderBy('m.id')
      .limit(TRACKER_WEEK_MEETINGS_MAX + 1)
      .execute();
    const cut = meetings.length > TRACKER_WEEK_MEETINGS_MAX;
    const counted = meetings.slice(0, TRACKER_WEEK_MEETINGS_MAX);
    if (counted.length === 0) return zTrackerWeek.parse(empty);
    const lines = await ctx.trx
      .selectFrom('ludy_meetings.transcript_segment')
      .select(['meeting_id', 'stage', 'text'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', 'in', counted.map((m) => m.id))
      .limit(WEEK_LINES_MAX)
      .execute();
    const byMeeting = new Map<string, Array<{ stage: string; text: string }>>();
    for (const l of lines) (byMeeting.get(l.meeting_id) ?? byMeeting.set(l.meeting_id, []).get(l.meeting_id))?.push({ stage: l.stage, text: l.text });
    const perTerm = new Map<string, Array<{ meetingId: string; title: string; count: number }>>();
    for (const m of counted) {
      const words = currentLines(byMeeting.get(m.id) ?? []).map((l) => wordsOf(l.text));
      for (const t of tracked) {
        const count = words.reduce((sum, w) => sum + countNeedle(w, t.needle), 0);
        if (count > 0) (perTerm.get(t.id) ?? perTerm.set(t.id, []).get(t.id))?.push({ meetingId: m.id, title: m.title, count });
      }
    }
    const result = tracked.flatMap((t) => {
      const hit = perTerm.get(t.id);
      if (!hit) return [];
      const ranked = [...hit].sort((a, b) => b.count - a.count || (a.meetingId < b.meetingId ? -1 : 1));
      return [
        {
          id: t.id,
          term: t.term,
          count: hit.reduce((sum, h) => sum + h.count, 0),
          meetings: ranked.slice(0, TRACKER_WEEK_LISTED_MAX),
          moreMeetings: Math.max(0, ranked.length - TRACKER_WEEK_LISTED_MAX),
        },
      ];
    });
    result.sort((a, b) => b.count - a.count || (a.term.toLowerCase() < b.term.toLowerCase() ? -1 : 1));
    return zTrackerWeek.parse({ ...empty, meetings: counted.length, cut, terms: result });
  },
});

export const trackersCommands = [trackerAdd, trackerRemove];
export const trackersQueries = [trackerList, trackerHits, trackerWeek];
