// SPDX-License-Identifier: AGPL-3.0-only
// Retention and shredding of a meeting's audio, video and text (issue #2579, ADR-0047 point 7, plan docs/plan/meetings.md section 9).
//
// The org keeps three settings on its tenant row (meetings.settings.set, an owner or admin): how long audio, a kept video and text live. Each is stamped on
// a meeting when it is recorded, so the period the participants were told stays true when a setting changes later. The worker's nightly job
// (apps/kernel/src/meetings-retention.ts) reads the meetings whose period has ended through crove_meetings.meetings_due and runs the system commands below
// in each meeting's own org; the database checks every date again, so a bug in the job can fail a run but never shred early.
//
// Shredding is deleting the kind's media_key row: every copy of the ciphertext (current and old versions, bucket backups) is unreadable from that commit on.
// The file rows and the objects follow as the store allows: a segment or video row deleted with its key leaves its crove_kernel.file row an orphan, which the
// worker's sweep (meetings.media.orphan_keys, meetings.media.discard) deletes after the object, so a crash between the two steps repeats, never loses.
import { sql } from 'kysely';
import {
  MEETING_RETENTION_DEFAULTS,
  meetingSettingsProblem,
  zMeetingMediaDiscard,
  zMeetingOrphanKeys,
  zMeetingRetentionShred,
  zMeetingSettingsGet,
  zMeetingShredReplay,
  zMeetingSettingsSet,
  type MeetingSettings,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

// The retention periods count calendar days in Vietnam (UTC+7, no daylight saving), the zone the nightly job and the database's due check use.
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/** The Vietnam calendar day of an instant, as YYYY-MM-DD. */
export function vnDay(at: Date): string {
  return new Date(at.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Vietnam calendar day `days` days after an instant. */
export function dayAfter(at: Date, days: number): string {
  return vnDay(new Date(at.getTime() + days * DAY_MS));
}

/** A date column's value as YYYY-MM-DD (a Date from the driver is read in UTC, as the migrations' date arithmetic is for these columns). */
export function dayText(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

export interface RetentionDates {
  // The day the audio's key is shredded.
  audio: string;
  // The day a kept video's key is shredded: never after the audio's.
  video: string;
  // The day the meeting's text, consent record and everything else of it is deleted; null keeps it until a person deletes the meeting.
  text: string | null;
}

/**
 * The three dates of a meeting recorded at `at` under the org's settings. A meeting whose transcript is never ready (AI off, no model, a spent budget) still
 * gets dates, counted from the recording: "deleted right after the transcript" (0) is the shortest choice, 7 days, until a transcript moves the date earlier.
 * The video is never kept past the audio.
 */
export function retentionDates(at: Date, settings: MeetingSettings): RetentionDates {
  const audio = dayAfter(at, settings.audioRetentionDays === 0 ? 7 : settings.audioRetentionDays);
  const video = dayAfter(at, settings.videoRetentionDays);
  return {
    audio,
    video: video < audio ? video : audio,
    text: settings.textRetentionDays === 0 ? null : dayAfter(at, settings.textRetentionDays),
  };
}

interface TenantRetentionRow {
  meeting_audio_retention_days: number;
  meeting_video_retention_days: number;
  meeting_text_retention_days: number;
}

function settingsOf(row: TenantRetentionRow): MeetingSettings {
  return {
    audioRetentionDays: row.meeting_audio_retention_days as MeetingSettings['audioRetentionDays'],
    videoRetentionDays: row.meeting_video_retention_days as MeetingSettings['videoRetentionDays'],
    textRetentionDays: row.meeting_text_retention_days as MeetingSettings['textRetentionDays'],
  };
}

/** The org's retention settings; the defaults for an org whose row cannot be read. */
export async function readRetentionSettings(trx: QueryContext['trx'], orgId: string): Promise<MeetingSettings> {
  const row = await trx
    .selectFrom('crove_kernel.tenant')
    .select(['meeting_audio_retention_days', 'meeting_video_retention_days', 'meeting_text_retention_days'])
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  return row ? settingsOf(row) : { ...MEETING_RETENTION_DEFAULTS };
}

export const meetingSettingsGet = defineQuery({
  name: 'meetings.settings.get',
  input: zMeetingSettingsGet,
  access: ['owner', 'admin', 'member'],
  handler: async (ctx): Promise<MeetingSettings> => readRetentionSettings(ctx.trx, ctx.orgId),
});

// A change applies to meetings recorded afterwards, so the period participants were told stays true (plan section 9). The database's guard trigger lets only
// this command's actors (an owner or admin in the org's own context) write the columns.
export const meetingSettingsSet = defineCommand({
  name: 'meetings.settings.set',
  input: zMeetingSettingsSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input): Promise<MeetingSettings> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Only authenticated members can perform this action');
    const problem = meetingSettingsProblem(input);
    if (problem) throw new DomainError('MEETING_SETTINGS_INVALID', 422, 'A kept video cannot outlast the audio', { problem });
    const before = await readRetentionSettings(ctx.trx, ctx.orgId);
    // Audio may not drop below the video in the same stroke: the table's check holds the pair, so write both in one statement.
    await ctx.trx
      .updateTable('crove_kernel.tenant')
      .set({
        meeting_audio_retention_days: input.audioRetentionDays,
        meeting_video_retention_days: input.videoRetentionDays,
        meeting_text_retention_days: input.textRetentionDays,
      })
      .where('org_id', '=', ctx.orgId)
      .execute();
    ctx.audit({ audioRetentionDays: input.audioRetentionDays, videoRetentionDays: input.videoRetentionDays, textRetentionDays: input.textRetentionDays, previous: before });
    return input;
  },
});

function requireSystem(ctx: CommandContext | QueryContext): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Only a system actor may do this');
}

export interface RetentionOutcome {
  // Whether anything was deleted (false: not due after all, or already gone).
  applied: boolean;
  kind: 'audio' | 'video' | 'text';
}

// The nightly job's step for one meeting and kind, in the meeting's own org (the worker's system context). Counts and the kind only reach the audit row; a
// meeting's id is the audit target.
export const meetingRetentionShred = defineCommand({
  name: 'meetings.retention.shred',
  input: zMeetingRetentionShred,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<RetentionOutcome> => {
    requireSystem(ctx);
    let applied: boolean;
    if (input.kind === 'text') {
      const { rows } = await sql<{ done: boolean }>`
        SELECT crove_meetings.meeting_text_purge(${ctx.orgId}::uuid, ${input.meetingId}::uuid) AS done`.execute(ctx.trx);
      applied = rows[0]?.done === true;
    } else {
      const { rows } = await sql<{ n: number }>`
        SELECT crove_meetings.meeting_shred(${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${input.kind}::text) AS n`.execute(ctx.trx);
      applied = (rows[0]?.n ?? 0) > 0;
    }
    ctx.audit({ meetingId: input.meetingId, kind: input.kind, applied });
    return { applied, kind: input.kind };
  },
});

// After a restore: deletes a meeting a shred reference of the archive store names (ADR-0017 section 8). Idempotent.
export const meetingShredReplay = defineCommand({
  name: 'meetings.shred.replay',
  input: zMeetingShredReplay,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<{ deleted: boolean }> => {
    requireSystem(ctx);
    const { rows } = await sql<{ done: boolean }>`
      SELECT crove_meetings.meeting_replay_shred(${ctx.orgId}::uuid, ${input.meetingId}::uuid) AS done`.execute(ctx.trx);
    const deleted = rows[0]?.done === true;
    ctx.audit({ meetingId: input.meetingId, replayed: true, deleted });
    return { deleted };
  },
});

// The storage keys of orphan meeting media files (ids from crove_meetings.meetings_orphan_media), for the worker to delete the objects before their rows. A key
// another file row of the org also names is reported as shared and never deleted: the objects are content addressed.
export const meetingMediaOrphanKeys = defineQuery({
  name: 'meetings.media.orphan_keys',
  input: zMeetingOrphanKeys,
  access: 'system',
  handler: async (ctx, input): Promise<Array<{ fileId: string; storageKey: string; shared: boolean }>> => {
    requireSystem(ctx);
    const { rows } = await sql<{ id: string; storage_key: string; shared: boolean }>`
      SELECT f.id, f.storage_key,
             EXISTS (SELECT 1 FROM crove_kernel.file o WHERE o.org_id = f.org_id AND o.storage_key = f.storage_key AND o.id <> f.id) AS shared
        FROM crove_kernel.file f
       WHERE f.org_id = ${ctx.orgId}::uuid AND f.id = ANY (${input.fileIds}::uuid[]) AND f.source IN ('meeting_audio', 'meeting_video')`.execute(ctx.trx);
    return rows.map((r) => ({ fileId: r.id, storageKey: r.storage_key, shared: r.shared }));
  },
});

// Deletes one orphan meeting media file row once its object is gone; the definer refuses a row a segment or video row still names.
export const meetingMediaDiscard = defineCommand({
  name: 'meetings.media.discard',
  input: zMeetingMediaDiscard,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  handler: async (ctx, input): Promise<{ discarded: boolean }> => {
    requireSystem(ctx);
    const { rows } = await sql<{ done: boolean }>`
      SELECT crove_meetings.meeting_media_discard(${ctx.orgId}::uuid, ${input.fileId}::uuid) AS done`.execute(ctx.trx);
    const discarded = rows[0]?.done === true;
    ctx.audit({ fileId: input.fileId, discarded });
    return { discarded };
  },
});
