// SPDX-License-Identifier: AGPL-3.0-only
// Live notes, the copy of a finished window (issue #3110, ADR-0052 decision 2, ADR-0049 stage B and decision 8). This is the one live notes command that reads
// the recorder's private Vy result row, so it is the module's sink for the feature (MEMBER_VY_SINKS): what it copies stays tainted and carries the run it came
// from. The rest of the shape is in live-run.ts.
//
// Two commands, both the recorder's own, both in their user context:
//   meetings.live.tick         the finished window, if there is one, is copied: its lines become crove_meetings.live_line rows (the recorder's alone, "Bản nháp
//                              trực tiếp"); then the next window is started, unless the recording has ended, the pieces are gone or the recorder stopped.
//   meetings.live.notes_copy   the finished notes run (feature meetings.live_summary, made by the route of apps/kernel from the new lines and the previous notes
//                              only) replaces the earlier live draft: crove_meetings.meeting_result and action_item, feature meetings.live_notes, stage draft,
//                              tainted, with the checks of plan section 5.3 the batch summary uses.
// Nothing here creates a task: an item is a suggestion until the recorder accepts it (meetings.action_item.accept), exactly as for the batch summary.
import { sql } from 'kysely';
import {
  ITEMS_PER_MEETING_MAX,
  zLiveNotesCopy,
  zLiveNotesDone,
  zLiveResult,
  zLiveTick,
  zLiveTicked,
  zSummaryResult,
  type LiveNotesDone,
  type LiveTicked,
} from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { itemFlags } from './results.ts';
import { matchAttendee, parseWhen } from './summary.ts';
import { vnDay } from './retention.ts';
import { ROLES, userOf } from './transcript.ts';
import { LIVE_NOTES_FEATURE, LIVE_SUMMARY_FEATURE, lastLineSeq, latestWindow, lockLive, openLiveMeeting, recordingEnded, startWindow } from './live-run.ts';

export const liveTick = defineCommand({
  name: 'meetings.live.tick',
  input: zLiveTick,
  // It starts the next window, which sends audio to the provider and spends the budget: the same external effect as the first click (R2), which the recorder
  // approved by starting the live notes and keeps approving by leaving the pane open.
  risk: 'R2',
  sideEffect: 'external',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<LiveTicked> => {
    const userId = userOf(ctx.actor);
    await openLiveMeeting(ctx, input.meetingId, 'take its live notes');
    await lockLive(ctx.trx, ctx.orgId, userId);
    const latest = await latestWindow(ctx, input.meetingId);
    let copiedRunId: string | null = null;
    let lines = 0;

    // 1. A window that finished since the last tick: its text is the recorder's own result row, read in the recorder's own context.
    if (latest !== null && latest.state === 'ready') {
      const found = await ctx
        .query<{ status: string; feature: string; subjectType: string; subjectId: string; body: string | null; expiresAt: string }>('kernel.member_vy.result.get', { runId: latest.runId })
        .catch((error: unknown) => {
          if (error instanceof DomainError && error.code === 'RESULT_NOT_FOUND') return null;
          throw error;
        });
      const result = found && found.status === 'ok' ? found.value : null;
      const usable =
        result !== null &&
        result.feature === LIVE_NOTES_FEATURE &&
        result.subjectType === 'meeting' &&
        result.subjectId === input.meetingId &&
        result.status === 'ready' &&
        result.body !== null &&
        new Date(result.expiresAt).getTime() > ctx.now.getTime();
      if (usable && result) {
        // The body is the worker's, checked once there; it is read back strictly here and never trusted for its shape.
        let body;
        try {
          body = zLiveResult.parse(JSON.parse(result.body as string));
        } catch {
          throw new DomainError('LIVE_RESULT_INVALID', 422, 'The live notes result cannot be read');
        }
        // One copy of a window: a run whose lines are already here is not copied twice (two tabs ticking at once).
        const already = await ctx.trx
          .selectFrom('crove_meetings.live_line')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('meeting_id', '=', input.meetingId)
          .where('source_run_id', '=', latest.runId)
          .executeTakeFirst();
        if (!already) {
          for (const [seq, startSeconds, endSeconds, text] of body.lines) {
            await ctx.trx
              .insertInto('crove_meetings.live_line')
              .values({
                org_id: ctx.orgId,
                meeting_id: input.meetingId,
                seq,
                start_seconds: startSeconds,
                end_seconds: Math.max(startSeconds, endSeconds),
                text,
                source_run_id: latest.runId,
              })
              .onConflict((oc) => oc.columns(['org_id', 'meeting_id', 'seq']).doNothing())
              .execute();
            lines += 1;
          }
          copiedRunId = latest.runId;
        }
      }
    }

    // 2. The next window, unless the recording has ended or the recorder's pieces are gone.
    let runId: string | null = null;
    let state: LiveTicked['state'] = 'off';
    const ended = await recordingEnded(ctx, input.meetingId);
    if (latest !== null && latest.state === 'running') {
      state = 'running';
    } else if (ended) {
      // The final recording is in: the batch transcript takes over and the preview is replaced by it (meetings.transcript.copy_result).
      state = 'stopped';
    } else if (latest !== null && latest.state === 'failed') {
      // A spent budget, a kill switch or a provider failure: the pane says so and no new window is started until the recorder starts again.
      state = 'stopped';
    } else if (latest !== null) {
      runId = await startWindow(ctx, input.meetingId, await lastLineSeq(ctx, input.meetingId));
      state = runId === null ? 'waiting' : 'running';
    }
    ctx.audit({ meetingId: input.meetingId, copiedRunId, lines, runId, state });
    return zLiveTicked.parse({ meetingId: input.meetingId, copiedRunId, lines, runId, state, errorCode: latest?.errorCode ?? null });
  },
});

// The running notes of this meeting, replaced by the fresh ones. Only the live draft Vy wrote is replaced: a summary the recorder typed or kept, and
// the batch summary's own draft, are left alone, and an item the recorder already accepted keeps its task.
async function replaceLiveNotes(
  ctx: Parameters<typeof startWindow>[0],
  meetingId: string,
  runId: string,
  notes: import('@crove/kernel-contract').SummaryResult,
  userId: string,
): Promise<boolean> {
  const row = await ctx.trx.selectFrom('crove_meetings.meeting').select(['started_at']).where('org_id', '=', ctx.orgId).where('id', '=', meetingId).executeTakeFirstOrThrow();
  const meetingDay = vnDay(row.started_at ?? new Date());
  const readers = await ctx.trx.selectFrom('crove_meetings.meeting_reader').select('user_id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', meetingId).execute();
  const ids = [userId, ...readers.map((r) => r.user_id)];
  const { rows: profiles } = await sql<{ user_id: string; email: string; display_name: string | null }>`SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${ids}::uuid[])`.execute(
    ctx.trx,
  );
  const people = profiles.map((p) => ({ userId: p.user_id, name: p.display_name ?? p.email.split('@')[0] ?? '' }));

  // The earlier live draft goes; the batch summary's draft (another feature) and anything the recorder typed stay.
  await ctx.trx
    .deleteFrom('crove_meetings.meeting_result')
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .where('feature', '=', LIVE_NOTES_FEATURE)
    .where('stage', '=', 'draft')
    .where('tainted', '=', true)
    .execute();
  await ctx.trx
    .deleteFrom('crove_meetings.action_item')
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'draft')
    .where('status', '=', 'suggested')
    .where('tainted', '=', true)
    .where('source_run_id', 'is not', null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('crove_kernel.ai_run as r')
          .select('r.id')
          .whereRef('r.id', '=', 'crove_meetings.action_item.source_run_id')
          .where('r.org_id', '=', ctx.orgId)
          .where('r.feature', '=', LIVE_NOTES_FEATURE),
      ),
    )
    .execute();
  if (notes.summary === '' && notes.decisions.length === 0 && notes.items.length === 0) return false;
  // A summary draft the recorder keeps is theirs: the live notes do not fight it, they only skip their own summary this time.
  const mine = await ctx.trx
    .selectFrom('crove_meetings.meeting_result')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'draft')
    .executeTakeFirst();
  if (!mine && (notes.summary !== '' || notes.decisions.length > 0)) {
    await ctx.trx
      .insertInto('crove_meetings.meeting_result')
      .values({
        org_id: ctx.orgId,
        meeting_id: meetingId,
        summary: notes.summary === '' ? notes.decisions[0] ?? '-' : notes.summary,
        decisions: sql`${JSON.stringify(notes.decisions)}::jsonb`,
        feature: LIVE_NOTES_FEATURE,
        stage: 'draft',
        tainted: true,
        source_run_id: runId,
      })
      .execute()
      .catch((error: unknown) => {
        // Another draft appeared between the read and the insert: the recorder's own stands.
        if ((error as { code?: string }).code === '23505') return undefined;
        throw error;
      });
  }
  const kept = await ctx.trx
    .selectFrom('crove_meetings.action_item')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .executeTakeFirstOrThrow();
  for (const item of notes.items.slice(0, Math.max(0, ITEMS_PER_MEETING_MAX - kept.n))) {
    await ctx.trx
      .insertInto('crove_meetings.action_item')
      .values({
        org_id: ctx.orgId,
        meeting_id: meetingId,
        title: item.title,
        who_drafted: itemFlags(item.who).length > 0 ? '' : item.who,
        who_parsed: matchAttendee(item.who, people),
        when_drafted: itemFlags(item.when).length > 0 ? '' : item.when,
        when_parsed: parseWhen(item.when, meetingDay),
        transcript_seconds: item.seconds,
        stage: 'draft',
        flags: sql`${JSON.stringify(itemFlags(item.title))}::jsonb`,
        tainted: true,
        source_run_id: runId,
      })
      .execute();
  }
  return true;
}

export const liveNotesCopy = defineCommand({
  name: 'meetings.live.notes_copy',
  input: zLiveNotesCopy,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<LiveNotesDone> => {
    const userId = userOf(ctx.actor);
    await openLiveMeeting(ctx, input.meetingId, 'copy its running notes');
    await lockLive(ctx.trx, ctx.orgId, userId);
    // The recorder's own result, read in the recorder's own context (the row is sealed to its member). A run of another meeting or feature is not this one.
    const found = await ctx
      .query<{ status: string; feature: string; subjectType: string; subjectId: string; body: string | null; expiresAt: string }>('kernel.member_vy.result.get', { runId: input.runId })
      .catch((error: unknown) => {
        if (error instanceof DomainError && error.code === 'RESULT_NOT_FOUND') throw new DomainError('LIVE_NOTES_NOT_FOUND', 404, 'No live notes result for this meeting');
        throw error;
      });
    if (found.status !== 'ok') throw new DomainError('LIVE_NOTES_NOT_FOUND', 404, 'No live notes result for this meeting');
    const result = found.value;
    if (result.feature !== LIVE_SUMMARY_FEATURE || result.subjectType !== 'meeting' || result.subjectId !== input.meetingId) {
      throw new DomainError('LIVE_NOTES_NOT_FOUND', 404, 'No live notes result for this meeting');
    }
    if (new Date(result.expiresAt).getTime() <= ctx.now.getTime()) throw new DomainError('LIVE_NOTES_NOT_FOUND', 404, 'No live notes result for this meeting');
    if (result.status !== 'ready' || result.body === null) throw new DomainError('LIVE_NOTES_NOT_READY', 409, 'The live notes are not finished');
    // The body is the model's, checked once by the agent package; it is read back strictly here and never trusted for its shape.
    let notes;
    try {
      notes = zSummaryResult.parse(JSON.parse(result.body));
    } catch {
      throw new DomainError('LIVE_RESULT_INVALID', 422, 'The live notes result cannot be read');
    }
    // One copy of a run: the rows carry the run they came from (source_run_id) and the taint, so a second click is not a second copy.
    const already = await ctx.trx
      .selectFrom('crove_meetings.meeting_result')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('source_run_id', '=', input.runId)
      .where('tainted', '=', true)
      .executeTakeFirst();
    if (already) throw new DomainError('LIVE_NOTES_ALREADY_COPIED', 409, 'These live notes were already copied into the draft');
    await replaceLiveNotes(ctx, input.meetingId, input.runId, notes, userId);
    ctx.audit({ meetingId: input.meetingId, runId: input.runId, decisionCount: notes.decisions.length, itemCount: notes.items.length, dropped: notes.dropped });
    return zLiveNotesDone.parse({ meetingId: input.meetingId, state: 'ready', runId: input.runId, errorCode: null, decisions: notes.decisions.length, items: notes.items.length });
  },
});

export const liveNotesCommands = [liveTick, liveNotesCopy];
