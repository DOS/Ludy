// SPDX-License-Identifier: AGPL-3.0-only
// The table of contents of a meeting (#3844, ADR-0049 stage A): a short title and the second of the transcript line each chapter starts at. This is the part the recorder types and the readers read;
// the recorder's own Vy fills the same table in a later step. Who may read or write what is decided by the row policies of crove_meetings.meeting_chapter (the recorder every stage, a reader of the
// meeting the published rows, a user context only), and these commands check it again. The chapters are published with the minutes (meetings.result.publish), replace the set published before, go
// with the meeting, and expire as a draft after 30 days. A start second must be the start of a real line of the transcript (the recorder reads every line of their meeting), each second once; a
// title holds no email address and no run of eight or more digits (the personal-data finder and erasure reach a title anyway, so nothing rests on that rule). Audit rows carry the meeting id and counts, never a title.
import { CHAPTERS_MAX, chapterTitleProblem, zChapters, zChaptersSave, zChaptersSaved, zMeetingRef, type Chapter, type Chapters } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { recorderMeeting } from './results.ts';
import { ROLES, missingAnchors, openMeeting, userOf } from './transcript.ts';

const TITLE_MESSAGES = {
  empty: 'A chapter needs a title',
  too_long: 'A chapter title is too long',
  multiline: 'A chapter title is one line',
  control: 'A chapter title holds a character that cannot be shown',
  contact: 'A chapter title holds no email address or phone number',
} as const;

export const chaptersSave = defineCommand({
  name: 'meetings.chapters.save',
  input: zChaptersSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    await recorderMeeting(ctx, input.meetingId, 'write its chapters');
    const chapters = input.chapters
      .map((c) => ({ title: c.title.trim(), startSeconds: c.startSeconds }))
      .sort((a, b) => a.startSeconds - b.startSeconds);
    for (const chapter of chapters) {
      const problem = chapterTitleProblem(chapter.title);
      if (problem) throw new DomainError(`CHAPTER_TITLE_${problem.toUpperCase()}`, 422, TITLE_MESSAGES[problem]);
    }
    if (new Set(chapters.map((c) => c.startSeconds)).size !== chapters.length) throw new DomainError('CHAPTER_DUPLICATE_SECOND', 422, 'Two chapters start at the same second');
    // The meeting row is held, so a save and a publish of the same meeting are one after the other, and a delete or an erase waits for this save.
    await ctx.trx.selectFrom('crove_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forNoKeyUpdate().execute();
    if (chapters.length > 0) {
      // Each second must be the start (to the whole second) of a line of this meeting's transcript, which the recorder reads in full.
      const missing = await missingAnchors(ctx, input.meetingId, chapters.map((c) => c.startSeconds));
      if (missing.length > 0) throw new DomainError('CHAPTER_NOT_ANCHORED', 422, 'A chapter must start at a line of the transcript');
    }
    // The draft set is replaced whole. A chapter that starts at the second of a chapter the model wrote, or that carries its title, keeps the mark (and the run it came from) even when the other is edited: only the recorder's review
    // (meetings.draft.review) clears it, never a save. A chapter at any other second is the recorder's own.
    const marked = await ctx.trx
      .selectFrom('crove_meetings.meeting_chapter')
      .select(['start_seconds', 'title', 'source_run_id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('stage', '=', 'draft')
      .where('tainted', '=', true)
      .execute();
    const runBySecond = new Map(marked.map((m) => [m.start_seconds, m.source_run_id]));
    const runByTitle = new Map(marked.map((m) => [m.title, m.source_run_id]));
    // The mark follows the chapter by its second or by its title: moving a chapter to another line, or changing only its title, never clears it.
    const markOf = (c: { title: string; startSeconds: number }): { marked: boolean; fromRunId: string | null } => {
      const bySecond = runBySecond.has(c.startSeconds);
      const byTitle = runByTitle.has(c.title);
      return { marked: bySecond || byTitle, fromRunId: bySecond ? (runBySecond.get(c.startSeconds) ?? null) : (runByTitle.get(c.title) ?? null) };
    };
    await ctx.trx.deleteFrom('crove_meetings.meeting_chapter').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('stage', '=', 'draft').execute();
    if (chapters.length > 0) {
      await ctx.trx
        .insertInto('crove_meetings.meeting_chapter')
        .values(
          chapters.map((c, i) => ({
            org_id: ctx.orgId,
            meeting_id: input.meetingId,
            stage: 'draft' as const,
            position: i + 1,
            title: c.title,
            start_seconds: c.startSeconds,
            tainted: markOf(c).marked,
            source_run_id: markOf(c).fromRunId,
          })),
        )
        .execute();
    }
    ctx.audit({ meetingId: input.meetingId, chapters: chapters.length });
    return zChaptersSaved.parse({ meetingId: input.meetingId, chapters: chapters.length });
  },
});

// What the caller may read of the meeting's chapters: the recorder the draft beside the published set, a reader the published set only (the table's row policy decides; the draft is then empty).
// A sensitive read, as the summary's: it leaves an audit row naming the meeting.
export const chaptersGet = defineQuery({
  name: 'meetings.chapters.get',
  input: zMeetingRef,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<Chapters> => {
    userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const rows = await ctx.trx
      .selectFrom('crove_meetings.meeting_chapter')
      .select(['id', 'stage', 'position', 'title', 'start_seconds', 'tainted'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('position')
      .execute();
    const view = (stage: 'draft' | 'published'): Chapter[] =>
      rows.filter((r) => r.stage === stage).slice(0, CHAPTERS_MAX).map((r) => ({ id: r.id, position: r.position, title: r.title, startSeconds: r.start_seconds, tainted: r.tainted }));
    return zChapters.parse({ meetingId: input.meetingId, draft: view('draft'), published: view('published') });
  },
});

export const chaptersCommands = [chaptersSave];
export const chaptersQueries = [chaptersGet];
