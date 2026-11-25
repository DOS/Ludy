// SPDX-License-Identifier: AGPL-3.0-only
// The transcript of a meeting (#2578, ADR-0047 points 2 and 3, ADR-0049 stage A, meetings plan M4a): the recorder's draft
// segments, read, replaced by a transcription run and corrected by hand. Only the recorder reads or writes a draft (the RLS
// policies of transcript_segment say so, and these commands check the recorder again); a reader of the meeting reads only
// published segments. The audit rows carry ids and counts, never the text. Both commands are for a signed-in member (a user
// actor): the background run of M4b is the recorder's own Vy and writes only its own result (member_vy_result); the recorder's
// own action copies that result into the draft through draft_store, so no agent context ever writes this table.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  zMeetingRef,
  zTranscriptCorrect,
  zTranscriptDraftStore,
  type Transcript,
  type TranscriptSegmentInput,
  type TranscriptStage,
  type TranscriptionMaker,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { dayText, vnDay } from './retention.ts';

export const ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];
const INSERT_BATCH = 500;

export function userOf(actor: { type: string; userId?: string }): string {
  if (actor.type !== 'user' || !actor.userId) throw new DomainError('FORBIDDEN', 403, 'Only authenticated members can perform this action');
  return actor.userId;
}

const notFound = () => new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');

// The meeting, 404 when the caller cannot read it or its text period has ended.
export async function openMeeting(trx: QueryContext['trx'], orgId: string, meetingId: string) {
  const meeting = await trx
    .selectFrom('ludy_meetings.meeting')
    .select(['id', 'recorder_user_id', sql<string | null>`text_retention_date::text`.as('text_day')])
    .where('org_id', '=', orgId)
    .where('id', '=', meetingId)
    .executeTakeFirst();
  if (!meeting || (meeting.text_day !== null && dayText(meeting.text_day) <= vnDay(new Date()))) throw notFound();
  return meeting;
}

/**
 * Puts the published lines of a meeting in order with whatever is checked against them (#4971). The recorder's publish replaces the published lines (`transcript_publish`), and a highlight is checked
 * against them when it is added by the recorder or by any reader of the meeting. A reader cannot hold the meeting row (the UPDATE policy of the table admits the recorder only, and every locking clause
 * needs it), and the foreign key's FOR KEY SHARE does not conflict with the publish's FOR NO KEY UPDATE, so the two take this transaction-scoped advisory lock of the meeting instead: the publish
 * exclusively (`replace`), a check against the lines shared (`read`), so many adds run together and one publish waits for them or they wait for it. What runs after the lock is taken reads the lines as the
 * other transaction left them (READ COMMITTED). The publish takes it after the meeting row and the add takes nothing else of the meeting first, so the two cannot deadlock.
 */
export async function lockPublishedLines(trx: QueryContext['trx'], meetingId: string, mode: 'replace' | 'read'): Promise<void> {
  const key = sql`pg_catalog.hashtextextended(${`meetings.lines:${meetingId.toLowerCase()}`}, 0)`;
  if (mode === 'replace') await sql`SELECT pg_catalog.pg_advisory_xact_lock(${key})`.execute(trx);
  else await sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(${key})`.execute(trx);
}

/** Holds the meeting row FOR NO KEY UPDATE before reading private results or mutating drafts (#4415, #3916). */
export async function lockMeeting(trx: QueryContext['trx'], orgId: string, meetingId: string): Promise<void> {
  const held = await trx.selectFrom('ludy_meetings.meeting').select('id').where('org_id', '=', orgId).where('id', '=', meetingId).forNoKeyUpdate().executeTakeFirst();
  // A meeting deleted while this waited is gone, not a foreign key error or stale read below.
  if (!held) throw notFound();
}

/**
 * The draft transcript lines of a meeting as the recorder's screen needs them (#4899): how many there are, how many a machine wrote and the recorder has not read, and a key over exactly those unread lines
 * (the digest of their ids, empty when none). The review names that key, so it clears only the lines the screen showed. Row security lets only the recorder see a draft, so callers ask for the recorder.
 */
export async function draftLineState(trx: QueryContext['trx'], orgId: string, meetingId: string): Promise<{ draft: number; unread: number; key: string }> {
  const row = await trx
    .selectFrom('ludy_meetings.transcript_segment')
    .select([
      sql<string>`count(*)::text`.as('draft'),
      sql<string>`(count(*) filter (where tainted))::text`.as('unread'),
      sql<string | null>`md5(string_agg(id::text, ',' order by id) filter (where tainted))`.as('key'),
    ])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'draft')
    .executeTakeFirstOrThrow();
  return { draft: Number(row.draft), unread: Number(row.unread), key: row.key ?? '' };
}

// A new run replaces the earlier draft, corrections included: the recorder asked for it. The caller has checked that the caller is the recorder.
// `fromRun` is set only by the copy of a Vy result (meetings.transcript.copy_result): those rows are the model's text, so they are born tainted and name the run they came
// from (source_run_id), and nothing can change either afterwards but the recorder's review (ludy_meetings.draft_review). What the recorder typed is not tainted.
// `source` names whose transcription the rows are when it is not Ludy's own (C2, #3174: the transcript Google Meet wrote, taken by meetings.import.take_transcript); such rows are tainted too and
// name no run. Nothing updates `source` afterwards.
export async function replaceDraft(
  ctx: { trx: QueryContext['trx']; orgId: string },
  meetingId: string,
  segments: readonly TranscriptSegmentInput[],
  fromRun?: { tainted: true; sourceRunId?: string; source?: TranscriptionMaker; platformCut?: boolean },
): Promise<void> {
  for (const segment of segments) {
    if (segment.endSeconds < segment.startSeconds) throw new DomainError('INVALID', 422, 'A transcript segment ends before it starts');
  }
  // The meeting row is held first, in the order a publish, a chapters save and the personal-data erasure take it (the meeting, then its rows): a re-transcription is one after the other with them, so
  // a chapter checked against the lines cannot be saved or published against lines that a concurrent replacement is deleting (#3916). The caller may already hold the meeting's media lock (an
  // advisory lock taken before any row of the meeting), which is the same order.
  await lockMeeting(ctx.trx, ctx.orgId, meetingId);
  await ctx.trx.deleteFrom('ludy_meetings.transcript_segment').where('org_id', '=', ctx.orgId).where('meeting_id', '=', meetingId).where('stage', '=', 'draft').execute();
  // The batch transcript replaces the live preview (ADR-0052 L4a, #3110): once a real transcript is stored the "Bản nháp trực tiếp" lines are gone, with the text they held.
  if (segments.length > 0) await ctx.trx.deleteFrom('ludy_meetings.live_line').where('org_id', '=', ctx.orgId).where('meeting_id', '=', meetingId).execute();
  for (let i = 0; i < segments.length; i += INSERT_BATCH) {
    const rows = segments.slice(i, i + INSERT_BATCH).map((s) => ({
      org_id: ctx.orgId,
      meeting_id: meetingId,
      start_seconds: String(s.startSeconds),
      end_seconds: String(s.endSeconds),
      speaker_label: s.speakerLabel,
      text: s.text,
      stage: 'draft' as const,
      ...(fromRun ? { tainted: fromRun.tainted, ...(fromRun.sourceRunId === undefined ? {} : { source_run_id: fromRun.sourceRunId }), ...(fromRun.source === undefined ? {} : { source: fromRun.source }) } : {}),
    }));
    await ctx.trx.insertInto('ludy_meetings.transcript_segment').values(rows).execute();
  }
  // The note that a platform's transcript was cut (#3922) belongs to the lines just stored: set with a cut platform transcript, cleared by every other replacement (the recorder's own transcription, a
  // draft cleared), so it never outlives the partial draft. Only written when it changes.
  const cut = fromRun?.platformCut === true;
  await ctx.trx.updateTable('ludy_meetings.meeting').set({ platform_transcript_cut: cut }).where('org_id', '=', ctx.orgId).where('id', '=', meetingId).where('platform_transcript_cut', '<>', cut).execute();
}

export const transcriptDraftStore = defineCommand({
  name: 'meetings.transcript.draft_store',
  input: zTranscriptDraftStore,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can store its transcript');
    await replaceDraft(ctx, input.meetingId, input.segments);
    ctx.audit({ meetingId: input.meetingId, stored: input.segments.length });
    return { meetingId: input.meetingId, stored: input.segments.length };
  },
});

export const transcriptCorrect = defineCommand({
  name: 'meetings.transcript.correct',
  input: zTranscriptCorrect,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const segment = await ctx.trx
      .selectFrom('ludy_meetings.transcript_segment')
      .select(['id', 'meeting_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.segmentId)
      .where('stage', '=', 'draft')
      .executeTakeFirst();
    // RLS shows a draft to its recorder only, so any other caller meets the same answer as for an unknown id.
    if (!segment) throw new DomainError('TRANSCRIPT_SEGMENT_NOT_FOUND', 404, 'Transcript segment not found');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, segment.meeting_id);
    if (meeting.recorder_user_id !== userId) throw new DomainError('TRANSCRIPT_SEGMENT_NOT_FOUND', 404, 'Transcript segment not found');
    await ctx.trx
      .updateTable('ludy_meetings.transcript_segment')
      .set({
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.speakerLabel === undefined ? {} : { speaker_label: input.speakerLabel }),
        corrected: true,
        updated_at: sql<Date>`pg_catalog.now()`,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.segmentId)
      .execute();
    const textChanged = input.text !== undefined;
    const labelChanged = input.speakerLabel !== undefined;
    ctx.audit({ segmentId: input.segmentId, meetingId: segment.meeting_id, textChanged, labelChanged });
    return { segmentId: input.segmentId, corrected: true as const };
  },
});

// The transcript the caller may read. A sensitive read: each one leaves an audit row naming the meeting.
export const transcriptGet = defineQuery({
  name: 'meetings.transcript.get',
  input: zMeetingRef,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<Transcript> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.transcript_segment')
      .select(['id', sql<string>`start_seconds::text`.as('start_seconds'), sql<string>`end_seconds::text`.as('end_seconds'), 'speaker_label', 'text', 'stage', 'corrected', 'source'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('start_seconds')
      .orderBy('id')
      .execute();
    const stage: Transcript['stage'] = rows.length === 0 ? 'none' : rows.some((r) => r.stage === 'draft') ? 'draft' : 'published';
    // The recorder reads their working draft while one exists (a re-transcription after a publish, #4899): the lines published before it stay for the readers until the next publish replaces them, and are not
    // listed again beside the draft that will replace them. A reader reads published lines only, so nothing changes for them.
    const shown = stage === 'draft' ? rows.filter((r) => r.stage === 'draft') : rows;
    return {
      meetingId: input.meetingId,
      isRecorder: meeting.recorder_user_id === userId,
      stage,
      segments: shown.map((r) => ({
        id: r.id,
        startSeconds: Number(r.start_seconds),
        endSeconds: Number(r.end_seconds),
        speakerLabel: r.speaker_label,
        text: r.text,
        stage: r.stage as TranscriptStage,
        corrected: r.corrected,
        source: r.source as TranscriptionMaker,
      })),
    };
  },
});

// The whole seconds, among `seconds`, at which no line of the meeting's transcript starts (a line starts at a second when its start, cut to the whole second, is that second). The caller is the
// recorder, who reads every line of their meeting (the draft as well as a published one), so every line counts. Chapters are saved against this and checked against it again at publish (#3881), so a
// re-transcription that replaced the lines since the save cannot leave a chapter pointing at a second where no line starts.
export async function missingAnchors(ctx: { trx: QueryContext['trx']; orgId: string }, meetingId: string, seconds: readonly number[]): Promise<number[]> {
  if (seconds.length === 0) return [];
  const found = await sql<{ second: number }>`
    SELECT DISTINCT pg_catalog.floor(s.start_seconds)::int AS second
      FROM ludy_meetings.transcript_segment s
     WHERE s.org_id = ${ctx.orgId}::uuid AND s.meeting_id = ${meetingId}::uuid AND pg_catalog.floor(s.start_seconds)::int = ANY(${sql.val([...seconds])}::int[])`.execute(ctx.trx);
  const anchored = new Set(found.rows.map((r) => r.second));
  return seconds.filter((s) => !anchored.has(s));
}
