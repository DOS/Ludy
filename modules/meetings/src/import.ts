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
import { zMeetingImportStart, type MeetingLanguage } from '@crove/kernel-contract';
import { DomainError, defineCommand, newStagingKey, type CommandContext } from '@crove/kernel-runtime';
import { sql } from 'kysely';
import { createMeetingRow } from './meeting-core.ts';
import { ROLES } from './transcript.ts';

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

type Trx = CommandContext['trx'];

async function readOwnRecording(trx: Trx, orgId: string, userId: string, recordingId: string) {
  return trx
    .selectFrom('crove_kernel.meeting_platform_recording as r')
    .innerJoin('crove_kernel.meeting_platform_connection as c', (join) => join.onRef('c.org_id', '=', 'r.org_id').onRef('c.id', '=', 'r.connection_id'))
    .select(['r.status', 'r.title', 'r.started_at', 'r.meeting_id', 'c.provider'])
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
      // Audio first: the video of a recording is not imported by C1.
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

export const importCommands = [meetingImportStart];
