// SPDX-License-Identifier: AGPL-3.0-only
// The one place a sealed recording becomes the meeting's audio or video (issue #2578 and #3126). Two commands record media and both end here: meetings.media.record (the
// upload route sealed the whole file the recorder sent) and meetings.live.assemble_record (the assemble route joined the live pieces, ADR-0052 L4a), so there is one write
// path and one set of rules for the key, the file row, the segment and the live pieces.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MeetingMediaRecord } from '@ludy/kernel-contract';
import { DomainError, type CommandContext } from '@ludy/kernel-runtime';
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
  // True for the recording joined from the live pieces (meetings.live.assemble_record): its segment is flagged, so a late complete upload may replace it (#3187).
  // False for an upload, which replaces a joined recording but never an uploaded one.
  joinedFromPieces: boolean;
  input: Pick<MeetingMediaRecord, 'kind' | 'keyId' | 'wrappedKeyHex' | 'storageKey' | 'generation' | 'sizeBytes' | 'sha256' | 'contentType' | 'lengthSeconds'>;
}

/**
 * Records one sealed recording: takes the meeting's media lock, refuses a second recording of the kind, deletes the live pieces (their keys first, so they are unreadable
 * from this commit; their file rows are left for the worker's orphan sweep), seals the key, writes the file row and the segment or video row. The caller has checked the
 * recorder, the retention day and the storage key. Answers the file id and how many pieces it discarded.
 *
 * A late complete upload replaces a recording that was joined from the live pieces (#3187), in this same transaction and under the same lock, as long as no transcript
 * or summary was made from the joined audio (a summary from the old audio must not silently change). The joined segment and its key go, the sweep deletes the object
 * (its file row is left, as the pieces' are); then the upload is recorded as for a meeting with no audio. `replaced` says so. Anything else already recorded is refused.
 */
export async function recordSealedMedia(ctx: CommandContext, p: RecordSealedMedia): Promise<{ fileId: string; liveChunksDiscarded: number; replaced: boolean }> {
  const { input, meetingId, userId } = p;
  // A meeting made by importing a platform recording (consent method `platform_notice`, C1 #3173) holds only that import: an upload, a presigned upload or a live assembly into it is refused, because the consent
  // on record is the platform's own notice for that one recording and says nothing of any other audio. The import's own request passes: its recording row was claimed by this member for this meeting.
  const { rows: made } = await sql<{ imported: boolean; claimed: boolean }>`
    SELECT m.consent_method = 'platform_notice' AS imported,
           EXISTS (SELECT 1 FROM crove_kernel.meeting_platform_recording r
                   WHERE r.org_id = m.org_id AND r.meeting_id = m.id AND r.user_id = ${userId}::uuid AND r.status = 'claimed') AS claimed
    FROM crove_meetings.meeting m WHERE m.org_id = ${ctx.orgId}::uuid AND m.id = ${meetingId}::uuid`.execute(ctx.trx);
  if (made[0]?.imported === true && made[0].claimed !== true) {
    throw new DomainError('IMPORT_ONLY', 403, 'This meeting holds only the recording imported from its meeting platform');
  }
  // The lock is taken first, so a piece being recorded at this moment either commits before this and is deleted here, or waits and finds the recording ended.
  await lockMeetingMedia(ctx, meetingId);
  // One recording of a kind: whichever arrives first stands (a late final upload after an assembly, or the other way round, is told so, not left to a unique violation),
  // except that a complete upload replaces a joined recording nobody has used yet (#3187).
  let replaced = false;
  if (input.kind === 'audio') {
    const { rows: segments } = await sql<{ joined: boolean }>`
      SELECT joined_from_pieces AS joined FROM crove_meetings.audio_segment WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid`.execute(ctx.trx);
    if (segments.length > 0) {
      if (p.joinedFromPieces || segments.some((row) => !row.joined)) throw new DomainError('MEDIA_ALREADY_RECORDED', 409, `This meeting already has its ${input.kind} recording`);
      if (await joinedAudioInUse(ctx, meetingId)) {
        throw new DomainError('MEDIA_JOINED_IN_USE', 409, 'The recording joined from the live pieces was already used for a transcript or a summary, so the complete recording cannot replace it');
      }
      // The joined segment and its key go (the key by the recorder's own definer; the file row stays for the orphan sweep, which deletes the object first).
      await sql`DELETE FROM crove_meetings.audio_segment WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid`.execute(ctx.trx);
      await sql`SELECT crove_meetings.media_key_shred(${ctx.orgId}::uuid, ${meetingId}::uuid, 'audio')`.execute(ctx.trx);
      replaced = true;
    }
  } else {
    const { rows: held } = await sql<{ done: boolean }>`
      SELECT EXISTS (SELECT 1 FROM crove_meetings.meeting_video WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid) AS done`.execute(ctx.trx);
    if (held[0]?.done === true) throw new DomainError('MEDIA_ALREADY_RECORDED', 409, `This meeting already has its ${input.kind} recording`);
  }
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
      .values({ org_id: ctx.orgId, id: randomUUID(), meeting_id: meetingId, file_id: fileId, segment_order: 0, start_offset_seconds: 0, length_seconds: input.lengthSeconds, joined_from_pieces: p.joinedFromPieces })
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
  // A recording imported from a meeting platform (C1, #3173) is done once its media is recorded: the definer moves a claimed recording of this meeting and member to imported, and does nothing
  // for a meeting that is no import.
  await sql`SELECT crove_kernel.meeting_platform_recording_imported(${meetingId}::uuid)`.execute(ctx.trx);
  // Every recording that reaches the server ends its meeting's recording, whether it came as an upload or was joined from live pieces (#3205): ended_at is set
  // once (the first media wins), the start plus what was recorded and never later than now. That is also what takes the meeting out of the app's recording chip.
  await sql`
    UPDATE crove_meetings.meeting
    SET ended_at = LEAST(started_at + (${input.lengthSeconds}::int * interval '1 second'), ${ctx.now}::timestamptz), updated_at = ${ctx.now}::timestamptz
    WHERE org_id = ${ctx.orgId}::uuid AND id = ${meetingId}::uuid AND ended_at IS NULL AND started_at IS NOT NULL`.execute(ctx.trx);
  return { fileId, liveChunksDiscarded, replaced };
}

// Whether anything was made from a meeting's audio: a transcription or a summary was started on it (the start commands stamp meeting.audio_used_at under this same lock,
// so a start either commits before this reads or waits for the replacement and finds the new audio), or the meeting holds a transcript, minutes or action items (typed
// or written by a run). A failed or cancelled start counts too, which is the safe side: the joined recording is replaced only while nothing derives from it. Live notes
// are not counted: they come from the live pieces, not from the joined recording. The recorder's Vy runs themselves are private rows this module does not read.
async function joinedAudioInUse(ctx: CommandContext, meetingId: string): Promise<boolean> {
  const { rows } = await sql<{ used: boolean }>`
    SELECT EXISTS (SELECT 1 FROM crove_meetings.meeting WHERE org_id = ${ctx.orgId}::uuid AND id = ${meetingId}::uuid AND audio_used_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM crove_meetings.transcript_segment WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid)
        OR EXISTS (SELECT 1 FROM crove_meetings.meeting_result WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid)
        OR EXISTS (SELECT 1 FROM crove_meetings.action_item WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid) AS used`.execute(ctx.trx);
  return rows[0]?.used === true;
}

/** The trace a transcription or summary start leaves on the meeting (#3187), under the media lock the caller already holds. Set once: the first start wins. */
export async function markAudioUsed(ctx: CommandContext, meetingId: string): Promise<void> {
  await sql`UPDATE crove_meetings.meeting SET audio_used_at = COALESCE(audio_used_at, ${ctx.now}::timestamptz) WHERE org_id = ${ctx.orgId}::uuid AND id = ${meetingId}::uuid`.execute(ctx.trx);
}
