// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { zMeetingPlatform } from './meeting-agenda.ts';
import { zCaptureStart } from './meeting-capture.ts';
import { zMinutesTemplateCopy } from './meeting-minutes-templates.ts';
import { SECTIONS_MAX, zBuiltInSummaryTemplate, zMeetingSummaryTemplate, zSectionEntry } from './meeting-templates.ts';
import { MEETING_LABELS_MAX, zLabelValue } from './meeting-labels.ts';
import { zPlaceValue } from './meeting-place.ts';
import { zId } from './schemas.ts';

// `in_call_chat`: the recorder pasted the recording notice in the call's chat (Meetings A1, #3159).
// `platform_notice`: the meeting platform showed its own recording notice to everyone in the call and the importer confirms it (Meetings C1, #3173). A recording the platform already finished is
// imported with this method only; it is not a written method (see WRITTEN_CONSENT_METHODS), so a strict org refuses it.
export const CONSENT_METHODS = ['told_at_start', 'in_invite', 'in_writing', 'in_call_chat', 'platform_notice'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];
// The methods only an import may use. A live recording (the app's recorder, the extension) is made while the call runs, so it never offers these: the screens and the extension filter them out.
export const IMPORT_ONLY_CONSENT_METHODS: readonly ConsentMethod[] = ['platform_notice'];
export type LiveConsentMethod = Exclude<ConsentMethod, 'platform_notice'>;
export const LIVE_CONSENT_METHODS: readonly LiveConsentMethod[] = CONSENT_METHODS.filter((m): m is LiveConsentMethod => !IMPORT_ONLY_CONSENT_METHODS.includes(m));

// Why a recording stopped without the recorder's own click (Meetings A1, #3159): a code, never text. The screens turn it into
// plain words ("Tab họp đã đóng", "Micro bị mất"...). Same set as the CHECK on ludy_meetings.meeting.recording_stop_reason.
export const RECORDING_STOP_REASONS = ['tab_closed', 'mic_lost', 'permission_lost', 'storage_full', 'left_screen', 'unknown'] as const;
export type RecordingStopReason = (typeof RECORDING_STOP_REASONS)[number];
export const zRecordingStopReason = z.enum(RECORDING_STOP_REASONS);

// The versions of the recording notice text a meeting may store as `consent_notice_version` (A1, #3159). The text itself
// lives in one place, packages/meeting-recorder/src/notice.ts, and carries the current version; a client sends the version
// it showed, the server accepts only a known one. A new wording adds a version here and keeps the old ones.
export const CONSENT_NOTICE_VERSION = '2026-11-v1';
// The notice text of an import (C1, #3173): the platform showed its own notice, and Ludy's own text says what Ludy does with the copy. Same string as IMPORT_NOTICE.version in the recorder kit.
export const IMPORT_CONSENT_NOTICE_VERSION = '2026-11-imp-v1';
export const KNOWN_CONSENT_NOTICE_VERSIONS: readonly string[] = [CONSENT_NOTICE_VERSION, IMPORT_CONSENT_NOTICE_VERSION];

export const MEETING_VISIBILITIES = ['attendees', 'org'] as const;
export type MeetingVisibility = (typeof MEETING_VISIBILITIES)[number];

export const MEETING_STATUSES = ['ready', 'processing', 'completed', 'error'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_LANGUAGES = ['vi', 'en'] as const;
export type MeetingLanguage = (typeof MEETING_LANGUAGES)[number];

export const zConsentMethod = z.enum(CONSENT_METHODS);
export const zMeetingVisibility = z.enum(MEETING_VISIBILITIES);
export const zMeetingStatus = z.enum(MEETING_STATUSES);
export const zMeetingLanguage = z.enum(MEETING_LANGUAGES);

export const zMeetingRef = z.strictObject({
  meetingId: zId,
});

export const zMeetingVisibleIdsInput = z.strictObject({
  meetingIds: z.array(zId).max(200),
});
export type MeetingVisibleIdsInput = z.infer<typeof zMeetingVisibleIdsInput>;

// What the Ludy extension may read of a meeting its own token created (issue #2582): where it is in its life and whether
// its audio and video arrived, never a title, a reader, a transcript or any media.
export const zMeetingExtensionStatus = z.strictObject({
  meetingId: zId,
  status: zMeetingStatus,
  keepVideo: z.boolean(),
  // The recorder ticked "Ghi chú trực tiếp" for this meeting (ADR-0052 L4a): the extension then sends live chunks while it records.
  liveNotes: z.boolean(),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  lengthSeconds: z.number().nullable(),
});
export type MeetingExtensionStatus = z.infer<typeof zMeetingExtensionStatus>;

// The recording indicator (Meetings A1, #3159): the calling member's own meeting, made by the extension, that is still waiting for its
// first audio, so the app header can show "Đang ghi 12:31" while the extension records. Derived from the meeting row: no heartbeat, no
// new route for the extension. `null` when there is none. The window is in RECORDING_NOW_WINDOW_HOURS.
export const RECORDING_NOW_WINDOW_HOURS = 4;
export const zMeetingRecordingNowInput = z.strictObject({});
export const zMeetingRecordingNow = z.strictObject({
  recording: z.strictObject({ meetingId: zId, startedAt: z.string() }).nullable(),
});
export type MeetingRecordingNow = z.infer<typeof zMeetingRecordingNow>;

export const zMeetingSummary = z.strictObject({
  id: zId,
  title: z.string(),
  language: zMeetingLanguage,
  visibility: zMeetingVisibility,
  status: zMeetingStatus,
  recorderUserId: zId,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  lengthSeconds: z.number().nullable(),
  keepVideo: z.boolean(),
  // Live notes were opted into for this meeting (ADR-0052 L4a), at the consent step, and cannot change afterwards.
  liveNotes: z.boolean(),
  // The minutes template the recorder picked (Meetings A4, #3162): a code; its sections live in code (meeting-templates.ts).
  summaryTemplate: zMeetingSummaryTemplate,
  // The place the recorder set for the biên bản (#5013): one line, null when none. Read where the title is.
  place: zPlaceValue.nullable(),
  audioRetentionDate: z.string(),
  // null: the org keeps text until a person deletes the meeting.
  textRetentionDate: z.string().nullable(),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  hasTranscript: z.boolean(),
  platform: zMeetingPlatform.nullable(),
  readersCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MeetingSummary = z.infer<typeof zMeetingSummary>;

// A row of the meetings list (#4966): the summary and the labels the recorder put on the meeting (at most five, in the order they were added), read with the page of meetings in one query, so the chips, the
// label filter and the label choices of the list never depend on a cap of their own. A label of a meeting the caller cannot read is not here (the row policy), as the meeting itself is not.
export const zMeetingListItem = zMeetingSummary.extend({ labels: z.array(zLabelValue).max(MEETING_LABELS_MAX) });
export type MeetingListItem = z.infer<typeof zMeetingListItem>;

export const zMeetingDetail = zMeetingSummary.extend({
  consentMethod: zConsentMethod,
  consentConfirmedBy: zId,
  consentConfirmedAt: z.string(),
  consentNoticeVersion: z.string(),
  // Set when the recording stopped without the recorder's click; the stop time is `endedAt` (A1, #3159).
  recordingStopReason: zRecordingStopReason.nullable(),
  // True while the draft is a platform's transcript that was cut (the platform sent more than Ludy reads or the draft takes, #3922): the page tells the recorder the draft stops early.
  platformTranscriptCut: z.boolean(),
  readers: z.array(zId),
  videoRetentionDate: z.string().nullable(),
  isRecorder: z.boolean(),
  // The meeting's own copy of its org template (#3578), on a meeting whose template is 'custom'; null otherwise. Headings and the sections a run fills are read from it, never from the live template.
  minutesTemplate: zMinutesTemplateCopy.nullable(),
});
export type MeetingDetail = z.infer<typeof zMeetingDetail>;

export const zMeetingListInput = z
  .strictObject({
    visibility: zMeetingVisibility.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    // Plain-text title search (Vietnamese diacritics and case folded; #5052). Empty or whitespace-only behaves as unset.
    search: z.string().trim().max(200).optional(),
    // Keyset cursor (#5052): held time (`startedAt ?? createdAt`) and `id` of the last item of the previous page, both or neither.
    afterStartedAt: z.iso.datetime({ offset: true }).optional(),
    afterId: zId.optional(),
  })
  .refine((v) => (v.afterStartedAt === undefined) === (v.afterId === undefined), {
    message: 'afterStartedAt and afterId come together',
    path: ['afterId'],
  });
export type MeetingListInput = z.infer<typeof zMeetingListInput>;

export const zMeetingCreate = z.strictObject({
  title: z.string().trim().min(1).max(200),
  language: zMeetingLanguage.default('vi'),
  visibility: zMeetingVisibility.default('attendees'),
  keepVideo: z.boolean().default(false),
  // "Ghi chú trực tiếp" (ADR-0052 L4a): off by default, opted in per meeting at the consent step, fixed once the meeting exists.
  liveNotes: z.boolean().default(false),
  // The minutes template (A4, #3162): the general summary unless the recorder picks another; the recorder can change it later (meetings.minutes.set_template).
  summaryTemplate: zBuiltInSummaryTemplate.default('general'),
  // A live recording or an upload never claims the platform's own notice: that method belongs to meetings.import.start alone (C1, #3173).
  consentMethod: zConsentMethod.exclude(['platform_notice']),
  // The version of the notice text the client showed (and the recorder may have copied); absent means the current one.
  // The import notice is for imports alone (zMeetingImportStart): a live meeting never records a text that was not shown.
  consentNoticeVersion: z.string().max(20).refine((v) => v !== IMPORT_CONSENT_NOTICE_VERSION && KNOWN_CONSENT_NOTICE_VERSIONS.includes(v), 'Unknown notice version').optional(),
  readerUserIds: z.array(zId).optional(),
  lengthSeconds: z.number().int().nonnegative().optional(),
  // A live recording says what it knows of the call, and the server refuses a second capture of the same call (ADR-0055 slice 1, #4123). An extension token is always a live capture, with or without this.
  capture: zCaptureStart.optional(),
});
export type MeetingCreate = z.infer<typeof zMeetingCreate>;

// The click on "Nhập" for a recording a meeting platform finished (C1, #3173): one command makes the meeting with its consent record and links the recording. The consent is the platform's own notice,
// confirmed by the importer, and the notice text shown is the import one; nothing else is accepted here. Audio first: no video, no live notes.
export const zMeetingImportStart = z.strictObject({
  recordingId: zId,
  // Absent means the recording's own title.
  title: z.string().trim().min(1).max(200).optional(),
  language: zMeetingLanguage.default('vi'),
  visibility: zMeetingVisibility.default('attendees'),
  readerUserIds: z.array(zId).optional(),
  summaryTemplate: zBuiltInSummaryTemplate.default('general'),
  consentMethod: z.literal('platform_notice'),
  consentNoticeVersion: z.literal(IMPORT_CONSENT_NOTICE_VERSION),
  consentConfirmed: z.literal(true),
});
export type MeetingImportStart = z.infer<typeof zMeetingImportStart>;

// The clean-up after a failed import is dismissed, or before the platform connection that held it is disconnected (#3587): the empty meeting a failed try left in the member's list goes, by the same
// rule as a retry (the importer's own, never edited, holding nothing). Exactly one of the two: one recording, or every failed or dismissed recording of one connection.
export const zMeetingImportDiscardEmpty = z
  .strictObject({ recordingId: zId.optional(), connectionId: zId.optional() })
  .refine((v) => (v.recordingId === undefined) !== (v.connectionId === undefined), { message: 'Exactly one of recordingId and connectionId' });
export type MeetingImportDiscardEmpty = z.infer<typeof zMeetingImportDiscardEmpty>;
export const zMeetingImportDiscarded = z.strictObject({ removed: z.number().int().min(0) });
export type MeetingImportDiscarded = z.infer<typeof zMeetingImportDiscarded>;

export const zMeetingCreated = z.strictObject({
  meetingId: zId,
});
export type MeetingCreated = z.infer<typeof zMeetingCreated>;

// The recorder picks (or changes) the minutes template of their meeting (A4, #3162). It decides the sections the next summary run fills and the headings the
// recorder types under; text already saved is not touched.
// 'custom' (#3578) picks a template the org wrote and needs its id; a built-in code takes none.
export const zMeetingTemplateSet = z
  .strictObject({ meetingId: zId, summaryTemplate: zMeetingSummaryTemplate, templateId: zId.optional() })
  .refine((v) => (v.summaryTemplate === 'custom') === (v.templateId !== undefined), { message: 'templateId goes with the custom template and with nothing else', path: ['templateId'] });
export const zMeetingTemplateSetDone = z.strictObject({ meetingId: zId, summaryTemplate: zMeetingSummaryTemplate });

export const zMeetingDeleted = z.strictObject({
  meetingId: zId,
  shredded: z.boolean(),
});
export type MeetingDeleted = z.infer<typeof zMeetingDeleted>;

// The owner's compliance list (#2703, ADR-0047): every meeting of the org, the attendees-only ones the owner cannot read included, as
// metadata only, so the owner can find one to delete. Never a title, a transcript, a summary, a reader or any other text.
export const MEETING_OWNER_LIST_PAGE = 200;

export const zMeetingOwnerListInput = z
  .strictObject({
    limit: z.number().int().min(1).max(MEETING_OWNER_LIST_PAGE).optional(),
    // The keyset cursor: the start and id of the last row of the previous page, both or neither.
    afterStartedAt: z.iso.datetime({ offset: true }).optional(),
    afterId: zId.optional(),
  })
  .refine((v) => (v.afterStartedAt === undefined) === (v.afterId === undefined), {
    message: 'afterStartedAt and afterId come together',
    path: ['afterId'],
  });
export type MeetingOwnerListInput = z.infer<typeof zMeetingOwnerListInput>;

export const zMeetingOwnerListItem = z.strictObject({
  id: zId,
  recorderUserId: zId,
  // When the meeting started (its creation time when it has no start).
  startedAt: z.string(),
  visibility: zMeetingVisibility,
  status: zMeetingStatus,
  audioRetentionDate: z.string(),
  // null: the meeting kept no video.
  videoRetentionDate: z.string().nullable(),
  // null: the org keeps text until a person deletes the meeting.
  textRetentionDate: z.string().nullable(),
});
export type MeetingOwnerListItem = z.infer<typeof zMeetingOwnerListItem>;

export const zMeetingOwnerList = z.strictObject({
  items: z.array(zMeetingOwnerListItem),
  // The cursor of the next page, null on the last one.
  next: z.strictObject({ afterStartedAt: z.string(), afterId: zId }).nullable(),
});
export type MeetingOwnerList = z.infer<typeof zMeetingOwnerList>;

export const zMeetingReaderAdd = z.strictObject({
  meetingId: zId,
  userId: zId,
});
export type MeetingReaderAdd = z.infer<typeof zMeetingReaderAdd>;

export const zMeetingReaderRemove = z.strictObject({
  meetingId: zId,
  userId: zId,
});
export type MeetingReaderRemove = z.infer<typeof zMeetingReaderRemove>;

export const zMeetingReaderResult = z.strictObject({
  meetingId: zId,
  userId: zId,
});
export type MeetingReaderResult = z.infer<typeof zMeetingReaderResult>;

export const zMeetingMediaMeta = zMeetingRef.extend({
  kind: z.enum(['audio', 'video']),
});
export type MeetingMediaMeta = z.infer<typeof zMeetingMediaMeta>;

export const zMeetingMediaRecord = zMeetingRef.extend({
  kind: z.enum(['audio', 'video']),
  keyId: z.string().min(1).max(64),
  wrappedKeyHex: z.string().regex(/^[0-9a-fA-F]{120}$/),
  storageKey: z.string().min(1).max(255),
  generation: z.string().nullable().optional(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  contentType: z.string().min(1).max(64),
  // Measured by crove-media at upload (#2985), never the client's value: the upload route is the only caller.
  lengthSeconds: z.number().int().positive(),
  // The recording stopped without the recorder's click (A1, #3159): a code the upload route validated; absent for a recording the recorder stopped.
  stopReason: zRecordingStopReason.optional(),
});
export type MeetingMediaRecord = z.infer<typeof zMeetingMediaRecord>;

// A recording that ended with no media reaching the server (#3196): the extension reports it so the header chip lets go at once, not after
// RECORDING_NOW_WINDOW_HOURS. Codes and a length only. `reason` is absent for the member's own stop (nothing was saved), a code for a stop they
// did not ask for. `lengthSeconds` is what the recorder's own clock counted; the end time is the start plus it, never later than now.
export const zMeetingRecordingStopped = zMeetingRef.extend({
  reason: zRecordingStopReason.optional(),
  lengthSeconds: z.number().int().min(0).max(24 * 3600).optional(),
});
export type MeetingRecordingStopped = z.infer<typeof zMeetingRecordingStopped>;
// `ended` is false when nothing changed: the meeting already had a recording or an end time (the call is a no-op then, and safe to repeat).
export const zMeetingRecordingStoppedDone = z.strictObject({ meetingId: zId, ended: z.boolean() });
export type MeetingRecordingStoppedDone = z.infer<typeof zMeetingRecordingStoppedDone>;

// One piece of about 15 seconds of the recording, sent while the meeting is recorded (ADR-0052 L4a, issue #3109). The upload route seals it under its own
// data key and stores the ciphertext; this command only records it. The pieces are consecutive slices of one MediaRecorder stream, so in order they make
// the recording; the final upload stays the authoritative audio and replaces them. lengthSeconds is what the recorder's clock says, never measured.
export const LIVE_CHUNK_MAX_BYTES = 1024 * 1024;
export const LIVE_CHUNK_MAX_COUNT = 1000;
export const LIVE_CHUNK_MAX_TOTAL_BYTES = 300 * 1024 * 1024;
export const LIVE_CHUNK_MAX_SECONDS = 120;
// A meeting takes live chunks for this long after it started: the kernel's 4 hour cap of a run, and a quarter of an hour of grace.
export const LIVE_CHUNK_WINDOW_SECONDS = 4 * 3600 + 15 * 60;

export const zMeetingLiveChunk = zMeetingRef.extend({
  seq: z.number().int().min(0).max(LIVE_CHUNK_MAX_COUNT - 1),
  keyId: z.string().min(1).max(64),
  wrappedKeyHex: z.string().regex(/^[0-9a-fA-F]{120}$/),
  storageKey: z.string().min(1).max(255),
  generation: z.string().nullable().optional(),
  sizeBytes: z.number().int().positive().max(LIVE_CHUNK_MAX_BYTES + 28 * 20),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  contentType: z.string().min(1).max(64),
  lengthSeconds: z.number().int().min(1).max(LIVE_CHUNK_MAX_SECONDS),
});
export type MeetingLiveChunk = z.infer<typeof zMeetingLiveChunk>;

export const zMeetingLiveChunkRecorded = z.strictObject({
  meetingId: zId,
  seq: z.number().int(),
  // true: a chunk with this number was already kept (a retry after a lost answer), so nothing was stored again and the caller drops its new object.
  duplicate: z.boolean(),
});
export type MeetingLiveChunkRecorded = z.infer<typeof zMeetingLiveChunkRecorded>;

// The recorder's click "Ghép bản ghi từ các đoạn trực tiếp" when the final recording never arrived (ADR-0052 L4a, issue #3126). Once the window of the live pieces has
// passed with pieces and no final audio, the pieces are joined, in order, into one recording under a fresh audio key. Why a piece may not be assembled yet or at all:
//   none                 it can be assembled now
//   no_pieces            the meeting kept no live piece
//   still_recording      the window (LIVE_CHUNK_WINDOW_SECONDS) has not passed: the final recording may still come
//   audio_recorded       the final audio or video is recorded (the pieces were discarded with it)
//   first_piece_missing  piece 0 carries the container header; without it the later pieces cannot be read
//   expired              the meeting's audio period has ended (the pieces are shredded)
export const LIVE_ASSEMBLE_REASONS = ['no_pieces', 'still_recording', 'audio_recorded', 'first_piece_missing', 'expired'] as const;
export type LiveAssembleReason = (typeof LIVE_ASSEMBLE_REASONS)[number];
export const zLiveAssembleState = z.strictObject({
  // The pane offers the click only when this is true.
  available: z.boolean(),
  reason: z.enum(LIVE_ASSEMBLE_REASONS).nullable(),
  // How many pieces the meeting holds, and the numbers missing between 0 and the last one (a gap is reported, never fatal).
  pieces: z.number().int().min(0),
  missing: z.array(z.number().int().min(0)).max(LIVE_CHUNK_MAX_COUNT),
});
export type LiveAssembleState = z.infer<typeof zLiveAssembleState>;

// What the route records after it joined and sealed the pieces. The wrapped key and the storage address are ciphertext metadata; the length is crove-media's. pieces and
// lastSeq say which set the route joined, so a set that changed meanwhile is refused instead of recorded.
export const zMeetingLiveAssemble = zMeetingRef.extend({
  keyId: z.string().min(1).max(64),
  wrappedKeyHex: z.string().regex(/^[0-9a-fA-F]{120}$/),
  storageKey: z.string().min(1).max(255),
  generation: z.string().nullable().optional(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  contentType: z.string().min(1).max(64),
  lengthSeconds: z.number().int().positive(),
  pieces: z.number().int().min(1).max(LIVE_CHUNK_MAX_COUNT),
  lastSeq: z.number().int().min(0).max(LIVE_CHUNK_MAX_COUNT - 1),
  // The pieces the plan left out because their key or file is gone: they count as missing in the answer. pieces + leftOut is every piece the meeting holds.
  leftOut: z.array(z.number().int().min(0).max(LIVE_CHUNK_MAX_COUNT - 1)).max(LIVE_CHUNK_MAX_COUNT).default([]),
});
export type MeetingLiveAssemble = z.infer<typeof zMeetingLiveAssemble>;

// What the plan query answers to the recorder's own route: the pieces in order with their files and wrapped keys (never plaintext), the numbers missing, and the last piece's number.
export interface LiveAssemblePlanPiece {
  seq: number;
  lengthSeconds: number;
  fileId: string;
  storageKey: string;
  generation: string | null;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  keyId: string;
  wrappedKey: Buffer;
}
export interface LiveAssemblePlan {
  meetingId: string;
  pieces: LiveAssemblePlanPiece[];
  missing: number[];
  // The pieces left out of `pieces` because their key or file is gone (also in `missing`).
  leftOut: number[];
  lastSeq: number;
}

export const zMeetingLiveAssembled = z.strictObject({
  meetingId: zId,
  fileId: zId,
  pieces: z.number().int().min(1),
  missing: z.array(z.number().int().min(0)).max(LIVE_CHUNK_MAX_COUNT),
  lengthSeconds: z.number().int().positive(),
});
export type MeetingLiveAssembled = z.infer<typeof zMeetingLiveAssembled>;

// The worker's reseal of one media key after a credential key rotation (system actor only).
export const zMeetingMediaKeyReseal = z.strictObject({
  id: z.string().uuid(),
  fromKeyId: z.string().min(1).max(64),
  toKeyId: z.string().min(1).max(64),
  fromWrappedKeyHex: z.string().regex(/^[0-9a-f]{120}$/),
  wrappedKeyHex: z.string().regex(/^[0-9a-f]{120}$/),
});

// The org's three retention settings (ADR-0047 point 7, plan section 9), stamped on a meeting when it is recorded: audio kept N days (0: deleted right after
// the transcript, which is 7 days while no transcript exists), a kept video 7 or 30 days and never longer than the audio, text 90, 365 or 730 days or
// until deleted (0).
export const MEETING_AUDIO_RETENTION_CHOICES = [0, 7, 30, 90] as const;
export const MEETING_VIDEO_RETENTION_CHOICES = [7, 30] as const;
export const MEETING_TEXT_RETENTION_CHOICES = [0, 90, 365, 730] as const;
export const MEETING_RETENTION_DEFAULTS = { audioRetentionDays: 30, videoRetentionDays: 7, textRetentionDays: 365 } as const;

const zChoice = <T extends readonly [number, number, ...number[]]>(choices: T) =>
  z.union(choices.map((n) => z.literal(n)) as unknown as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]]);

export const zMeetingSettings = z.strictObject({
  audioRetentionDays: zChoice(MEETING_AUDIO_RETENTION_CHOICES),
  videoRetentionDays: zChoice(MEETING_VIDEO_RETENTION_CHOICES),
  textRetentionDays: zChoice(MEETING_TEXT_RETENTION_CHOICES),
});
export type MeetingSettings = z.infer<typeof zMeetingSettings>;

// The video period is never longer than the audio's (0 counts as 7 days).
export function meetingSettingsProblem(s: MeetingSettings): string | null {
  return s.videoRetentionDays > Math.max(s.audioRetentionDays, 7) ? 'video_longer_than_audio' : null;
}

export const zMeetingSettingsSet = zMeetingSettings.refine((s) => meetingSettingsProblem(s) === null, { message: 'video_longer_than_audio', path: ['videoRetentionDays'] });
export type MeetingSettingsSet = z.infer<typeof zMeetingSettingsSet>;

export const zMeetingSettingsGet = z.strictObject({});

// The org setting "Cần xác nhận trước khi ghi" (Meetings A2, #3160): `standard` accepts any consent method (today); `strict` accepts only a written
// one (WRITTEN_CONSENT_METHODS), so "said at the start" alone is refused when a meeting is created. A change applies to meetings created afterwards.
export const MEETING_CONSENT_POLICIES = ['standard', 'strict'] as const;
export type MeetingConsentPolicy = (typeof MEETING_CONSENT_POLICIES)[number];
export const zMeetingConsentPolicyValue = z.enum(MEETING_CONSENT_POLICIES);
export const WRITTEN_CONSENT_METHODS: readonly ConsentMethod[] = ['in_invite', 'in_writing', 'in_call_chat'];
export const consentMethodAllowed = (policy: MeetingConsentPolicy, method: ConsentMethod): boolean => policy === 'standard' || WRITTEN_CONSENT_METHODS.includes(method);
export const zMeetingConsentPolicyGet = z.strictObject({});
export const zMeetingConsentPolicy = z.strictObject({ policy: zMeetingConsentPolicyValue });
export type MeetingConsentPolicyState = z.infer<typeof zMeetingConsentPolicy>;

// The org setting "Ký biên bản họp" (Meetings, #4703): off by default. While it is off the server refuses to create a meeting_minutes eSign envelope (SIGN_MINUTES_SIGNING_OFF); envelopes made
// earlier stay readable and a signed one downloadable. Every member reads it (the minutes page shows the handoff only while it is on); an owner or admin changes it.
export const zMeetingMinutesEsignGet = z.strictObject({});
export const zMeetingMinutesEsign = z.strictObject({ enabled: z.boolean() });
export type MeetingMinutesEsignState = z.infer<typeof zMeetingMinutesEsign>;

// System commands of the nightly retention and the shred replay (worker only).
export const zMeetingRetentionShred = z.strictObject({
  meetingId: zId,
  kind: z.enum(['audio', 'video', 'text', 'draft']),
});
export type MeetingRetentionShred = z.infer<typeof zMeetingRetentionShred>;

export const zMeetingShredReplay = z.strictObject({ meetingId: zId });
export type MeetingShredReplay = z.infer<typeof zMeetingShredReplay>;

export const zMeetingMediaDiscard = z.strictObject({ fileId: zId });
export type MeetingMediaDiscard = z.infer<typeof zMeetingMediaDiscard>;

export const zMeetingOrphanKeys = z.strictObject({ fileIds: z.array(zId).min(1).max(200) });
export type MeetingOrphanKeys = z.infer<typeof zMeetingOrphanKeys>;

// The transcript of a meeting (#2578, M4a): timestamped segments with a speaker label. A segment is a draft, the recorder's
// own working copy, until the recorder publishes it (the summary step, M6).
export const TRANSCRIPT_STAGES = ['draft', 'published'] as const;
export type TranscriptStage = (typeof TRANSCRIPT_STAGES)[number];
// Whose transcription a line is (C2, #3174; C4, #3176): Ludy's own, or the transcript Google Meet or Microsoft Teams wrote and the recorder imported. The screens label the others as the platform's.
export const TRANSCRIPTION_MAKERS = ['ludy', 'google_meet', 'microsoft_teams', 'zoom'] as const;
export type TranscriptionMaker = (typeof TRANSCRIPTION_MAKERS)[number];
export const TRANSCRIPT_TEXT_MAX = 4000;
export const TRANSCRIPT_SPEAKER_MAX = 80;
export const TRANSCRIPT_SEGMENTS_MAX = 5000;

export const zTranscriptSegmentInput = z.strictObject({
  startSeconds: z.number().min(0).max(86_400),
  endSeconds: z.number().min(0).max(86_400),
  speakerLabel: z.string().trim().min(1).max(TRANSCRIPT_SPEAKER_MAX),
  text: z.string().trim().min(1).max(TRANSCRIPT_TEXT_MAX),
});
export type TranscriptSegmentInput = z.infer<typeof zTranscriptSegmentInput>;

// Replaces the meeting's draft transcript with these segments: the recorder's transcription run, or a re-run.
export const zTranscriptDraftStore = z.strictObject({
  meetingId: zId,
  segments: z.array(zTranscriptSegmentInput).max(TRANSCRIPT_SEGMENTS_MAX),
});
export const zTranscriptDraftStored = z.strictObject({ meetingId: zId, stored: z.number().int().min(0) });

// The recorder's correction of one draft segment: its text, its speaker label, or both.
export const zTranscriptCorrect = z
  .strictObject({
    segmentId: zId,
    text: z.string().trim().min(1).max(TRANSCRIPT_TEXT_MAX).optional(),
    speakerLabel: z.string().trim().min(1).max(TRANSCRIPT_SPEAKER_MAX).optional(),
  })
  .refine((v) => v.text !== undefined || v.speakerLabel !== undefined, { message: 'name a text or a speaker label to correct' });
export const zTranscriptCorrected = z.strictObject({ segmentId: zId, corrected: z.literal(true) });

export const zTranscriptSegment = z.strictObject({
  id: zId,
  startSeconds: z.number(),
  endSeconds: z.number(),
  speakerLabel: z.string(),
  text: z.string(),
  stage: z.enum(TRANSCRIPT_STAGES),
  corrected: z.boolean(),
  source: z.enum(TRANSCRIPTION_MAKERS),
});
export type TranscriptSegment = z.infer<typeof zTranscriptSegment>;

// The input of the import of a platform's transcript (C2, #3174): the lines the job staged, read again and bounded here (tainted input). It is no RPC input: only the import route runs the command.
// A line of a platform's transcript, read again here (defense in depth: the job's `stageTranscript` already clamps the times and drops NUL bytes, so a staged line holds neither fault; this refuses
// them if the staged bytes ever come from another path). A line that ends before it starts is no span of speech, and a NUL byte is no text: Postgres refuses it in a text column, which would fail the
// whole import with a 500 instead of this refusal. Only the platform import asks for this: the draft transcript of a recording (`zTranscriptDraftStore`) keeps its own rules.
const zImportedSegment = zTranscriptSegmentInput
  .refine((line) => line.endSeconds >= line.startSeconds, { message: 'a line ends before it starts', path: ['endSeconds'] })
  .refine((line) => !line.text.includes('\u0000'), { message: 'a line holds a NUL byte', path: ['text'] })
  .refine((line) => !line.speakerLabel.includes('\u0000'), { message: 'a line holds a NUL byte', path: ['speakerLabel'] });
export const zMeetingTranscriptImport = z.strictObject({
  meetingId: zId,
  segments: z.array(zImportedSegment).min(1).max(TRANSCRIPT_SEGMENTS_MAX),
  // The platform's transcript was longer than the lines here (#3922): the staged file says so, the route passes it on, the meeting keeps it.
  platformCut: z.boolean().default(false),
});
export type MeetingTranscriptImport = z.infer<typeof zMeetingTranscriptImport>;

// What the caller may read of a meeting's transcript: the recorder reads their draft (and anything published); every other
// reader of the meeting reads published segments only. `stage` is the stage the caller sees.
export const zTranscript = z.strictObject({
  meetingId: zId,
  isRecorder: z.boolean(),
  stage: z.enum(['none', ...TRANSCRIPT_STAGES]),
  segments: z.array(zTranscriptSegment),
});
export type Transcript = z.infer<typeof zTranscript>;

// Search across the transcript lines the caller reads (L2, #2589). A plain search, no model call. `q` is folded in SQL like the lines are (lower case, Vietnamese
// marks and đ removed), every word a word prefix, all required. A page is `limit` hits from `offset`; at most MEETING_SEARCH_HITS_MAX hits can be paged, and `capped`
// says that more matched than that.
export const MEETING_SEARCH_QUERY_MAX = 200;
export const MEETING_SEARCH_HITS_MAX = 200;
export const MEETING_SEARCH_PAGE_MAX = 50;
export const zMeetingSearchInput = z.strictObject({
  q: z.string().trim().min(2).max(MEETING_SEARCH_QUERY_MAX),
  limit: z.number().int().min(1).max(MEETING_SEARCH_PAGE_MAX).default(20),
  offset: z.number().int().min(0).max(MEETING_SEARCH_HITS_MAX).default(0),
  // Only the lines of the meetings that carry this label (#4965), the same label whatever the case: the command keeps the page to the labelled meetings, from the hits the search can reach (the first 200), so a page is never cut after it was read.
  label: z.string().trim().pipe(zLabelValue).optional(),
});
export type MeetingSearchInput = z.infer<typeof zMeetingSearchInput>;
export const zMeetingSearchHit = z.strictObject({
  meetingId: zId,
  meetingTitle: z.string(),
  // When the meeting was held (its start, else when it was created), an ISO 8601 instant.
  heldAt: z.string(),
  segmentId: zId,
  startSeconds: z.number(),
  speakerLabel: z.string(),
  text: z.string(),
  // The stage the caller sees: a draft line is the recorder's own.
  stage: z.enum(TRANSCRIPT_STAGES),
});
export type MeetingSearchHit = z.infer<typeof zMeetingSearchHit>;
export const zMeetingSearchResult = z.strictObject({
  hits: z.array(zMeetingSearchHit),
  hasMore: z.boolean(),
  capped: z.boolean(),
});
export type MeetingSearchResult = z.infer<typeof zMeetingSearchResult>;

// The recorder's transcription run (#2578, M4b, ADR-0049 decision 8). The recorder's own Vy transcribes in the background and writes only its own
// result (member_vy_result); the recorder's own action then copies that result into the draft transcript.
export const TRANSCRIBE_STATES = ['none', 'running', 'ready', 'failed'] as const;
export type TranscribeState = (typeof TRANSCRIBE_STATES)[number];
export const zTranscribeStart = z.strictObject({ meetingId: zId });
export const zTranscribeStarted = z.strictObject({ meetingId: zId, runId: zId });
// The recorder stops their own transcription run of a meeting (#3033): `cancelled` is false when there was nothing running to stop.
export const zTranscribeCancel = z.strictObject({ meetingId: zId });
export const zTranscribeCancelled = z.strictObject({ meetingId: zId, cancelled: z.boolean() });
// What the recorder's screen shows: whether transcription is switched on in this deployment at all, the state of the latest run, and the fixed
// code of a failed one (AI_OFF, AI_BUDGET_EXHAUSTED, TRANSCRIBE_FAILED, ...). Never text.
export const zTranscribeStatus = z.strictObject({
  meetingId: zId,
  enabled: z.boolean(),
  state: z.enum(TRANSCRIBE_STATES),
  runId: zId.nullable(),
  errorCode: z.string().nullable(),
});
export type TranscribeStatus = z.infer<typeof zTranscribeStatus>;
// The recorder copies a finished run's result into the draft transcript (replacing the earlier draft, as draft_store does).
export const zTranscriptCopy = z.strictObject({ meetingId: zId, runId: zId });
// A meeting, for the recorder's transcription status.
export const zTranscribeRunRef = z.strictObject({ meetingId: zId });
// What a transcription run stores in its result row: a compact JSON, `{"v":1,"p":[speakers],"s":[[start,end,speaker index,text],...]}`. A result row holds at
// most 100000 characters (a database check), which is about an hour and a half of speech; a longer meeting fails with TRANSCRIPT_TOO_LONG, never a cut transcript.
export const zTranscriptResult = z.strictObject({
  v: z.literal(1),
  p: z.array(z.string()).max(200),
  s: z.array(z.tuple([z.number(), z.number(), z.number().int().min(0), z.string()])).max(TRANSCRIPT_SEGMENTS_MAX),
});

// Code-assisted draft redaction (#4001, ADR-0047): deterministic detection on all draft publish surfaces; typed marks with zero original digits/chars; no undo store.
export const REDACTION_KINDS = ['email', 'phone', 'national_id', 'tax_code', 'bank_account'] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];
export const zRedactionKind = z.enum(REDACTION_KINDS);

export const REDACTION_MARK_BY_KIND: Readonly<Record<RedactionKind, string>> = Object.freeze({
  email: '[đã ẩn: email]',
  phone: '[đã ẩn: số điện thoại]',
  national_id: '[đã ẩn: CCCD]',
  tax_code: '[đã ẩn: mã số thuế]',
  bank_account: '[đã ẩn: số tài khoản]',
});

export const REDACTION_SURFACES = [
  'transcript_segment.text',
  'transcript_segment.speaker_label',
  'meeting_result.summary',
  'meeting_result.decision',
  'action_item.title',
  'action_item.who_drafted',
  'action_item.when_drafted',
  'meeting_chapter.title',
  'meeting.title',
] as const;
export type RedactionSurface = (typeof REDACTION_SURFACES)[number];
export const zRedactionSurface = z.enum(REDACTION_SURFACES);

export const REDACTION_CANDIDATES_MAX = 2000;
export const REDACTION_SELECTIONS_MAX = 500;

export const zRedactionCandidate = z.strictObject({
  surface: zRedactionSurface,
  targetId: zId,
  decisionIndex: z.number().int().min(0).max(50 - 1).nullable(),
  kind: zRedactionKind,
  startPos: z.number().int().min(1).max(1_000_000),
  endPos: z.number().int().min(2),
  matchText: z.string().min(1),
  mark: z.string().min(1),
  version: z.string().min(1),
  startSeconds: z.number().nullable(),
});
export type RedactionCandidate = z.infer<typeof zRedactionCandidate>;

export const zTranscriptRedactCandidates = z.strictObject({
  meetingId: zId,
  titleEditable: z.boolean(),
  candidates: z.array(zRedactionCandidate).max(REDACTION_CANDIDATES_MAX),
  truncated: z.boolean(),
});
export type TranscriptRedactCandidates = z.infer<typeof zTranscriptRedactCandidates>;

export const zRedactionSelection = z
  .strictObject({
    surface: zRedactionSurface,
    targetId: zId,
    decisionIndex: z.number().int().min(0).max(50 - 1).nullable().default(null),
    kind: zRedactionKind,
    startPos: z.number().int().min(1).max(1_000_000),
    version: z.string().trim().min(1).max(64),
  })
  .refine((v) => (v.surface === 'meeting_result.decision' ? v.decisionIndex !== null : v.decisionIndex === null), {
    message: 'decisionIndex is required for meeting_result.decision and must be null otherwise',
  });
export type RedactionSelection = z.infer<typeof zRedactionSelection>;

export const zTranscriptRedact = z.strictObject({
  meetingId: zId,
  confirmed: z.literal(true),
  items: z.array(zRedactionSelection).min(1).max(REDACTION_SELECTIONS_MAX),
});
export type TranscriptRedact = z.infer<typeof zTranscriptRedact>;

export const zRedactionCountsByKind = z.strictObject({
  email: z.number().int().min(0),
  phone: z.number().int().min(0),
  national_id: z.number().int().min(0),
  tax_code: z.number().int().min(0),
  bank_account: z.number().int().min(0),
});
export type RedactionCountsByKind = z.infer<typeof zRedactionCountsByKind>;

export const zTranscriptRedacted = z.strictObject({
  meetingId: zId,
  redactedCount: z.number().int().min(0),
  countsByKind: zRedactionCountsByKind,
  droppedVyResults: z.number().int().min(0),
  cancelledVyRuns: z.number().int().min(0),
  droppedTranslations: z.number().int().min(0),
});
export type TranscriptRedacted = z.infer<typeof zTranscriptRedacted>;

// The summary, the decisions and the action items of a meeting (#2580, M6 part A). The recorder types them or copies them from the result of their own Vy;
// they are drafts only the recorder reads until the recorder's one click publishes them to the meeting's readers.
export const RESULT_SUMMARY_MAX = 8000;
export const RESULT_DECISION_MAX = 500;
export const RESULT_DECISIONS_MAX = 50;
export const ITEM_TITLE_MAX = 300;
export const ITEM_TEXT_MAX = 200;
export const ITEMS_PER_MEETING_MAX = 100;
// `asked_aloud`: the item came from a cue spoken to Vy in the meeting (#4807). An item with any flag is never "clean", so the bulk accept leaves it for the recorder to confirm one by one.
export const ITEM_FLAGS = ['contact_in_title', 'asked_aloud'] as const;
export type ItemFlag = (typeof ITEM_FLAGS)[number];

const zDay = z.iso.date();

// Saves the recorder's own summary and decisions as the draft (replacing the earlier draft).
// A meeting on the general template (Tóm tắt chung) is saved as `summary`; one on another template (A4, #3162) is saved as the template's `sections` and the
// summary is made from them by code (sectionsToText), so a result is one text however it was typed. The module refuses the mix.
export const zMeetingResultSave = z
  .strictObject({
    meetingId: zId,
    summary: z.string().trim().max(RESULT_SUMMARY_MAX).default(''),
    sections: z.array(zSectionEntry).max(SECTIONS_MAX).default([]),
    decisions: z.array(z.string().trim().min(1).max(RESULT_DECISION_MAX)).max(RESULT_DECISIONS_MAX),
  })
  .refine((v) => v.summary !== '' || v.sections.some((s) => s.text !== ''), { message: 'write a summary or a section', path: ['summary'] });
export const zMeetingResultSaved = z.strictObject({ meetingId: zId, decisions: z.number().int().min(0) });

const zItemFields = {
  title: z.string().trim().min(1).max(ITEM_TITLE_MAX),
  // Who and when as said, free words; and as the person (or code) matched them: an attendee of the meeting, a date.
  who: z.string().trim().max(ITEM_TEXT_MAX),
  whoUserId: zId.nullable(),
  when: z.string().trim().max(ITEM_TEXT_MAX),
  whenDate: zDay.nullable(),
  transcriptSeconds: z.number().int().min(0).max(86_400).nullable(),
};
export const zActionItemCreate = z.strictObject({ meetingId: zId, ...zItemFields });
export const zActionItemEdit = z
  .strictObject({
    itemId: zId,
    title: zItemFields.title.optional(),
    who: zItemFields.who.optional(),
    whoUserId: zItemFields.whoUserId.optional(),
    when: zItemFields.when.optional(),
    whenDate: zItemFields.whenDate.optional(),
    transcriptSeconds: zItemFields.transcriptSeconds.optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: 'name something to change' });
export const zActionItemRef = z.strictObject({ itemId: zId });
export const zActionItemCreated = z.strictObject({ itemId: zId });
export const zActionItemDeleted = z.strictObject({ itemId: zId, deleted: z.literal(true) });

// The one click that shows the drafts to the meeting's readers: `confirmed: true` is the person's own click, never defaulted.
export const zResultPublish = z.strictObject({ meetingId: zId, confirmed: z.literal(true) });
// `chapters` (#3844): how many chapters of the meeting's table of contents were published with them.
// `lines` (#4899): how many lines of the draft transcript were shared with them, the lines the meeting's readers read from now on.
export const zResultPublished = z.strictObject({ meetingId: zId, results: z.number().int().min(0), items: z.number().int().min(0), chapters: z.number().int().min(0), lines: z.number().int().min(0) });

// Accepting an item makes a team task from it. The person confirms the title, picks the date and the seat (never picked for them when the attendee holds
// none or several); a task is read by every member, and the transcript is never copied into it.
export const zActionItemAccept = z.strictObject({
  itemId: zId,
  confirmed: z.literal(true),
  title: z.string().trim().min(1).max(ITEM_TITLE_MAX),
  due: zDay.nullable(),
  positionId: zId,
});
export const zActionItemAccepted = z.strictObject({ itemId: zId, taskId: zId });
// Every clean item at once: its attendee holds exactly one seat, its date is parsed, its title carries no link, email or phone, and it has no flag.
export const zActionItemAcceptClean = z.strictObject({ meetingId: zId, confirmed: z.literal(true) });
export const zActionItemsAccepted = z.strictObject({ meetingId: zId, accepted: z.number().int().min(0), taskIds: z.array(zId) });

export const zMeetingResultView = z.strictObject({
  id: zId,
  feature: z.enum(['manual', 'meetings.summary']),
  stage: z.enum(TRANSCRIPT_STAGES),
  summary: z.string(),
  decisions: z.array(z.string()),
  tainted: z.boolean(),
});
export const zActionItemView = z.strictObject({
  id: zId,
  stage: z.enum(TRANSCRIPT_STAGES),
  status: z.enum(['suggested', 'accepted']),
  title: z.string(),
  who: z.string(),
  whoUserId: zId.nullable(),
  when: z.string(),
  whenDate: zDay.nullable(),
  transcriptSeconds: z.number().int().nullable(),
  flags: z.array(z.enum(ITEM_FLAGS)),
  tainted: z.boolean(),
  taskId: zId.nullable(),
  // The seats the attendee holds now (a person picks one at accept); clean only with exactly one, a parsed date and no flag.
  positions: z.array(z.strictObject({ id: zId, title: z.string() })),
  clean: z.boolean(),
  // Who the said name probably means (#3921), found by code when the item names nobody yet: the one attendee, else the one other member, whose name the said words match; null when none or
  // when two or more match. Only a suggestion: nothing is stored until a person makes the task, and the seats are those the person holds now.
  suggestion: z.strictObject({ userId: zId, name: z.string(), source: z.enum(['attendee', 'member']), positions: z.array(z.strictObject({ id: zId, title: z.string() })) }).nullable(),
});
export const zMeetingResults = z.strictObject({
  meetingId: zId,
  isRecorder: z.boolean(),
  // The recorder reads a draft beside the published one; a reader reads the published one only.
  draft: zMeetingResultView.nullable(),
  published: zMeetingResultView.nullable(),
  items: z.array(zActionItemView),
  // The recorder's draft transcript lines (#4899): how many there are (the publish shares them too), how many of them a machine wrote (a transcription, a platform's transcript) and the recorder has not read
  // yet (shared only after the review), and a key over exactly those unread lines that the review sends back so it clears only what this screen showed. Zero and empty for a reader, and for a transcript the
  // recorder typed.
  transcriptDraft: z.number().int().min(0),
  transcriptUnread: z.number().int().min(0),
  transcriptUnreadKey: z.string().max(64),
});
export type MeetingResults = z.infer<typeof zMeetingResults>;
export type ActionItemView = z.infer<typeof zActionItemView>;
// Where a task made from an item came from, for the link on the task: the meeting when the caller may read it, else a refusal the screen words.
export const zActionItemSource = z.strictObject({ meetingId: zId });

// The recorder copies a finished summary run of their own Vy into their draft (#2580, M6 part B): the draft summary, the decisions and the action items,
// all marked as the model's text until the recorder edits them. Nothing is shared by this; the recorder's own publish does that.
export const zSummaryCopy = z.strictObject({ meetingId: zId, runId: zId });
export const zSummaryCopied = z.strictObject({ meetingId: zId, decisions: z.number().int().min(0), items: z.number().int().min(0), dropped: z.number().int().min(0) });
// What a summary run stores in its result row: the body the agent package's checks produced. The copy command reads it back strictly, as it reads a transcript.
// A5 (#3163): "Viết lại đầy đủ", Vy's expansion of the recorder's rough notes with the transcript. The recorder's own lines are kept verbatim (code inserts the original text of a note line
// the model named by number, so no model wording can replace it) and every line Vy added carries the second of the transcript it rests on. Built per section of the meeting's template
// (key null on the general summary, which has one block). The text is the same one copied into the draft by meetings.summary.copy_result; this shape is for the recorder to read first.
export const NOTES_BODY_MAX = 6000;
export const ENHANCED_LINE_MAX = 6000;
// The note lines (at most 300) and the lines Vy adds (at most 100) of one section.
export const ENHANCED_LINES_MAX = 400;
export const zEnhancedLine = z.strictObject({
  // true: the recorder's own line, verbatim; false: a line Vy added, with `seconds` pointing at a real line of the transcript.
  own: z.boolean(),
  text: z.string().min(1).max(ENHANCED_LINE_MAX),
  seconds: z.number().int().min(0).max(86_400).nullable(),
});
export const zEnhancedSection = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).nullable(),
  lines: z.array(zEnhancedLine).min(1).max(ENHANCED_LINES_MAX),
});
export const zEnhanced = z.strictObject({ sections: z.array(zEnhancedSection).min(1).max(SECTIONS_MAX) });
export type Enhanced = z.infer<typeof zEnhanced>;

// Which attendee a speaker label may be (#3502), as the recorder's Vy proposed it and the agent's checks kept it: the transcript's label, the attendee's own spelling and the second
// of a line that speaker says it on. Only a proposal: the recorder's click (`zSpeakerName`) is what renames the label.
export const SPEAKER_SUGGESTIONS_MAX = 20;
export const zSpeakerSuggestion = z.strictObject({
  label: z.string().min(1).max(TRANSCRIPT_SPEAKER_MAX),
  name: z.string().min(1).max(TRANSCRIPT_SPEAKER_MAX),
  seconds: z.number().int().min(0).max(86_400),
});
export type SpeakerSuggestion = z.infer<typeof zSpeakerSuggestion>;

export const zSummaryResult = z.strictObject({
  // Set when the run expanded the recorder's notes instead of summarizing the transcript (A5); `summary` is then '' and there are no sections, decisions or items of their own.
  enhanced: zEnhanced.optional(),
  // The template the run was asked for and the sections it filled (A4, #3162); a body stored before that has neither, which reads as the general summary.
  template: zMeetingSummaryTemplate.default('general'),
  // On a custom template (#3578): the md5 of the copy of the sections the run was asked to fill. The save refuses a run whose hash is not the meeting's now (another template, or the same one edited and picked again).
  templateHash: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  sections: z.array(zSectionEntry).max(SECTIONS_MAX).default([]),
  summary: z.string().max(RESULT_SUMMARY_MAX),
  decisions: z.array(z.string().min(1).max(RESULT_DECISION_MAX)).max(RESULT_DECISIONS_MAX),
  items: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(ITEM_TITLE_MAX),
        who: z.string().max(ITEM_TEXT_MAX),
        when: z.string().max(ITEM_TEXT_MAX),
        seconds: z.number().int().min(0).max(86_400).nullable(),
      }),
    )
    .max(ITEMS_PER_MEETING_MAX),
  // The speaker suggestions of #3502; a body stored before that has none.
  speakers: z.array(zSpeakerSuggestion).max(SPEAKER_SUGGESTIONS_MAX).default([]),
  dropped: z.number().int().min(0),
});
export type SummaryResult = z.infer<typeof zSummaryResult>;

// The suggestions of a finished summary run that still apply (#3502): the label is still on a draft line and the name is still one of the meeting's people. Read by the recorder alone.
export const zSpeakerSuggestionsInput = z.strictObject({ meetingId: zId, runId: zId });
export const zSpeakerSuggestions = z.strictObject({ meetingId: zId, runId: zId, suggestions: z.array(zSpeakerSuggestion).max(SPEAKER_SUGGESTIONS_MAX) });
export type SpeakerSuggestions = z.infer<typeof zSpeakerSuggestions>;
// The recorder's click: the draft lines that carry `label` take `name` for their speaker. The name must be one of the meeting's people; nothing of Vy's is needed.
export const zSpeakerName = z.strictObject({
  meetingId: zId,
  label: z.string().min(1).max(TRANSCRIPT_SPEAKER_MAX),
  name: z.string().min(1).max(TRANSCRIPT_SPEAKER_MAX),
});
export const zSpeakerNamed = z.strictObject({ meetingId: zId, label: z.string(), name: z.string(), lines: z.number().int().min(1) });

// The recorder's rough notes of a meeting (A5, #3163): theirs alone to read and write. Saving an empty text deletes them.
export const zNotesSave = z.strictObject({ meetingId: zId, body: z.string().max(NOTES_BODY_MAX) });
export const zNotesSaved = z.strictObject({ meetingId: zId, saved: z.boolean() });
export const zNotes = z.strictObject({ meetingId: zId, body: z.string(), updatedAt: z.string().nullable() });
export type Notes = z.infer<typeof zNotes>;
// What the recorder reads of a finished expansion before copying it into their draft: their own lines and Vy's, by section, and how many lines the checks removed.
export const zNotesPreviewInput = z.strictObject({ meetingId: zId, runId: zId });
export const zNotesPreview = z.strictObject({ meetingId: zId, runId: zId, template: zMeetingSummaryTemplate, enhanced: zEnhanced, dropped: z.number().int().min(0) });
export type NotesPreview = z.infer<typeof zNotesPreview>;

// The recorder's explicit review of the draft Vy wrote: `confirmed: true` is their own click, never defaulted. Only then can the draft be shared.
// `ids` are the rows the screen showed (the summary and the items): only those lose the mark, so a row copied in another tab after the recorder looked keeps it.
// `transcript` (#4899): the same "I read this" for the draft transcript lines of the meeting that a machine wrote. They are too many to name one by one (an hour of talk is hundreds of lines), so the
// command finds them itself, in the recorder's own meeting. Either some ids or `transcript` must be there.
export const zDraftReview = z
  // `transcript` is the key the screen was given with `transcriptUnreadKey`: the review reads the unread transcript lines only while they are still exactly those (STALE_TRANSCRIPT_REVIEW otherwise).
  .strictObject({ meetingId: zId, confirmed: z.literal(true), ids: z.array(zId).max(ITEMS_PER_MEETING_MAX + 1), transcript: z.string().min(1).max(64).optional() })
  .refine((v) => v.ids.length > 0 || v.transcript !== undefined, { message: 'name what was read: ids, or the transcript' });
export const zDraftReviewed = z.strictObject({ meetingId: zId, cleared: z.number().int().min(0) });

// The recorder's Vy summarizing a meeting (#2580, M6 part B2). `start` is the module's own command (the route runs it first); `summarize` is the route the screen
// calls: it starts the run, reads the transcript as the recorder, makes the one model call and stores the answer in the recorder's own Vy result, then says how it
// went in fixed words. The recorder copies a finished result into their draft with copySummary.
export const SUMMARY_STATES = ['ready', 'failed'] as const;
export const zSummaryStart = z.strictObject({ meetingId: zId });
export const zSummaryStarted = z.strictObject({ meetingId: zId, runId: zId });
export const zSummaryRef = z.strictObject({ meetingId: zId });
// `reason` says why not: the deployment's switch is off, or the caller is not the meeting's recorder.
export const zSummaryStatus = z.strictObject({ meetingId: zId, enabled: z.boolean(), reason: z.enum(['off', 'not_recorder']).nullable() });
export const zSummarized = z.strictObject({ meetingId: zId, runId: zId, state: z.enum(SUMMARY_STATES), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable() });
export type Summarized = z.infer<typeof zSummarized>;

// Live notes (L4a-2, #3110, ADR-0052 decision 2): the preview of a meeting being recorded. The pieces of #3109 are transcribed by the recorder's own Vy, one run
// per window, and the recorder's own tick copies each finished window into the preview lines and the running notes. The lines are the recorder's alone and are
// replaced by the batch transcript; the notes are ordinary draft rows (feature meetings.live_notes), so a task still needs the recorder's click.
export const LIVE_LINE_TEXT_MAX = 4000;
export const LIVE_LINES_MAX = 100_000;
// The pieces one window takes: one or two of about 15 seconds each, so a line is never more than about one window behind the speech (the target of ADR-0052 is about
// 30 seconds). A tick with no new piece starts nothing.
export const LIVE_WINDOW_PIECES = 2;
// How often the running notes are refreshed, unless the recorder asks for them sooner.
export const LIVE_NOTES_EVERY_SECONDS = 5 * 60;
// What one window's run stores in its result row, read back strictly by the tick, as a transcript result is.
export const zLiveResult = z.strictObject({
  v: z.literal(1),
  // [piece order, start seconds, end seconds, text] of each piece this window read. A silent piece has the text '': it is still a line, so the next window starts after it
  // (a silent start or a pause must not be read again at every tick), and it is not shown.
  lines: z.array(z.tuple([z.number().int().min(0).max(LIVE_LINES_MAX - 1), z.number().int().min(0).max(86_400), z.number().int().min(0).max(86_400), z.string().max(LIVE_LINE_TEXT_MAX)])).max(200),
});
export type LiveResult = z.infer<typeof zLiveResult>;

// The running notes (the second part of the live notes): asked on its own, every five minutes or on the recorder's click, because a member's Vy has one live run per
// feature and a window may be running. `previous` is the live draft as it stands (null the first time) and `lines` the preview lines written since it was.
export const zLiveNotesInput = z.strictObject({
  meetingId: zId,
  language: zMeetingLanguage,
  previous: z.strictObject({ summary: z.string(), decisions: z.array(z.string()), items: z.array(z.string()) }).nullable(),
  lines: z.array(z.strictObject({ startSeconds: z.number().int().min(0), endSeconds: z.number().int().min(0), text: z.string() })),
});
export type LiveNotesInput = z.infer<typeof zLiveNotesInput>;
export const zLiveNotesAsk = z.strictObject({ meetingId: zId });
export const zLiveNotesDone = z.strictObject({
  meetingId: zId,
  // 'nothing': no new line since the notes were last made, so no run was started and nothing was spent.
  state: z.enum(['ready', 'failed', 'nothing']),
  runId: zId.nullable(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  decisions: z.number().int().min(0),
  items: z.number().int().min(0),
});
export type LiveNotesDone = z.infer<typeof zLiveNotesDone>;
export const zLiveNotesCopy = z.strictObject({ meetingId: zId, runId: zId });

export const zLiveRef = z.strictObject({ meetingId: zId });
export const zLiveStart = z.strictObject({ meetingId: zId });
export const zLiveStarted = z.strictObject({ meetingId: zId, runId: zId });
export const zLiveTick = z.strictObject({ meetingId: zId });
export const zLiveTicked = z.strictObject({
  meetingId: zId,
  // The window that was copied, when one was ready.
  copiedRunId: zId.nullable(),
  lines: z.number().int().min(0),
  // The window started by this tick, when one was.
  runId: zId.nullable(),
  state: z.enum(['off', 'waiting', 'running', 'stopped']),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
});
export type LiveTicked = z.infer<typeof zLiveTicked>;
export const zLiveStopped = z.strictObject({ meetingId: zId, stopped: z.boolean() });
export const zLiveLine = z.strictObject({
  id: zId,
  seq: z.number().int().min(0),
  startSeconds: z.number().int().min(0),
  endSeconds: z.number().int().min(0),
  text: z.string(),
});
export type LiveLine = z.infer<typeof zLiveLine>;
// What the live pane shows. `enabled` is the deployment's transcription switch and the meeting's own opt-in; `reason` says why the pane is empty when it is.
export const zLiveStatus = z.strictObject({
  meetingId: zId,
  // The meeting was opted into live notes at its consent step (#3109).
  optedIn: z.boolean(),
  // This deployment transcribes and holds a credential key, and AI is not off.
  enabled: z.boolean(),
  state: z.enum(['off', 'waiting', 'running', 'stopped']),
  runId: zId.nullable(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  lines: z.array(zLiveLine),
  notesUpdatedAt: z.string().nullable(),
  // Whether the recorder may join the pieces into the recording because the final upload never arrived (#3126); only the recorder sees it.
  assemble: zLiveAssembleState,
});
export type LiveStatus = z.infer<typeof zLiveStatus>;

// Links of a meeting (L1, #2587, ADR-0024): to a party, to at most one deal, and to the calendar event it came from. Set and removed by the meeting's
// recorder; read only by the readers of the meeting.
export const MEETING_LINK_KINDS = ['party', 'deal', 'calendar_event'] as const;
export type MeetingLinkKind = (typeof MEETING_LINK_KINDS)[number];
export const zMeetingLinkKind = z.enum(MEETING_LINK_KINDS);

export const zMeetingLinkAdd = z.strictObject({
  meetingId: zId,
  kind: zMeetingLinkKind,
  targetId: zId,
});
export type MeetingLinkAdd = z.infer<typeof zMeetingLinkAdd>;

export const zMeetingLinkRemove = z.strictObject({
  meetingId: zId,
  linkId: zId,
});
export type MeetingLinkRemove = z.infer<typeof zMeetingLinkRemove>;

export const zMeetingLink = z.strictObject({
  id: zId,
  meetingId: zId,
  kind: zMeetingLinkKind,
  targetId: zId,
  // The name to show: a party's name or the calendar event's title; null for a deal (the CRM module names it) and from add.
  label: z.string().nullable(),
  createdBy: zId,
  createdAt: z.string(),
});
export type MeetingLink = z.infer<typeof zMeetingLink>;

export const zMeetingLinkRemoved = z.strictObject({ meetingId: zId, linkId: zId, removed: z.boolean() });
export type MeetingLinkRemoved = z.infer<typeof zMeetingLinkRemoved>;

// The meetings linked to one target, as the viewer may read them: a meeting the viewer does not read is not in the list at all (no row, no title).
export const MEETING_LINK_PAGE = 50;
export const zMeetingsOfTargetInput = z.strictObject({
  kind: zMeetingLinkKind,
  targetId: zId,
  limit: z.number().int().min(1).max(MEETING_LINK_PAGE).optional(),
});
export type MeetingsOfTargetInput = z.infer<typeof zMeetingsOfTargetInput>;

export const zMeetingOfTarget = z.strictObject({
  linkId: zId,
  meetingId: zId,
  title: z.string(),
  startedAt: z.string().nullable(),
  status: zMeetingStatus,
  visibility: zMeetingVisibility,
  recorderUserId: zId,
});
export type MeetingOfTarget = z.infer<typeof zMeetingOfTarget>;

// Vy's suggestion of what a meeting may be linked to (L1, #2587): read only, for the recorder. A suggestion is TAINTED (computed from the transcript text, which can
// say anything): it names a contact whose name the transcript says, and a deal whose title it says, and links nothing. The recorder links with a click on links.add,
// which checks the target again. The core works with AI off: today the suggestion is deterministic and calls no model.
export const MEETING_LINK_SUGGEST_MAX = 5;
// `ai` names what the model did: always 'off' today (the suggestion is deterministic, no model is called and no transcript text leaves the kernel); the other states are
// kept for a later model ordering through the AI budget meter, as the contact-company suggestion has (#2438).
export const MEETING_LINK_SUGGEST_AI = ['off', 'used', 'budget', 'busy', 'failed'] as const;
export const zMeetingLinkSuggested = z.strictObject({
  tainted: z.literal(true),
  ai: z.enum(MEETING_LINK_SUGGEST_AI),
  parties: z.array(z.strictObject({ partyId: zId, name: z.string(), mentions: z.number().int() })).max(MEETING_LINK_SUGGEST_MAX),
  deals: z.array(z.strictObject({ dealId: zId, title: z.string(), partyId: zId, partyName: z.string() })).max(MEETING_LINK_SUGGEST_MAX),
});
export type MeetingLinkSuggested = z.infer<typeof zMeetingLinkSuggested>;

// The machine translation of a meeting's summary (meetings integrations E1, #3184, plan section 7a). The member's own Vy translates the summary, its decisions and the titles
// of its action items between Vietnamese and English in one call; the result is kept privately for the member who asked (its own table in the meetings schema), shown beside the original
// as "Bản dịch máy", tainted, and never the source of a task, mail, post, webhook, search hit or export. `stage` is the summary the member read: the published one (any reader) or
// their own draft (the recorder).
export const TRANSLATION_STAGES = ['draft', 'published'] as const;
// The languages a translation can be made INTO (E3, #3186): a meeting is held in `vi` or `en` (MEETING_LANGUAGES), and Chinese (Simplified), Japanese and Korean are targets only. Each of the three is offered
// only where the deployment has switched it on (MEETINGS_TRANSLATION_LANGUAGES), after a native reader's check of its quality; `vi` and `en` are always the other language of the pair.
export const TRANSLATION_TARGETS = ['vi', 'en', 'zh', 'ja', 'ko'] as const;
export type TranslationTarget = (typeof TRANSLATION_TARGETS)[number];
export const zTranslationTarget = z.enum(TRANSLATION_TARGETS);
export const TRANSLATION_FLAGGED_TARGETS = ['zh', 'ja', 'ko'] as const;
export type TranslationFlaggedTarget = (typeof TRANSLATION_FLAGGED_TARGETS)[number];
export const TRANSLATION_STATES = ['ok', 'warn', 'refused'] as const;
// A fixed word for what code found: a refusal (MISSING, EMPTY, TOO_LONG, UNCHANGED, INVENTED_NUMBER, CONTACT_ADDED) or a warning (NUMBER_DROPPED, NAME_ADDED).
export const TRANSLATION_CODES = ['MISSING', 'EMPTY', 'TOO_LONG', 'UNCHANGED', 'INVENTED_NUMBER', 'CONTACT_ADDED', 'NUMBER_DROPPED', 'NAME_ADDED'] as const;
export const TRANSLATION_SEGMENTS_MAX = 1 + RESULT_DECISIONS_MAX + ITEMS_PER_MEETING_MAX;
export const TRANSLATION_SEGMENT_TEXT_MAX = 12_000;
const zTranslationStage = z.enum(TRANSLATION_STAGES);
// 'summary', 'decision:<index>' or 'item:<id>': what a segment translates.
export const zTranslationKey = z.string().regex(/^(?:summary|decision:\d{1,3}|item:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
export const zTranslationHash = z.string().regex(/^[0-9a-f]{64}$/);
export const zTranslationSegment = z.strictObject({
  key: zTranslationKey,
  // '' for a refused segment: the original shows, with a fixed word.
  text: z.string().max(TRANSLATION_SEGMENT_TEXT_MAX),
  state: z.enum(TRANSLATION_STATES),
  codes: z.array(z.enum(TRANSLATION_CODES)).max(TRANSLATION_CODES.length),
});
export type TranslationSegment = z.infer<typeof zTranslationSegment>;
// What a translation run stores in its result row (the body the agent package's checks produced); the sink reads it back strictly, as it reads a summary result.
export const zTranslationResult = z.strictObject({
  v: z.literal(1),
  from: zMeetingLanguage,
  to: zTranslationTarget,
  stage: zTranslationStage,
  hash: zTranslationHash,
  segments: z.array(zTranslationSegment).min(1).max(TRANSLATION_SEGMENTS_MAX),
});
export type TranslationResult = z.infer<typeof zTranslationResult>;

// `to`: the language asked for; absent, the other language of the vi/en pair (what the screens did before the picker, #3186).
export const zTranslationRef = z.strictObject({ meetingId: zId, stage: zTranslationStage, to: zTranslationTarget.optional() });
// The same for the transcript, which has no stage in the request.
export const zTranscriptTranslationRef = z.strictObject({ meetingId: zId, to: zTranslationTarget.optional() });
// The text the caller reads and may translate: the original segments in the order the screen shows them, the language pair and the hash of the text (a changed original has another hash).
export const zTranslationSource = z.strictObject({
  meetingId: zId,
  stage: zTranslationStage,
  from: zMeetingLanguage,
  to: zTranslationTarget,
  hash: zTranslationHash,
  segments: z.array(z.strictObject({ key: zTranslationKey, text: z.string() })).min(1).max(TRANSLATION_SEGMENTS_MAX),
});
export type TranslationSource = z.infer<typeof zTranslationSource>;
export const zTranslateStarted = z.strictObject({ meetingId: zId, runId: zId });
export const zTranslationCopy = z.strictObject({ meetingId: zId, runId: zId });
export const zTranslationCopied = z.strictObject({
  meetingId: zId,
  stage: zTranslationStage,
  segments: z.number().int().min(1),
  refused: z.number().int().min(0),
  warned: z.number().int().min(0),
});
// The route the screen calls: starts the run, reads what the member reads, makes the one model call, stores the answer and keeps it for the member; says how it went in fixed words.
export const zTranslated = z.strictObject({
  meetingId: zId,
  stage: zTranslationStage,
  runId: zId.nullable(),
  state: z.enum(['ready', 'failed']),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
});
export type Translated = z.infer<typeof zTranslated>;
// What the translate button of a stage shows: whether it can be pressed, why not, the target language and the cost expected before the click. `estimate` is null when the deployment
// has no price set (no figure is better than a guess).
export const zTranslationStatus = z.strictObject({
  meetingId: zId,
  stage: zTranslationStage,
  enabled: z.boolean(),
  reason: z.enum(['off', 'nothing']).nullable(),
  from: zMeetingLanguage,
  to: zTranslationTarget,
  // The languages the member may pick for this meeting: the other language of the pair, and each of Chinese, Japanese and Korean the deployment has switched on (#3186).
  targets: z.array(zTranslationTarget).max(TRANSLATION_TARGETS.length).default([]),
  estimate: z.strictObject({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), cost: z.string().regex(/^\d+(?:\.\d+)?$/).nullable() }).nullable(),
});
export type TranslationStatus = z.infer<typeof zTranslationStatus>;
// The caller's own translations of the meeting, one per stage they asked for, with whether the original changed since (stale: "Bản dịch cũ, dịch lại").
export const zTranslationView = z.strictObject({
  stage: zTranslationStage,
  from: zMeetingLanguage,
  to: zTranslationTarget,
  stale: z.boolean(),
  createdAt: z.string(),
  segments: z.array(zTranslationSegment),
});
// One per stage and language the member asked for.
export const zTranslations = z.strictObject({ meetingId: zId, translations: z.array(zTranslationView).max(TRANSLATION_STAGES.length * TRANSLATION_TARGETS.length) });
export type Translations = z.infer<typeof zTranslations>;

// The machine translation of a meeting's transcript (meetings integrations E2, #3185, plan section 7a). The member's own Vy translates the lines the member reads, a few chunks at a time, in
// the member's own request (ADR-0049 stage A, like the summary); each request takes the next batch of lines that still have no current translation, so a request that stops (a refused
// chunk, a stop, a failure) keeps what earlier ones finished and the next click goes on from there. The page asks again while it is open. The parts live in the same private row as
// the summary's (kind 'transcript'), one row for the member, meeting, stage and language, each part named by the line it translated and the hash of that line's text (a corrected line
// makes its part stale).
// A chunk is about this many UTF-8 bytes of numbered JSON (a one-hour Vietnamese transcript is about twenty of them); a request takes at most this many chunks (one: it stays within the bound of a single model call, whatever deadline a proxy in front sets, and the page asks again).
export const TRANSCRIPT_TRANSLATE_CHUNK_BYTES = 4500;
export const TRANSCRIPT_TRANSLATE_CHUNKS_PER_RUN = 1;
// More lines than this is not a transcript this translates.
export const TRANSCRIPT_TRANSLATE_LINES_MAX = 5000;
const zPartHash = z.string().regex(/^[0-9a-f]{16}$/);
// One translated part as the run stores it in its result row and the copy keeps it in the member's row: k the line's id, h the hash of its text, t the translation ('' when refused),
// s what code found and c the fixed words for it (compact on purpose: the row keeps a part for every line of a long transcript).
export const zTranscriptPart = z.strictObject({
  k: zId,
  h: zPartHash,
  t: z.string().max(TRANSLATION_SEGMENT_TEXT_MAX),
  s: z.enum(TRANSLATION_STATES),
  c: z.array(z.enum(TRANSLATION_CODES)).max(TRANSLATION_CODES.length),
});
export type TranscriptPart = z.infer<typeof zTranscriptPart>;
export const zTranscriptTranslationResult = z.strictObject({
  v: z.literal(1),
  kind: z.literal('transcript'),
  from: zMeetingLanguage,
  to: zTranslationTarget,
  stage: zTranslationStage,
  parts: z.array(zTranscriptPart).min(1).max(TRANSCRIPT_TRANSLATE_LINES_MAX),
});
export type TranscriptTranslationResult = z.infer<typeof zTranscriptTranslationResult>;
// What the row holds: the parts of every request kept so far.
export const zTranscriptParts = z.array(zTranscriptPart).max(TRANSCRIPT_TRANSLATE_LINES_MAX);
// The state of the member's transcript translation, for the button and the progress line ("Đã dịch 12/20 phần"): a part is one chunk-sized share of the transcript, so the figures
// are of parts, not of lines. `state` is the member's latest run of this meeting (none, running, ready or failed with a fixed word).
export const zTranscriptTranslationStatus = z.strictObject({
  meetingId: zId,
  stage: zTranslationStage.nullable(),
  enabled: z.boolean(),
  reason: z.enum(['off', 'nothing']).nullable(),
  from: zMeetingLanguage,
  to: zTranslationTarget,
  // The languages the member may pick for this meeting (as the summary's status says).
  targets: z.array(zTranslationTarget).max(TRANSLATION_TARGETS.length).default([]),
  // Lines of the transcript the member reads, and those with a current translation (a refused line counts: it will not be asked again), those stale, and those still to translate.
  lines: z.number().int().min(0),
  translated: z.number().int().min(0),
  stale: z.number().int().min(0),
  remaining: z.number().int().min(0),
  // Chunks, as the run will send them: those of the whole transcript and those already done.
  chunksTotal: z.number().int().min(0),
  chunksDone: z.number().int().min(0),
  state: z.enum(['none', 'running', 'ready', 'failed']),
  runId: zId.nullable(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  // The cost expected for the lines still to translate, before the click; null when the deployment has no price set.
  estimate: z.strictObject({ calls: z.number().int().min(0), inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), cost: z.string().regex(/^\d+(?:\.\d+)?$/).nullable() }).nullable(),
});
export type TranscriptTranslationStatus = z.infer<typeof zTranscriptTranslationStatus>;
// The route the page calls: takes the next batch, translates it, stores the answer and keeps it for the member; says how it went in fixed words. `translated` is the lines kept by this
// request, `remaining` those still to translate after it.
export const zTranscriptTranslated = z.strictObject({
  meetingId: zId,
  runId: zId.nullable(),
  state: z.enum(['ready', 'failed']),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  translated: z.number().int().min(0),
  remaining: z.number().int().min(0),
});
export type TranscriptTranslated = z.infer<typeof zTranscriptTranslated>;
// What the module's start gives a request: the member's run and the ids of the next batch of lines (whole chunks), and what is left; the text comes from the source query below.
export const zTranscriptStarted = z.strictObject({
  meetingId: zId,
  runId: zId,
  stage: zTranslationStage,
  from: zMeetingLanguage,
  to: zTranslationTarget,
  remaining: z.number().int().min(1),
  lineIds: z.array(zId).min(1).max(TRANSCRIPT_TRANSLATE_LINES_MAX),
});
export type TranscriptStarted = z.infer<typeof zTranscriptStarted>;
export const zTranscriptSourceRef = z.strictObject({ meetingId: zId, lineIds: z.array(zId).min(1).max(TRANSCRIPT_TRANSLATE_LINES_MAX) });
// The text of those lines as the caller reads them now, in the order of the transcript (a line that was removed is not there).
export const zTranscriptSource = z.strictObject({ meetingId: zId, lines: z.array(z.strictObject({ id: zId, text: z.string() })).max(TRANSCRIPT_TRANSLATE_LINES_MAX) });
export type TranscriptSource = z.infer<typeof zTranscriptSource>;
export const zTranscriptTranslateStopped = z.strictObject({ meetingId: zId, stopped: z.boolean() });
// The member's own translated parts of the transcript they read, one per line, with whether the line changed since (stale: "Bản dịch cũ, dịch lại").
export const zTranscriptTranslationView = z.strictObject({
  meetingId: zId,
  stage: zTranslationStage.nullable(),
  from: zMeetingLanguage,
  to: zTranslationTarget,
  parts: z.array(z.strictObject({ lineId: zId, text: z.string(), state: z.enum(TRANSLATION_STATES), codes: z.array(z.enum(TRANSLATION_CODES)), stale: z.boolean() })).max(TRANSCRIPT_TRANSLATE_LINES_MAX),
});
export type TranscriptTranslationView = z.infer<typeof zTranscriptTranslationView>;

// A series of meetings (#3542, owner decision 2026-11-17): meetings that come from one recurring calendar event, or that the recorder says follow one another. `set` is the recorder's click
// "Buổi này nối tiếp buổi trước" (a meeting they recorded; null takes this meeting out of its series). `openItems` is what the caller reads of the previous meeting of the series that is still open:
// accepted items with the live status of their task, and items nobody accepted. A caller who does not read the previous meeting gets none of it (row security), not even its title.
export const SERIES_ITEMS_MAX = 100;
export const zSeriesSet = z.strictObject({ meetingId: zId, previousMeetingId: zId.nullable() });
export const zSeriesSetResult = z.strictObject({ meetingId: zId, inSeries: z.boolean() });
export const zSeriesOpenItemsInput = z.strictObject({ meetingId: zId });
export const SERIES_TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'in_review'] as const;
export const zSeriesOpenItem = z.strictObject({
  id: zId,
  title: z.string(),
  who: z.string(),
  // The person the item's task is with now (the holder of its seat), else the attendee the item was parsed to; null when neither is known.
  whoUserId: zId.nullable(),
  // The title of the seat the task is with, when it has one (shown when no person is known for the item).
  assigneeSeat: z.string().nullable(),
  when: z.string(),
  whenDate: z.string().nullable(),
  // True when the item was accepted into a task; false is "chưa giao" (a suggestion nobody accepted).
  assigned: z.boolean(),
  // The task's live status, or null when the item has no task or the caller cannot read the task.
  taskStatus: z.enum(SERIES_TASK_STATUSES).nullable(),
  due: z.string().nullable(),
});
export type SeriesOpenItem = z.infer<typeof zSeriesOpenItem>;
export const zSeriesOpenItems = z.strictObject({
  meetingId: zId,
  inSeries: z.boolean(),
  previous: z.strictObject({ meetingId: zId, title: z.string(), startedAt: z.string() }).nullable(),
  items: z.array(zSeriesOpenItem).max(SERIES_ITEMS_MAX),
});
export type SeriesOpenItems = z.infer<typeof zSeriesOpenItems>;

// What the worker's series nudge is told (the command checks it again before it writes anything): one member, the series, and the start of the next meeting of it.
export const zSeriesNudge = z.strictObject({ userId: zId, seriesId: zId, startsAt: z.iso.datetime({ offset: true }) });

// The inputs and limits of the two Meetings reads of an MCP company grant (#3731): the descriptions are what the client's model reads.
export const MCP_MEETINGS_DEFAULT = 25;
export const MCP_MEETINGS_MAX = 50;
// The most plain lines of the minutes' text, of characters in each, decisions and action items a client gets; the Truncated flags say when more was left out.
export const MCP_SUMMARY_LINES_MAX = 80;
export const MCP_LINE_MAX = 2000;
export const MCP_DECISIONS_MAX = 30;
export const MCP_ACTIONS_MAX = 50;

export const zMcpMeetingsInput = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional().describe('Only meetings that started at or after this time (ISO 8601 with an offset).'),
  to: z.iso.datetime({ offset: true }).optional().describe('Only meetings that started before this time (ISO 8601 with an offset).'),
  limit: z.number().int().min(1).max(MCP_MEETINGS_MAX).default(MCP_MEETINGS_DEFAULT).describe(`How many meetings to return (1 to ${MCP_MEETINGS_MAX}, default ${MCP_MEETINGS_DEFAULT}).`),
});
export const zMcpMinutesInput = z.strictObject({ meetingId: zId.describe('The id of a meeting from ludy_meetings_list.') });

// The open action items across published org-visible meetings (#3804): at most MCP_OPEN_ACTIONS_MAX, the newest meeting first.
export const MCP_OPEN_ACTIONS_DEFAULT = 50;
export const MCP_OPEN_ACTIONS_MAX = 100;
export const zMcpOpenActionsInput = z.strictObject({
  dueBefore: z.iso.date().optional().describe('Only items with a due date before this day (an ISO day, YYYY-MM-DD). Items with no due date are left out when it is set.'),
  limit: z.number().int().min(1).max(MCP_OPEN_ACTIONS_MAX).default(MCP_OPEN_ACTIONS_DEFAULT).describe(`How many items to return (1 to ${MCP_OPEN_ACTIONS_MAX}, default ${MCP_OPEN_ACTIONS_DEFAULT}).`),
});

// The open action items of the meetings of one series (#3837): keyed on a meeting the client already has, never on a series id (none leaves Ludy), at most MCP_OPEN_ACTIONS_MAX, newest meeting first.
export const zMcpSeriesOpenItemsInput = z.strictObject({
  meetingId: zId.describe('The id of a meeting from ludy_meetings_list. The items of every meeting in the same series as this one are listed.'),
  limit: z.number().int().min(1).max(MCP_OPEN_ACTIONS_MAX).default(MCP_OPEN_ACTIONS_DEFAULT).describe(`How many items to return (1 to ${MCP_OPEN_ACTIONS_MAX}, default ${MCP_OPEN_ACTIONS_DEFAULT}).`),
});

// The published decisions of the meetings of the last 7, 14 or 30 days (#4016): the window counts from the meeting's start, at most MCP_OPEN_ACTIONS_MAX decisions, the newest meeting first.
export const MCP_DECISIONS_DAYS = [7, 14, 30] as const;
export const MCP_DECISIONS_DAYS_DEFAULT = 14;
export const zMcpDecisionsInput = z.strictObject({
  days: z.literal([...MCP_DECISIONS_DAYS]).default(MCP_DECISIONS_DAYS_DEFAULT).describe(`How far back to look, counted from now: ${MCP_DECISIONS_DAYS.join(', ')} days (default ${MCP_DECISIONS_DAYS_DEFAULT}). A meeting counts by its start.`),
  limit: z.number().int().min(1).max(MCP_OPEN_ACTIONS_MAX).default(MCP_OPEN_ACTIONS_DEFAULT).describe(`How many decisions to return (1 to ${MCP_OPEN_ACTIONS_MAX}, default ${MCP_OPEN_ACTIONS_DEFAULT}).`),
});

// A search over the published minutes (#4030): the typed words are folded in code (lower case, Vietnamese marks and đ removed) and never reach the database; at most MCP_SEARCH_WORDS_MAX words, each the
// start of a word of ONE line (the title, a summary line, a decision or an action item title) of a meeting the grant may already read; at most MCP_SEARCH_MEETINGS_MAX of the newest such meetings are searched.
export const MCP_SEARCH_QUERY_MAX = 200;
export const MCP_SEARCH_WORDS_MAX = 8;
export const MCP_SEARCH_DEFAULT = 10;
export const MCP_SEARCH_MAX = 50;
export const MCP_SEARCH_MEETINGS_MAX = 200;
export const MCP_SNIPPET_MAX = 200;
export const MCP_SEARCH_FIELDS = ['title', 'decision', 'summary', 'action'] as const;
export const zMcpSearchInput = z.strictObject({
  q: z.string().trim().min(2).max(MCP_SEARCH_QUERY_MAX).describe(`The words to look for (2 to ${MCP_SEARCH_QUERY_MAX} characters). Case and Vietnamese marks do not matter ("chiet khau" finds "chiết khấu"). Every word must start a word of the same line; at most ${MCP_SEARCH_WORDS_MAX} words count.`),
  limit: z.number().int().min(1).max(MCP_SEARCH_MAX).default(MCP_SEARCH_DEFAULT).describe(`How many meetings to return (1 to ${MCP_SEARCH_MAX}, default ${MCP_SEARCH_DEFAULT}).`),
});


// The "minutes draft ready" notice of the recorder (#3730): kind, event and mail template. The notice holds no text of the draft and no title: the in-app line is a fixed text that opens the meeting through its
// subject, and the mail holds a fixed line and the link, so no copy of the title or of the draft exists to erase.
export const SUMMARY_READY_KIND = 'meetings.summary_ready';
export const SUMMARY_READY_EVENT = 'meetings.summary.ready';
export const SUMMARY_READY_MAIL_TEMPLATE = 'meetings.summary_ready';
export const SUMMARY_READY_MAIL_SOURCE = 'meetings.summary_ready';
// What the API tells the recorder's own command after a summary run was stored as ready: the meeting and the run (the notice's key: one per finished run).
export const zSummaryReadyRef = z.strictObject({ meetingId: zId, runId: zId });
export type SummaryReadyRef = z.infer<typeof zSummaryReadyRef>;
// The outbox event: ids and the meeting's language, never a word. The recorder is the one who made the run (the command checks it), so the worker's notice reads the recipient here.
export const zSummaryReadyEvent = z.strictObject({ meetingId: zId, runId: zId, recorderUserId: zId, language: z.enum(['vi', 'en']) });
export type SummaryReadyEvent = z.infer<typeof zSummaryReadyEvent>;
// The worker's dispatch is told the event's id only and reads the event itself.
export const zSummaryReadyDispatch = z.strictObject({ eventId: zId });
// The mail's merge data: the org's name, the app path that opens the meeting, the language. No other key can be stored.
export const zSummaryReadyMail = z.strictObject({
  lang: z.enum(['vi', 'en']),
  org: z.string().trim().min(1).max(200),
  path: z.string().regex(/^\/o\/[a-z0-9][a-z0-9-]{0,62}\/meetings\/[0-9a-f-]{36}$/),
});
export type SummaryReadyMail = z.infer<typeof zSummaryReadyMail>;

// The wake-up of an agent when the minutes of an org-visible meeting are published (#3803, ADR-0051 decision 4). The outbox event holds the meeting's id and the instant its result was published, and nothing
// a person typed (no title, no text): `meetings.result.publish` emits it only for a meeting of visibility 'org' when the call published a result. The wake-up body the receiver gets (type MINUTES_WAKE_TYPE) carries
// the same two facts as `meeting_id` and `published_at`; the agent reads the minutes with ludy_meeting_minutes under its grant.
export const MINUTES_PUBLISHED_EVENT = 'meetings.minutes.published';
export const MINUTES_WAKE_TYPE = 'meetings.minutes_published';
export const zMinutesPublishedEvent = z.strictObject({ meetingId: zId, publishedAt: z.iso.datetime() });
export type MinutesPublishedEvent = z.infer<typeof zMinutesPublishedEvent>;
