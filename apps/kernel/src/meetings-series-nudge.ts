// SPDX-License-Identifier: AGPL-3.0-only
// The sweep of the series nudge (#3542): every 5 minutes, about 30 minutes before the next meeting of a recurring series, each person who still has open items from the previous meeting gets one
// in-app notice (how many, and a link; never a title). It reaches no URL and sends no mail: it reads ids and times through the worker-only definer crove_meetings.series_nudges_due and runs the
// command meetings.series.nudge in the org's system context, which derives the row again before it writes the notice (once per member and event: the notice's key).
// The definer lists only nudges still to send (not told, not muted, Meetings on), so a pass that hits the limit goes on with the rest on the next one. A failure for one nudge never stops the others; it stays listed for the next pass, which is still inside the 30 minutes until the meeting starts. Logs carry id prefixes and codes only.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

export const MEETINGS_SERIES_NUDGE_CRON = '*/5 * * * *';
// Nudges one pass handles at most; the rest wait for the next pass.
const PER_PASS = 200;

const ACTOR = { type: 'system' as const, component: 'meetings.series' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

// One pass. Returns what it did, for the log and the tests.
export async function runMeetingsSeriesNudgeSweep(deps: { runtime: Runtime; workerDb: Db; perPass?: number }): Promise<{ found: number; sent: number; failures: number }> {
  const done = { found: 0, sent: 0, failures: 0 };
  const { rows } = await sql<{ org_id: string; user_id: string; series_id: string; starts_at: Date }>`
    SELECT org_id, user_id, series_id, starts_at FROM crove_meetings.series_nudges_due(${deps.perPass ?? PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of rows) {
    // The definer already leaves out an org whose Meetings is off (ADR-0053); this is the runtime's own check.
    if (!(await deps.runtime.appOn(row.org_id, 'meetings').catch(() => false))) continue;
    done.found += 1;
    const nudge = () =>
      deps.runtime.execute<{ sent: number }>('meetings.series.nudge', { userId: row.user_id, seriesId: row.series_id, startsAt: new Date(row.starts_at).toISOString() }, { actor: ACTOR, orgId: row.org_id });
    try {
      // A second try is harmless: the notice's key writes it once.
      done.sent += (await nudge().catch(nudge)).sent;
    } catch (error) {
      done.failures += 1;
      console.warn(`[meetings-series-nudge] org ${row.org_id.slice(0, 8)}`, codeOf(error));
    }
  }
  return done;
}
