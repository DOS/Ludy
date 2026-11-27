// SPDX-License-Identifier: AGPL-3.0-only
// Worker sweep and expiry purge for member-Vy daily morning briefing prep lines (#5073 Step 2b-2, ADR-0049):
//   - purgeExpiredMorningBriefLines clears expired morning_brief_lines rows on the nightly memberVySweep clock.
//   - runMeetingsBriefDailySweep finds opted-in members due inside their morning window via ludy_meetings.morning_brief_daily_due,
//     opens a system-started member_vy run (meetings.brief_daily) that never supersedes active runs, reads facts in member_vy
//     context, calls the MeetingsBriefWriter port under memberVyRunMeter, persists checked lines <= 240 code points through
//     meetings.brief.store_lines, and records counts only in member_vy_result.
// Never imports @ludy/agent/member-vy or member-vy-ports.ts (member-vy-sinks.test.ts). Logs carry org prefixes and codes only.
import { sql } from 'kysely';
import { AiBudgetExhaustedError, AiMeterMissingError, withAiScope } from '@ludy/agent';
import type { Db } from '@ludy/db';
import { MEMBER_VY_RUN_ERROR_CODES, type MemberVyRunErrorCode } from '@ludy/kernel';
import { MORNING_BRIEFING_CAPS, briefLines, type DailyBriefFacts, type DailyBriefItem } from '@ludy/kernel-contract';
import { DomainError, memberVyRuntime, type Runtime, type SystemActor } from '@ludy/kernel-runtime';
import { memberVyRunMeter, type AiPrice } from './ai-meter.ts';

export const MEETINGS_BRIEF_DAILY_CRON = '*/5 * * * *';

const PER_PASS = 200;
const ACTIVE_CONNECTIONS_MAX = 20;
const BRIEF_LINES_TTL_MS = 36 * 3_600_000;
const ACTOR: SystemActor = { type: 'system', component: 'meetings.brief_daily' };

export type MeetingsBriefWriteResult =
  | { sentences: readonly string[]; dropped: number; errorCode?: undefined }
  | { errorCode: string };

export interface MeetingsBriefWriter {
  writeDailyBrief(
    member: { readonly orgId: string; readonly memberUserId: string },
    facts: readonly { kind: 'decision' | 'item' | 'deal'; text: string }[],
  ): Promise<MeetingsBriefWriteResult>;
}

export interface BriefDailyDueRow {
  org_id: string;
  user_id: string;
  day: string;
  window_from: Date | string;
  window_to: Date | string;
  english: boolean;
}

export interface BriefDailySweepDeps {
  runtime: Runtime;
  workerDb: Db;
  writer?: MeetingsBriefWriter | null | undefined;
  price?: AiPrice | undefined;
  perPass?: number | undefined;
  orgId?: string | undefined;
  userId?: string | undefined;
  day?: string | undefined;
}

export interface BriefDailySweepResult {
  found: number;
  prepared: number;
  skipped: number;
  failures: number;
}

export interface BriefDailyMemberOutcome {
  status: 'prepared' | 'skipped' | 'failed';
  storedMeetings: number;
  storedLines: number;
  errorCode: string | null;
}

function toIsoTimestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; ) {
    const cp = value.codePointAt(i) ?? 0;
    i += cp > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

// Drops empty sentences, sentences above MORNING_BRIEFING_CAPS.vyLineTextMax code points, or overflow lines without slicing text.
function fitMorningLines(rawSentences: readonly string[]): { lines: string[]; extraDropped: number } {
  const kept: string[] = [];
  let extraDropped = 0;
  for (const raw of rawSentences) {
    const trimmed = raw.trim();
    const len = codePointLength(trimmed);
    if (len < 1 || len > MORNING_BRIEFING_CAPS.vyLineTextMax || kept.length >= MORNING_BRIEFING_CAPS.vyLinesPerMeetingMax) {
      extraDropped += 1;
      continue;
    }
    kept.push(trimmed);
  }
  return { lines: kept, extraDropped };
}

function targetMeetingIdOf(item: DailyBriefItem): string | null {
  return item.meetingId ?? item.brief.previous?.meetingId ?? null;
}

/** Maps a daily brief failure to one of MEMBER_VY_RUN_ERROR_CODES accepted by kernel.member_vy.run.finish. */
export function briefDailyFailureCode(error: unknown): MemberVyRunErrorCode {
  if (error instanceof AiBudgetExhaustedError) return 'AI_BUDGET_EXHAUSTED';
  if (error instanceof AiMeterMissingError) return 'TRANSCRIBE_FAILED';
  let code = 'TRANSCRIBE_FAILED';
  if (error instanceof DomainError) {
    if (error.code === 'BUDGET_EXHAUSTED') code = 'AI_BUDGET_EXHAUSTED';
    else if (error.code === 'KILL_SWITCH_ON' || error.code === 'KILL_SWITCH' || error.code === 'MODULE_OFF') code = 'AI_STOPPED';
    else if (error.code === 'BRIEF_LINES_NOT_ELIGIBLE') code = 'VY_NOT_ALLOWED';
    else if (error.code === 'VY_RUN_NOT_LIVE') code = 'AGENT_RUN_NOT_LIVE';
    else if (error.code === 'USER_DISABLED') code = 'MEMBER_NOT_ACTIVE';
    else code = error.code;
  } else if (typeof error === 'string') {
    code = error === 'BRIEF_TIMEOUT' ? 'TRANSCRIBE_TIMEOUT' : error;
  }
  return (MEMBER_VY_RUN_ERROR_CODES as readonly string[]).includes(code)
    ? (code as MemberVyRunErrorCode)
    : 'TRANSCRIBE_FAILED';
}

/** Deletes up to `limit` expired rows from ludy_meetings.morning_brief_lines via the worker-only definer. */
export async function purgeExpiredMorningBriefLines(workerDb: Db, limit = 500): Promise<number> {
  const capped = Math.max(1, Math.min(Math.trunc(limit), 5000));
  const { rows } = await sql<{ deleted: number }>`
    SELECT ludy_meetings.morning_brief_lines_purge(${capped}::int) AS deleted`.execute(workerDb);
  return Number(rows[0]?.deleted ?? 0);
}

/** Prepares and stores daily morning briefing Vy prep lines for one due member, closing ai_run in finally. */
export async function runMeetingsBriefDailyForMember(
  deps: { runtime: Runtime; workerDb: Db; writer: MeetingsBriefWriter; price?: AiPrice | undefined },
  row: BriefDailyDueRow,
): Promise<BriefDailyMemberOutcome> {
  if (!(await deps.runtime.appOn(row.org_id, 'meetings').catch(() => false))) {
    return { status: 'skipped', storedMeetings: 0, storedLines: 0, errorCode: 'MODULE_OFF' };
  }

  const { rows: connRows } = await sql<{ id: string }>`
    SELECT id FROM ludy_meetings.morning_brief_active_connections(${row.org_id}::uuid, ${row.user_id}::uuid) AS t(id)`.execute(deps.workerDb);
  const connectionIds = connRows.map((c) => c.id).slice(0, ACTIVE_CONNECTIONS_MAX);
  if (connectionIds.length === 0) {
    return { status: 'skipped', storedMeetings: 0, storedLines: 0, errorCode: null };
  }

  let started: { agentId: string; runId: string; resultId: string; expiresAt: string };
  try {
    started = await deps.runtime.execute<{ agentId: string; runId: string; resultId: string; expiresAt: string }>(
      'kernel.member_vy.run.start_daily',
      { userId: row.user_id, feature: 'meetings.brief_daily' },
      { actor: ACTOR, orgId: row.org_id },
    );
  } catch (error: unknown) {
    return {
      status: 'skipped',
      storedMeetings: 0,
      storedLines: 0,
      errorCode: error instanceof DomainError ? error.code : 'START_FAILED',
    };
  }

  const vy = memberVyRuntime(deps.runtime, row.org_id, { agentId: started.agentId, runId: started.runId });
  let fatalCode: MemberVyRunErrorCode | null = null;
  let storedFailed = false;
  let storedMeetings = 0;
  let linesCount = 0;

  try {
    const factsResult = await vy.query<DailyBriefFacts>('meetings.brief.daily_facts', {
      from: toIsoTimestamp(row.window_from),
      to: toIsoTimestamp(row.window_to),
      connectionIds,
    });
    const scope = {
      orgId: row.org_id,
      agentId: started.agentId,
      memberRunId: started.runId,
      meter: memberVyRunMeter({
        runtime: deps.runtime,
        vy,
        actor: ACTOR,
        orgId: row.org_id,
        agentId: started.agentId,
        price: deps.price,
      }),
    };

    const seenMeetings = new Set<string>();
    const expiresAt = new Date(Date.now() + BRIEF_LINES_TTL_MS).toISOString();
    let meetingsCount = 0;
    let factsCount = 0;
    let sentencesCount = 0;
    let droppedCount = 0;
    let callErrors = 0;
    let lastCallErrorCode: string | null = null;

    for (const item of factsResult.items) {
      if (meetingsCount >= MORNING_BRIEFING_CAPS.vyMeetingsMax) break;
      if (item.brief.empty) continue;
      const targetMeetingId = targetMeetingIdOf(item);
      if (!targetMeetingId || seenMeetings.has(targetMeetingId)) continue;
      const numbered = briefLines(item.brief);
      if (numbered.length === 0) continue;

      seenMeetings.add(targetMeetingId);
      meetingsCount += 1;
      factsCount += numbered.length;

      // Re-check run liveness, vy.use, kill switches, and budget immediately before calling the writer.
      await vy.query('kernel.member_vy.run.check', {});

      const written = await withAiScope(scope, () =>
        deps.writer.writeDailyBrief(
          { orgId: row.org_id, memberUserId: row.user_id },
          numbered.map((line) => ({ kind: line.kind, text: line.text })),
        ),
      );

      if (!('sentences' in written)) {
        callErrors += 1;
        lastCallErrorCode = written.errorCode;
        continue;
      }

      sentencesCount += written.sentences.length;
      const { lines, extraDropped } = fitMorningLines(written.sentences);
      droppedCount += written.dropped + extraDropped;
      if (lines.length === 0) continue;

      // Re-check run state and switches right before writing derived lines into morning_brief_lines.
      await vy.query('kernel.member_vy.run.check', {});

      try {
        await deps.runtime.execute(
          'meetings.brief.store_lines',
          { userId: row.user_id, meetingId: targetMeetingId, lines, expiresAt },
          { actor: ACTOR, orgId: row.org_id },
        );
        linesCount += lines.length;
        storedMeetings += 1;
      } catch (storeError: unknown) {
        if (storeError instanceof DomainError && storeError.code === 'MEETING_NOT_FOUND') {
          droppedCount += lines.length;
          continue;
        }
        throw storeError;
      }
    }

    if (storedMeetings === 0 && callErrors > 0) {
      fatalCode = briefDailyFailureCode(lastCallErrorCode ?? 'BRIEF_FAILED');
    } else {
      const body = JSON.stringify({
        v: 1,
        meetings: meetingsCount,
        facts: factsCount,
        sentences: sentencesCount,
        lines: linesCount,
        dropped: droppedCount,
      });
      const stored = await vy.execute<{ stored: boolean; status: 'ready' | 'failed' }>(
        'kernel.member_vy.result.store',
        { runId: started.runId, outcome: { status: 'ready', body } },
      );
      if (!stored.stored) {
        fatalCode = 'AI_STOPPED';
        storedFailed = true;
      }
    }
  } catch (error: unknown) {
    fatalCode = briefDailyFailureCode(error);
  } finally {
    if (fatalCode !== null && !storedFailed) {
      await vy
        .execute('kernel.member_vy.result.store', {
          runId: started.runId,
          outcome: { status: 'failed', errorCode: fatalCode },
        })
        .catch(() => undefined);
    }
    await deps.runtime
      .execute(
        'kernel.member_vy.run.finish',
        { runId: started.runId, errorCode: fatalCode },
        { actor: ACTOR, orgId: row.org_id },
      )
      .catch((finishError: unknown) => {
        console.error(
          `[meetings-brief-daily] org ${row.org_id.slice(0, 8)} could not close run ${started.runId.slice(0, 8)}`,
          finishError instanceof DomainError ? finishError.code : finishError instanceof Error ? finishError.name : 'error',
        );
      });
  }

  return {
    status: fatalCode !== null ? 'failed' : 'prepared',
    storedMeetings,
    storedLines: linesCount,
    errorCode: fatalCode,
  };
}

/** Runs one worker sweep across due members, isolating failures so one org or member never blocks others. */
export async function runMeetingsBriefDailySweep(deps: BriefDailySweepDeps): Promise<BriefDailySweepResult> {
  const done: BriefDailySweepResult = { found: 0, prepared: 0, skipped: 0, failures: 0 };
  if (!deps.writer) return done;

  const { rows } = await sql<BriefDailyDueRow>`
    SELECT org_id, user_id, day::text AS day, window_from, window_to, english
    FROM ludy_meetings.morning_brief_daily_due(${deps.perPass ?? PER_PASS}::int, ${deps.orgId ?? null}::uuid, ${deps.userId ?? null}::uuid, ${deps.day ?? null}::date)`.execute(
    deps.workerDb,
  );

  for (const row of rows) {
    done.found += 1;
    try {
      const outcome = await runMeetingsBriefDailyForMember(
        { runtime: deps.runtime, workerDb: deps.workerDb, writer: deps.writer, price: deps.price },
        row,
      );
      if (outcome.status === 'prepared') done.prepared += 1;
      else if (outcome.status === 'skipped') done.skipped += 1;
      else {
        done.failures += 1;
        console.warn(`[meetings-brief-daily] org ${row.org_id.slice(0, 8)} failed ${outcome.errorCode ?? 'UNKNOWN'}`);
      }
    } catch (error: unknown) {
      done.failures += 1;
      console.warn(`[meetings-brief-daily] org ${row.org_id.slice(0, 8)}`, briefDailyFailureCode(error));
    }
  }
  return done;
}
