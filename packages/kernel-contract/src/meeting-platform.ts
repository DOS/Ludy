// SPDX-License-Identifier: AGPL-3.0-only
// Meeting platform connections and the recordings they offer (meetings integrations C1, issue #3173, plan docs/plan/meetings-integrations.md section 6.1): a member connects Google Meet, Zoom or
// Microsoft Teams (or the offline sandbox), sees the recordings the platform finished as SUGGESTIONS, and imports one with a click. Nothing is downloaded before that click. Shapes shared by the
// kernel commands, the worker's import job, the app and the platform adapters (C2 to C4 only add adapters).
import { z } from 'zod';
import { zId } from './schemas.ts';

export const MEETING_PLATFORM_PROVIDERS = ['sandbox', 'google_meet', 'zoom', 'microsoft_teams'] as const;
export type MeetingPlatformProvider = (typeof MEETING_PLATFORM_PROVIDERS)[number];
export const zMeetingPlatformProvider = z.enum(MEETING_PLATFORM_PROVIDERS);

// The names of the recording providers in the shared oauth_state table (a calendar's state is `google_calendar`; these never collide with it).
export const MEETING_PLATFORM_OAUTH_PROVIDERS = ['google_recordings', 'zoom_recordings', 'teams_recordings'] as const;
export type MeetingPlatformOAuthProvider = (typeof MEETING_PLATFORM_OAUTH_PROVIDERS)[number];
export const zMeetingPlatformOAuthProvider = z.enum(MEETING_PLATFORM_OAUTH_PROVIDERS);

export const MEETING_PLATFORM_CONNECTION_STATUSES = ['active', 'expired'] as const;
// suggested -> importing (the click) -> staged (the worker's bytes wait in staging) -> claimed (the member's request took them) -> imported; failed and dismissed branch off.
export const MEETING_PLATFORM_RECORDING_STATUSES = ['suggested', 'importing', 'staged', 'claimed', 'imported', 'failed', 'dismissed'] as const;
export type MeetingPlatformRecordingStatus = (typeof MEETING_PLATFORM_RECORDING_STATUSES)[number];

// The platform's list covers this many days back.
export const MEETING_PLATFORM_LIST_DAYS = 14;
// Staged bytes the member does not claim are deleted after this long (the row fails with `not_claimed`).
export const MEETING_PLATFORM_STAGING_HOURS = 24;
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
  status: z.enum(MEETING_PLATFORM_RECORDING_STATUSES),
  meetingId: zId.nullable(),
  errorCode: z.string().nullable(),
});
export type MeetingPlatformRecordingView = z.infer<typeof zMeetingPlatformRecordingView>;

export const zMeetingPlatformRecordingRef = z.strictObject({ recordingId: zId });
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
});
export type MeetingPlatformListed = z.infer<typeof zMeetingPlatformListed>;
