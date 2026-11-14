// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { CONSENT_NOTICE_VERSION, MEETING } from './manifest.ts';
import { meetingSearch } from './search.ts';
import { transcriptCorrect, transcriptDraftStore, transcriptGet } from './transcript.ts';
import { transcribeCommandList } from './transcribe.ts';
import { transcribeRunCommands, transcribeRunQueries } from './transcribe-run.ts';
import { notesCommands, notesQueries } from './notes.ts';
import { resultCommands, resultQueries } from './results.ts';
import { summaryCommands, summaryQueries } from './summary.ts';
import { summaryRunCommands, summaryRunQueries } from './summary-run.ts';
import { translateCommands } from './translate.ts';
import { translateRunCommands, translateRunQueries } from './translate-run.ts';
import { linkCommands, linkQueries } from './links.ts';
import { hookCommands, hookQueries } from './hook.ts';
import { liveNotesCommands } from './live-notes.ts';
import { liveRunCommands, liveRunQueries } from './live-run.ts';
import { liveCommands } from './live.ts';
import { liveAssembleCommands, liveAssembleQueries } from './live-assemble.ts';
import { recordSealedMedia } from './media-record.ts';
import { dropFollowupPayloads } from './followup-erase.ts';
import { followupCommands, followupQueries } from './followup.ts';
import {
  dayText,
  meetingMediaDiscard,
  meetingMediaOrphanKeys,
  meetingRetentionShred,
  meetingConsentPolicyGet,
  meetingConsentPolicySet,
  meetingSettingsGet,
  meetingSettingsSet,
  readConsentPolicy,
  meetingShredReplay,
  readRetentionSettings,
  retentionDates,
  vnDay,
} from './retention.ts';
import {
  auditValue,
  MEETING_OWNER_LIST_PAGE,
  zMeetingCreate,
  consentMethodAllowed,
  zMeetingExtensionStatus,
  zMeetingRecordingNow,
  zMeetingRecordingNowInput,
  RECORDING_NOW_WINDOW_HOURS,
  type MeetingRecordingNow,
  zMeetingListInput,
  zMeetingMediaKeyReseal,
  zMeetingMediaMeta,
  zMeetingMediaRecord,
  zMeetingOwnerListInput,
  zMeetingReaderAdd,
  zMeetingReaderRemove,
  zMeetingRef,
  type ConsentMethod,
  type MeetingDetail,
  type MeetingExtensionStatus,
  type RecordingStopReason,
  type MeetingLanguage,
  type MeetingSummaryTemplate,
  type MeetingOwnerList,
  type MeetingOwnerListItem,
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

export { mediaExtension } from './media-record.ts';

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
  live_notes: boolean;
  summary_template: MeetingSummaryTemplate;
  consent_method: ConsentMethod;
  consent_confirmed_by: string;
  consent_confirmed_at: Date | string;
  consent_notice_version: string;
  recording_stop_reason: RecordingStopReason | null;
  audio_retention_date: Date | string;
  text_retention_date: Date | string | null;
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
    liveNotes: r.live_notes,
    summaryTemplate: r.summary_template,
    audioRetentionDate: dayText(r.audio_retention_date),
    textRetentionDate: r.text_retention_date === null ? null : dayText(r.text_retention_date),
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
  // The Ludy extension's meetings scope may create a meeting (ADR-0047 point 10, #2582); it is stamped with the token.
  extension: { scope: 'meetings' },
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const extensionTokenId = ctx.actor.type === 'user' ? (ctx.actor.extension?.tokenId ?? null) : null;
    // A strict org accepts only a written consent method (A2, #3160): the same refusal for an in-app recording, an extension recording and an
    // upload, since all three make their meeting here. Nothing is created and no audio can follow. A policy changed later does not touch this one.
    if (!consentMethodAllowed(await readConsentPolicy(ctx.trx, ctx.orgId), input.consentMethod)) {
      throw new DomainError('CONSENT_METHOD_NOT_ALLOWED', 422, 'This organization accepts only a written consent method');
    }
    const meetingId = randomUUID();
    const startedAt = ctx.now;
    // The periods the org's settings give today, stamped on the meeting so the period the participants were told stays true (plan section 9).
    const dates = retentionDates(startedAt, await readRetentionSettings(ctx.trx, ctx.orgId));

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
        live_notes: input.liveNotes,
        summary_template: input.summaryTemplate,
        consent_method: input.consentMethod,
        consent_confirmed_by: userId,
        consent_confirmed_at: startedAt,
        consent_notice_version: input.consentNoticeVersion ?? CONSENT_NOTICE_VERSION,
        audio_retention_date: dates.audio,
        text_retention_date: dates.text,
        extension_token_id: extensionTokenId,
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
      consentNoticeVersion: input.consentNoticeVersion ?? CONSENT_NOTICE_VERSION,
      liveNotes: input.liveNotes,
      summaryTemplate: input.summaryTemplate,
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
  // The extension's meetings scope finishes the upload of a meeting its own token created, and no other (#2582).
  extension: { scope: 'meetings' },
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id', 'recorder_user_id', 'keep_video', 'extension_token_id', 'started_at', 'ended_at', 'recording_stop_reason', sql<string>`audio_retention_date::text`.as('audio_retention_day')])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }
    if (meeting.recorder_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder may record media');
    }
    // An extension token reaches only the meetings it created: any other is answered as one that does not exist.
    if (ctx.actor.type === 'user' && ctx.actor.extension && meeting.extension_token_id !== ctx.actor.extension.tokenId) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }
    if (input.kind === 'video' && !meeting.keep_video) {
      throw new DomainError('VIDEO_NOT_ENABLED', 400, 'Video retention is disabled for this meeting');
    }
    // Media is not accepted for a meeting whose period for it has ended: the nightly job would shred it at once, and it was told to the participants that
    // it would not be kept past that day (#2579).
    if (meeting.audio_retention_day <= vnDay(ctx.now)) {
      throw new DomainError('MEDIA_RETENTION_PASSED', 409, 'The retention period of this meeting has ended');
    }
    if (input.storageKey !== fileKey(ctx.orgId, input.sha256)) {
      throw new DomainError('INVALID_STORAGE_KEY', 400, 'Storage key must match org and sha256');
    }

    const { fileId, liveChunksDiscarded } = await recordSealedMedia(ctx, { userId, meetingId: input.meetingId, audioRetentionDay: meeting.audio_retention_day, input });

    // A recording that stopped without the recorder's click (A1, #3159): the reason code and the stop time (the start plus what was
    // recorded, never later than now) stay on the meeting, once, so it can say "Ghi âm đã dừng lúc ...". A code, never text.
    // Every recording that reaches the server ends its meeting's recording: ended_at is set once (the first media wins), which is also what
    // takes the meeting out of the app's recording chip.
    if (meeting.ended_at === null && meeting.started_at !== null) {
      const endedAt = new Date(Math.min(new Date(meeting.started_at).getTime() + input.lengthSeconds * 1000, ctx.now.getTime()));
      await ctx.trx
        .updateTable('crove_meetings.meeting')
        .set({ ended_at: endedAt, updated_at: ctx.now, ...(input.stopReason !== undefined && meeting.recording_stop_reason === null ? { recording_stop_reason: input.stopReason } : {}) })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.meetingId)
        .execute();
    }

    ctx.audit({ meetingId: input.meetingId, kind: input.kind, fileId, ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}), ...(liveChunksDiscarded > 0 ? { liveChunksDiscarded } : {}) });
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
    // The follow-up mails hold a copy of the shared text: it goes with the meeting (#3016).
    const mailPayloads = await dropFollowupPayloads(ctx, input.meetingId);
    await ctx.trx
      .deleteFrom('crove_meetings.meeting')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .execute();

    ctx.audit({ meetingId: input.meetingId, shredded: true, mailPayloads });
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
    // The follow-up mails hold a copy of the shared text: it goes with the meeting (#3016). A meeting that does not exist has none, and the delete below then says so.
    const mailPayloads = await dropFollowupPayloads(ctx, input.meetingId);

    const { rows } = await sql<{ deleted: boolean }>`
      SELECT crove_meetings.meeting_owner_delete(${ctx.orgId}::uuid, ${input.meetingId}::uuid) AS deleted
    `.execute(ctx.trx);

    if (!rows[0]?.deleted) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }

    ctx.audit({ meetingId: input.meetingId, shredded: true, complianceOwnerDelete: true, mailPayloads });
    return { meetingId: input.meetingId, shredded: true };
  },
});

// The owner's compliance list (#2703, ADR-0047): every meeting of the org as metadata only, the attendees-only ones the owner is no reader
// of included, so the owner can pick one for meetings.meeting.owner_delete. A command, not a query, so every call leaves an audit row; the
// row holds counts and ids, never text. The definer checks the owner again and answers no text column.
const OWNER_LIST_STATUS: Record<number, MeetingStatus> = { 1: 'ready', 2: 'processing', 3: 'completed', 4: 'error' };

export const meetingOwnerList = defineCommand({
  name: 'meetings.meeting.owner_list',
  input: zMeetingOwnerListInput,
  risk: 'R0',
  sideEffect: 'none',
  access: ['owner'],
  handler: async (ctx, input): Promise<MeetingOwnerList> => {
    userOf(ctx.actor);
    const limit = input.limit ?? MEETING_OWNER_LIST_PAGE;
    // One row more than the page tells whether another page follows. The definer caps a call at the page size, so a full page asks
    // again for one row past it instead.
    const { rows } = await sql<{
      id: string;
      started_text: string;
      recorder_user_id: string;
      org_wide: boolean;
      status_code: number;
      audio_retention_date: Date | string;
      video_retention_date: Date | string | null;
      text_retention_date: Date | string | null;
    }>`
      SELECT l.id, pg_catalog.to_json(l.started_at) #>> '{}' AS started_text, l.recorder_user_id, l.org_wide, l.status_code,
             l.audio_retention_date, l.video_retention_date, l.text_retention_date
      FROM crove_meetings.meeting_owner_list_page(${ctx.orgId}::uuid, ${limit}::integer, ${input.afterStartedAt ?? null}::timestamptz, ${input.afterId ?? null}::uuid) l
    `.execute(ctx.trx);
    const items: MeetingOwnerListItem[] = rows.map((r) => ({
      id: r.id,
      recorderUserId: r.recorder_user_id,
      startedAt: r.started_text,
      visibility: r.org_wide ? 'org' : 'attendees',
      status: OWNER_LIST_STATUS[r.status_code] ?? 'error',
      audioRetentionDate: dayText(r.audio_retention_date),
      videoRetentionDate: r.video_retention_date === null ? null : dayText(r.video_retention_date),
      textRetentionDate: r.text_retention_date === null ? null : dayText(r.text_retention_date),
    }));
    let next: MeetingOwnerList['next'] = null;
    const last = items[items.length - 1];
    if (items.length === limit && last) {
      const { rows: more } = await sql<{ id: string }>`
        SELECT l.id FROM crove_meetings.meeting_owner_list_page(${ctx.orgId}::uuid, 1, ${last.startedAt}::timestamptz, ${last.id}::uuid) l
      `.execute(ctx.trx);
      if (more.length > 0) next = { afterStartedAt: last.startedAt, afterId: last.id };
    }
    ctx.audit({ count: items.length, limit, paged: input.afterId !== undefined, more: next !== null });
    return { items, next };
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

// After a credential key rotation: the worker stores one media key wrapped under the current key, only if the stored key is still
// the one it read (the definer compares the key id and the wrapped bytes under the update). System actor only.
export const meetingMediaKeyReseal = defineCommand({
  name: 'meetings.media_key.reseal',
  input: zMeetingMediaKeyReseal,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Only a system actor may do this');
    const { rows } = await sql<{ resealed: boolean }>`
      SELECT crove_meetings.media_key_reseal(
        ${ctx.orgId}::uuid,
        ${input.id}::uuid,
        ${input.fromKeyId}::text,
        ${input.toKeyId}::text,
        ${Buffer.from(input.fromWrappedKeyHex, 'hex')}::bytea,
        ${Buffer.from(input.wrappedKeyHex, 'hex')}::bytea
      ) AS resealed
    `.execute(ctx.trx);
    const resealed = rows[0]?.resealed === true;
    // Key ids only: they name a key without revealing it.
    if (resealed) ctx.audit({ keyRowId: input.id, fromKeyId: input.fromKeyId, toKeyId: input.toKeyId });
    return { resealed };
  },
});

// The recording indicator of the app header (A1, #3159): the caller's own meeting made by the extension that has no audio yet
// (no media recorded yet, so no end time) and started in the last RECORDING_NOW_WINDOW_HOURS. A person's own meetings only; nothing of any other member. Not sensitive:
// it returns an id and a start time, never a title, and the app asks every few seconds.
export const meetingRecordingNow = defineQuery({
  name: 'meetings.meeting.recording_now',
  input: zMeetingRecordingNowInput,
  access: READERS,
  handler: async (ctx): Promise<MeetingRecordingNow> => {
    const userId = userOf(ctx.actor);
    const now = new Date();
    const since = new Date(now.getTime() - RECORDING_NOW_WINDOW_HOURS * 3_600_000);
    const row = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id', 'started_at'])
      .where('org_id', '=', ctx.orgId)
      .where('recorder_user_id', '=', userId)
      .where('status', '=', 'ready')
      .where('extension_token_id', 'is not', null)
      .where('started_at', '>', since)
      .where('ended_at', 'is', null)
      .where((eb) => eb.or([eb('text_retention_date', 'is', null), eb('text_retention_date', '>', vnDay(now))]))
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return zMeetingRecordingNow.parse({
      recording: row ? { meetingId: row.id, startedAt: new Date(row.started_at as Date | string).toISOString() } : null,
    });
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
      .where('org_id', '=', ctx.orgId)
      // A meeting past its text date is gone from its day, not from the nightly job's run (#2579).
      .where((eb) => eb.or([eb('text_retention_date', 'is', null), eb('text_retention_date', '>', vnDay(new Date()))]));

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
    if (!meeting || (meeting.text_retention_date !== null && dayText(meeting.text_retention_date) <= vnDay(new Date()))) {
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
      recordingStopReason: meeting.recording_stop_reason,
      readers: readerIds,
      videoRetentionDate,
      isRecorder: meeting.recorder_user_id === userId,
    };
  },
});

// What the Ludy extension may read of a meeting (#2582, ADR-0047 point 10): its status, whether its audio and video arrived
// and its length, never its title, readers, transcript or media. A token reaches only the meetings it created, and the
// recorder of one (an owner or admin included) no other; every other case is the same 404. Each read leaves an audit
// row that names the token, so a device's use of the meetings scope can be listed.
export const meetingExtensionStatus = defineQuery({
  name: 'meetings.meeting.extension_status',
  input: zMeetingRef,
  access: READERS,
  extension: { scope: 'meetings' },
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MeetingExtensionStatus> => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id', 'recorder_user_id', 'status', 'keep_video', 'live_notes', 'length_seconds', 'extension_token_id', sql<string | null>`text_retention_date::text`.as('text_day')])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    const tokenId = ctx.actor.type === 'user' ? (ctx.actor.extension?.tokenId ?? null) : null;
    if (
      !meeting ||
      meeting.recorder_user_id !== userId ||
      (tokenId !== null && meeting.extension_token_id !== tokenId) ||
      (meeting.text_day !== null && meeting.text_day <= vnDay(new Date()))
    ) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }
    const audio = await ctx.trx
      .selectFrom('crove_meetings.audio_segment')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();
    const video = await ctx.trx
      .selectFrom('crove_meetings.meeting_video')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();
    return zMeetingExtensionStatus.parse({
      meetingId: input.meetingId,
      status: meeting.status,
      keepVideo: meeting.keep_video,
      liveNotes: meeting.live_notes,
      hasAudio: audio !== undefined,
      hasVideo: video !== undefined,
      lengthSeconds: meeting.length_seconds,
    });
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
      .select(['id', sql<string>`audio_retention_date::text`.as('audio_day'), sql<string | null>`text_retention_date::text`.as('text_day')])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }
    // A period that has ended is final from its day, not from the nightly job's run (#2579).
    if (meeting.audio_day <= vnDay(new Date()) || (meeting.text_day !== null && meeting.text_day <= vnDay(new Date()))) {
      throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting media retention has ended');
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
      .select(['id', sql<string>`audio_retention_date::text`.as('audio_day'), sql<string | null>`text_retention_date::text`.as('text_day')])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }
    // A period that has ended is final from its day, not from the nightly job's run (#2579).
    if (meeting.text_day !== null && meeting.text_day <= vnDay(new Date())) {
      throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting media retention has ended');
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
      .select(['f.id as fileId', 'f.storage_key as storageKey', 'f.generation as generation', 'f.size_bytes as sizeBytes', 'f.sha256', 'f.content_type as contentType', sql<string>`v.video_retention_date::text`.as('videoDay')])
      .where('v.org_id', '=', ctx.orgId)
      .where('v.meeting_id', '=', input.meetingId)
      .executeTakeFirst();
    if (!video) {
      throw new DomainError('VIDEO_NOT_FOUND', 404, 'Meeting video not found');
    }
    if (video.videoDay <= vnDay(new Date())) throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting media retention has ended');

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
      .select(['id', sql<string>`audio_retention_date::text`.as('audio_day'), sql<string | null>`text_retention_date::text`.as('text_day')])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }
    // A period that has ended is final from its day, not from the nightly job's run (#2579).
    if ((input.kind === 'audio' && meeting.audio_day <= vnDay(new Date())) || (meeting.text_day !== null && meeting.text_day <= vnDay(new Date()))) {
      throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting media retention has ended');
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
        .select(['f.id as fileId', 'f.storage_key as storageKey', 'f.generation as generation', 'f.size_bytes as sizeBytes', 'f.sha256', 'f.content_type as contentType', sql<string>`v.video_retention_date::text`.as('videoDay')])
        .where('v.org_id', '=', ctx.orgId)
        .where('v.meeting_id', '=', input.meetingId)
        .executeTakeFirst();
      if (!video) {
        throw new DomainError('VIDEO_NOT_FOUND', 404, 'Meeting video not found');
      }
      if (video.videoDay <= vnDay(new Date())) throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting media retention has ended');
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
  meetingOwnerList,
  meetingReaderAdd,
  meetingReaderRemove,
  meetingMediaKeyReseal,
  meetingSettingsSet,
  meetingConsentPolicySet,
  meetingRetentionShred,
  meetingShredReplay,
  meetingMediaDiscard,
  transcriptDraftStore,
  transcriptCorrect,
  ...transcribeRunCommands,
  ...transcribeCommandList,
  ...resultCommands,
  ...notesCommands,
  ...summaryCommands,
  ...summaryRunCommands,
  ...translateCommands,
  ...translateRunCommands,
  ...linkCommands,
  ...followupCommands,
  ...liveCommands,
  ...liveAssembleCommands,
  ...liveRunCommands,
  ...liveNotesCommands,
  ...hookCommands,
];

export const meetingsQueries = [
  meetingList,
  meetingGet,
  meetingExtensionStatus,
  meetingRecordingNow,
  meetingAudioRead,
  meetingVideoRead,
  meetingMediaMeta,
  meetingSettingsGet,
  meetingConsentPolicyGet,
  meetingMediaOrphanKeys,
  transcriptGet,
  meetingSearch,
  ...transcribeRunQueries,
  ...resultQueries,
  ...notesQueries,
  ...summaryQueries,
  ...summaryRunQueries,
  ...translateRunQueries,
  ...linkQueries,
  ...followupQueries,
  ...liveRunQueries,
  ...liveAssembleQueries,
  ...hookQueries,
];
