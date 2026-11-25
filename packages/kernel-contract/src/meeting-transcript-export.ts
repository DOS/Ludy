// SPDX-License-Identifier: AGPL-3.0-only
// The transcript of a meeting as a file to keep (#4817, plan docs/plan/meetings.md L19): plain text ("speaker: line", each with its time), SRT (timed captions) or a Word file (on the writer of #4774), built on the server
// from the lines the caller reads, under the same reader rule as the transcript page (the recorder reads their draft, every other reader the published lines), so text that was redacted is
// not in the file. The file comes back inside the answer as base64, so no download route is needed. This file holds the shapes and the limits both sides use; no database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const TRANSCRIPT_EXPORT_FORMATS = ['txt', 'srt', 'docx'] as const;
export type TranscriptExportFormat = (typeof TRANSCRIPT_EXPORT_FORMATS)[number];
export const TRANSCRIPT_EXPORT_MIMES = {
  txt: 'text/plain; charset=utf-8',
  srt: 'application/x-subrip; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const satisfies Record<TranscriptExportFormat, string>;
// A file name is cut to this many characters before the extension.
export const TRANSCRIPT_EXPORT_NAME_MAX = 120;

export const zTranscriptExportInput = z.strictObject({
  meetingId: zId,
  format: z.enum(TRANSCRIPT_EXPORT_FORMATS),
});
export type TranscriptExportInput = z.infer<typeof zTranscriptExportInput>;

export const zTranscriptExport = z.strictObject({
  format: z.enum(TRANSCRIPT_EXPORT_FORMATS),
  filename: z.string().min(1).max(TRANSCRIPT_EXPORT_NAME_MAX + 8),
  mimeType: z.enum(Object.values(TRANSCRIPT_EXPORT_MIMES) as [string, ...string[]]),
  bytes: z.number().int().min(1),
  lines: z.number().int().min(1),
  contentBase64: z.string().min(1),
});
export type TranscriptExport = z.infer<typeof zTranscriptExport>;
