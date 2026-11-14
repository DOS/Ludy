// SPDX-License-Identifier: AGPL-3.0-only
// Assemble the live pieces into the recording when the final upload never arrives (issue #3126, ADR-0052 L4a). The pieces of #3109 are consecutive slices of one MediaRecorder
// stream, so in order they ARE the recording (piece 0 carries the container header). When the window of the pieces (LIVE_CHUNK_WINDOW_SECONDS) has passed with pieces and no final
// audio, the recorder's own click joins them:
//
//   meetings.live.assemble_plan    (query, the recorder only) the pieces in order with their files and wrapped keys, and the numbers missing between 0 and the last one. It
//                                  refuses with a fixed code when there is nothing to join or it is too early. The route of apps/kernel reads it in the recorder's own context,
//                                  as playback does, decrypts one piece at a time into a fresh audio key, and has crove-media measure the result.
//   meetings.live.assemble_record  (command, the recorder only) takes the meeting's media lock, checks again under it that no final audio exists and that the pieces are the set
//                                  the route joined, then records the sealed result through the same body as an upload (recordSealedMedia), which deletes the pieces in the same
//                                  transaction.
//
// Nothing here is read by the system or by Vy: the recorder reads their own pieces, as they read their own recording. Nothing is AI: no run, no meter, no budget.
import { sql } from 'kysely';
import {
  LIVE_CHUNK_WINDOW_SECONDS,
  zLiveRef,
  zMeetingLiveAssemble,
  zMeetingLiveAssembled,
  type LiveAssembleReason,
  type LiveAssemblePlan,
  type LiveAssemblePlanPiece,
  type LiveAssembleState,
  type MeetingLiveAssembled,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, fileKey, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { lockMeetingMedia, recordSealedMedia } from './media-record.ts';
import { vnDay } from './retention.ts';

const ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

function userOf(actor: CommandContext['actor'] | QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Only authenticated members can perform this action');
  return actor.userId;
}

export interface AssemblePiece {
  seq: number;
  lengthSeconds: number;
  fileId: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface AssembleFacts {
  recorderUserId: string;
  audioDay: string;
  pieces: AssemblePiece[];
  missing: number[];
  reason: LiveAssembleReason | null;
}

// What the meeting holds and whether its pieces may be joined now. The caller has opened the meeting; the reads are the recorder's (the pieces' policies admit nobody else, so for
// anyone else the list is empty and the reason is `no_pieces`).
export async function assembleFacts(ctx: CommandContext | QueryContext, meetingId: string, now: Date): Promise<AssembleFacts> {
  const meeting = await ctx.trx
    .selectFrom('crove_meetings.meeting')
    .select(['recorder_user_id', 'started_at', sql<string>`audio_retention_date::text`.as('audio_day'), sql<string | null>`text_retention_date::text`.as('text_day')])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', meetingId)
    .executeTakeFirst();
  if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
  const rows = await ctx.trx
    .selectFrom('crove_meetings.live_chunk')
    .select(['seq', 'length_seconds', 'file_id', 'size_bytes', 'created_at'])
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .orderBy('seq')
    .execute();
  const pieces: AssemblePiece[] = rows.map((r) => ({ seq: r.seq, lengthSeconds: r.length_seconds, fileId: r.file_id, sizeBytes: Number(r.size_bytes), createdAt: new Date(r.created_at) }));
  // The numbers between 0 and the last piece that no piece holds: a lost piece, reported and never fatal (except piece 0).
  const have = new Set(pieces.map((p) => p.seq));
  const last = pieces.at(-1)?.seq ?? -1;
  const missing: number[] = [];
  for (let seq = 0; seq <= last; seq += 1) if (!have.has(seq)) missing.push(seq);
  const { rows: ended } = await sql<{ done: boolean }>`
    SELECT (EXISTS (SELECT 1 FROM crove_meetings.audio_segment WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid)
         OR EXISTS (SELECT 1 FROM crove_meetings.meeting_video WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid)) AS done`.execute(ctx.trx);
  // The window counts from the start; a meeting with no start time counts from its last piece, so the final recording is never raced.
  const lastPieceAt = pieces.reduce<number>((at, p) => Math.max(at, p.createdAt.getTime()), 0);
  const reference = meeting.started_at ? new Date(meeting.started_at).getTime() : lastPieceAt;
  let reason: LiveAssembleReason | null = null;
  if (meeting.audio_day <= vnDay(now) || (meeting.text_day !== null && meeting.text_day <= vnDay(now))) reason = 'expired';
  else if (ended[0]?.done === true) reason = 'audio_recorded';
  else if (pieces.length === 0) reason = 'no_pieces';
  else if (now.getTime() <= reference + LIVE_CHUNK_WINDOW_SECONDS * 1000) reason = 'still_recording';
  else if (!have.has(0)) reason = 'first_piece_missing';
  return { recorderUserId: meeting.recorder_user_id, audioDay: meeting.audio_day, pieces, missing, reason };
}

export function assembleState(facts: AssembleFacts): LiveAssembleState {
  return { available: facts.reason === null, reason: facts.reason, pieces: facts.pieces.length, missing: facts.missing };
}

// The refusal for a reason the pieces cannot be joined, with a fixed code the pane words.
export function refuseAssemble(reason: LiveAssembleReason): DomainError {
  switch (reason) {
    case 'no_pieces':
      return new DomainError('LIVE_NO_PIECES', 404, 'This meeting kept no live pieces to join');
    case 'still_recording':
      return new DomainError('LIVE_STILL_OPEN', 409, 'The recording of this meeting may still arrive: the pieces can be joined after its window has passed');
    case 'audio_recorded':
      return new DomainError('MEDIA_ALREADY_RECORDED', 409, 'This meeting already has its recording');
    case 'first_piece_missing':
      return new DomainError('LIVE_FIRST_PIECE_MISSING', 409, 'The first piece holds the container header; without it the others cannot be joined');
    case 'expired':
      return new DomainError('MEDIA_RETENTION_PASSED', 409, 'The retention period of this meeting has ended');
  }
}

function recorderOnly(ctx: CommandContext | QueryContext, facts: AssembleFacts): void {
  if (facts.recorderUserId !== userOf(ctx.actor)) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can join its live pieces');
}

export const liveAssemblePlan = defineQuery({
  name: 'meetings.live.assemble_plan',
  input: zLiveRef,
  access: ROLES,
  // The wrapped keys of the pieces: read in the recorder's own context only, like the audio key of a playback.
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<LiveAssemblePlan> => {
    const facts = await assembleFacts(ctx, input.meetingId, new Date());
    recorderOnly(ctx, facts);
    if (facts.reason) throw refuseAssemble(facts.reason);
    const files = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'storage_key', 'generation', 'sha256', 'content_type'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', facts.pieces.map((p) => p.fileId))
      .execute();
    const byFile = new Map(files.map((f) => [f.id, f]));
    const pieces: LiveAssemblePlanPiece[] = [];
    const missing = [...facts.missing];
    for (const piece of facts.pieces) {
      const file = byFile.get(piece.fileId);
      const { rows } = await sql<{ key_id: string; wrapped_key: Buffer }>`
        SELECT key_id, wrapped_key FROM crove_meetings.media_key_read(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${`live:${piece.seq}`})`.execute(ctx.trx);
      const key = rows[0];
      // A piece with no file row or no key is lost as far as the recording goes: it is a gap, and piece 0 cannot be one.
      if (!file || !key) {
        if (piece.seq === 0) throw refuseAssemble('first_piece_missing');
        missing.push(piece.seq);
        continue;
      }
      pieces.push({
        seq: piece.seq,
        lengthSeconds: piece.lengthSeconds,
        fileId: piece.fileId,
        storageKey: file.storage_key,
        generation: file.generation,
        sizeBytes: piece.sizeBytes,
        sha256: file.sha256,
        contentType: file.content_type,
        keyId: key.key_id,
        wrappedKey: key.wrapped_key,
      });
    }
    missing.sort((a, b) => a - b);
    return { meetingId: input.meetingId, pieces, missing, lastSeq: facts.pieces.at(-1)?.seq ?? 0 };
  },
});

export const liveAssembleRecord = defineCommand({
  name: 'meetings.live.assemble_record',
  input: zMeetingLiveAssemble,
  // Records ciphertext the recorder's own route sealed from the recorder's own pieces: the same internal effect as an upload.
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MeetingLiveAssembled> => {
    const userId = userOf(ctx.actor);
    // An extension token never joins pieces: the click is the app's.
    if (ctx.actor.type === 'user' && ctx.actor.extension) throw new DomainError('FORBIDDEN', 403, 'Only the app can join live pieces');
    // The lock first, so a final upload or a piece in flight is either committed before the check below or waits for this transaction.
    await lockMeetingMedia(ctx, input.meetingId);
    const facts = await assembleFacts(ctx, input.meetingId, ctx.now);
    recorderOnly(ctx, facts);
    if (facts.reason) throw refuseAssemble(facts.reason);
    // The set the route joined is the set that is here now (no piece can arrive after the window, so a difference is a retry of another click or a delete).
    if (facts.pieces.length < input.pieces || (facts.pieces.at(-1)?.seq ?? -1) !== input.lastSeq) {
      throw new DomainError('LIVE_PIECES_CHANGED', 409, 'The live pieces changed while they were joined; try again');
    }
    if (input.storageKey !== fileKey(ctx.orgId, input.sha256)) throw new DomainError('INVALID_STORAGE_KEY', 400, 'Storage key must match org and sha256');
    const { fileId, liveChunksDiscarded } = await recordSealedMedia(ctx, {
      userId,
      meetingId: input.meetingId,
      audioRetentionDay: facts.audioDay,
      input: { kind: 'audio', ...input },
    });
    // Ids and numbers only: no key, no storage address, no audio. The numbers of the pieces that were missing say where the recording has a gap.
    ctx.audit({ meetingId: input.meetingId, fileId, pieces: input.pieces, discarded: liveChunksDiscarded, missing: facts.missing.length, ...(facts.missing.length > 0 ? { missingSeqs: facts.missing.slice(0, 50) } : {}) });
    return zMeetingLiveAssembled.parse({ meetingId: input.meetingId, fileId, pieces: input.pieces, missing: facts.missing, lengthSeconds: input.lengthSeconds });
  },
});

export const liveAssembleCommands = [liveAssembleRecord];
export const liveAssembleQueries = [liveAssemblePlan];
