// SPDX-License-Identifier: AGPL-3.0-only
// Live notes capture (issue #3109, ADR-0052 L4a). While a meeting the recorder opted into live notes is recorded, the recorder's extension or app sends pieces of
// about 15 seconds. The upload route seals each piece under its own data key and stores the ciphertext (the same sealing as the final recording, ADR-0047 point 4);
// this command records it: the key as a media_key row of kind live:<seq>, the ciphertext as a meeting_audio file row, and a live_chunk row that names it.
//
// What this slice keeps and what it leaves: the pieces are consecutive slices of one MediaRecorder stream, so in order they make the recording (the first carries the
// container header). They are kept until the final recording is recorded (meetings.media.record deletes them, so the audio is kept once), or until the meeting's audio
// date shreds them with the audio. Nothing reads them yet: the live transcript (#3110) reads them through the recorder's own Vy run. The final upload is not touched,
// so a lost piece never loses the recording.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  LIVE_CHUNK_MAX_TOTAL_BYTES,
  LIVE_CHUNK_WINDOW_SECONDS,
  zMeetingLiveChunk,
  zMeetingLiveChunkRecorded,
  type MeetingLiveChunkRecorded,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, fileKey, type CommandContext } from '@crove/kernel-runtime';
import type { MemberRole } from '@crove/db';
import { vnDay } from './retention.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export const meetingLiveChunk = defineCommand({
  name: 'meetings.live.chunk',
  input: zMeetingLiveChunk,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // The one command the extension's meetings scope gains in this slice (ADR-0052, plan section 5.7): a piece of the recording of a meeting its own token created.
  extension: { scope: 'meetings' },
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx: CommandContext, input): Promise<MeetingLiveChunkRecorded> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Only authenticated members can perform this action');
    const userId = ctx.actor.userId;
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select([
        'id',
        'recorder_user_id',
        'live_notes',
        'extension_token_id',
        'started_at',
        'consent_confirmed_by',
        'consent_notice_version',
        sql<string>`audio_retention_date::text`.as('audio_day'),
        sql<string | null>`text_retention_date::text`.as('text_day'),
      ])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting || (meeting.text_day !== null && meeting.text_day <= vnDay(ctx.now))) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder may send live notes audio');
    // An extension token reaches only the meetings it created: any other is answered as one that does not exist.
    if (ctx.actor.extension && meeting.extension_token_id !== ctx.actor.extension.tokenId) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    // Off unless the recorder ticked it at the consent step: a meeting that did not accepts no piece, whoever asks.
    if (!meeting.live_notes) throw new DomainError('LIVE_NOTES_NOT_ENABLED', 409, 'Live notes were not turned on for this meeting');
    // No audio without the record of who told the participants (ADR-0047 point 6). The columns cannot be null, so the check reads what a record is: confirmed by the
    // recorder, with a notice version.
    if (meeting.consent_confirmed_by !== meeting.recorder_user_id || meeting.consent_notice_version.trim() === '') {
      throw new DomainError('CONSENT_MISSING', 409, 'The meeting has no consent record');
    }
    if (meeting.audio_day <= vnDay(ctx.now)) throw new DomainError('MEDIA_RETENTION_PASSED', 409, 'The retention period of this meeting has ended');
    const startedAt = meeting.started_at === null ? null : new Date(meeting.started_at).getTime();
    // One lock per meeting, shared with meetings.media.record: a piece and the final recording of the same meeting never run side by side, so a piece cannot
    // commit after the recording discarded the pieces and stay beside it.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`meetings.live:${ctx.orgId}:${input.meetingId}`}, 0))`.execute(ctx.trx);
    const ended = await sql<{ done: boolean }>`
      SELECT (EXISTS (SELECT 1 FROM crove_meetings.audio_segment WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${input.meetingId}::uuid)
           OR EXISTS (SELECT 1 FROM crove_meetings.meeting_video WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${input.meetingId}::uuid)) AS done`.execute(ctx.trx);
    // The recording has ended once its final audio or video is recorded, and a meeting takes pieces only for the longest run the kernel allows.
    if (ended.rows[0]?.done === true || (startedAt !== null && ctx.now.getTime() > startedAt + LIVE_CHUNK_WINDOW_SECONDS * 1000)) {
      throw new DomainError('LIVE_CLOSED', 409, 'The recording of this meeting has ended');
    }
    if (input.storageKey !== fileKey(ctx.orgId, input.sha256)) throw new DomainError('INVALID_STORAGE_KEY', 400, 'Storage key must match org and sha256');

    // A piece of this number is already kept: a retry after a lost answer. The first one stands and the caller drops the object it just stored.
    const existing = await ctx.trx
      .selectFrom('crove_meetings.live_chunk')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('seq', '=', input.seq)
      .executeTakeFirst();
    if (existing) return zMeetingLiveChunkRecorded.parse({ meetingId: input.meetingId, seq: input.seq, duplicate: true });

    // The first piece carries the container header: without it the later ones cannot be read, so they are not kept.
    if (input.seq > 0) {
      const first = await ctx.trx
        .selectFrom('crove_meetings.live_chunk')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('meeting_id', '=', input.meetingId)
        .where('seq', '=', 0)
        .executeTakeFirst();
      if (!first) throw new DomainError('LIVE_FIRST_PIECE_MISSING', 409, 'The first piece of the live notes audio has not arrived');
    }

    const { rows: total } = await sql<{ bytes: string }>`
      SELECT COALESCE(SUM(size_bytes), 0)::text AS bytes FROM crove_meetings.live_chunk WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${input.meetingId}::uuid`.execute(ctx.trx);
    if (Number(total[0]?.bytes ?? '0') + input.sizeBytes > LIVE_CHUNK_MAX_TOTAL_BYTES) {
      throw new DomainError('FILE_TOO_LARGE', 413, 'The live notes audio of this meeting is at its size limit');
    }

    await sql`SELECT crove_meetings.media_key_seal(
      ${ctx.orgId}::uuid,
      ${input.meetingId}::uuid,
      ${input.keyId}::text,
      ${`live:${input.seq}`}::text,
      ${Buffer.from(input.wrappedKeyHex, 'hex')}::bytea
    )`.execute(ctx.trx);

    const fileId = randomUUID();
    await ctx.trx
      .insertInto('crove_kernel.file')
      .values({
        org_id: ctx.orgId,
        id: fileId,
        filename: `meeting-${input.meetingId}-live-${input.seq}.bin`,
        content_type: input.contentType,
        size_bytes: String(input.sizeBytes),
        sha256: input.sha256,
        storage_key: input.storageKey,
        generation: input.generation ?? null,
        source: 'meeting_audio',
        created_by: userId,
      })
      .execute();
    await ctx.trx
      .insertInto('crove_meetings.live_chunk')
      .values({
        org_id: ctx.orgId,
        id: randomUUID(),
        meeting_id: input.meetingId,
        seq: input.seq,
        file_id: fileId,
        size_bytes: String(input.sizeBytes),
        length_seconds: input.lengthSeconds,
      })
      .execute();

    // Ids and numbers only: no key, no storage address, no audio.
    ctx.audit({ meetingId: input.meetingId, seq: input.seq, sizeBytes: input.sizeBytes });
    return zMeetingLiveChunkRecorded.parse({ meetingId: input.meetingId, seq: input.seq, duplicate: false });
  },
});

export const liveCommands = [meetingLiveChunk];
