// SPDX-License-Identifier: AGPL-3.0-only
// Live notes as the recorder's own Vy, the part that never reads a private result row (issue #3110, ADR-0052 decision 2, ADR-0049 stage B). The copy of a
// finished window, which does, is in live-notes.ts. The shape mirrors transcription (transcribe-run.ts and transcribe.ts):
//
//   meetings.live.start   the recorder's own click on "Ghi chú trực tiếp" for a meeting that opted in at its consent step (#3109): it starts the first
//                         window's run (kernel.member_vy.run.start, which checks vy.use, the four kill switches and the budget) and asks the worker for the
//                         job through an event that carries ids only.
//   (the worker)          enters the recorder's member-scoped context for that one run, reads that window's pieces through the live door
//                         (kernel.member_vy.meeting_audio.open in its live mode), transcribes them metered by audio length, and writes ONLY
//                         kernel.member_vy_result. The running notes are a run of their own (meetings.live.notes_start, below).
//   meetings.live.tick    (live-notes.ts) the pane's poll, the recorder's own action: copies a finished window into the preview lines,
//                         then starts the next window. The one command here that reads the private result row.
//   meetings.live.stop    the recorder stops the live notes; the recording and its upload are untouched.
//   meetings.live.status  what the pane shows: the opt-in, whether this deployment can do it, the state of the latest window and the lines so far.
//
// Why one run per window and not one run for the whole meeting (as ADR-0052 section 2 sketched): kernel.member_vy.result.store is terminal (it writes a row
// that must still be `running`, once), and a member-scoped background context may write nothing but its own result row (ADR-0049 decision 1), so a single
// four-hour run could show the recorder nothing until the meeting ended. One run per window keeps the ADR's intent, one live run at a time for the feature,
// and never cuts off a transcription or a summary (#3029).
import { sql } from 'kysely';
import {
  LIVE_WINDOW_PIECES,
  zLiveNotesAsk,
  zLiveNotesInput,
  zLiveRef,
  zLiveStart,
  zLiveStarted,
  zLiveStatus,
  zLiveStopped,
  type LiveNotesInput,
  type LiveStatus,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { isSummaryEnabled } from './summary-run.ts';
import { vnDay } from './retention.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const LIVE_NOTES_FEATURE = 'meetings.live_notes';
// The running notes are a run of their own (a member's Vy has one live run per feature, and a window may be running): one model call, in the foreground.
export const LIVE_SUMMARY_FEATURE = 'meetings.live_summary';

// Whether this deployment can run live notes at all: the same switch and credential key transcription needs (set at start-up by apps/kernel), since a window is
// a transcription of the pieces. False: no run starts and the pane says the deployment does not do it.
let liveEnabled = false;
export function setLiveNotesEnabled(enabled: boolean): void {
  liveEnabled = enabled;
}
let liveBroker = true;
export function setLiveNotesBroker(configured: boolean): void {
  liveBroker = configured;
}
export const liveNotesReady = (): boolean => liveEnabled && liveBroker;

// One start, tick or stop of a member's live notes at a time, as transcription locks its starts (#3033): without it two ticks of two tabs both see no live run
// and both start a window, and the second would supersede the first after it spent budget.
export async function lockLive(trx: QueryContext['trx'], orgId: string, userId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`meetings.live_notes:${orgId}:${userId}`}, 0))`.execute(trx);
}

export interface LiveMeeting {
  recorder_user_id: string;
  live_notes: boolean;
  audio_day: string;
}

// The meeting a live notes command acts on, with what every one of them checks: it exists and is readable, the caller recorded it, it opted in, and its audio
// period has not ended (from that day a window would only fail).
export async function openLiveMeeting(ctx: CommandContext | QueryContext, meetingId: string, what: string): Promise<LiveMeeting> {
  const userId = userOf(ctx.actor);
  await openMeeting(ctx.trx, ctx.orgId, meetingId);
  const row = await ctx.trx
    .selectFrom('crove_meetings.meeting')
    .select(['recorder_user_id', 'live_notes', sql<string>`audio_retention_date::text`.as('audio_day')])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', meetingId)
    .executeTakeFirstOrThrow();
  if (row.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, `Only the meeting recorder can ${what}`);
  if (!row.live_notes) throw new DomainError('LIVE_NOTES_NOT_ENABLED', 409, 'Live notes were not turned on for this meeting');
  if (row.audio_day <= vnDay('now' in ctx ? ctx.now : new Date())) throw new DomainError('MEDIA_RETENTION_PASSED', 409, 'The retention period of this meeting has ended');
  return row;
}

// Whether the recording has ended: its final audio or video is recorded (meetings.media.record, which also deleted the pieces), so no window follows.
export async function recordingEnded(ctx: CommandContext | QueryContext, meetingId: string): Promise<boolean> {
  const { rows } = await sql<{ done: boolean }>`
    SELECT (EXISTS (SELECT 1 FROM crove_meetings.audio_segment WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid)
         OR EXISTS (SELECT 1 FROM crove_meetings.meeting_video WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid)) AS done`.execute(ctx.trx);
  return rows[0]?.done === true;
}

// The piece the preview has reached, so the next window asks for what follows it. -1: nothing copied yet.
export async function lastLineSeq(ctx: CommandContext | QueryContext, meetingId: string): Promise<number> {
  const { rows } = await sql<{ seq: number | null }>`
    SELECT MAX(seq)::int AS seq FROM crove_meetings.live_line WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid`.execute(ctx.trx);
  return rows[0]?.seq ?? -1;
}

// Starts one window's run for this meeting, as the recorder, and asks the worker for it. The caller holds the live lock and has checked the meeting.
export async function startWindow(ctx: CommandContext, meetingId: string, afterSeq: number): Promise<string | null> {
  const userId = userOf(ctx.actor);
  // Nothing new to transcribe: no run and no spend. The pane waits and ticks again.
  const { rows: next } = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM crove_meetings.live_chunk WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid AND seq > ${afterSeq}::int`.execute(ctx.trx);
  if ((next[0]?.n ?? 0) === 0) return null;
  const started = await ctx.run<{ runId: string; resultId: string }>('kernel.member_vy.run.start', { feature: LIVE_NOTES_FEATURE, subjectType: 'meeting', subjectId: meetingId });
  const agent = await ctx.trx
    .selectFrom('crove_kernel.agent')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('kind', '=', 'member_vy')
    .where('member_user_id', '=', userId)
    .executeTakeFirstOrThrow();
  await ctx.emit('meetings.live_notes.requested', {
    meetingId,
    runId: started.runId,
    agentId: agent.id,
    afterSeq,
    pieces: LIVE_WINDOW_PIECES,
  });
  return started.runId;
}

// The state of the recorder's latest window, for the pane and for the tick.
export async function latestWindow(ctx: CommandContext | QueryContext, meetingId: string): Promise<{ runId: string; state: 'running' | 'ready' | 'failed'; errorCode: string | null } | null> {
  const latest = await ctx.query<{ runId: string; state: 'running' | 'ready' | 'failed'; errorCode: string | null } | null>('kernel.member_vy.run.latest', {
    feature: LIVE_NOTES_FEATURE,
    subjectType: 'meeting',
    subjectId: meetingId,
  });
  return latest.status === 'ok' ? latest.value : null;
}

export const liveStart = defineCommand({
  name: 'meetings.live.start',
  input: zLiveStart,
  // The click sends the meeting's audio to the transcription provider and spends the AI budget: an external effect (R2, plan section 4.7), the click being the
  // person's approval of that spend for this meeting.
  risk: 'R2',
  sideEffect: 'external',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await openLiveMeeting(ctx, input.meetingId, 'start its live notes');
    if (!liveEnabled) throw new DomainError('TRANSCRIBE_OFF', 422, 'Transcription is not turned on here; the meeting works as it did');
    if (!liveBroker) throw new DomainError('TRANSCRIBE_NO_BROKER', 503, 'Transcription needs the deployment credential key (CREDENTIAL_KEY or CREDENTIAL_KEY_FILE); ask the operator');
    if (await recordingEnded(ctx, input.meetingId)) throw new DomainError('LIVE_CLOSED', 409, 'The recording of this meeting has ended');
    await lockLive(ctx.trx, ctx.orgId, userId);
    // A window of this meeting that is still going is not started over; a run of this feature for ANOTHER meeting of the recorder is not cut off either.
    const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: LIVE_NOTES_FEATURE, subjectId: input.meetingId });
    if (live.status !== 'ok' || live.value.live) throw new DomainError('LIVE_RUNNING', 409, 'The live notes of this meeting are already running');
    const other = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: LIVE_NOTES_FEATURE });
    if (other.status !== 'ok' || other.value.live) throw new DomainError('LIVE_OTHER_RUNNING', 409, 'Another meeting of yours is taking live notes; stop it first');
    const runId = await startWindow(ctx, input.meetingId, await lastLineSeq(ctx, input.meetingId));
    if (runId === null) throw new DomainError('LIVE_NO_AUDIO', 422, 'No audio of this meeting has arrived yet');
    ctx.audit({ meetingId: input.meetingId, runId });
    return zLiveStarted.parse({ meetingId: input.meetingId, runId });
  },
});

export const liveStop = defineCommand({
  name: 'meetings.live.stop',
  input: zLiveRef,
  // Stopping the recorder's own run spends nothing and sends nothing.
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await openLiveMeeting(ctx, input.meetingId, 'stop its live notes');
    await lockLive(ctx.trx, ctx.orgId, userId);
    const latest = await latestWindow(ctx, input.meetingId);
    if (latest === null) return zLiveStopped.parse({ meetingId: input.meetingId, stopped: false });
    const stopped = await ctx.run<{ cancelled: boolean }>('kernel.member_vy.run.cancel', { runId: latest.runId });
    ctx.audit({ meetingId: input.meetingId, runId: latest.runId, stopped: stopped.cancelled });
    return zLiveStopped.parse({ meetingId: input.meetingId, stopped: stopped.cancelled });
  },
});

export const liveStatus = defineQuery({
  name: 'meetings.live.status',
  input: zLiveRef,
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<LiveStatus> => {
    const userId = userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['recorder_user_id', 'live_notes'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirstOrThrow();
    const empty: LiveStatus = {
      meetingId: input.meetingId,
      optedIn: meeting.live_notes,
      enabled: liveNotesReady(),
      state: 'off',
      runId: null,
      errorCode: null,
      lines: [],
      notesUpdatedAt: null,
    };
    // Only the recorder sees the preview: an attendee, an owner, an admin and every other member get the empty pane, as they do for a draft.
    if (meeting.recorder_user_id !== userId) return zLiveStatus.parse(empty);
    const lines = await ctx.trx
      .selectFrom('crove_meetings.live_line')
      .select(['id', 'seq', 'start_seconds', 'end_seconds', 'text'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('seq')
      .execute();
    const notes = await ctx.trx
      .selectFrom('crove_meetings.meeting_result')
      .select(['updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('feature', '=', LIVE_NOTES_FEATURE)
      .where('stage', '=', 'draft')
      .executeTakeFirst();
    const latest = await latestWindow(ctx, input.meetingId);
    return zLiveStatus.parse({
      ...empty,
      state: latest === null ? 'off' : latest.state === 'running' ? 'running' : latest.state === 'ready' ? 'waiting' : 'stopped',
      runId: latest?.runId ?? null,
      errorCode: latest?.errorCode ?? null,
      lines: lines.map((l) => ({ id: l.id, seq: l.seq, startSeconds: l.start_seconds, endSeconds: l.end_seconds, text: l.text })),
      notesUpdatedAt: notes ? new Date(notes.updated_at).toISOString() : null,
    });
  },
});

// The lines the running notes have not read yet, with the notes as they stand: what the model is given and all it is given (the new text and the previous notes
// only, ADR-0052 section 2, so the cost of a refresh does not grow with the meeting). The notes' age is the draft's own `updated_at`; a line is new when it was written
// after it. Read in the recorder's own context, so only the recorder can ask.
async function notesInput(ctx: CommandContext | QueryContext, meetingId: string): Promise<LiveNotesInput> {
  const meeting = await ctx.trx
    .selectFrom('crove_meetings.meeting')
    .select(['language'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', meetingId)
    .executeTakeFirstOrThrow();
  const draft = await ctx.trx
    .selectFrom('crove_meetings.meeting_result')
    .select(['summary', 'decisions', 'updated_at'])
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .where('feature', '=', LIVE_NOTES_FEATURE)
    .where('stage', '=', 'draft')
    .executeTakeFirst();
  const items = draft
    ? await ctx.trx
        .selectFrom('crove_meetings.action_item')
        .select(['title'])
        .where('org_id', '=', ctx.orgId)
        .where('meeting_id', '=', meetingId)
        .where('stage', '=', 'draft')
        .where('source_run_id', 'is not', null)
        .orderBy('created_at')
        .execute()
    : [];
  let query = ctx.trx
    .selectFrom('crove_meetings.live_line')
    .select(['start_seconds', 'end_seconds', 'text'])
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId);
  if (draft) query = query.where('created_at', '>', draft.updated_at);
  const lines = await query.orderBy('seq').limit(LIVE_NOTES_LINES_MAX).execute();
  const decisions = draft ? ((typeof draft.decisions === 'string' ? JSON.parse(draft.decisions) : draft.decisions) as unknown) : [];
  return zLiveNotesInput.parse({
    meetingId,
    language: meeting.language,
    previous: draft ? { summary: draft.summary, decisions: Array.isArray(decisions) ? decisions.filter((d): d is string => typeof d === 'string') : [], items: items.map((i) => i.title) } : null,
    lines: lines.map((l) => ({ startSeconds: l.start_seconds, endSeconds: l.end_seconds, text: l.text })),
  });
}

// The most lines one refresh reads: about forty minutes of speech at one line per piece. A longer gap is read in the next refreshes, never cut.
export const LIVE_NOTES_LINES_MAX = 160;

export const liveNotesInput = defineQuery({
  name: 'meetings.live.notes_input',
  input: zLiveRef,
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<LiveNotesInput> => {
    await openLiveMeeting(ctx, input.meetingId, 'read its live lines');
    return notesInput(ctx, input.meetingId);
  },
});

// Starts the run of one refresh of the running notes, as the recorder: the recorder only, the deployment's summary switch, a meeting that opted in, and new lines to
// read (none: no run and no spend, the answer is `null`). The kernel's run.start then checks vy.use, the kill switches and the budget. The route of apps/kernel makes
// the one model call after it, as the batch summary's route does.
export const liveNotesStart = defineCommand({
  name: 'meetings.live.notes_start',
  input: zLiveNotesAsk,
  // The model call spends the AI budget on the recorder's own click or on the pane they left open: the same external effect as a window (R2).
  risk: 'R2',
  sideEffect: 'external',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await openLiveMeeting(ctx, input.meetingId, 'ask for its running notes');
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Notes by Vy are not turned on here');
    await lockLive(ctx.trx, ctx.orgId, userId);
    const pending = await notesInput(ctx, input.meetingId);
    if (pending.lines.length === 0) return { meetingId: input.meetingId, runId: null };
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: LIVE_SUMMARY_FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    ctx.audit({ meetingId: input.meetingId, runId: started.runId, lines: pending.lines.length });
    return { meetingId: input.meetingId, runId: started.runId as string | null };
  },
});

export const liveRunCommands = [liveStart, liveStop, liveNotesStart];
export const liveRunQueries = [liveStatus, liveNotesInput];
