// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { zId } from './schemas.ts';

export const CONSENT_METHODS = ['told_at_start', 'in_invite', 'in_writing'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

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

// What the Ludy extension may read of a meeting its own token created (issue #2582): where it is in its life and whether
// its audio and video arrived, never a title, a reader, a transcript or any media.
export const zMeetingExtensionStatus = z.strictObject({
  meetingId: zId,
  status: zMeetingStatus,
  keepVideo: z.boolean(),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  lengthSeconds: z.number().nullable(),
});
export type MeetingExtensionStatus = z.infer<typeof zMeetingExtensionStatus>;

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
  audioRetentionDate: z.string(),
  // null: the org keeps text until a person deletes the meeting.
  textRetentionDate: z.string().nullable(),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  readersCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MeetingSummary = z.infer<typeof zMeetingSummary>;

export const zMeetingDetail = zMeetingSummary.extend({
  consentMethod: zConsentMethod,
  consentConfirmedBy: zId,
  consentConfirmedAt: z.string(),
  consentNoticeVersion: z.string(),
  readers: z.array(zId),
  videoRetentionDate: z.string().nullable(),
  isRecorder: z.boolean(),
});
export type MeetingDetail = z.infer<typeof zMeetingDetail>;

export const zMeetingListInput = z.strictObject({
  visibility: zMeetingVisibility.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type MeetingListInput = z.infer<typeof zMeetingListInput>;

export const zMeetingCreate = z.strictObject({
  title: z.string().trim().min(1).max(200),
  language: zMeetingLanguage.default('vi'),
  visibility: zMeetingVisibility.default('attendees'),
  keepVideo: z.boolean().default(false),
  consentMethod: zConsentMethod,
  readerUserIds: z.array(zId).optional(),
  lengthSeconds: z.number().int().nonnegative().optional(),
});
export type MeetingCreate = z.infer<typeof zMeetingCreate>;

export const zMeetingCreated = z.strictObject({
  meetingId: zId,
});
export type MeetingCreated = z.infer<typeof zMeetingCreated>;

export const zMeetingDeleted = z.strictObject({
  meetingId: zId,
  shredded: z.boolean(),
});
export type MeetingDeleted = z.infer<typeof zMeetingDeleted>;

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
  lengthSeconds: z.number().int().positive().optional(),
});
export type MeetingMediaRecord = z.infer<typeof zMeetingMediaRecord>;

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

// System commands of the nightly retention and the shred replay (worker only).
export const zMeetingRetentionShred = z.strictObject({
  meetingId: zId,
  kind: z.enum(['audio', 'video', 'text']),
});
export type MeetingRetentionShred = z.infer<typeof zMeetingRetentionShred>;

export const zMeetingShredReplay = z.strictObject({ meetingId: zId });
export type MeetingShredReplay = z.infer<typeof zMeetingShredReplay>;

export const zMeetingMediaDiscard = z.strictObject({ fileId: zId });
export type MeetingMediaDiscard = z.infer<typeof zMeetingMediaDiscard>;

export const zMeetingOrphanKeys = z.strictObject({ fileIds: z.array(zId).min(1).max(200) });
export type MeetingOrphanKeys = z.infer<typeof zMeetingOrphanKeys>;
