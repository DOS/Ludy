// SPDX-License-Identifier: AGPL-3.0-only
// Search across the transcript lines the caller reads (#2589, ADR-0047 point 2, meetings plan L2). A plain text search: no model call, no AI meter, and it works with
// AI off. The typed words are folded in SQL the way every line was folded when it was stored (crove_kernel.search_fold: lower case, Vietnamese marks and đ removed), so
// "chiet khau" finds "chiết khấu". Which lines are found is decided twice. First by crove_meetings.search_segment_ids (migration 20261226000000), a definer that finds the
// hits by the index and keeps the ones the caller reads (the recorder: every stage of their own meeting; any other reader: published lines of a meeting they read; an owner
// or admin who is no reader finds nothing; a meeting past its text date is left out) and answers ids only. Then this query reads those ids under row security, which decides
// again for every row it returns. The audit row of a sensitive read hashes the typed words, so no query text lands in the audit log.
import { sql } from 'kysely';
import {
  MEETING_SEARCH_HITS_MAX,
  zMeetingSearchInput,
  type MeetingSearchHit,
  type MeetingSearchResult,
  type TranscriptStage,
} from '@crove/kernel-contract';
import { defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { vnDay } from './retention.ts';
import { ROLES, userOf } from './transcript.ts';

type Trx = QueryContext['trx'];

/**
 * The hits of one page of the search, for the caller's own transaction: `size + 1` ids from the definer (which keeps the lines the caller reads), then those rows read under row security, which
 * decides again for every row. A line a row-security policy hides, or one of a meeting past its text date, is simply not there. Shared by the search and by the question box (A3, #3161), so both
 * see exactly the same lines and no other door to a meeting's text exists.
 */
export async function findSearchHits(trx: Trx, orgId: string, q: string, size: number, offset: number): Promise<{ hits: MeetingSearchHit[]; hasMore: boolean }> {
  const found = await sql<{ id: string }>`SELECT id FROM crove_meetings.search_segment_ids(${q}, ${size + 1}, ${offset})`.execute(trx);
  const ids = found.rows.map((r) => r.id);
  if (ids.length === 0) return { hits: [], hasMore: false };
  const rows = await trx
    .selectFrom('crove_meetings.transcript_segment as s')
    .innerJoin('crove_meetings.meeting as m', (join) => join.onRef('m.org_id', '=', 's.org_id').onRef('m.id', '=', 's.meeting_id'))
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
    .where((eb) => eb.or([eb('m.text_retention_date', 'is', null), eb('m.text_retention_date', '>', vnDay(new Date()))]))
    .execute();
  const byId = new Map(rows.map((r) => [r.segment_id, r]));
  const hits: MeetingSearchHit[] = [];
  for (const id of ids.slice(0, size)) {
    const r = byId.get(id);
    // A row row security hides from the caller is simply not there: the answer for it is the answer for no match.
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
  return { hits, hasMore: ids.length > size };
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
    const { hits, hasMore } = await findSearchHits(ctx.trx, ctx.orgId, input.q, size, input.offset);
    return { hits, hasMore, capped: hasMore && input.offset + size >= MEETING_SEARCH_HITS_MAX };
  },
});
