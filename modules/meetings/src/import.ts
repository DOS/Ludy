// SPDX-License-Identifier: AGPL-3.0-only
// Importing a recording a meeting platform finished (meetings integrations C1, issue #3173, plan docs/plan/meetings-integrations.md section 6.1).
//
// - The member presses "Nhập" on a suggestion. meetings.import.start is the one command behind it: it creates the meeting with its consent record (the platform showed its own notice to everyone
//   and the importer confirms it) through the same core as meetings.meeting.create, then links the recording and queues the download (crove_kernel.meeting_platform_recording_begin).
// - It does no network I/O itself. The queued download is made by the worker's import job, which is why the command declares an external effect, like meetings.hook.set: the job
//   (`kernel-meetings-import-sweep handler`, apps/kernel/test/invariant/job-egress.test.ts) is justified by this command.
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
    .select(['r.status', 'r.title', 'r.started_at', 'c.provider'])
    .where('r.org_id', '=', orgId)
    .where('r.id', '=', recordingId)
    .where('r.user_id', '=', userId)
    .executeTakeFirst();
}

export const meetingImportStart = defineCommand({
  name: 'meetings.import.start',
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
