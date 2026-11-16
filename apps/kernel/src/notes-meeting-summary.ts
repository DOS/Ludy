// SPDX-License-Identifier: AGPL-3.0-only
// Reads a meeting's published summary (or the recorder's non-empty draft) through the audited sensitive-query path
// and saves it as a shared org note linked to the meeting (#1679, step N10).
import {
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  type MeetingDetail,
  type MeetingResults,
  type NoteFromMeetingSummaryInput,
  type NoteWritten,
} from '@crove/kernel-contract';
import { DomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';

const MEETINGS_OFF = () => new DomainError('NOTES_MEETING_UNAVAILABLE', 400, 'Tính năng Biên bản cuộc họp đang tắt');

async function queryMeetingOrUnavailable<T>(
  runtime: Runtime,
  name: string,
  input: Record<string, unknown>,
  as: { actor: UserActor; orgId: string },
): Promise<T> {
  try {
    return await runtime.query<T>(name, input, as);
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === 'MODULE_OFF') {
      throw MEETINGS_OFF();
    }
    throw error;
  }
}

export async function saveMeetingSummaryAsNote(
  runtime: Runtime,
  orgId: string,
  actor: UserActor,
  input: NoteFromMeetingSummaryInput,
): Promise<NoteWritten> {
  const as = { actor, orgId };
  // Fail before issuing any sensitive read when Notes is disabled for the org or Meetings is absent/disabled.
  await runtime.query('notes.note.list', { view: 'mine', limit: 1 }, as);
  if (!runtime.installed('meetings')) {
    throw MEETINGS_OFF();
  }

  const meeting = await queryMeetingOrUnavailable<MeetingDetail>(runtime, 'meetings.meeting.get', { meetingId: input.meetingId }, as);
  const results = await queryMeetingOrUnavailable<MeetingResults>(runtime, 'meetings.result.get', { meetingId: input.meetingId }, as);

  const hasContent = (r: { summary: string; decisions: readonly string[] } | null) =>
    r !== null && (r.summary.trim() !== '' || r.decisions.some((d) => d.trim() !== ''));

  const published = hasContent(results.published) ? results.published : null;
  let source = published;
  if (!source && results.isRecorder && hasContent(results.draft)) {
    if (results.draft?.tainted) {
      throw new DomainError('DRAFT_NOT_REVIEWED', 409, 'Hãy rà soát bản nháp của Vy trước khi lưu thành ghi chú chung');
    }
    source = results.draft;
  }
  if (!source) {
    throw new DomainError('MEETING_SUMMARY_EMPTY', 409, 'Cuộc họp chưa có tóm tắt để lưu thành ghi chú');
  }

  const summaryText = source.summary.trim();
  const decisions = source.decisions.map((d) => d.trim()).filter(Boolean);
  const decisionsText = decisions.length > 0 ? `## Quyết định\n${decisions.map((d) => `- ${d}`).join('\n')}` : '';
  const body = [summaryText, decisionsText].filter(Boolean).join('\n\n').slice(0, NOTE_BODY_MAX);
  const title = (input.title?.trim() || meeting.title.trim() || 'Tóm tắt cuộc họp').slice(0, NOTE_TITLE_MAX);

  return runtime.execute<NoteWritten>(
    'notes.note.from_meeting_summary',
    { meetingId: input.meetingId, title, body },
    as,
  );
}
