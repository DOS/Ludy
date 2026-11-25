// SPDX-License-Identifier: AGPL-3.0-only
// Highlights on a transcript line or range (#4819, plan docs/plan/meetings.md L21): the recorder of a meeting or a reader of it marks a line, or a run of lines, and the meeting's readers see the
// mark on the meeting page. A highlight is an anchor (the start second of the first and of the last line) and the member who made it; it holds no text, so what a reader sees under it is the
// transcript they read now (a redacted line shows redacted, a line the recorder replaced shows what is there now), and the marks go with the meeting (the text retention shred, a delete, the org
// purge) because the row cascades. Who may read, add and remove is decided by the row policies of ludy_meetings.meeting_highlight (user context only; the recorder and the readers read and add for
// themselves; the author or the recorder removes; nobody edits), and these commands check it again. Each anchor must be the start second of a published line (a reader reads published lines only, and a mark on the recorder's
// draft would tell them where it is). One member has at most 50 marks in a meeting, and marking the same range twice is one mark. An audit row carries the meeting id and the two seconds, never a line.
import {
  HIGHLIGHTS_PER_MEMBER_MAX,
  zHighlightAdd,
  zHighlightAdded,
  zHighlightRemove,
  zHighlightRemoved,
  zHighlights,
  zMeetingRef,
  type Highlight,
  type HighlightAdded,
  type HighlightRemoved,
  type Highlights,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { sql } from 'kysely';
import { cleanName } from './speaker.ts';
import { ROLES, lockPublishedLines, openMeeting, userOf } from './transcript.ts';

export const highlightAdd = defineCommand({
  name: 'meetings.highlight.add',
  input: zHighlightAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<HighlightAdded> => {
    const userId = userOf(ctx.actor);
    // 404 when the caller cannot read the meeting or its text period has ended.
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const base = () =>
      ctx.trx.selectFrom('ludy_meetings.meeting_highlight').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('created_by', '=', userId);
    const mine = () => base().select(['id', 'start_seconds', 'end_seconds']);
    const again = await mine().where('start_seconds', '=', input.startSeconds).where('end_seconds', '=', input.endSeconds).executeTakeFirst();
    if (again) return zHighlightAdded.parse({ meetingId: input.meetingId, highlightId: again.id, created: false });
    // The published lines are held steady while they are read: a publish that replaces them waits for this transaction, or has finished and the lines read below are its new ones (#4971). The meeting row
    // itself cannot be locked here (a reader may add, and only the recorder may update the row), so the lock is the advisory one the publish takes too.
    await lockPublishedLines(ctx.trx, ctx.orgId, input.meetingId, 'read');
    // Both ends must be the start (to the whole second) of a PUBLISHED line: the readers of the meeting read published lines only, so a mark on a draft line would tell them where the recorder's draft
    // lines are, and a re-transcription would leave it pointing at nothing. The transcript's row security still decides which lines the caller reads.
    const found = await sql<{ second: number }>`
      SELECT DISTINCT pg_catalog.floor(s.start_seconds)::int AS second
        FROM ludy_meetings.transcript_segment s
       WHERE s.org_id = ${ctx.orgId}::uuid AND s.meeting_id = ${input.meetingId}::uuid AND s.stage = 'published'
         AND pg_catalog.floor(s.start_seconds)::int = ANY(${sql.val([input.startSeconds, input.endSeconds])}::int[])`.execute(ctx.trx);
    const anchored = new Set(found.rows.map((r) => r.second));
    if (![input.startSeconds, input.endSeconds].every((second) => anchored.has(second))) throw new DomainError('HIGHLIGHT_NOT_ANCHORED', 422, 'A highlight must start and end at a published line of the transcript');
    // One member's adds in one meeting are one after the other, so two tabs cannot both pass the count below at 49.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`highlight:${input.meetingId}:${userId}`}, 0))`.execute(ctx.trx);
    const have = await base().select(sql<number>`pg_catalog.count(*)::int`.as('n')).executeTakeFirstOrThrow();
    if (have.n >= HIGHLIGHTS_PER_MEMBER_MAX) throw new DomainError('HIGHLIGHT_LIMIT', 422, `A member can have at most ${HIGHLIGHTS_PER_MEMBER_MAX} highlights in one meeting`);
    const row = await ctx.trx
      .insertInto('ludy_meetings.meeting_highlight')
      .values({ org_id: ctx.orgId, meeting_id: input.meetingId, created_by: userId, start_seconds: input.startSeconds, end_seconds: input.endSeconds })
      // A second tab or a double click that raced the check above lands on the unique constraint: the one mark stands.
      .onConflict((oc) => oc.columns(['org_id', 'meeting_id', 'created_by', 'start_seconds', 'end_seconds']).doNothing())
      .returning('id')
      .executeTakeFirst();
    const highlightId =
      row?.id ?? (await mine().where('start_seconds', '=', input.startSeconds).where('end_seconds', '=', input.endSeconds).executeTakeFirstOrThrow()).id;
    ctx.audit({ meetingId: input.meetingId, startSeconds: input.startSeconds, endSeconds: input.endSeconds, created: row !== undefined });
    return zHighlightAdded.parse({ meetingId: input.meetingId, highlightId, created: row !== undefined });
  },
});

export const highlightRemove = defineCommand({
  name: 'meetings.highlight.remove',
  input: zHighlightRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<HighlightRemoved> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const row = await ctx.trx
      .selectFrom('ludy_meetings.meeting_highlight')
      .select(['id', 'created_by'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('id', '=', input.highlightId)
      .executeTakeFirst();
    // A mark the caller cannot read is a mark that is not there, whatever its id.
    if (!row) throw new DomainError('HIGHLIGHT_NOT_FOUND', 404, 'Highlight not found');
    if (row.created_by !== userId && meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the member who marked it or the recorder can remove a highlight');
    await ctx.trx.deleteFrom('ludy_meetings.meeting_highlight').where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    ctx.audit({ meetingId: input.meetingId });
    return zHighlightRemoved.parse({ meetingId: input.meetingId, highlightId: row.id });
  },
});

// The marks of the meeting the caller may read (the table's row policy decides), in the order of the transcript. No line text: the page reads the lines itself, the same ones the transcript panel shows.
// Not a sensitive read: a mark is two seconds and a name the org already knows the member by.
export const highlightList = defineQuery({
  name: 'meetings.highlight.list',
  input: zMeetingRef,
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<Highlights> => {
    const userId = userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.meeting_highlight')
      .select(['id', 'created_by', 'start_seconds', 'end_seconds'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('start_seconds')
      .orderBy('end_seconds')
      .orderBy('created_at')
      .orderBy('id')
      .limit(2000)
      .execute();
    const authors = [...new Set(rows.map((r) => r.created_by).filter((id) => id !== userId))];
    const names = new Map<string, string>();
    if (authors.length > 0) {
      const { rows: profiles } = await sql<{ user_id: string; display_name: string | null }>`SELECT user_id, display_name FROM ludy_kernel.member_profiles(${authors}::uuid[])`.execute(ctx.trx);
      for (const p of profiles) {
        const name = cleanName(p.display_name);
        if (name !== '') names.set(p.user_id, name);
      }
    }
    const highlights: Highlight[] = rows.map((r) => ({
      id: r.id,
      startSeconds: r.start_seconds,
      endSeconds: r.end_seconds,
      mine: r.created_by === userId,
      markedBy: r.created_by === userId ? null : (names.get(r.created_by) ?? null),
    }));
    return zHighlights.parse({ meetingId: input.meetingId, highlights });
  },
});

export const highlightsCommands = [highlightAdd, highlightRemove];
export const highlightsQueries = [highlightList];
