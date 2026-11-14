// SPDX-License-Identifier: AGPL-3.0-only
// The one place a sealed recording becomes the meeting's audio or video (issue #2578 and #3126). Two commands record media and both end here: meetings.media.record (the
// upload route sealed the whole file the recorder sent) and meetings.live.assemble_record (the assemble route joined the live pieces, ADR-0052 L4a), so there is one write
// path and one set of rules for the key, the file row, the segment and the live pieces.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MeetingMediaRecord } from '@crove/kernel-contract';
import { DomainError, type CommandContext } from '@crove/kernel-runtime';
import { readRetentionSettings, retentionDates } from './retention.ts';

const MEDIA_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
};

/** File extension for a sniffed container (detectMediaContainer), so the stored name matches the bytes (#2703). */
export function mediaExtension(contentType: string, kind: 'audio' | 'video'): string {
  return MEDIA_EXTENSIONS[contentType] ?? (kind === 'audio' ? 'bin' : 'mp4');
}

/** The advisory lock every writer of a meeting's live pieces and of its final media takes first (#3118): a piece, an upload and an assembly never run side by side. */
export async function lockMeetingMedia(ctx: Pick<CommandContext, 'trx' | 'orgId'>, meetingId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`meetings.live:${ctx.orgId}:${meetingId}`}, 0))`.execute(ctx.trx);
}

export interface RecordSealedMedia {
  userId: string;
  meetingId: string;
  // The meeting's audio retention day (YYYY-MM-DD): a video is never kept past it.
  audioRetentionDay: string;
  input: Pick<MeetingMediaRecord, 'kind' | 'keyId' | 'wrappedKeyHex' | 'storageKey' | 'generation' | 'sizeBytes' | 'sha256' | 'contentType' | 'lengthSeconds'>;
}

/**
 * Records one sealed recording: takes the meeting's media lock, refuses a second recording of the kind, deletes the live pieces (their keys first, so they are unreadable
 * from this commit; their file rows are left for the worker's orphan sweep), seals the key, writes the file row and the segment or video row. The caller has checked the
 * recorder, the retention day and the storage key. Answers the file id and how many pieces it discarded.
 */
export async function recordSealedMedia(ctx: CommandContext, p: RecordSealedMedia): Promise<{ fileId: string; liveChunksDiscarded: number }> {
  const { input, meetingId, userId } = p;
  // The lock is taken first, so a piece being recorded at this moment either commits before this and is deleted here, or waits and finds the recording ended.
  await lockMeetingMedia(ctx, meetingId);
  // One recording of a kind: whichever arrives first stands (a late final upload after an assembly, or the other way round, is told so, not left to a unique violation).
  const { rows: held } = await sql<{ done: boolean }>`
    SELECT EXISTS (SELECT 1 FROM crove_meetings.audio_segment WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid AND ${input.kind}::text = 'audio')
        OR EXISTS (SELECT 1 FROM crove_meetings.meeting_video WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid AND ${input.kind}::text = 'video') AS done`.execute(ctx.trx);
  if (held[0]?.done === true) throw new DomainError('MEDIA_ALREADY_RECORDED', 409, `This meeting already has its ${input.kind} recording`);
  const { rows: discarded } = await sql<{ n: number }>`SELECT crove_meetings.live_chunk_discard(${ctx.orgId}::uuid, ${meetingId}::uuid) AS n`.execute(ctx.trx);
  const liveChunksDiscarded = Number(discarded[0]?.n ?? 0);
  await sql`SELECT crove_meetings.media_key_seal(
    ${ctx.orgId}::uuid,
    ${meetingId}::uuid,
    ${input.keyId}::text,
    ${input.kind}::text,
    ${Buffer.from(input.wrappedKeyHex, 'hex')}::bytea
  )`.execute(ctx.trx);

  const fileId = randomUUID();
  await ctx.trx
    .insertInto('crove_kernel.file')
    .values({
      org_id: ctx.orgId,
      id: fileId,
      filename: `meeting-${meetingId}.${mediaExtension(input.contentType, input.kind)}`,
      content_type: input.contentType,
      size_bytes: String(input.sizeBytes),
      sha256: input.sha256,
      storage_key: input.storageKey,
      generation: input.generation ?? null,
      source: input.kind === 'audio' ? 'meeting_audio' : 'meeting_video',
      created_by: userId,
    })
    .execute();

  if (input.kind === 'audio') {
    await ctx.trx
      .insertInto('crove_meetings.audio_segment')
      .values({ org_id: ctx.orgId, id: randomUUID(), meeting_id: meetingId, file_id: fileId, segment_order: 0, start_offset_seconds: 0, length_seconds: input.lengthSeconds })
      .execute();
  } else {
    // The org's video period from the recording, never past the meeting's own audio date.
    const videoDay = retentionDates(ctx.now, await readRetentionSettings(ctx.trx, ctx.orgId)).video;
    const videoRetentionDate = videoDay < p.audioRetentionDay ? videoDay : p.audioRetentionDay;
    await ctx.trx
      .insertInto('crove_meetings.meeting_video')
      .values({ org_id: ctx.orgId, id: randomUUID(), meeting_id: meetingId, file_id: fileId, length_seconds: input.lengthSeconds, video_retention_date: videoRetentionDate })
      .execute();
  }
  return { fileId, liveChunksDiscarded };
}
