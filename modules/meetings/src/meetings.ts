// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { CONSENT_NOTICE_VERSION, MEETING } from './manifest.ts';
import {
  auditValue,
  zMeetingCreate,
  zMeetingListInput,
  zMeetingMediaMeta,
  zMeetingMediaRecord,
  zMeetingReaderAdd,
  zMeetingReaderRemove,
  zMeetingRef,
  type ConsentMethod,
  type MeetingDetail,
  type MeetingLanguage,
  type MeetingStatus,
  type MeetingSummary,
  type MeetingVisibility,
} from '@crove/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  fileKey,
  type CommandContext,
  type QueryContext,
} from '@crove/kernel-runtime';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

function userOf(actor: CommandContext['actor'] | QueryContext['actor']): string {
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated members can perform this action');
  }
  return actor.userId;
}

export function detectMediaContainer(bytes: Uint8Array, kind: 'audio' | 'video'): string | null {
  if (bytes.length < 12) return null;
  // WebM / Matroska (EBML ID 0x1A45DFA3)
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return kind === 'video' ? 'video/webm' : 'audio/webm';
  }
  // MP4 / M4A (ftyp box at offset 4)
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return kind === 'video' ? 'video/mp4' : 'audio/mp4';
  }
  if (kind === 'audio') {
    // Ogg container (OggS)
    if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
      return 'audio/ogg';
    }
    // WAV (RIFF....WAVE)
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
    ) {
      return 'audio/wav';
    }
    // MP3 with ID3 header
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      return 'audio/mpeg';
    }
    // MP3 raw frame sync
    const b1 = bytes[1];
    if (bytes[0] === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0) {
      return 'audio/mpeg';
    }
  }
  return null;
}

export function isValidMediaContainer(bytes: Uint8Array, kind: 'audio' | 'video'): boolean {
  return detectMediaContainer(bytes, kind) !== null;
}

interface MeetingRow {
  id: string;
  recorder_user_id: string;
  visibility: MeetingVisibility;
  title: string;
  language: MeetingLanguage;
  status: MeetingStatus;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  length_seconds: number | null;
  keep_video: boolean;
  consent_method: ConsentMethod;
  consent_confirmed_by: string;
  consent_confirmed_at: Date | string;
  consent_notice_version: string;
  audio_retention_date: Date | string;
  text_retention_date: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toSummary(r: MeetingRow, readersCount: number, hasAudio: boolean, hasVideo: boolean): MeetingSummary {
  return {
    id: r.id,
    recorderUserId: r.recorder_user_id,
    visibility: r.visibility,
    title: r.title,
    language: r.language,
    status: r.status,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    lengthSeconds: r.length_seconds,
    keepVideo: r.keep_video,
    audioRetentionDate: typeof r.audio_retention_date === 'string' ? r.audio_retention_date.slice(0, 10) : new Date(r.audio_retention_date).toISOString().slice(0, 10),
    textRetentionDate: typeof r.text_retention_date === 'string' ? r.text_retention_date.slice(0, 10) : new Date(r.text_retention_date).toISOString().slice(0, 10),
    hasAudio,
    hasVideo,
    readersCount,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export const meetingCreate = defineCommand({
  name: 'meetings.meeting.create',
  input: zMeetingCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meetingId = randomUUID();
    const startedAt = ctx.now;
    const audioRetentionDate = new Date(startedAt.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const textRetentionDate = new Date(startedAt.getTime() + 365 * 86_400_000).toISOString().slice(0, 10);

    await ctx.trx
      .insertInto('crove_meetings.meeting')
      .values({
        org_id: ctx.orgId,
        id: meetingId,
        recorder_user_id: userId,
        visibility: input.visibility,
        title: input.title,
        language: input.language,
        status: 'ready',
        started_at: startedAt,
        ended_at: null,
        length_seconds: input.lengthSeconds ?? null,
        keep_video: input.keepVideo,
        consent_method: input.consentMethod,
        consent_confirmed_by: userId,
        consent_confirmed_at: startedAt,
        consent_notice_version: CONSENT_NOTICE_VERSION,
        audio_retention_date: audioRetentionDate,
        text_retention_date: textRetentionDate,
      })
      .execute();

    if (input.visibility === 'attendees' && input.readerUserIds && input.readerUserIds.length > 0) {
      const uniqueReaderIds = Array.from(new Set(input.readerUserIds.filter((id) => id !== userId)));
      if (uniqueReaderIds.length > 0) {
        const validMembers = await ctx.trx
          .selectFrom('crove_kernel.tenant_member')
          .select(['user_id'])
          .where('org_id', '=', ctx.orgId)
          .where('user_id', 'in', uniqueReaderIds)
          .where('role', 'in', ['owner', 'admin', 'member'])
          .execute();
        if (validMembers.length !== uniqueReaderIds.length) {
          throw new DomainError('INVALID_READER', 400, 'All readers must be active non-viewer members of this organization');
        }
        for (const readerId of uniqueReaderIds) {
          await ctx.trx
            .insertInto('crove_meetings.meeting_reader')
            .values({
              org_id: ctx.orgId,
              id: randomUUID(),
              meeting_id: meetingId,
              user_id: readerId,
            })
            .onConflict((oc) => oc.columns(['org_id', 'meeting_id', 'user_id']).doNothing())
            .execute();
        }
      }
    }

    ctx.audit({
      meetingId,
      title: auditValue(MEETING, 'title', input.title),
      visibility: input.visibility,
      consentMethod: input.consentMethod,
    });

    return { meetingId };
  },
});

export const meetingMediaRecord = defineCommand({
  name: 'meetings.media.record',
  input: zMeetingMediaRecord,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id', 'recorder_user_id', 'keep_video'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }
    if (meeting.recorder_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder may record media');
    }
    if (input.kind === 'video' && !meeting.keep_video) {
      throw new DomainError('VIDEO_NOT_ENABLED', 400, 'Video retention is disabled for this meeting');
    }
    if (input.storageKey !== fileKey(ctx.orgId, input.sha256)) {
      throw new DomainError('INVALID_STORAGE_KEY', 400, 'Storage key must match org and sha256');
    }

    const wrappedKey = Buffer.from(input.wrappedKeyHex, 'hex');
    await sql`SELECT crove_meetings.media_key_seal(
      ${ctx.orgId}::uuid,
      ${input.meetingId}::uuid,
      ${input.keyId}::text,
      ${input.kind}::text,
      ${wrappedKey}::bytea
    )`.execute(ctx.trx);

    const fileId = randomUUID();
    const filename = `meeting-${input.meetingId}.${input.kind === 'audio' ? 'opus' : 'mp4'}`;
    await ctx.trx
      .insertInto('crove_kernel.file')
      .values({
        org_id: ctx.orgId,
        id: fileId,
        filename,
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
        .values({
          org_id: ctx.orgId,
          id: randomUUID(),
          meeting_id: input.meetingId,
          file_id: fileId,
          segment_order: 0,
          start_offset_seconds: 0,
          length_seconds: input.lengthSeconds ?? 1800,
        })
        .execute();
    } else {
      const videoRetentionDate = new Date(ctx.now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
      await ctx.trx
        .insertInto('crove_meetings.meeting_video')
        .values({
          org_id: ctx.orgId,
          id: randomUUID(),
          meeting_id: input.meetingId,
          file_id: fileId,
          length_seconds: input.lengthSeconds ?? 1800,
          video_retention_date: videoRetentionDate,
        })
        .execute();
    }

    ctx.audit({ meetingId: input.meetingId, kind: input.kind, fileId });
    return { fileId };
  },
});

export const meetingDelete = defineCommand({
  name: 'meetings.meeting.delete',
  input: zMeetingRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id', 'recorder_user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }

    if (meeting.recorder_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can delete this meeting');
    }

    await sql`SELECT crove_meetings.media_key_shred(${ctx.orgId}::uuid, ${input.meetingId}::uuid)`.execute(ctx.trx);
    await ctx.trx
      .deleteFrom('crove_meetings.meeting')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .execute();

    ctx.audit({ meetingId: input.meetingId, shredded: true });
    return { meetingId: input.meetingId, shredded: true };
  },
});

export const meetingOwnerDelete = defineCommand({
  name: 'meetings.meeting.owner_delete',
  input: zMeetingRef,
  risk: 'R3',
  sideEffect: 'internal',
  access: ['owner'],
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    await sql`SELECT crove_meetings.media_key_shred(${ctx.orgId}::uuid, ${input.meetingId}::uuid)`.execute(ctx.trx);

    const { rows } = await sql<{ deleted: boolean }>`
      SELECT crove_meetings.meeting_owner_delete(${ctx.orgId}::uuid, ${input.meetingId}::uuid) AS deleted
    `.execute(ctx.trx);

    if (!rows[0]?.deleted) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }

    ctx.audit({ meetingId: input.meetingId, shredded: true, complianceOwnerDelete: true });
    return { meetingId: input.meetingId, shredded: true };
  },
});

export const meetingReaderAdd = defineCommand({
  name: 'meetings.reader.add',
  input: zMeetingReaderAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id', 'recorder_user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    if (meeting.recorder_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can add readers');
    }

    const member = await ctx.trx
      .selectFrom('crove_kernel.tenant_member')
      .select(['role'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', input.userId)
      .where('role', 'in', ['owner', 'admin', 'member'])
      .executeTakeFirst();
    if (!member) {
      throw new DomainError('INVALID_READER', 400, 'Reader must be an active non-viewer member of this organization');
    }

    await ctx.trx
      .insertInto('crove_meetings.meeting_reader')
      .values({
        org_id: ctx.orgId,
        id: randomUUID(),
        meeting_id: input.meetingId,
        user_id: input.userId,
      })
      .onConflict((oc) => oc.columns(['org_id', 'meeting_id', 'user_id']).doNothing())
      .execute();

    ctx.audit({ meetingId: input.meetingId, addedUserId: input.userId });
    return { meetingId: input.meetingId, userId: input.userId };
  },
});

export const meetingReaderRemove = defineCommand({
  name: 'meetings.reader.remove',
  input: zMeetingReaderRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id', 'recorder_user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    if (meeting.recorder_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can remove readers');
    }

    await ctx.trx
      .deleteFrom('crove_meetings.meeting_reader')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('user_id', '=', input.userId)
      .execute();

    ctx.audit({ meetingId: input.meetingId, removedUserId: input.userId });
    return { meetingId: input.meetingId, userId: input.userId };
  },
});

export const meetingList = defineQuery({
  name: 'meetings.meeting.list',
  input: zMeetingListInput,
  access: READERS,
  handler: async (ctx, input): Promise<MeetingSummary[]> => {
    let query = ctx.trx
      .selectFrom('crove_meetings.meeting')
      .selectAll()
      .where('org_id', '=', ctx.orgId);

    if (input.visibility) {
      query = query.where('visibility', '=', input.visibility);
    }

    const rows = (await query
      .orderBy('started_at', 'desc')
      .limit(input.limit ?? 50)
      .execute()) as unknown as MeetingRow[];

    if (rows.length === 0) return [];

    const meetingIds = rows.map((r) => r.id);

    const readers = await ctx.trx
      .selectFrom('crove_meetings.meeting_reader')
      .select(['meeting_id', sql<string>`count(*)::text`.as('count')])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', 'in', meetingIds)
      .groupBy('meeting_id')
      .execute();
    const readersMap = new Map(readers.map((r) => [r.meeting_id, Number(r.count)]));

    const audioSegments = await ctx.trx
      .selectFrom('crove_meetings.audio_segment')
      .select(['meeting_id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', 'in', meetingIds)
      .execute();
    const audioSet = new Set(audioSegments.map((a) => a.meeting_id));

    const videos = await ctx.trx
      .selectFrom('crove_meetings.meeting_video')
      .select(['meeting_id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', 'in', meetingIds)
      .execute();
    const videoSet = new Set(videos.map((v) => v.meeting_id));

    return rows.map((r) =>
      toSummary(r, readersMap.get(r.id) ?? 0, audioSet.has(r.id), videoSet.has(r.id)),
    );
  },
});

export const meetingGet = defineQuery({
  name: 'meetings.meeting.get',
  input: zMeetingRef,
  access: READERS,
  handler: async (ctx, input): Promise<MeetingDetail> => {
    const userId = userOf(ctx.actor);
    const meeting = (await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst()) as unknown as MeetingRow | undefined;
    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }

    const readers = await ctx.trx
      .selectFrom('crove_meetings.meeting_reader')
      .select(['user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .execute();
    const readerIds = readers.map((r) => r.user_id);

    const audioSegment = await ctx.trx
      .selectFrom('crove_meetings.audio_segment')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();

    const video = await ctx.trx
      .selectFrom('crove_meetings.meeting_video')
      .select(['id', 'video_retention_date'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();

    const videoRetentionDate = video?.video_retention_date
      ? typeof video.video_retention_date === 'string'
        ? video.video_retention_date.slice(0, 10)
        : new Date(video.video_retention_date).toISOString().slice(0, 10)
      : null;

    const summary = toSummary(meeting, readerIds.length, audioSegment !== undefined, video !== undefined);
    return {
      ...summary,
      consentMethod: meeting.consent_method,
      consentConfirmedBy: meeting.consent_confirmed_by,
      consentConfirmedAt: new Date(meeting.consent_confirmed_at).toISOString(),
      consentNoticeVersion: meeting.consent_notice_version,
      readers: readerIds,
      videoRetentionDate,
      isRecorder: meeting.recorder_user_id === userId,
    };
  },
});

export const meetingAudioRead = defineQuery({
  name: 'meetings.meeting.audio_read',
  input: zMeetingRef,
  access: READERS,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }

    const { rows: readerRows } = await sql<{ ok: boolean }>`
      SELECT crove_meetings.is_meeting_reader(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${userId}::uuid) AS ok
    `.execute(ctx.trx);
    if (!readerRows[0]?.ok) {
      throw new DomainError('FORBIDDEN', 403, 'You do not have permission to play meeting audio');
    }

    const { rows: keyRows } = await sql<{ key_id: string; wrapped_key: Buffer }>`
      SELECT key_id, wrapped_key FROM crove_meetings.media_key_read(${ctx.orgId}::uuid, ${input.meetingId}::uuid, 'audio')
    `.execute(ctx.trx);
    if (keyRows.length === 0 || !keyRows[0]) {
      throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting audio key has been shredded');
    }

    const segment = await ctx.trx
      .selectFrom('crove_meetings.audio_segment as s')
      .innerJoin('crove_kernel.file as f', (join) =>
        join.onRef('f.org_id', '=', 's.org_id').onRef('f.id', '=', 's.file_id'),
      )
      .select(['f.id as fileId', 'f.storage_key as storageKey', 'f.generation as generation', 'f.size_bytes as sizeBytes', 'f.sha256', 'f.content_type as contentType'])
      .where('s.org_id', '=', ctx.orgId)
      .where('s.meeting_id', '=', input.meetingId)
      .executeTakeFirst();
    if (!segment) {
      throw new DomainError('AUDIO_NOT_FOUND', 404, 'Meeting audio segment not found');
    }

    return {
      meetingId: input.meetingId,
      fileId: segment.fileId,
      storageKey: segment.storageKey,
      generation: segment.generation,
      sizeBytes: Number(segment.sizeBytes),
      sha256: segment.sha256,
      contentType: segment.contentType,
      keyId: keyRows[0].key_id,
      wrappedKey: keyRows[0].wrapped_key,
    };
  },
});

export const meetingVideoRead = defineQuery({
  name: 'meetings.meeting.video_read',
  input: zMeetingRef,
  access: READERS,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }

    const { rows: readerRows } = await sql<{ ok: boolean }>`
      SELECT crove_meetings.is_meeting_reader(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${userId}::uuid) AS ok
    `.execute(ctx.trx);
    if (!readerRows[0]?.ok) {
      throw new DomainError('FORBIDDEN', 403, 'You do not have permission to play meeting video');
    }

    const { rows: keyRows } = await sql<{ key_id: string; wrapped_key: Buffer }>`
      SELECT key_id, wrapped_key FROM crove_meetings.media_key_read(${ctx.orgId}::uuid, ${input.meetingId}::uuid, 'video')
    `.execute(ctx.trx);
    if (keyRows.length === 0 || !keyRows[0]) {
      throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting video key has been shredded');
    }

    const video = await ctx.trx
      .selectFrom('crove_meetings.meeting_video as v')
      .innerJoin('crove_kernel.file as f', (join) =>
        join.onRef('f.org_id', '=', 'v.org_id').onRef('f.id', '=', 'v.file_id'),
      )
      .select(['f.id as fileId', 'f.storage_key as storageKey', 'f.generation as generation', 'f.size_bytes as sizeBytes', 'f.sha256', 'f.content_type as contentType'])
      .where('v.org_id', '=', ctx.orgId)
      .where('v.meeting_id', '=', input.meetingId)
      .executeTakeFirst();
    if (!video) {
      throw new DomainError('VIDEO_NOT_FOUND', 404, 'Meeting video not found');
    }

    return {
      meetingId: input.meetingId,
      fileId: video.fileId,
      storageKey: video.storageKey,
      generation: video.generation,
      sizeBytes: Number(video.sizeBytes),
      sha256: video.sha256,
      contentType: video.contentType,
      keyId: keyRows[0].key_id,
      wrappedKey: keyRows[0].wrapped_key,
    };
  },
});

export const meetingMediaMeta = defineQuery({
  name: 'meetings.meeting.media_meta',
  input: zMeetingMediaMeta,
  access: READERS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }

    const { rows: readerRows } = await sql<{ ok: boolean }>`
      SELECT crove_meetings.is_meeting_reader(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${userId}::uuid) AS ok
    `.execute(ctx.trx);
    if (!readerRows[0]?.ok) {
      throw new DomainError('FORBIDDEN', 403, 'You do not have permission to play meeting media');
    }

    const { rows: keyRows } = await sql<{ key_id: string; wrapped_key: Buffer }>`
      SELECT key_id, wrapped_key FROM crove_meetings.media_key_read(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${input.kind})
    `.execute(ctx.trx);
    if (keyRows.length === 0 || !keyRows[0]) {
      throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting media key has been shredded');
    }

    if (input.kind === 'audio') {
      const segment = await ctx.trx
        .selectFrom('crove_meetings.audio_segment as s')
        .innerJoin('crove_kernel.file as f', (join) =>
          join.onRef('f.org_id', '=', 's.org_id').onRef('f.id', '=', 's.file_id'),
        )
        .select(['f.id as fileId', 'f.storage_key as storageKey', 'f.generation as generation', 'f.size_bytes as sizeBytes', 'f.sha256', 'f.content_type as contentType'])
        .where('s.org_id', '=', ctx.orgId)
        .where('s.meeting_id', '=', input.meetingId)
        .executeTakeFirst();
      if (!segment) {
        throw new DomainError('AUDIO_NOT_FOUND', 404, 'Meeting audio segment not found');
      }
      return {
        meetingId: input.meetingId,
        fileId: segment.fileId,
        storageKey: segment.storageKey,
        generation: segment.generation,
        sizeBytes: Number(segment.sizeBytes),
        sha256: segment.sha256,
        contentType: segment.contentType,
        keyId: keyRows[0].key_id,
        wrappedKey: keyRows[0].wrapped_key,
      };
    } else {
      const video = await ctx.trx
        .selectFrom('crove_meetings.meeting_video as v')
        .innerJoin('crove_kernel.file as f', (join) =>
          join.onRef('f.org_id', '=', 'v.org_id').onRef('f.id', '=', 'v.file_id'),
        )
        .select(['f.id as fileId', 'f.storage_key as storageKey', 'f.generation as generation', 'f.size_bytes as sizeBytes', 'f.sha256', 'f.content_type as contentType'])
        .where('v.org_id', '=', ctx.orgId)
        .where('v.meeting_id', '=', input.meetingId)
        .executeTakeFirst();
      if (!video) {
        throw new DomainError('VIDEO_NOT_FOUND', 404, 'Meeting video not found');
      }
      return {
        meetingId: input.meetingId,
        fileId: video.fileId,
        storageKey: video.storageKey,
        generation: video.generation,
        sizeBytes: Number(video.sizeBytes),
        sha256: video.sha256,
        contentType: video.contentType,
        keyId: keyRows[0].key_id,
        wrappedKey: keyRows[0].wrapped_key,
      };
    }
  },
});

export const meetingsCommands = [
  meetingCreate,
  meetingMediaRecord,
  meetingDelete,
  meetingOwnerDelete,
  meetingReaderAdd,
  meetingReaderRemove,
];

export const meetingsQueries = [
  meetingList,
  meetingGet,
  meetingAudioRead,
  meetingVideoRead,
  meetingMediaMeta,
];
