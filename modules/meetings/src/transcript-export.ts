// SPDX-License-Identifier: AGPL-3.0-only
// The transcript of a meeting as a file (#4817, plan docs/plan/meetings-integrations.md), the module's side.
//
// meetings.transcript.download   the lines the caller may read, as plain text or SRT. A sensitive read: each one leaves an audit row naming the meeting, with no text in it.
//
// The reader rule is the transcript page's (meetings.transcript.get): the meeting is opened under the caller's own row security and text period (a meeting the caller does not read, or whose
// text has gone, is a 404), and the lines are read under the same row security, so a reader gets the published lines and the recorder their draft while one exists. Redaction rewrites the rows,
// so a hidden value is not in the file. With no line the answer is TRANSCRIPT_EXPORT_EMPTY (409). Nothing is written, and no model is used.
import { sql } from 'kysely';
import { TRANSCRIPT_EXPORT_MIMES, zTranscriptExport, zTranscriptExportInput, type TranscriptExport } from '@ludy/kernel-contract';
import { DomainError, defineQuery } from '@ludy/kernel-runtime';
import { vnDay } from './retention.ts';
import { exportableCount, transcriptFile, transcriptFilename } from './transcript-export-file.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const transcriptDownload = defineQuery({
  name: 'meetings.transcript.download',
  input: zTranscriptExportInput,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<TranscriptExport> => {
    userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const meeting = await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .select(['title', 'started_at', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirstOrThrow();
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.transcript_segment')
      .select([sql<string>`start_seconds::text`.as('start_seconds'), sql<string>`end_seconds::text`.as('end_seconds'), 'speaker_label', 'text', 'stage'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('start_seconds')
      .orderBy('id')
      .execute();
    // The stage the caller sees on the page: their draft while one exists, else the published lines.
    const stage = rows.some((r) => r.stage === 'draft') ? 'draft' : 'published';
    const lines = rows
      .filter((r) => r.stage === stage)
      .map((r) => ({ startSeconds: Number(r.start_seconds), endSeconds: Number(r.end_seconds), speakerLabel: r.speaker_label, text: r.text }));
    const count = exportableCount(lines);
    if (count === 0) throw new DomainError('TRANSCRIPT_EXPORT_EMPTY', 409, 'There is no transcript to download');
    const bytes = Buffer.from(transcriptFile(input.format, lines), 'utf8');
    const day = vnDay(new Date((meeting.started_at ?? meeting.created_at) as Date | string));
    return zTranscriptExport.parse({
      format: input.format,
      filename: transcriptFilename(meeting.title, day, input.format),
      mimeType: TRANSCRIPT_EXPORT_MIMES[input.format],
      bytes: bytes.length,
      lines: count,
      contentBase64: bytes.toString('base64'),
    });
  },
});

export const transcriptExportQueries = [transcriptDownload];
