// SPDX-License-Identifier: AGPL-3.0-only
// Meeting platform connections and the recordings they offer (meetings integrations C1, issue #3173, plan docs/plan/meetings-integrations.md section 6.1): a member connects Google Meet, Zoom or
// Microsoft Teams (or the offline sandbox), sees the recordings the platform finished as SUGGESTIONS, and imports one with a click. Nothing is downloaded before that click. Shapes shared by the
// kernel commands, the worker's import job, the app and the platform adapters (C2 to C4 only add adapters).
import { z } from 'zod';
import { zId } from './schemas.ts';

export const MEETING_PLATFORM_PROVIDERS = ['sandbox', 'google_meet', 'zoom', 'microsoft_teams'] as const;
export type MeetingPlatformProvider = (typeof MEETING_PLATFORM_PROVIDERS)[number];
export const zMeetingPlatformProvider = z.enum(MEETING_PLATFORM_PROVIDERS);
// The providers whose own transcript Ludy can import when a recording has nothing else (C2, #3174; the sandbox is the offline test platform). A provider is added here when its adapter reads a transcript, and the module's
// table of whose transcription it is (modules/meetings/src/import.ts) must name it too: that table is typed on this list.
export const MEETING_PLATFORM_TRANSCRIPT_PROVIDERS = ['sandbox', 'google_meet', 'microsoft_teams', 'zoom'] as const;
export type MeetingPlatformTranscriptProvider = (typeof MEETING_PLATFORM_TRANSCRIPT_PROVIDERS)[number];

// The names of the recording providers in the shared oauth_state table (a calendar's state is `google_calendar`; these never collide with it).
export const MEETING_PLATFORM_OAUTH_PROVIDERS = ['google_recordings', 'zoom_recordings', 'teams_recordings'] as const;
export type MeetingPlatformOAuthProvider = (typeof MEETING_PLATFORM_OAUTH_PROVIDERS)[number];
export const zMeetingPlatformOAuthProvider = z.enum(MEETING_PLATFORM_OAUTH_PROVIDERS);

// The platforms a member connects through the platform's own OAuth dialog (C3 onwards; the sandbox connects without one), and the name of their attempt in the oauth_state table. The return address of the
// dialog is `<APP_URL>/meetings/oauth/<platform>/callback`, a page of the app.
export const MEETING_PLATFORM_CONNECT_PROVIDERS = ['google_meet', 'zoom', 'microsoft_teams'] as const;
export type MeetingPlatformConnectProvider = (typeof MEETING_PLATFORM_CONNECT_PROVIDERS)[number];
export const zMeetingPlatformConnectProvider = z.enum(MEETING_PLATFORM_CONNECT_PROVIDERS);
export const MEETING_PLATFORM_OAUTH_NAME: Record<MeetingPlatformConnectProvider, MeetingPlatformOAuthProvider> = { google_meet: 'google_recordings', zoom: 'zoom_recordings', microsoft_teams: 'teams_recordings' };

export const MEETING_PLATFORM_CONNECTION_STATUSES = ['active', 'expired'] as const;
// suggested -> importing (the click) -> staged (the worker's bytes wait in staging) -> claimed (the member's request took them) -> imported; failed and dismissed branch off.
export const MEETING_PLATFORM_RECORDING_STATUSES = ['suggested', 'importing', 'staged', 'claimed', 'imported', 'failed', 'dismissed'] as const;
export type MeetingPlatformRecordingStatus = (typeof MEETING_PLATFORM_RECORDING_STATUSES)[number];

// The platform's list covers this many days back.
export const MEETING_PLATFORM_LIST_DAYS = 14;
// Staged bytes the member does not claim fail the row (`not_claimed`) after this long: the daily staging sweep deletes a staging/ object older than an hour, so the claim window stays inside it.
export const MEETING_PLATFORM_STAGING_MINUTES = 55;
// The job buffers a download in memory (the blob store has no streaming write to a staging key), so the declared size and the counted stream stay under the audio cap of an upload (MAX_MEETING_AUDIO_BYTES).
export const MEETING_PLATFORM_IMPORT_MAX_BYTES = 300 * 1024 * 1024;
// The most bytes of a platform's transcript the job stages (C2, #3174): 5000 lines of the longest text and speaker would be about 21 MB; a real one is far smaller. The import route reads it back under the same cap.
export const MEETING_PLATFORM_TRANSCRIPT_MAX_BYTES = 24 * 1024 * 1024;
// The most a platform's video file may be when its audio is taken out of it (C2a, #3306): the product's video upload cap (plan section 10) and crove-media's own MEDIA_MAX_INPUT_BYTES default. The audio
// cap above is unchanged and counts the audio that comes out. A video over this fails `too_large`.
export const MEETING_PLATFORM_VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// The connection's list is refreshed at most this often by the sweep, unless the member asked (last_synced_at cleared).
export const MEETING_PLATFORM_SYNC_MINUTES = 10;

// Why an import failed: a short code, never the platform's own message. The app words each one.
export const MEETING_PLATFORM_ERROR_CODES = [
  'download_failed',
  'platform_unavailable',
  'platform_refused',
  'connection_expired',
  'recording_gone',
  'too_large',
  'too_long',
  'no_audio',
  'invalid_media',
  'normalize_failed',
  'not_claimed',
  'claim_failed',
  'timeout',
  // C2 (#3174): the platform has a transcript for the recording but it holds no usable line (every line empty).
  'no_transcript',
  // Microsoft Teams (C4): the customer's tenant administrator has not turned on Graph access to meeting transcripts, or the speaker names; only they can.
  'transcripts_disabled',
  'speakers_disabled',
  // Google Meet's Picker route (#3174, ADR-0025 amendment): the recording needs the member to pick its file in Google Picker and none was picked (or the pick was taken away), or the file picked is not the one Meet gave
  // for this recording. The member picks again.
  'pick_missing',
  'pick_mismatch',
] as const;
export type MeetingPlatformErrorCode = (typeof MEETING_PLATFORM_ERROR_CODES)[number];
export const zMeetingPlatformErrorCode = z.enum(MEETING_PLATFORM_ERROR_CODES);

const zInstant = z.iso.datetime({ offset: true });

export const zMeetingPlatformConnectionView = z.strictObject({
  id: zId,
  provider: zMeetingPlatformProvider,
  displayName: z.string(),
  status: z.enum(MEETING_PLATFORM_CONNECTION_STATUSES),
  statusReason: z.string().nullable(),
  lastSyncedAt: zInstant.nullable(),
  connectedAt: zInstant,
});
export type MeetingPlatformConnectionView = z.infer<typeof zMeetingPlatformConnectionView>;

export const zMeetingPlatformRecordingView = z.strictObject({
  id: zId,
  connectionId: zId,
  provider: zMeetingPlatformProvider,
  title: z.string(),
  startedAt: zInstant,
  lengthSeconds: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  hasTranscript: z.boolean(),
  // The most bytes of a video file this deployment can take the audio out of (C2a, #3306), or null when it cannot (no crove-media): a recording that has only a video file can then be imported when its
  // size fits; null, it is refused as before. It is the video cap lowered to crove-media's own input limit where the deployment sets one.
  videoImportMaxBytes: z.number().int().positive().nullable(),
  // Google Meet's Picker route (#3174): the member has picked this recording's Drive file (kept on the row; the import job checks it). False for every row that needs no pick.
  picked: z.boolean(),
  status: z.enum(MEETING_PLATFORM_RECORDING_STATUSES),
  meetingId: zId.nullable(),
  errorCode: z.string().nullable(),
  // Minimal safe match reference when a suggested recording matches strictly one Ludy meeting the member can read within the B1 15-minute window (#4123 Step 3). Never leaks hidden or ambiguous meetings.
  matchedMeeting: z.strictObject({ meetingId: zId }).nullable(),
});
export type MeetingPlatformRecordingView = z.infer<typeof zMeetingPlatformRecordingView>;

export const zMeetingPlatformRecordingRef = z.strictObject({ recordingId: zId });

// Google Meet's Picker route (#3174, ADR-0025 amendment of 2026-11-25). A Meet recording is a video file in the organizer's Drive, so the member picks it in Google Picker (scope `drive.file`, in their own browser)
// and tells the API one thing: the Drive file id. A Drive file id is letters, digits, `-` and `_`. The import job compares it with the id Meet gave for the recording and downloads nothing on a mismatch.
export const MEETING_PLATFORM_DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;
export const zMeetingPlatformRecordingPick = z.strictObject({ recordingId: zId, fileId: z.string().regex(MEETING_PLATFORM_DRIVE_FILE_ID) });
export type MeetingPlatformRecordingPick = z.infer<typeof zMeetingPlatformRecordingPick>;

// Whether a recording must be picked before it is imported: a Google Meet recording that has a video file and neither audio nor a transcript (a conference with a transcript is imported as its transcript, nothing to pick).
export function meetingPlatformNeedsPick(provider: string, row: { hasAudio: boolean; hasVideo: boolean; hasTranscript: boolean }): boolean {
  return provider === 'google_meet' && row.hasVideo && !row.hasAudio && !row.hasTranscript;
}
export const zMeetingPlatformConnectionRef = z.strictObject({ connectionId: zId });

/** The binding a connection's tokens are sealed for (org, provider, account): the OAuth callback seals, the job opens. */
export function meetingPlatformBinding(orgId: string, provider: MeetingPlatformProvider, externalAccount: string) {
  return { orgId, provider: `meeting_platform:${provider}`, externalAccountId: externalAccount };
}

// What an adapter lists for one recording (the sweep stores it as a suggestion), as the definer reads it from JSON.
export const zMeetingPlatformListed = z.strictObject({
  id: z.string().min(1).max(1024),
  title: z.string().max(200),
  startedAt: zInstant,
  lengthSeconds: z.number().int().min(0).nullable(),
  sizeBytes: z.number().int().min(0).nullable(),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  hasTranscript: z.boolean(),
  meetingKey: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});
export type MeetingPlatformListed = z.infer<typeof zMeetingPlatformListed>;
