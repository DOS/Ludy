// SPDX-License-Identifier: AGPL-3.0-only
// Importing a recording a meeting platform finished (meetings integrations C1, issue #3173, plan docs/plan/meetings-integrations.md section 6.1).
//
// - The member presses "Nhập" on a suggestion. meetings.import.start is the one command behind it: it creates the meeting with its consent record (the platform showed its own notice to everyone
//   and the importer confirms it) through the same core as meetings.meeting.create, then links the recording and queues the download (crove_kernel.meeting_platform_recording_begin).
//   A retry of a failed recording first removes the meeting its earlier try made, when that meeting is the importer's own, was never edited since the import made it, and nothing of Meetings' own
//   hangs off it (#3288): no audio, video, transcript, minutes, items, note, link or calendar link (a translation needs a transcript or minutes, so it is covered). One that holds anything, or was
//   edited (a title, readers, a series), is kept. The meeting row is locked first, so a note or a link another tab adds meanwhile waits for the retry and is seen, never lost to the delete's cascade.
//   A note of the Notes module or a task of Projects that points at the meeting has no foreign key to it and survives the delete (the meeting is gone, its pointer stays).
// - It does no network I/O itself. The queued download is made by the worker's import job, which is why the command declares an external effect, like meetings.hook.set: the job
//   (`kernel-meeting-import-sweep handler`, apps/kernel/test/invariant/job-egress.test.ts) is justified by this command.
// - The bytes then wait in staging; the member's own request claims, seals and records them through POST /api/meetings/:id/media, so the sealing code is the one an upload uses.
// - No AI part: the transcript and minutes of the imported meeting are the ordinary ones, started by the member. Audit rows hold ids and the provider, never a title or a platform text.
import { MEETING_PLATFORM_TRANSCRIPT_PROVIDERS, zMeetingImportDiscarded, zMeetingImportDiscardEmpty, zMeetingImportStart, zMeetingTranscriptImport, type MeetingLanguage, type MeetingPlatformTranscriptProvider, type TranscriptionMaker } from '@crove/kernel-contract';
import { DomainError, defineCommand, newStagingKey, type CommandContext } from '@crove/kernel-runtime';
import { sql } from 'kysely';
import { createMeetingRow } from './meeting-core.ts';
import { lockMeetingMedia } from './media-record.ts';
import { ROLES, openMeeting, replaceDraft } from './transcript.ts';

// Whether this deployment can take the audio out of a platform's video file (C2a, #3306): crove-media is configured (MEDIA_URL). Set once at start by the kernel; off, a recording that has only a video file is refused at
// the click with the words it always had, before a meeting is made for it.
let videoImportOn = false;
export function setMeetingVideoImport(enabled: boolean): void {
  videoImportOn = enabled;
}

// What a recording without a title is called, until the member renames the meeting.
const UNTITLED: Record<MeetingLanguage, string> = { vi: 'Cuộc họp đã nhập', en: 'Imported meeting' };

// The definers' own words, as the member reads them.
function importError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'MEETING_PLATFORM_NOT_FOUND':
      throw new DomainError('MEETING_PLATFORM_NOT_FOUND', 404, 'Không tìm thấy bản ghi này');
    case 'MEETING_PLATFORM_STATE':
      throw new DomainError('MEETING_PLATFORM_STATE', 409, 'Bản ghi này đã được nhập hoặc đang được nhập');
    case 'MEETING_PLATFORM_NO_AUDIO':
      throw new DomainError('MEETING_PLATFORM_NO_AUDIO', 422, 'Nền tảng không có tệp âm thanh hay video cho bản ghi này');
    case 'MEETING_PLATFORM_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Bạn không nhập được bản ghi trong tổ chức này');
    default:
      throw error;
  }
}

// Whose transcription a platform's transcript is, by the provider of the connection it came through (the sandbox is the offline test platform and labels like Google, as C2 did).
// Typed on the contract's list of providers with a transcript path, so a provider added there cannot be left without its label.
const TRANSCRIPT_SOURCE_OF: Record<MeetingPlatformTranscriptProvider, TranscriptionMaker> = { google_meet: 'google_meet', microsoft_teams: 'microsoft_teams', sandbox: 'google_meet' };
const hasTranscriptPath = (provider: string): provider is MeetingPlatformTranscriptProvider => (MEETING_PLATFORM_TRANSCRIPT_PROVIDERS as readonly string[]).includes(provider);

type Trx = CommandContext['trx'];

async function readOwnRecording(trx: Trx, orgId: string, userId: string, recordingId: string) {
  return trx
    .selectFrom('crove_kernel.meeting_platform_recording as r')
    .innerJoin('crove_kernel.meeting_platform_connection as c', (join) => join.onRef('c.org_id', '=', 'r.org_id').onRef('c.id', '=', 'r.connection_id'))
    .select(['r.status', 'r.title', 'r.started_at', 'r.meeting_id', 'r.has_audio', 'r.has_video', 'r.has_transcript', 'c.provider'])
    .where('r.org_id', '=', orgId)
    .where('r.id', '=', recordingId)
    .where('r.user_id', '=', userId)
    .executeTakeFirst();
}

// Whether a meeting is the importer's own, unedited and holds nothing yet: the empty meeting a failed try left behind. Read as the importer, so row security shows what they may see of it (they
// record it, so every row of it), and a meeting that is not theirs or not there is not "empty" for them. The row is locked for the rest of the transaction first: a child row (a note, a link, an
// agenda link) takes a key-share lock on it, so one added in another tab waits until this command ends instead of slipping in between the check and the delete.
async function isEmptyOwnMeeting(trx: Trx, orgId: string, userId: string, meetingId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('crove_meetings.meeting')
    .select(['recorder_user_id', 'created_at', 'updated_at'])
    .where('org_id', '=', orgId)
    .where('id', '=', meetingId)
    .forUpdate()
    .executeTakeFirst();
  // Made by the import and never changed since: the title, the readers, the visibility and the series are still what the import set, so nothing the member did to it is lost.
  if (!row || row.recorder_user_id !== userId || new Date(row.updated_at).getTime() !== new Date(row.created_at).getTime()) return false;
  const { rows } = await sql<{ empty: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM crove_meetings.meeting m
      WHERE m.org_id = ${orgId}::uuid AND m.id = ${meetingId}::uuid AND m.recorder_user_id = ${userId}::uuid
        AND NOT EXISTS (SELECT 1 FROM crove_meetings.audio_segment x WHERE x.org_id = m.org_id AND x.meeting_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_video x WHERE x.org_id = m.org_id AND x.meeting_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM crove_meetings.transcript_segment x WHERE x.org_id = m.org_id AND x.meeting_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_result x WHERE x.org_id = m.org_id AND x.meeting_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM crove_meetings.action_item x WHERE x.org_id = m.org_id AND x.meeting_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_note x WHERE x.org_id = m.org_id AND x.meeting_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_link x WHERE x.org_id = m.org_id AND x.meeting_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM crove_meetings.calendar_agenda x WHERE x.org_id = m.org_id AND x.meeting_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM crove_meetings.live_line x WHERE x.org_id = m.org_id AND x.meeting_id = m.id)
    ) AS empty`.execute(trx);
  return rows[0]?.empty === true;
}

export const meetingImportStart = defineCommand({
  name: 'meetings.import.start',
  // Opens an import the app's switch-off would cut short: it holds the tenant row, as the switch does (ADR-0053).
  opensBusyWork: true,
  input: zMeetingImportStart,
  risk: 'R2',
  // The command itself makes no call. It queues the download of a recording from the platform the member connected, which the worker makes.
  sideEffect: 'external',
  access: ROLES,
  target: (input) => ({ type: 'kernel.meeting_platform_recording', id: input.recordingId }),
  handler: async (ctx, input) => {
    // The importer confirms what everyone was told: a person does, never an agent acting for one.
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới nhập được bản ghi');
    const userId = ctx.actor.userId;
    const recording = await readOwnRecording(ctx.trx, ctx.orgId, userId, input.recordingId);
    if (!recording) throw new DomainError('MEETING_PLATFORM_NOT_FOUND', 404, 'Không tìm thấy bản ghi này');
    if (recording.status !== 'suggested' && recording.status !== 'failed') {
      throw new DomainError('MEETING_PLATFORM_STATE', 409, 'Bản ghi này đã được nhập hoặc đang được nhập');
    }
    // No audio file, no way to take the audio out of a video file and no transcript the platform's provider can hand over (C2, #3174: a recording with only a transcript): refused here, before a meeting is made for it.
    const transcriptOnly = !recording.has_audio && !recording.has_video && recording.has_transcript && hasTranscriptPath(recording.provider);
    if (!recording.has_audio && !(recording.has_video && videoImportOn) && !transcriptOnly) throw new DomainError('MEETING_PLATFORM_NO_AUDIO', 422, 'Nền tảng không có tệp âm thanh hay video cho bản ghi này');
    const title = (input.title ?? (recording.title.trim() === '' ? UNTITLED[input.language] : recording.title.trim())).slice(0, 200);

    // A retry of a failed try: the empty meeting that try made goes, by the recorder's own delete path (it also shreds the meeting's keys), so the list does not keep one empty meeting for each failed click.
    let replaced: string | null = null;
    if (recording.status === 'failed' && recording.meeting_id !== null && (await isEmptyOwnMeeting(ctx.trx, ctx.orgId, userId, recording.meeting_id))) {
      await ctx.run('meetings.meeting.delete', { meetingId: recording.meeting_id });
      replaced = recording.meeting_id;
    }

    const meetingId = await createMeetingRow(ctx, {
      userId,
      title,
      language: input.language,
      visibility: input.visibility,
      // The call began when the platform says; the periods of keeping the media and the text are counted from now, or an old call would be refused at once as past its period.
      startedAt: recording.started_at,
      retentionFrom: ctx.now,
      lengthSeconds: null,
      // Audio only: the video of a platform's recording is never kept (C2a takes the audio out of it).
      keepVideo: false,
      liveNotes: false,
      summaryTemplate: input.summaryTemplate,
      consentMethod: input.consentMethod,
      consentNoticeVersion: input.consentNoticeVersion,
      readerUserIds: input.readerUserIds,
      extensionTokenId: null,
    });

    await sql`SELECT crove_kernel.meeting_platform_recording_begin(${input.recordingId}::uuid, ${meetingId}::uuid, ${newStagingKey()}::text)`.execute(ctx.trx).catch(importError);

    ctx.audit({
      recordingId: input.recordingId,
      meetingId,
      replacedMeetingId: replaced,
      provider: recording.provider,
      consentMethod: input.consentMethod,
      consentNoticeVersion: input.consentNoticeVersion,
      visibility: input.visibility,
      summaryTemplate: input.summaryTemplate,
    });
    return { meetingId };
  },
});

// The same clean-up as a retry, for the two paths that leave a failed try's empty meeting in the list for good (#3587): the member dismisses a failed recording, or disconnects the platform that listed
// it (its recording rows go with the connection, so the app asks first). The kernel commands cannot reach a meeting, so the app calls this one beside them. Only the member's own failed or dismissed
// recordings are looked at, and each meeting passes the retry's test (own, never edited, nothing hanging off it, the row locked first) before the recorder's own delete path removes it; a meeting that
// holds anything, was edited, is not theirs or is already gone is left alone, with no error. The recording row itself is the kernel's and is not touched here. Nothing here reads a platform or a title.
// Limits, by decision: the app calls it as a best-effort second step (a failure of it never undoes the dismissal or blocks the disconnect), so a failed call leaves the empty meeting, and the kernel's
// sweep drops a dismissed row after 14 days; it does not run while the Meetings app is off (unlike the delete it uses), which the app-gate invariant would have to list; and the app asks before a
// disconnect that a busy connection may still refuse, in which case the failed tries' empty meetings are already gone and their rows keep a pointer to nothing, which a retry treats as gone.
export const meetingImportDiscardEmpty = defineCommand({
  name: 'meetings.import.discard_empty',
  input: zMeetingImportDiscardEmpty,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => (input.recordingId !== undefined ? { type: 'kernel.meeting_platform_recording', id: input.recordingId } : { type: 'kernel.meeting_platform_connection', id: input.connectionId as string }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới dọn được bản ghi đã nhập');
    const userId = ctx.actor.userId;
    let q = ctx.trx
      .selectFrom('crove_kernel.meeting_platform_recording')
      .select(['id', 'meeting_id'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('status', 'in', ['failed', 'dismissed'])
      .where('meeting_id', 'is not', null)
      .orderBy('id');
    q = input.recordingId !== undefined ? q.where('id', '=', input.recordingId) : q.where('connection_id', '=', input.connectionId as string);
    const rows = await q.execute();
    if (input.recordingId !== undefined && rows.length === 0) {
      // A recording that is not theirs or not there is not found; one that is neither failed nor dismissed has nothing to clean.
      const own = await readOwnRecording(ctx.trx, ctx.orgId, userId, input.recordingId);
      if (!own) throw new DomainError('MEETING_PLATFORM_NOT_FOUND', 404, 'Không tìm thấy bản ghi này');
    }
    const meetingIds = [...new Set(rows.flatMap((r) => (r.meeting_id === null ? [] : [r.meeting_id])))];
    let removed = 0;
    for (const meetingId of meetingIds) {
      if (!(await isEmptyOwnMeeting(ctx.trx, ctx.orgId, userId, meetingId))) continue;
      await ctx.run('meetings.meeting.delete', { meetingId });
      removed += 1;
    }
    ctx.audit({ recordingId: input.recordingId ?? null, connectionId: input.connectionId ?? null, removed });
    return zMeetingImportDiscarded.parse({ removed });
  },
});

// The member's own step that finishes a TRANSCRIPT-ONLY import (C2, #3174): the worker's job staged the platform's transcript, the import route claimed it and read it again, and this command writes
// the lines as the recorder's draft. It is no RPC command (nothing in the contract names it): only the route runs it, with the lines it read from the staged file, so a member cannot call it
// with text of their own under the platform's name. It still refuses anything but the claimed transcript-only recording of this member for this meeting. The lines are the platform's
// transcription (Google Meet's or Microsoft Teams', by the provider of the connection the recording came through; a provider with no transcript path is refused): born tainted, `source` the platform (nothing updates it), so the recorder reads them before anything is published, and no AI call or cost is involved. It also takes the recording to `imported`
// and ends the meeting, as recording a media does for an audio import. The audit row holds ids and a count, never a line.
export const meetingImportTakeTranscript = defineCommand({
  name: 'meetings.import.take_transcript',
  input: zMeetingTranscriptImport,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới nhập được bản chép lời');
    const userId = ctx.actor.userId;
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Chỉ người ghi cuộc họp mới nhập được bản chép lời của nó');
    // The recording with the connection it came through (an inner join: a recording whose connection is gone is no claim). Whose transcription the lines are follows that provider, never the caller's input.
    const row = await ctx.trx
      .selectFrom('crove_kernel.meeting_platform_recording as r')
      .innerJoin('crove_kernel.meeting_platform_connection as c', (join) => join.onRef('c.org_id', '=', 'r.org_id').onRef('c.id', '=', 'r.connection_id'))
      .select(['r.id', 'r.length_seconds', 'c.provider'])
      .where('r.org_id', '=', ctx.orgId)
      .where('r.meeting_id', '=', input.meetingId)
      .where('r.user_id', '=', userId)
      .where('r.status', '=', 'claimed')
      .where('r.has_transcript', '=', true)
      .where('r.has_audio', '=', false)
      .where('r.has_video', '=', false)
      .executeTakeFirst();
    if (!row) throw new DomainError('IMPORT_NOT_CLAIMED', 403, 'Cuộc họp này không có bản chép lời nào đang chờ nhập');
    // Explicit, and nothing else: only a provider that has a transcript path is labelled, so a Zoom recording can never carry Google's label. A new provider adds its line here and in its migration.
    if (!hasTranscriptPath(row.provider)) throw new DomainError('IMPORT_NOT_CLAIMED', 403, 'Nền tảng này không có bản chép lời nào để nhập');
    const source = TRANSCRIPT_SOURCE_OF[row.provider];
    // The same lock as every writer of a meeting's media, so a piece or an upload that races with this finds the meeting done or waits for it.
    await lockMeetingMedia(ctx, input.meetingId);
    await replaceDraft(ctx, input.meetingId, input.segments, { tainted: true, source, platformCut: input.platformCut });
    await sql`SELECT crove_kernel.meeting_platform_recording_imported(${input.meetingId}::uuid)`.execute(ctx.trx);
    // The definer does nothing for a row that is no longer claimed (the sweep may have failed a stale claim since the read above, and the row cannot be locked by this role): then the
    // lines and the end of the meeting go with the rolled-back transaction, and the member is told so, never left with a half-imported meeting and a retry that makes a second one.
    const done = await ctx.trx.selectFrom('crove_kernel.meeting_platform_recording').select('status').where('org_id', '=', ctx.orgId).where('id', '=', row.id).executeTakeFirst();
    if (done?.status !== 'imported') throw new DomainError('IMPORT_NOT_CLAIMED', 409, 'Bản chép lời này không còn chờ nhập nữa, hãy thử nhập lại');
    // The call ended when the platform says it did, else with its last line; never later than now (the rule of recording a media).
    const seconds = row.length_seconds ?? Math.ceil(Math.max(...input.segments.map((s) => s.endSeconds)));
    await sql`
      UPDATE crove_meetings.meeting
      SET ended_at = LEAST(started_at + (${seconds}::int * interval '1 second'), ${ctx.now}::timestamptz), updated_at = ${ctx.now}::timestamptz
      WHERE org_id = ${ctx.orgId}::uuid AND id = ${input.meetingId}::uuid AND ended_at IS NULL AND started_at IS NOT NULL`.execute(ctx.trx);
    ctx.audit({ meetingId: input.meetingId, recordingId: row.id, stored: input.segments.length, source, cut: input.platformCut });
    return { meetingId: input.meetingId, stored: input.segments.length };
  },
});

export const importCommands = [meetingImportStart, meetingImportDiscardEmpty, meetingImportTakeTranscript];
