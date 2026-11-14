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
  // The recorder ticked "Ghi chú trực tiếp" for this meeting (ADR-0052 L4a): the extension then sends live chunks while it records.
  liveNotes: z.boolean(),
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
  // Live notes were opted into for this meeting (ADR-0052 L4a), at the consent step, and cannot change afterwards.
  liveNotes: z.boolean(),
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
  // "Ghi chú trực tiếp" (ADR-0052 L4a): off by default, opted in per meeting at the consent step, fixed once the meeting exists.
  liveNotes: z.boolean().default(false),
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
});
export type MeetingMediaRecord = z.infer<typeof zMeetingMediaRecord>;

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
// `ids` are the rows the screen showed (the summary and the items): only those lose the mark, so a row copied in another tab after the recorder looked keeps it.
export const zDraftReview = z.strictObject({ meetingId: zId, confirmed: z.literal(true), ids: z.array(zId).min(1).max(ITEMS_PER_MEETING_MAX + 1) });
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
export const TRANSLATION_STATES = ['ok', 'warn', 'refused'] as const;
// A fixed word for what code found: a refusal (MISSING, EMPTY, TOO_LONG, UNCHANGED, INVENTED_NUMBER, CONTACT_ADDED) or a warning (NUMBER_DROPPED, NAME_ADDED).
export const TRANSLATION_CODES = ['MISSING', 'EMPTY', 'TOO_LONG', 'UNCHANGED', 'INVENTED_NUMBER', 'CONTACT_ADDED', 'NUMBER_DROPPED', 'NAME_ADDED'] as const;
export const TRANSLATION_SEGMENTS_MAX = 1 + RESULT_DECISIONS_MAX + ITEMS_PER_MEETING_MAX;
export const TRANSLATION_SEGMENT_TEXT_MAX = 12_000;
const zTranslationStage = z.enum(TRANSLATION_STAGES);
// 'summary', 'decision:<index>' or 'item:<id>': what a segment translates.
const zTranslationKey = z.string().regex(/^(?:summary|decision:\d{1,3}|item:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
const zTranslationHash = z.string().regex(/^[0-9a-f]{64}$/);
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
  to: zMeetingLanguage,
  stage: zTranslationStage,
  hash: zTranslationHash,
  segments: z.array(zTranslationSegment).min(1).max(TRANSLATION_SEGMENTS_MAX),
});
export type TranslationResult = z.infer<typeof zTranslationResult>;

export const zTranslationRef = z.strictObject({ meetingId: zId, stage: zTranslationStage });
// The text the caller reads and may translate: the original segments in the order the screen shows them, the language pair and the hash of the text (a changed original has another hash).
export const zTranslationSource = z.strictObject({
  meetingId: zId,
  stage: zTranslationStage,
  from: zMeetingLanguage,
  to: zMeetingLanguage,
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
  to: zMeetingLanguage,
  estimate: z.strictObject({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), cost: z.string().regex(/^\d+(?:\.\d+)?$/).nullable() }).nullable(),
});
export type TranslationStatus = z.infer<typeof zTranslationStatus>;
// The caller's own translations of the meeting, one per stage they asked for, with whether the original changed since (stale: "Bản dịch cũ, dịch lại").
export const zTranslationView = z.strictObject({
  stage: zTranslationStage,
  from: zMeetingLanguage,
  to: zMeetingLanguage,
  stale: z.boolean(),
  createdAt: z.string(),
  segments: z.array(zTranslationSegment),
});
export const zTranslations = z.strictObject({ meetingId: zId, translations: z.array(zTranslationView).max(TRANSLATION_STAGES.length) });
export type Translations = z.infer<typeof zTranslations>;
