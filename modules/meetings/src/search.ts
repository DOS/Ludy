// SPDX-License-Identifier: AGPL-3.0-only
// Search across the transcript lines the caller reads (#2589, ADR-0047 point 2, meetings plan L2). A plain text search: no model call, no AI meter, and it works with
// AI off. The typed words are folded in SQL the way every line was folded when it was stored (ludy_kernel.search_fold: lower case, Vietnamese marks and đ removed), so
// "chiet khau" finds "chiết khấu". Which lines are found is decided twice. First by ludy_meetings.search_segment_ids (migration 20261226000000, restated by 20270117140000 and, for the one stage of the recorder, 20270326240000), a definer that finds the
// hits by the index and keeps the ones the caller reads (the recorder: one stage of their own meeting, their working draft while a draft line exists in it and the published lines otherwise (#4940); any other reader: published lines of a meeting they read; an owner
// or admin who is no reader finds nothing; a meeting past its text date is left out) and answers ids only. Then this query reads those ids under row security, which decides
// again for every row it returns. The audit row of a sensitive read hashes the typed words, so no query text lands in the audit log.
import { sql } from 'kysely';
import {
  MEETING_SEARCH_HITS_MAX,
  cleanLabelText,
  zMeetingSearchInput,
  type MeetingSearchHit,
  type MeetingSearchResult,
  type TranscriptStage,
} from '@ludy/kernel-contract';
import { defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { vnDay } from './retention.ts';
import { ROLES, userOf } from './transcript.ts';

type Trx = QueryContext['trx'];

/**
 * The hits of one page of the search, for the caller's own transaction: `size + 1` ids from the definer (which keeps the lines the caller reads), then those rows read under row security, which
 * decides again for every row. A line a row-security policy hides, or one of a meeting past its text date, is simply not there. Shared by the search and by the question box (A3, #3161), so both
 * see exactly the same lines and no other door to a meeting's text exists.
 */
export async function findSearchHits(trx: Trx, orgId: string, q: string, size: number, offset: number): Promise<{ hits: MeetingSearchHit[]; hasMore: boolean }> {
  const found = await sql<{ id: string }>`SELECT id FROM ludy_meetings.search_segment_ids(${q}, ${size + 1}, ${offset})`.execute(trx);
  const ids = found.rows.map((r) => r.id);
  if (ids.length === 0) return { hits: [], hasMore: false };
  const hits = await readHits(trx, orgId, ids.slice(0, size), null);
  return { hits, hasMore: ids.length > size };
}

/**
 * The rows of the given segment ids, in the order of the ids, read under the caller's row security (#4965: with a label, only the lines of the meetings that carry it, the label being read under its own
 * row policy too, so a label the caller cannot read matches nothing). A row row security hides, or one of a meeting past its text date, is simply not there: the answer for it is the answer for no match.
 */
async function readHits(trx: Trx, orgId: string, ids: readonly string[], label: string | null): Promise<MeetingSearchHit[]> {
  if (ids.length === 0) return [];
  let query = trx
    .selectFrom('ludy_meetings.transcript_segment as s')
    .innerJoin('ludy_meetings.meeting as m', (join) => join.onRef('m.org_id', '=', 's.org_id').onRef('m.id', '=', 's.meeting_id'))
    .select([
      's.id as segment_id',
      's.meeting_id',
      's.speaker_label',
      's.text',
      's.stage',
      sql<string>`s.start_seconds::text`.as('start_seconds'),
      'm.title',
      sql<string>`COALESCE(m.started_at, m.created_at)`.as('held_at'),
    ])
    .where('s.org_id', '=', orgId)
    .where('s.id', 'in', ids)
    .where((eb) => eb.or([eb('m.text_retention_date', 'is', null), eb('m.text_retention_date', '>', vnDay(new Date()))]));
  if (label !== null) {
    // One label of a meeting matches by its lower-cased text (the table's unique index is on it), so a segment joins at most one label row.
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('ludy_meetings.meeting_label as l')
          .select('l.id')
          .whereRef('l.org_id', '=', 's.org_id')
          .whereRef('l.meeting_id', '=', 's.meeting_id')
          .where(sql<boolean>`pg_catalog.lower(l.label) = pg_catalog.lower(${label})`),
      ),
    );
  }
  const rows = await query.execute();
  const byId = new Map(rows.map((r) => [r.segment_id, r]));
  const hits: MeetingSearchHit[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    hits.push({
      meetingId: r.meeting_id,
      meetingTitle: r.title,
      heldAt: new Date(r.held_at).toISOString(),
      segmentId: r.segment_id,
      startSeconds: Number(r.start_seconds),
      speakerLabel: r.speaker_label,
      text: r.text,
      stage: r.stage as TranscriptStage,
    });
  }
  return hits;
}

// The definer answers a page of at most 51 ids from an offset of at most 200 (migration 20261226000000), and at most MEETING_SEARCH_HITS_MAX hits can be paged.
const DEFINER_PAGE = 51;

/**
 * The hits of one page of the search restricted to the meetings that carry a label (#4965), with no change to the definer: the ids of the hits the search can reach (the first MEETING_SEARCH_HITS_MAX, in
 * its order) are asked of the definer page by page, read under row security joined to the label, and the filtered list is paged here. The answer is exact within those reachable hits: `capped` (on the last page)
 * says there were more hits than that, which may hold more lines of the labelled meetings than the list shows.
 */
async function findLabelledSearchHits(
  trx: Trx,
  orgId: string,
  q: string,
  label: string,
  size: number,
  offset: number,
): Promise<{ hits: MeetingSearchHit[]; hasMore: boolean; capped: boolean }> {
  const ids: string[] = [];
  for (let at = 0; at <= MEETING_SEARCH_HITS_MAX; at += DEFINER_PAGE) {
    const found = await sql<{ id: string }>`SELECT id FROM ludy_meetings.search_segment_ids(${q}, ${DEFINER_PAGE}, ${at})`.execute(trx);
    ids.push(...found.rows.map((r) => r.id));
    if (found.rows.length < DEFINER_PAGE) break;
  }
  const reachable = ids.slice(0, MEETING_SEARCH_HITS_MAX);
  const hits = await readHits(trx, orgId, reachable, label);
  const hasMore = hits.length > offset + size;
  // Like the unlabelled search, `capped` is said on the last page the filtered list can give (the client stops paging on it), and only when the search had more hits than it can reach.
  return { hits: hits.slice(offset, offset + size), hasMore, capped: !hasMore && ids.length > MEETING_SEARCH_HITS_MAX };
}

export const meetingSearch = defineQuery({
  name: 'meetings.search',
  input: zMeetingSearchInput,
  access: ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<MeetingSearchResult> => {
    userOf(ctx.actor);
    // At most MEETING_SEARCH_HITS_MAX hits can be paged: a page ends there, and `capped` says there were more.
    const size = Math.min(input.limit, MEETING_SEARCH_HITS_MAX - input.offset);
    if (size < 1) return { hits: [], hasMore: false, capped: true };
    if (input.label !== undefined) {
      // A label that cleans to nothing matches no meeting: no hits, never the unfiltered search (the contract's trim keeps this from happening today; it is here so a change there cannot widen the search).
      const label = cleanLabelText(input.label);
      if (label === '') return { hits: [], hasMore: false, capped: false };
      // With a label (#4965) the page is made of the lines of the labelled meetings, from the hits the search can reach.
      const found = await findLabelledSearchHits(ctx.trx, ctx.orgId, input.q, label, size, input.offset);
      return { hits: found.hits, hasMore: found.hasMore, capped: found.capped };
    }
    const { hits, hasMore } = await findSearchHits(ctx.trx, ctx.orgId, input.q, size, input.offset);
    return { hits, hasMore, capped: hasMore && input.offset + size >= MEETING_SEARCH_HITS_MAX };
  },
});
