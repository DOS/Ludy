// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import { CONSENT_NOTICE_VERSION, MEETING } from './manifest.ts';
import { meetingSearch } from './search.ts';
import { labelsOfMeetings } from './labels.ts';
import { transcriptCorrect, transcriptDraftStore, transcriptGet } from './transcript.ts';
import { createRedactCommands, redactQueries } from './redact.ts';
import { transcribeCommandList } from './transcribe.ts';
import { transcribeRunCommands, transcribeRunQueries } from './transcribe-run.ts';
import { chaptersCommands, chaptersQueries } from './chapters.ts';
import { chaptersRunCommands, chaptersRunQueries } from './chapters-run.ts';
import { placeCommands } from './place.ts';
import { titleCommands, titleQueries } from './title.ts';
import { commitmentsCommands, commitmentsQueries } from './commitments.ts';
import { templateSuggestCommands, templateSuggestQueries } from './template-suggest.ts';
import { openPointsCommands, openPointsQueries } from './open-points.ts';
import { salesInsightCommands, salesInsightQueries } from './sales-insight.ts';
import { labelSuggestCommands, labelSuggestQueries } from './label-suggest.ts';
import { notesCommands, notesQueries } from './notes.ts';
import { resultCommands, resultQueries } from './results.ts';
import { glossaryCommands, glossaryQueries } from './glossary.ts';
import { minutesTemplateCommands, minutesTemplateQueries } from './minutes-templates.ts';
import { minutesVersionCommands, minutesVersionQueries } from './minutes-version.ts';
import { mcpMeetingsQueries } from './mcp.ts';
import { seriesCommands, seriesQueries } from './series.ts';
import { speakerCommands } from './speaker.ts';
import { summaryCommands, summaryQueries } from './summary.ts';
import { summaryReadyCommands } from './summary-ready.ts';
import { summaryRunCommands, summaryRunQueries } from './summary-run.ts';
import { dropDraftTranslationsForMember, translateCommands } from './translate.ts';
import { speakingStyleQueries } from './speaking-style.ts';
import { transcriptExportQueries } from './transcript-export.ts';
import { translateRunCommands, translateRunQueries } from './translate-run.ts';
import { askRunCommands, askRunQueries } from './ask.ts';
import { briefCommands, briefQueries } from './brief.ts';
import { digestCommands, digestQueries } from './digest.ts';
import { highlightsCommands, highlightsQueries } from './highlights.ts';
import { labelsCommands, labelsQueries } from './labels.ts';
import { loadQueries } from './load.ts';
import { trackerAlertCommands, trackerAlertQueries } from './tracker-alerts.ts';
import { trackersCommands, trackersQueries } from './trackers.ts';
import { voiceCueCommands } from './voice-cue.ts';
import { minutesDocxQueries } from './minutes-docx.ts';
import { todayQueries } from './today.ts';
import { morningCommands, morningQueries } from './morning.ts';
import { weeklyCommands, weeklyQueries } from './weekly.ts';
import { assigneeCommands, assigneeQueries } from './assignee.ts';
import { adherenceCommands, adherenceQueries } from './adherence.ts';
import { agendaCommands, agendaQueries } from './agenda.ts';
import { chatCommands, chatQueries } from './chat.ts';
import { linkCommands, linkQueries } from './links.ts';
import { hookCommands, hookQueries } from './hook.ts';
import { liveNotesCommands } from './live-notes.ts';
import { liveRunCommands, liveRunQueries } from './live-run.ts';
import { liveCommands } from './live.ts';
import { captureCommands, endCapture, openCapture } from './capture.ts';
import { liveAssembleCommands, liveAssembleQueries } from './live-assemble.ts';
import { lockMeetingMedia, recordSealedMedia } from './media-record.ts';
import { createMeetingRow } from './meeting-core.ts';
import { importCommands } from './import.ts';
import { meetingMinutesEsignGet, meetingMinutesEsignSet } from './minutes-esign.ts';
import { minutesLinkCommands, minutesLinkQueries } from './minutes-link.ts';
import { dropFollowupPayloads } from './followup-erase.ts';
import { dealUpdateCommands, dealUpdateQueries } from './deal-update.ts';
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
  meetingShredReplay,
  vnDay,
} from './retention.ts';
import {
  auditValue,
  joinServiceFromUrl,
  MEETING_OWNER_LIST_PAGE,
  zMeetingCreate,
  zMeetingExtensionStatus,
  zMeetingRecordingNow,
  zMeetingRecordingNowInput,
  RECORDING_NOW_WINDOW_HOURS,
  type MeetingRecordingNow,
  zMeetingListInput,
  zMeetingMediaKeyReseal,
  zMeetingMediaMeta,
  zMeetingMediaRecord,
  zMeetingRecordingStopped,
  zMeetingRecordingStoppedDone,
  zMeetingOwnerListInput,
  zMeetingReaderAdd,
  zMeetingReaderRemove,
  zMeetingRef,
  zMeetingVisibleIdsInput,
  type ConsentMethod,
  type MeetingDetail,
  type MeetingExtensionStatus,
  type MeetingPlatform,
  type MeetingRecordingStoppedDone,
  type RecordingStopReason,
  type MeetingLanguage,
  type MeetingSummaryTemplate,
  parseStoredSections,
  type MeetingOwnerList,
  type MeetingOwnerListItem,
  type MeetingStatus,
  type MeetingListItem,
  type MeetingSummary,
  type MeetingVisibility,
} from '@ludy/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  fileKey,
  type CommandContext,
  type QueryContext,
} from '@ludy/kernel-runtime';

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
  place: string | null;
  minutes_template_name: string | null;
  minutes_template_sections: unknown;
  minutes_template_hash: string | null;
  consent_method: ConsentMethod;
  consent_confirmed_by: string;
  consent_confirmed_at: Date | string;
  consent_notice_version: string;
  recording_stop_reason: RecordingStopReason | null;
  platform_transcript_cut: boolean;
  audio_retention_date: Date | string;
  text_retention_date: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toSummary(
  r: MeetingRow,
  readersCount: number,
  hasAudio: boolean,
  hasVideo: boolean,
  hasTranscript: boolean,
  platform: MeetingPlatform | null,
): MeetingSummary {
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
    place: r.place,
    audioRetentionDate: dayText(r.audio_retention_date),
    textRetentionDate: r.text_retention_date === null ? null : dayText(r.text_retention_date),
    hasAudio,
    hasVideo,
    hasTranscript,
    platform,
    readersCount,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export const meetingCreate = defineCommand({
  name: 'meetings.meeting.create',
  // Opens a recording the app's switch-off would cut short: it holds the tenant row, as the switch does (ADR-0053).
  opensBusyWork: true,
  input: zMeetingCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // The Ludy extension's meetings scope may create a meeting (ADR-0047 point 10, #2582); it is stamped with the token.
  extension: { scope: 'meetings' },
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const extensionTokenId = ctx.actor.type === 'user' ? (ctx.actor.extension?.tokenId ?? null) : null;
    const meetingId = await createMeetingRow(ctx, {
      userId,
      title: input.title,
      language: input.language,
      visibility: input.visibility,
      startedAt: ctx.now,
      retentionFrom: ctx.now,
      lengthSeconds: input.lengthSeconds ?? null,
      keepVideo: input.keepVideo,
      liveNotes: input.liveNotes,
      summaryTemplate: input.summaryTemplate,
      consentMethod: input.consentMethod,
      consentNoticeVersion: input.consentNoticeVersion ?? CONSENT_NOTICE_VERSION,
      readerUserIds: input.readerUserIds,
      extensionTokenId,
    });
    // A live recording is a capture (ADR-0055 slice 1, #4123), and an extension token always is: asked here, in the meeting's own transaction, so a refused start (CAPTURE_ALREADY_RUNNING) leaves no meeting.
    const captureKind = input.capture !== undefined || extensionTokenId !== null ? await openCapture(ctx, meetingId, input.capture) : null;

    ctx.audit({
      meetingId,
      title: auditValue(MEETING, 'title', input.title),
      visibility: input.visibility,
      consentMethod: input.consentMethod,
      consentNoticeVersion: input.consentNoticeVersion ?? CONSENT_NOTICE_VERSION,
      liveNotes: input.liveNotes,
      summaryTemplate: input.summaryTemplate,
      ...(captureKind !== null ? { capture: captureKind } : {}),
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
      .selectFrom('ludy_meetings.meeting')
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

    const { fileId, liveChunksDiscarded, replaced } = await recordSealedMedia(ctx, { userId, meetingId: input.meetingId, audioRetentionDay: meeting.audio_retention_day, joinedFromPieces: false, input });

    // A recording that stopped without the recorder's click (A1, #3159): the reason code stays on the meeting, once (with the first media, which is also what
    // recordSealedMedia ends the meeting's recording on, #3205), so it can say "Ghi âm đã dừng lúc ...". A code, never text. The stop reason is this command's
    // alone: a recording joined from live pieces carries none.
    if (meeting.ended_at === null && meeting.started_at !== null && input.stopReason !== undefined && meeting.recording_stop_reason === null) {
      await ctx.trx
        .updateTable('ludy_meetings.meeting')
        .set({ recording_stop_reason: input.stopReason, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.meetingId)
        // Once: a reason a report already left (#3196) is kept.
        .where('recording_stop_reason', 'is', null)
        .execute();
    }

    ctx.audit({ meetingId: input.meetingId, kind: input.kind, fileId, ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}), ...(liveChunksDiscarded > 0 ? { liveChunksDiscarded } : {}), ...(replaced ? { replacedJoined: true } : {}) });
    return { fileId };
  },
});

// A recording ended and no media will reach the server (#3196): the extension stopped with nothing saved, the upload never arrived, or the
// capture failed to start after the meeting was made. It sets the meeting's end time and, for a stop the member did not ask for, the stop code,
// once, so the app's recording chip lets go at once instead of after its window. Codes and a length only, in the input and the audit.
// A no-op (and `ended: false`) once the meeting has any recording or an end time, so a late or repeated call changes nothing.
export const meetingRecordingStopped = defineCommand({
  name: 'meetings.meeting.recording_stopped',
  input: zMeetingRecordingStopped,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // The extension's meetings scope reports the end of a meeting its own token created, and no other (#3196).
  extension: { scope: 'meetings' },
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MeetingRecordingStoppedDone> => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .select(['recorder_user_id', 'extension_token_id', 'started_at', 'ended_at', 'recording_stop_reason'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder may end its recording');
    // An extension token reaches only the meetings it created: any other is answered as one that does not exist.
    if (ctx.actor.type === 'user' && ctx.actor.extension && meeting.extension_token_id !== ctx.actor.extension.tokenId) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }
    // The media lock first, so a recording being stored at this moment either commits before the checks below or waits for this transaction.
    await lockMeetingMedia(ctx, input.meetingId);
    // The recorder says the recording is over, whether or not anything was recorded: the call is free again (ADR-0055 slice 1, #4123).
    await endCapture(ctx, input.meetingId, 'stopped');
    const { rows: held } = await sql<{ recorded: boolean; ended: boolean }>`
      SELECT EXISTS (SELECT 1 FROM ludy_meetings.audio_segment WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${input.meetingId}::uuid)
          OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_video WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${input.meetingId}::uuid) AS recorded,
             (SELECT ended_at IS NOT NULL FROM ludy_meetings.meeting WHERE org_id = ${ctx.orgId}::uuid AND id = ${input.meetingId}::uuid) AS ended`.execute(ctx.trx);
    const changed = held[0]?.recorded !== true && held[0]?.ended !== true;
    if (changed) {
      const length = input.lengthSeconds === undefined || meeting.started_at === null ? null : input.lengthSeconds;
      await sql`
        UPDATE ludy_meetings.meeting
        SET ended_at = CASE WHEN ${length}::int IS NULL THEN ${ctx.now}::timestamptz ELSE LEAST(started_at + (${length}::int * interval '1 second'), ${ctx.now}::timestamptz) END,
            recording_stop_reason = COALESCE(recording_stop_reason, ${input.reason ?? null}::text),
            updated_at = ${ctx.now}::timestamptz
        WHERE org_id = ${ctx.orgId}::uuid AND id = ${input.meetingId}::uuid AND ended_at IS NULL`.execute(ctx.trx);
    }
    ctx.audit({ meetingId: input.meetingId, changed, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
    return zMeetingRecordingStoppedDone.parse({ meetingId: input.meetingId, ended: changed });
  },
});

export const meetingDelete = defineCommand({
  name: 'meetings.meeting.delete',
  runsWhenOff: 'deletes a meeting and its recording, which the owner of the data may still do while the app is off',
  input: zMeetingRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('ludy_meetings.meeting')
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

    await sql`SELECT ludy_meetings.media_key_shred(${ctx.orgId}::uuid, ${input.meetingId}::uuid)`.execute(ctx.trx);
    // The follow-up mails hold a copy of the shared text: it goes with the meeting (#3016).
    const mailPayloads = await dropFollowupPayloads(ctx, input.meetingId);
    await ctx.trx
      .deleteFrom('ludy_meetings.meeting')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .execute();

    ctx.audit({ meetingId: input.meetingId, shredded: true, mailPayloads });
    return { meetingId: input.meetingId, shredded: true };
  },
});

export const meetingOwnerDelete = defineCommand({
  name: 'meetings.meeting.owner_delete',
  runsWhenOff: 'deletes a meeting and its recording on the org owner\'s word while the app is off',
  input: zMeetingRef,
  risk: 'R3',
  sideEffect: 'internal',
  access: ['owner'],
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    await sql`SELECT ludy_meetings.media_key_shred(${ctx.orgId}::uuid, ${input.meetingId}::uuid)`.execute(ctx.trx);
    // The follow-up mails hold a copy of the shared text: it goes with the meeting (#3016). A meeting that does not exist has none, and the delete below then says so.
    const mailPayloads = await dropFollowupPayloads(ctx, input.meetingId);

    const { rows } = await sql<{ deleted: boolean }>`
      SELECT ludy_meetings.meeting_owner_delete(${ctx.orgId}::uuid, ${input.meetingId}::uuid) AS deleted
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
      FROM ludy_meetings.meeting_owner_list_page(${ctx.orgId}::uuid, ${limit}::integer, ${input.afterStartedAt ?? null}::timestamptz, ${input.afterId ?? null}::uuid) l
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
        SELECT l.id FROM ludy_meetings.meeting_owner_list_page(${ctx.orgId}::uuid, 1, ${last.startedAt}::timestamptz, ${last.id}::uuid) l
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
      .selectFrom('ludy_meetings.meeting')
      .select(['id', 'recorder_user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    if (meeting.recorder_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can add readers');
    }

    const member = await ctx.trx
      .selectFrom('ludy_kernel.tenant_member')
      .select(['role'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', input.userId)
      .where('role', 'in', ['owner', 'admin', 'member'])
      .executeTakeFirst();
    if (!member) {
      throw new DomainError('INVALID_READER', 400, 'Reader must be an active non-viewer member of this organization');
    }

    await ctx.trx
      .insertInto('ludy_meetings.meeting_reader')
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
      .selectFrom('ludy_meetings.meeting')
      .select(['id', 'recorder_user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    if (meeting.recorder_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can remove readers');
    }

    await ctx.trx
      .deleteFrom('ludy_meetings.meeting_reader')
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
  runsWhenOff: 'rewraps the sealed recording keys under the current key while the app is off',
  input: zMeetingMediaKeyReseal,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Only a system actor may do this');
    const { rows } = await sql<{ resealed: boolean }>`
      SELECT ludy_meetings.media_key_reseal(
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
      .selectFrom('ludy_meetings.meeting')
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

// Caller's active calendar events with event reading enabled, scoped by org, user, and calendar_agenda_read RLS.
function readableAgendaPlatforms(trx: QueryContext['trx'], orgId: string, userId: string) {
  return trx
    .selectFrom('ludy_meetings.calendar_agenda as a')
    .innerJoin('ludy_kernel.calendar_connection as c', (join) => join.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.connection_id'))
    .where('a.org_id', '=', orgId)
    .where('a.user_id', '=', userId)
    .where('c.status', '=', 'active')
    .where('c.read_events', '=', true);
}

export const meetingList = defineQuery({
  name: 'meetings.meeting.list',
  input: zMeetingListInput,
  access: READERS,
  handler: async (ctx, input): Promise<MeetingListItem[]> => {
    const userId = userOf(ctx.actor);
    let query = ctx.trx
      .selectFrom('ludy_meetings.meeting')
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

    // The labels of the page (#4966): one read, under the caller's row security.
    const labelMap = await labelsOfMeetings(ctx.trx, ctx.orgId, meetingIds);

    const readers = await ctx.trx
      .selectFrom('ludy_meetings.meeting_reader')
      .select(['meeting_id', sql<string>`count(*)::text`.as('count')])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', 'in', meetingIds)
      .groupBy('meeting_id')
      .execute();
    const readersMap = new Map(readers.map((r) => [r.meeting_id, Number(r.count)]));

    const audioSegments = await ctx.trx
      .selectFrom('ludy_meetings.audio_segment')
      .select(['meeting_id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', 'in', meetingIds)
      .execute();
    const audioSet = new Set(audioSegments.map((a) => a.meeting_id));

    const videos = await ctx.trx
      .selectFrom('ludy_meetings.meeting_video')
      .select(['meeting_id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', 'in', meetingIds)
      .execute();
    const videoSet = new Set(videos.map((v) => v.meeting_id));

    // transcript_segment_read RESTRICTIVE RLS ensures recorders see drafts/published while readers only see published.
    // EXISTS stops at the first visible segment per meeting instead of evaluating RLS on every row.
    const transcriptMeetings = await sql<{ meeting_id: string }>`
      SELECT m.id AS meeting_id
      FROM pg_catalog.unnest(${meetingIds}::uuid[]) AS m(id)
      WHERE EXISTS (
        SELECT 1
        FROM ludy_meetings.transcript_segment s
        WHERE s.org_id = ${ctx.orgId}::uuid
          AND s.meeting_id = m.id
      )
    `.execute(ctx.trx);
    const transcriptSet = new Set(transcriptMeetings.rows.map((t) => t.meeting_id));

    // Active, readable caller calendar events only; mapped to platform code without exposing raw joinUrl.
    const agendaPlatforms = await readableAgendaPlatforms(ctx.trx, ctx.orgId, userId)
      .select(['a.meeting_id', 'a.join_url'])
      .where('a.meeting_id', 'in', meetingIds)
      .execute();
    const platformMap = new Map<string, MeetingPlatform>();
    for (const row of agendaPlatforms) {
      if (!row.meeting_id) continue;
      const platform = joinServiceFromUrl(row.join_url);
      if (platform !== null) platformMap.set(row.meeting_id, platform);
    }

    return rows.map((r) => ({
      ...toSummary(r, readersMap.get(r.id) ?? 0, audioSet.has(r.id), videoSet.has(r.id), transcriptSet.has(r.id), platformMap.get(r.id) ?? null),
      labels: labelMap.get(r.id) ?? [],
    }));
  },
});

export const meetingGet = defineQuery({
  name: 'meetings.meeting.get',
  input: zMeetingRef,
  access: READERS,
  handler: async (ctx, input): Promise<MeetingDetail> => {
    const userId = userOf(ctx.actor);
    const meeting = (await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst()) as unknown as MeetingRow | undefined;
    if (!meeting || (meeting.text_retention_date !== null && dayText(meeting.text_retention_date) <= vnDay(new Date()))) {
      throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }

    const readers = await ctx.trx
      .selectFrom('ludy_meetings.meeting_reader')
      .select(['user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .execute();
    const readerIds = readers.map((r) => r.user_id);

    const audioSegment = await ctx.trx
      .selectFrom('ludy_meetings.audio_segment')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();

    const video = await ctx.trx
      .selectFrom('ludy_meetings.meeting_video')
      .select(['id', 'video_retention_date'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();

    const transcriptSegment = await ctx.trx
      .selectFrom('ludy_meetings.transcript_segment')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .limit(1)
      .executeTakeFirst();

    const agendaPlatform = await readableAgendaPlatforms(ctx.trx, ctx.orgId, userId)
      .select(['a.join_url'])
      .where('a.meeting_id', '=', input.meetingId)
      .limit(1)
      .executeTakeFirst();

    const videoRetentionDate = video?.video_retention_date
      ? typeof video.video_retention_date === 'string'
        ? video.video_retention_date.slice(0, 10)
        : new Date(video.video_retention_date).toISOString().slice(0, 10)
      : null;

    const summary = toSummary(
      meeting,
      readerIds.length,
      audioSegment !== undefined,
      video !== undefined,
      transcriptSegment !== undefined,
      joinServiceFromUrl(agendaPlatform?.join_url ?? null),
    );
    return {
      ...summary,
      consentMethod: meeting.consent_method,
      consentConfirmedBy: meeting.consent_confirmed_by,
      consentConfirmedAt: new Date(meeting.consent_confirmed_at).toISOString(),
      consentNoticeVersion: meeting.consent_notice_version,
      recordingStopReason: meeting.recording_stop_reason,
      platformTranscriptCut: meeting.platform_transcript_cut,
      readers: readerIds,
      videoRetentionDate,
      isRecorder: meeting.recorder_user_id === userId,
      minutesTemplate:
        meeting.minutes_template_sections === null || meeting.minutes_template_name === null || meeting.minutes_template_hash === null
          ? null
          : { name: meeting.minutes_template_name, hash: meeting.minutes_template_hash, sections: parseStoredSections(meeting.minutes_template_sections) },
    };
  },
});

export const meetingVisibleIds = defineQuery({
  name: 'meetings.meeting.visible_ids',
  input: zMeetingVisibleIdsInput,
  access: READERS,
  handler: async (ctx, input): Promise<{ visibleIds: string[] }> => {
    userOf(ctx.actor);
    if (input.meetingIds.length === 0) return { visibleIds: [] };
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', input.meetingIds)
      .where((eb) => eb.or([eb('text_retention_date', 'is', null), eb('text_retention_date', '>', vnDay(new Date()))]))
      .execute();
    return { visibleIds: rows.map((r) => r.id) };
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
      .selectFrom('ludy_meetings.meeting')
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
      .selectFrom('ludy_meetings.audio_segment')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst();
    const video = await ctx.trx
      .selectFrom('ludy_meetings.meeting_video')
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
      .selectFrom('ludy_meetings.meeting')
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
      SELECT ludy_meetings.is_meeting_reader(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${userId}::uuid) AS ok
    `.execute(ctx.trx);
    if (!readerRows[0]?.ok) {
      throw new DomainError('FORBIDDEN', 403, 'You do not have permission to play meeting audio');
    }

    const { rows: keyRows } = await sql<{ key_id: string; wrapped_key: Buffer }>`
      SELECT key_id, wrapped_key FROM ludy_meetings.media_key_read(${ctx.orgId}::uuid, ${input.meetingId}::uuid, 'audio')
    `.execute(ctx.trx);
    if (keyRows.length === 0 || !keyRows[0]) {
      throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting audio key has been shredded');
    }

    const segment = await ctx.trx
      .selectFrom('ludy_meetings.audio_segment as s')
      .innerJoin('ludy_kernel.file as f', (join) =>
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
      .selectFrom('ludy_meetings.meeting')
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
      SELECT ludy_meetings.is_meeting_reader(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${userId}::uuid) AS ok
    `.execute(ctx.trx);
    if (!readerRows[0]?.ok) {
      throw new DomainError('FORBIDDEN', 403, 'You do not have permission to play meeting video');
    }

    const { rows: keyRows } = await sql<{ key_id: string; wrapped_key: Buffer }>`
      SELECT key_id, wrapped_key FROM ludy_meetings.media_key_read(${ctx.orgId}::uuid, ${input.meetingId}::uuid, 'video')
    `.execute(ctx.trx);
    if (keyRows.length === 0 || !keyRows[0]) {
      throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting video key has been shredded');
    }

    const video = await ctx.trx
      .selectFrom('ludy_meetings.meeting_video as v')
      .innerJoin('ludy_kernel.file as f', (join) =>
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
      .selectFrom('ludy_meetings.meeting')
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
      SELECT ludy_meetings.is_meeting_reader(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${userId}::uuid) AS ok
    `.execute(ctx.trx);
    if (!readerRows[0]?.ok) {
      throw new DomainError('FORBIDDEN', 403, 'You do not have permission to play meeting media');
    }

    const { rows: keyRows } = await sql<{ key_id: string; wrapped_key: Buffer }>`
      SELECT key_id, wrapped_key FROM ludy_meetings.media_key_read(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${input.kind})
    `.execute(ctx.trx);
    if (keyRows.length === 0 || !keyRows[0]) {
      throw new DomainError('MEDIA_KEY_SHREDDED', 404, 'Meeting media key has been shredded');
    }

    if (input.kind === 'audio') {
      const segment = await ctx.trx
        .selectFrom('ludy_meetings.audio_segment as s')
        .innerJoin('ludy_kernel.file as f', (join) =>
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
        .selectFrom('ludy_meetings.meeting_video as v')
        .innerJoin('ludy_kernel.file as f', (join) =>
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
  meetingRecordingStopped,
  meetingDelete,
  meetingOwnerDelete,
  meetingOwnerList,
  meetingReaderAdd,
  meetingReaderRemove,
  meetingMediaKeyReseal,
  meetingSettingsSet,
  meetingConsentPolicySet,
  meetingMinutesEsignSet,
  ...minutesLinkCommands,
  meetingRetentionShred,
  meetingShredReplay,
  meetingMediaDiscard,
  transcriptDraftStore,
  transcriptCorrect,
  ...createRedactCommands(dropDraftTranslationsForMember),
  ...transcribeRunCommands,
  ...transcribeCommandList,
  ...resultCommands,
  ...notesCommands,
  ...chaptersCommands,
  ...trackersCommands,
  ...trackerAlertCommands,
  ...highlightsCommands,
  ...labelsCommands,
  ...chaptersRunCommands,
  ...titleCommands,
  ...placeCommands,
  ...commitmentsCommands,
  ...templateSuggestCommands,
  ...openPointsCommands,
  ...salesInsightCommands,
  ...labelSuggestCommands,
  ...summaryCommands,
  ...speakerCommands,
  ...seriesCommands,
  ...minutesTemplateCommands,
  ...minutesVersionCommands,
  ...glossaryCommands,
  ...summaryRunCommands,
  ...summaryReadyCommands,
  ...translateCommands,
  ...translateRunCommands,
  ...askRunCommands,
  ...briefCommands,
  ...digestCommands,
  ...voiceCueCommands,
  ...morningCommands,
  ...weeklyCommands,
  ...assigneeCommands,
  ...adherenceCommands,
  ...agendaCommands,
  ...chatCommands,
  ...linkCommands,
  ...followupCommands,
  ...dealUpdateCommands,
  ...liveCommands,
  ...captureCommands,
  ...liveAssembleCommands,
  ...liveRunCommands,
  ...liveNotesCommands,
  ...hookCommands,
  ...importCommands,
];

export const meetingsQueries = [
  meetingList,
  meetingGet,
  meetingVisibleIds,
  meetingExtensionStatus,
  meetingRecordingNow,
  meetingAudioRead,
  meetingVideoRead,
  meetingMediaMeta,
  meetingSettingsGet,
  meetingConsentPolicyGet,
  meetingMinutesEsignGet,
  ...minutesLinkQueries,
  meetingMediaOrphanKeys,
  transcriptGet,
  ...redactQueries,
  meetingSearch,
  ...transcribeRunQueries,
  ...resultQueries,
  ...notesQueries,
  ...chaptersQueries,
  ...chaptersRunQueries,
  ...titleQueries,
  ...commitmentsQueries,
  ...templateSuggestQueries,
  ...openPointsQueries,
  ...salesInsightQueries,
  ...labelSuggestQueries,
  ...summaryQueries,
  ...seriesQueries,
  ...minutesTemplateQueries,
  ...minutesVersionQueries,
  ...glossaryQueries,
  ...summaryRunQueries,
  ...translateRunQueries,
  ...askRunQueries,
  ...briefQueries,
  ...digestQueries,
  ...loadQueries,
  ...trackersQueries,
  ...trackerAlertQueries,
  ...highlightsQueries,
  ...labelsQueries,
  ...minutesDocxQueries,
  ...todayQueries,
  ...morningQueries,
  ...weeklyQueries,
  ...assigneeQueries,
  ...adherenceQueries,
  ...agendaQueries,
  ...chatQueries,
  ...linkQueries,
  ...followupQueries,
  ...dealUpdateQueries,
  ...liveRunQueries,
  ...liveAssembleQueries,
  ...hookQueries,
  ...mcpMeetingsQueries,
  ...transcriptExportQueries,
  ...speakingStyleQueries,
];
