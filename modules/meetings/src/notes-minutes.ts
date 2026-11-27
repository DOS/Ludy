// SPDX-License-Identifier: AGPL-3.0-only
// Drafting structured minutes from the recorder's typed notes when a meeting has no audio recording (#5129, L32).
// Recorder-only; requires zero transcript segments and non-empty, unredacted typed notes; returns only numbered note lines, language, and attendee display names (names only).
// Never touches Vy output sinks; counts/IDs only in audit.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  ITEM_TEXT_MAX,
  NOTES_MINUTES_LINES_MAX,
  zMeetingRef,
  zNotesMinutesFacts,
  zNotesMinutesStarted,
  zNotesMinutesStatus,
  type NotesMinutesFacts,
  type NotesMinutesStarted,
  type NotesMinutesStatus,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { vyReason } from './ask.ts';
import { hasRedactedMinutes } from './catch-up.ts';
import { attendeeNames } from './speaker.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const NOTES_MINUTES_FEATURE = 'meetings.notes_minutes';

const ERASED_NOTE_MARK = '[đã xóa]';

export function splitNoteLines(body: string): string[] {
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    lines.push(trimmed);
    if (lines.length >= NOTES_MINUTES_LINES_MAX) break;
  }
  return lines;
}

export function hasRedactedNotes(body: string): boolean {
  return hasRedactedMinutes([body]) || body.includes(ERASED_NOTE_MARK);
}

interface NotesMinutesLoaded {
  isRecorder: boolean;
  hasTranscript: boolean;
  noteBody: string;
  noteLines: string[];
  redacted: boolean;
  language: 'vi' | 'en';
  attendees: string[];
}

async function loadNotesMinutesState(
  ctx: QueryContext | CommandContext,
  meetingId: string,
  withAttendees: boolean,
): Promise<NotesMinutesLoaded> {
  const userId = userOf(ctx.actor);
  const meeting = await openMeeting(ctx.trx, ctx.orgId, meetingId);
  if (meeting.recorder_user_id !== userId) {
    return {
      isRecorder: false,
      hasTranscript: false,
      noteBody: '',
      noteLines: [],
      redacted: false,
      language: 'vi',
      attendees: [],
    };
  }

  const seg = await ctx.trx
    .selectFrom('ludy_meetings.transcript_segment')
    .select(sql<string>`count(*)::text`.as('n'))
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .executeTakeFirstOrThrow();
  const hasTranscript = Number(seg.n) > 0;

  const noteRow = await ctx.trx
    .selectFrom('ludy_meetings.meeting_note')
    .select('body')
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .executeTakeFirst();
  const noteBody = noteRow?.body ?? '';
  const noteLines = splitNoteLines(noteBody);
  const redacted = hasRedactedNotes(noteBody);

  let language: 'vi' | 'en' = 'vi';
  let attendees: string[] = [];
  if (withAttendees && !hasTranscript && noteLines.length > 0 && !redacted) {
    const meta = await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .select('language')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', meetingId)
      .executeTakeFirst();
    if (meta?.language === 'en') language = 'en';
    attendees = (await attendeeNames(ctx, meetingId, meeting.recorder_user_id))
      .map((a) => a.name.trim().slice(0, ITEM_TEXT_MAX))
      .filter((n) => n !== '')
      .slice(0, 100);
  }

  return {
    isRecorder: true,
    hasTranscript,
    noteBody,
    noteLines,
    redacted,
    language,
    attendees,
  };
}

function assertReadyState(state: NotesMinutesLoaded): void {
  if (!state.isRecorder) {
    throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can draft minutes from notes');
  }
  if (state.hasTranscript) {
    throw new DomainError('NOTES_MINUTES_HAS_TRANSCRIPT', 422, 'Meeting already has a transcript');
  }
  if (state.noteLines.length === 0) {
    throw new DomainError('NOTES_MINUTES_NO_NOTES', 422, 'Add typed notes before drafting minutes');
  }
  if (state.redacted) {
    throw new DomainError('NOTES_MINUTES_REDACTED', 422, 'Meeting notes contain redacted details');
  }
}

export const notesMinutesStatus = defineQuery({
  name: 'meetings.notes_minutes.status',
  access: ROLES,
  input: zMeetingRef,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<NotesMinutesStatus> => {
    const state = await loadNotesMinutesState(ctx, input.meetingId, false);
    let reason: NotesMinutesStatus['reason'] = null;
    if (!state.isRecorder) {
      reason = 'not_recorder';
    } else if (state.hasTranscript) {
      reason = 'has_transcript';
    } else if (state.noteLines.length === 0) {
      reason = 'no_notes';
    } else if (state.redacted) {
      reason = 'redacted';
    } else {
      reason = await vyReason(ctx);
    }
    return zNotesMinutesStatus.parse({
      meetingId: input.meetingId,
      available: reason === null,
      reason,
      estimate: null,
    });
  },
});

export const notesMinutesFacts = defineQuery({
  name: 'meetings.notes_minutes.facts',
  sensitive: true,
  access: ROLES,
  input: zMeetingRef,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<NotesMinutesFacts> => {
    const state = await loadNotesMinutesState(ctx, input.meetingId, true);
    assertReadyState(state);
    return zNotesMinutesFacts.parse({
      meetingId: input.meetingId,
      language: state.language,
      noteLines: state.noteLines,
      attendees: state.attendees,
      glossary: [],
    });
  },
});

export const notesMinutesStart = defineCommand({
  name: 'meetings.notes_minutes.start',
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  input: zMeetingRef,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<NotesMinutesStarted> => {
    const state = await loadNotesMinutesState(ctx, input.meetingId, false);
    assertReadyState(state);
    const vy = await vyReason(ctx);
    if (vy === 'off') throw new DomainError('NOTES_MINUTES_OFF', 422, 'Vy notes minutes is turned off for this workspace');
    if (vy === 'forbidden') throw new DomainError('VY_NOT_ALLOWED', 403, 'You do not have permission to use Vy');
    if (vy === 'paused' || vy === 'budget') throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Vy is paused or out of monthly AI budget');
    let run: { runId: string };
    try {
      run = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', {
        feature: NOTES_MINUTES_FEATURE,
        subjectType: NOTES_MINUTES_FEATURE,
        subjectId: randomUUID(),
      });
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_BUSY') {
        throw new DomainError('NOTES_MINUTES_BUSY', 409, 'Vy is already drafting minutes from notes; try again in a moment');
      }
      throw error;
    }
    ctx.audit({ meetingId: input.meetingId, noteLines: state.noteLines.length, runId: run.runId });
    return zNotesMinutesStarted.parse({ meetingId: input.meetingId, runId: run.runId });
  },
});

export const notesMinutesCommands = [notesMinutesStart];
export const notesMinutesQueries = [notesMinutesStatus, notesMinutesFacts];
