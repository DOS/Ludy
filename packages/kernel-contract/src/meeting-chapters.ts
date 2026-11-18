// SPDX-License-Identifier: AGPL-3.0-only
// Chapters ("Mục lục") of a meeting (#3844, ADR-0049 stage A): a short title and the second of the transcript line it starts at. Typed by the recorder (the recorder's own Vy fills the same table
// in a later step), shown to the meeting's readers once published. A title is plain text of one line: at most 80 characters, and no email address or run of eight or more digits (a chapter names a part of the
// meeting, not a person's contact). The personal-data finder and erasure reach a title anyway, as they reach the title of a meeting: nothing there rests on this rule.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const CHAPTERS_MAX = 20;
export const CHAPTER_TITLE_MAX = 80;
// The seconds a transcript line may start at: a day.
export const CHAPTER_SECOND_MAX = 86_400;

// Why a title is refused, a fixed word, or null when it is fine: it is trimmed by the caller first.
// The characters a title never holds: the class of the minutes templates' CHECK (and of the database's CHECK on this table), beside the line breaks that 'multiline' names: controls, the soft hyphen, the
// invisible fillers, zero-width and directional marks, bidi isolates, the Braille blank, the byte order mark, interlinear annotation and tag characters, and a lone surrogate.
// The combining grapheme joiner is outside the class: a combining mark inside one is a lint warning (no-misleading-character-class).
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]|\u034f|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
export type ChapterTitleProblem = 'empty' | 'too_long' | 'multiline' | 'control' | 'contact';
export function chapterTitleProblem(title: string): ChapterTitleProblem | null {
  if (title.length === 0) return 'empty';
  if (title.length > CHAPTER_TITLE_MAX) return 'too_long';
  if (/[\r\n\u2028\u2029]/.test(title)) return 'multiline';
  if (CONTROL.test(title)) return 'control';
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

// What a finished chapters run stores for the recorder (private to them, read back strictly by the copy): the checked chapters and how many the checks removed.
export const zChaptersResult = z.strictObject({
  chapters: z.array(z.strictObject({ title: z.string().min(1).max(CHAPTER_TITLE_MAX), startSeconds: z.number().int().min(0).max(CHAPTER_SECOND_MAX) })).min(1).max(CHAPTERS_MAX),
  dropped: z.number().int().min(0),
});
export type ChaptersResult = z.infer<typeof zChaptersResult>;

// The recorder's click that copies a finished run into their draft (born as the model's text, not yet read).
export const zChaptersCopy = z.strictObject({ meetingId: zId, runId: zId });
export const zChaptersCopied = z.strictObject({ meetingId: zId, chapters: z.number().int().min(0).max(CHAPTERS_MAX), dropped: z.number().int().min(0) });
