// SPDX-License-Identifier: AGPL-3.0-only
// The facts the Meetings screens use about recordings a meeting platform finished (meetings integrations C1, #3173): what a row offers, why it cannot be imported, how often to look again
// and which words a failure code gets. Pure functions, so the screens and their tests share one reading of a row.
import { MEETING_PLATFORM_ERROR_CODES, MEETING_PLATFORM_IMPORT_MAX_BYTES, MEETING_PLATFORM_TRANSCRIPT_PROVIDERS, MEETING_PLATFORM_VIDEO_MAX_BYTES, type MeetingPlatformErrorCode, type MeetingPlatformRecordingView } from '@crove/kernel-contract';

// The guide for the Microsoft 365 administrator of a Teams connection (the two steps in their own admin pages): the runbook of the repository, which is public.
export const MEETINGS_TEAMS_GUIDE = 'https://github.com/DOS/Ludy/blob/main/docs/runbooks/meetings-teams.md';

// The longest recording the import accepts: the transcription limit of 90 minutes (the product owner's rule for C1). A longer one is shown as too long to import.
export const IMPORT_MAX_SECONDS = 90 * 60;

// While a row is being downloaded, waiting to be claimed or being sealed, the list is read every 5 seconds; otherwise once a minute.
export const POLL_BUSY_MS = 5_000;
export const POLL_IDLE_MS = 60_000;

export type RecordingStatus = MeetingPlatformRecordingView['status'];

export const isInFlight = (status: RecordingStatus): boolean => status === 'importing' || status === 'staged' || status === 'claimed';

export function pollMs(rows: readonly MeetingPlatformRecordingView[] | undefined): number {
  return rows?.some((r) => isInFlight(r.status)) ? POLL_BUSY_MS : POLL_IDLE_MS;
}

// Why a recording cannot be imported by a click, in the order the server's own checks would meet them; null when it can.
export type ImportBlock = 'video_only' | 'transcript_only' | 'too_long' | 'too_large';

// A recording with neither an audio nor a video file whose provider can hand over its own transcript is imported as that transcript (C2, #3174): Ludy copies the platform's lines and keeps no audio. The
// server applies the same rule (the command, the job and the claim route), so the screen never offers a click the server would refuse.
export function isTranscriptImport(row: Pick<MeetingPlatformRecordingView, 'provider' | 'hasAudio' | 'hasVideo' | 'hasTranscript'>): boolean {
  return !row.hasAudio && !row.hasVideo && row.hasTranscript && (MEETING_PLATFORM_TRANSCRIPT_PROVIDERS as readonly string[]).includes(row.provider);
}

// Why a recording cannot be imported, or null. A recording with only a video file can be imported where the deployment can take the audio out of it (`videoImportMaxBytes`, C2a #3306); then the video's own size
// cap applies, as that deployment sets it (the audio that comes out is capped when it is staged). A transcript-only recording of a provider with a transcript path has no length or size limit of Ludy's own
// (nothing is transcribed or stored but its lines); one of a provider without that path is shown as such.
export function importBlock(
  row: Pick<MeetingPlatformRecordingView, 'provider' | 'hasAudio' | 'hasVideo' | 'hasTranscript' | 'videoImportMaxBytes' | 'lengthSeconds' | 'sizeBytes'>,
): ImportBlock | null {
  if (isTranscriptImport(row)) return null;
  if (!row.hasAudio && !(row.hasVideo && row.videoImportMaxBytes !== null)) return row.hasTranscript && !row.hasVideo ? 'transcript_only' : 'video_only';
  if (row.lengthSeconds !== null && row.lengthSeconds > IMPORT_MAX_SECONDS) return 'too_long';
  if (row.sizeBytes !== null && row.sizeBytes > (row.hasAudio ? MEETING_PLATFORM_IMPORT_MAX_BYTES : Math.min(MEETING_PLATFORM_VIDEO_MAX_BYTES, row.videoImportMaxBytes ?? 0))) return 'too_large';
  return null;
}

// The words of a failure: the key under meetings.platform.errors for a known code, and the general one for anything else (a code from a newer server).
export function errorKey(code: string | null | undefined): MeetingPlatformErrorCode | 'unknown' {
  return code !== null && code !== undefined && (MEETING_PLATFORM_ERROR_CODES as readonly string[]).includes(code) ? (code as MeetingPlatformErrorCode) : 'unknown';
}

// A length in words ("1 giờ 5 phút", "45 phút", "under 1 minute") from seconds; the parts are the screen's own translated units.
export function lengthParts(seconds: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round(seconds / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

// The submit button of the import dialog: the consent box is ticked, the title is not blank, the org accepts the platform notice and nothing is being sent.
export function canSubmitImport(input: { consentTicked: boolean; title: string; strict: boolean; pending: boolean }): boolean {
  return input.consentTicked && input.title.trim().length > 0 && !input.strict && !input.pending;
}

// A failed row can be tried again unless the same failure would come back: the platform no longer has it, it has no audio, or it is too large or too long.
const FINAL_ERRORS: readonly string[] = ['recording_gone', 'no_audio', 'no_transcript', 'too_large', 'too_long'];
export function canRetry(row: Pick<MeetingPlatformRecordingView, 'errorCode' | 'provider' | 'hasAudio' | 'hasVideo' | 'hasTranscript' | 'videoImportMaxBytes' | 'lengthSeconds' | 'sizeBytes'>): boolean {
  return importBlock(row) === null && !(row.errorCode !== null && FINAL_ERRORS.includes(row.errorCode));
}

// The rows the member's own request should claim now: staged, linked to their meeting and not tried on this page yet. The caller adds each id to `tried` as it starts, so a row is claimed once per
// page mount and a refusal is never retried in a loop.
export function rowsToClaim(rows: readonly MeetingPlatformRecordingView[] | undefined, tried: ReadonlySet<string>): Array<{ id: string; meetingId: string; transcript: boolean }> {
  const out: Array<{ id: string; meetingId: string; transcript: boolean }> = [];
  for (const row of rows ?? []) if (row.status === 'staged' && row.meetingId !== null && !tried.has(row.id)) out.push({ id: row.id, meetingId: row.meetingId, transcript: isTranscriptImport(row) });
  return out;
}

// A claim the server refuses because the row has already moved on (another tab claimed it first, or it is no longer staged or no longer the member's) is not an error for the member: the next read of
// the list says what became of it. Any other failure (a network error, a server error, a media check that could not run) is shown, with a way to try again.
export function isBenignClaimRefusal(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'MEETING_PLATFORM_STATE' || code === 'MEETING_PLATFORM_NOT_FOUND';
}
