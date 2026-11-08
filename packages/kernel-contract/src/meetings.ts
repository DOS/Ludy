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

// The transcript of a meeting (#2578, M4a): timestamped segments with a speaker label. A segment is a draft, the recorder's
// own working copy, until the recorder publishes it (the summary step, M6).
export const TRANSCRIPT_STAGES = ['draft', 'published'] as const;
export type TranscriptStage = (typeof TRANSCRIPT_STAGES)[number];
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
});
export type TranscriptSegment = z.infer<typeof zTranscriptSegment>;

// What the caller may read of a meeting's transcript: the recorder reads their draft (and anything published); every other
// reader of the meeting reads published segments only. `stage` is the stage the caller sees.
export const zTranscript = z.strictObject({
  meetingId: zId,
  isRecorder: z.boolean(),
  stage: z.enum(['none', ...TRANSCRIPT_STAGES]),
  segments: z.array(zTranscriptSegment),
});
export type Transcript = z.infer<typeof zTranscript>;

// The recorder's transcription run (#2578, M4b, ADR-0049 decision 8). The recorder's own Vy transcribes in the background and writes only its own
// result (member_vy_result); the recorder's own action then copies that result into the draft transcript.
export const TRANSCRIBE_STATES = ['none', 'running', 'ready', 'failed'] as const;
export type TranscribeState = (typeof TRANSCRIBE_STATES)[number];
export const zTranscribeStart = z.strictObject({ meetingId: zId });
export const zTranscribeStarted = z.strictObject({ meetingId: zId, runId: zId });
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

// The summary, the decisions and the action items of a meeting (#2580, M6 part A). The recorder types them or copies them from the result of their own Vy;
// they are drafts only the recorder reads until the recorder's one click publishes them to the meeting's readers.
export const RESULT_SUMMARY_MAX = 8000;
export const RESULT_DECISION_MAX = 500;
export const RESULT_DECISIONS_MAX = 50;
export const ITEM_TITLE_MAX = 300;
export const ITEM_TEXT_MAX = 200;
export const ITEMS_PER_MEETING_MAX = 100;
export const ITEM_FLAGS = ['contact_in_title'] as const;
export type ItemFlag = (typeof ITEM_FLAGS)[number];

const zDay = z.iso.date();

// Saves the recorder's own summary and decisions as the draft (replacing the earlier draft).
export const zMeetingResultSave = z.strictObject({
  meetingId: zId,
  summary: z.string().trim().min(1).max(RESULT_SUMMARY_MAX),
  decisions: z.array(z.string().trim().min(1).max(RESULT_DECISION_MAX)).max(RESULT_DECISIONS_MAX),
});
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
export const zResultPublished = z.strictObject({ meetingId: zId, results: z.number().int().min(0), items: z.number().int().min(0) });

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
});
export const zMeetingResults = z.strictObject({
  meetingId: zId,
  isRecorder: z.boolean(),
  // The recorder reads a draft beside the published one; a reader reads the published one only.
  draft: zMeetingResultView.nullable(),
  published: zMeetingResultView.nullable(),
  items: z.array(zActionItemView),
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
export const zSummaryResult = z.strictObject({
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
  dropped: z.number().int().min(0),
});
export type SummaryResult = z.infer<typeof zSummaryResult>;

// The recorder's explicit review of the draft Vy wrote: `confirmed: true` is their own click, never defaulted. Only then can the draft be shared.
export const zDraftReview = z.strictObject({ meetingId: zId, confirmed: z.literal(true) });
export const zDraftReviewed = z.strictObject({ meetingId: zId, cleared: z.number().int().min(0) });
