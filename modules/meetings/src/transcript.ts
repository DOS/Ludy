// SPDX-License-Identifier: AGPL-3.0-only
// The transcript of a meeting (#2578, ADR-0047 points 2 and 3, ADR-0049 stage A, meetings plan M4a): the recorder's draft
// segments, read, replaced by a transcription run and corrected by hand. Only the recorder reads or writes a draft (the RLS
// policies of transcript_segment say so, and these commands check the recorder again); a reader of the meeting reads only
// published segments. The audit rows carry ids and counts, never the text. The background run that calls draft_store as the
// recorder's own Vy is M4b.
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import {
  zMeetingRef,
  zTranscriptCorrect,
  zTranscriptDraftStore,
  type Transcript,
  type TranscriptStage,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { dayText, vnDay } from './retention.ts';

const ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];
const INSERT_BATCH = 500;

function userOf(actor: { type: string; userId?: string }): string {
  if (actor.type !== 'user' || !actor.userId) throw new DomainError('FORBIDDEN', 403, 'Only authenticated members can perform this action');
  return actor.userId;
}

const notFound = () => new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');

// The meeting, 404 when the caller cannot read it or its text period has ended.
async function openMeeting(trx: QueryContext['trx'], orgId: string, meetingId: string) {
  const meeting = await trx
    .selectFrom('crove_meetings.meeting')
    .select(['id', 'recorder_user_id', sql<string | null>`text_retention_date::text`.as('text_day')])
    .where('org_id', '=', orgId)
    .where('id', '=', meetingId)
    .executeTakeFirst();
  if (!meeting || (meeting.text_day !== null && dayText(meeting.text_day) <= vnDay(new Date()))) throw notFound();
  return meeting;
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
    for (const segment of input.segments) {
      if (segment.endSeconds < segment.startSeconds) throw new DomainError('INVALID', 422, 'A transcript segment ends before it starts');
    }
    // A new run replaces the earlier draft, corrections included: the recorder asked for it.
    await ctx.trx.deleteFrom('crove_meetings.transcript_segment').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('stage', '=', 'draft').execute();
    for (let i = 0; i < input.segments.length; i += INSERT_BATCH) {
      const rows = input.segments.slice(i, i + INSERT_BATCH).map((s) => ({
        org_id: ctx.orgId,
        meeting_id: input.meetingId,
        start_seconds: String(s.startSeconds),
        end_seconds: String(s.endSeconds),
        speaker_label: s.speakerLabel,
        text: s.text,
        stage: 'draft' as const,
      }));
      await ctx.trx.insertInto('crove_meetings.transcript_segment').values(rows).execute();
    }
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
      .selectFrom('crove_meetings.transcript_segment')
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
      .updateTable('crove_meetings.transcript_segment')
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
      .selectFrom('crove_meetings.transcript_segment')
      .select(['id', sql<string>`start_seconds::text`.as('start_seconds'), sql<string>`end_seconds::text`.as('end_seconds'), 'speaker_label', 'text', 'stage', 'corrected'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('start_seconds')
      .orderBy('id')
      .execute();
    const stage: Transcript['stage'] = rows.length === 0 ? 'none' : rows.some((r) => r.stage === 'draft') ? 'draft' : 'published';
    return {
      meetingId: input.meetingId,
      isRecorder: meeting.recorder_user_id === userId,
      stage,
      segments: rows.map((r) => ({
        id: r.id,
        startSeconds: Number(r.start_seconds),
        endSeconds: Number(r.end_seconds),
        speakerLabel: r.speaker_label,
        text: r.text,
        stage: r.stage as TranscriptStage,
        corrected: r.corrected,
      })),
    };
  },
});
