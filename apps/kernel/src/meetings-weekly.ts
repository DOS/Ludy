// SPDX-License-Identifier: AGPL-3.0-only
// The sweep of the weekly meetings notice (#4967): every 5 minutes, each member who turned the notice on and whose Monday time has come (in their own time zone, within six hours) and who has something the
// "this week" card would show gets one in-app notice and one mail with four counts and a link, never a title. It reaches no URL and sends nothing itself: it reads ids, a day and counts through the worker-only
// definer ludy_meetings.weekly_notices_due and runs the command meetings.weekly.notice in the org's system context, which derives the row again before it writes (once per member and Monday: the notice's key;
// the mail is queued only when that notice was written, and the mail queues do the sending).
// The definer lists only notices still to send (not told, not muted, Meetings on, a week with something to say), in no fixed order, so a pass that hits the limit goes on with the rest on the next one and a group
// of members that fail the same way cannot hold the same first rows for ever. A failure for one member never stops the others. Nothing here runs Vy.
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import { DomainError, type Runtime } from '@ludy/kernel-runtime';

export const MEETINGS_WEEKLY_CRON = '*/5 * * * *';
// Notices one pass handles at most; the rest wait for the next pass.
const PER_PASS = 200;

const ACTOR = { type: 'system' as const, component: 'meetings.weekly' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

export interface WeeklyNotifiedRow {
  orgId: string;
  notificationId: string;
}

// One pass. Returns what it did, for the log and the tests.
export async function runMeetingsWeeklySweep(deps: {
  runtime: Runtime;
  workerDb: Db;
  perPass?: number | undefined;
  // The instant the week is read at: the worker leaves it out (the clock); the tests set it to a Monday.
  at?: string | undefined;
  onNotified?: ((row: WeeklyNotifiedRow) => Promise<void>) | undefined;
}): Promise<{ found: number; sent: number; failures: number }> {
  const done = { found: 0, sent: 0, failures: 0 };
  const { rows } = await sql<{ org_id: string; user_id: string; day: string }>`
    SELECT org_id, user_id, day::text AS day FROM ludy_meetings.weekly_notices_due(${deps.perPass ?? PER_PASS}::int, NULL::uuid, NULL::uuid, NULL::date, ${deps.at ?? null}::timestamptz)`.execute(deps.workerDb);
  for (const row of rows) {
    // The definer already leaves out an org whose Meetings is off (ADR-0053); this is the runtime's own check.
    if (!(await deps.runtime.appOn(row.org_id, 'meetings').catch(() => false))) continue;
    done.found += 1;
    const notice = () =>
      deps.runtime.execute<{ notified: boolean; notificationId?: string | null }>('meetings.weekly.notice', { userId: row.user_id, day: row.day, ...(deps.at ? { at: deps.at } : {}) }, { actor: ACTOR, orgId: row.org_id });
    try {
      // A second try is harmless: the notice's key writes it once.
      const res = await notice().catch(notice);
      if (res.notified) {
        done.sent += 1;
        if (res.notificationId && deps.onNotified) {
          try {
            await deps.onNotified({ orgId: row.org_id, notificationId: res.notificationId });
          } catch (error) {
            // Leave the committed in-app notice and mail intact if queueing push fails.
            console.warn(`[meetings-weekly] push not queued for org ${row.org_id.slice(0, 8)}`, error instanceof Error ? error.name : 'error');
          }
        }
      }
    } catch (error) {
      done.failures += 1;
      console.warn(`[meetings-weekly] org ${row.org_id.slice(0, 8)}`, codeOf(error));
    }
  }
  return done;
}
