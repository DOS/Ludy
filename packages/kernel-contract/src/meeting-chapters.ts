// SPDX-License-Identifier: AGPL-3.0-only
// Chapters ("Mục lục") of a meeting (#3844, ADR-0049 stage A): a short title and the second of the transcript line it starts at. Typed by the recorder (the recorder's own Vy fills the same table
// in a later step), shown to the meeting's readers once published. A title is plain text of one line: at most 80 characters, no email address and no run of eight or more digits, so a title can
// never be the value a personal-data search probes for (the finder reads emails and runs of 8 to 20 digits).
import { z } from 'zod';
import { zId } from './schemas.ts';

export const CHAPTERS_MAX = 20;
export const CHAPTER_TITLE_MAX = 80;
// The seconds a transcript line may start at: a day.
export const CHAPTER_SECOND_MAX = 86_400;

// Why a title is refused, a fixed word, or null when it is fine: it is trimmed by the caller first.
export type ChapterTitleProblem = 'empty' | 'too_long' | 'multiline' | 'contact';
export function chapterTitleProblem(title: string): ChapterTitleProblem | null {
  if (title.length === 0) return 'empty';
  if (title.length > CHAPTER_TITLE_MAX) return 'too_long';
  if (/[\r\n\u2028\u2029]/.test(title)) return 'multiline';
  // An email address (any @), or eight or more digits however they are separated (spaces, dots, dashes, brackets, a plus): a phone number, a tax code, a national ID, an account.
  if (title.includes('@') || /(?:\d[\s.()+-]*){8,}/.test(title)) return 'contact';
  return null;
}

export const zChapterInput = z.strictObject({
  title: z.string().min(1).max(CHAPTER_TITLE_MAX * 2),
  startSeconds: z.number().int().min(0).max(CHAPTER_SECOND_MAX),
});
export type ChapterInput = z.infer<typeof zChapterInput>;

// The recorder's set: it replaces the draft chapters of the meeting. An empty list deletes the draft. The seconds must be the starts of real lines of the transcript, each once.
export const zChaptersSave = z.strictObject({ meetingId: zId, chapters: z.array(zChapterInput).max(CHAPTERS_MAX) });
export const zChaptersSaved = z.strictObject({ meetingId: zId, chapters: z.number().int().min(0).max(CHAPTERS_MAX) });

export const zChapter = z.strictObject({
  id: zId,
  position: z.number().int().min(1).max(CHAPTERS_MAX),
  title: z.string(),
  startSeconds: z.number().int().min(0).max(CHAPTER_SECOND_MAX),
  // True while the title is the model's, unedited: only the recorder's own draft can be (a reader sees published rows, never tainted).
  tainted: z.boolean(),
});
export type Chapter = z.infer<typeof zChapter>;

// What the caller reads: the recorder both stages, a reader of the meeting the published set only (the table's row policy decides, the draft is empty for anyone else).
export const zChapters = z.strictObject({ meetingId: zId, draft: z.array(zChapter), published: z.array(zChapter) });
export type Chapters = z.infer<typeof zChapters>;
