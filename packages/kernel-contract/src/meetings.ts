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
  textRetentionDate: z.string(),
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
