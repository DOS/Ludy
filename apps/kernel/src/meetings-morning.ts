// SPDX-License-Identifier: AGPL-3.0-only
// The sweep of the morning notice (#3955, part B): every 5 minutes, each member who turned the notice on and whose chosen time has come today (in their own time zone, within six hours) and who has at least one
// meeting that day gets one in-app notice and one mail with the count and a link, never a title. It reaches no URL and sends nothing itself: it reads ids, a day and a count through the worker-only definer
// ludy_meetings.morning_notices_due and runs the command meetings.morning.notice in the org's system context, which derives the row again before it writes (once per member and day: the notice's key; the mail
// is queued only when that notice was written, and the mail queues do the sending).
// The definer lists only notices still to send (not told, not muted, Meetings on), in no fixed order, so a pass that hits the limit goes on with the rest on the next one and a group of members that fail the same way cannot hold the same first rows for ever (#4085). A failure for one member never stops the others.
// Nothing here runs Vy: the briefs stay the member's own click.
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import { DomainError, type Runtime } from '@ludy/kernel-runtime';

export const MEETINGS_MORNING_CRON = '*/5 * * * *';
// Notices one pass handles at most; the rest wait for the next pass.
const PER_PASS = 200;

const ACTOR = { type: 'system' as const, component: 'meetings.morning' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

export interface MorningNotifiedRow {
  orgId: string;
  notificationId: string;
}

// One pass. Returns what it did, for the log and the tests.
export async function runMeetingsMorningSweep(deps: {
  runtime: Runtime;
  workerDb: Db;
  perPass?: number | undefined;
  onNotified?: ((row: MorningNotifiedRow) => Promise<void>) | undefined;
}): Promise<{ found: number; sent: number; failures: number }> {
  const done = { found: 0, sent: 0, failures: 0 };
  const { rows } = await sql<{ org_id: string; user_id: string; day: string }>`
    SELECT org_id, user_id, day::text AS day FROM ludy_meetings.morning_notices_due(${deps.perPass ?? PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of rows) {
    // The definer already leaves out an org whose Meetings is off (ADR-0053); this is the runtime's own check.
    if (!(await deps.runtime.appOn(row.org_id, 'meetings').catch(() => false))) continue;
    done.found += 1;
    const notice = () =>
      deps.runtime.execute<{ notified: boolean; notificationId?: string | null }>('meetings.morning.notice', { userId: row.user_id, day: row.day }, { actor: ACTOR, orgId: row.org_id });
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
            console.warn(`[meetings-morning] push not queued for org ${row.org_id.slice(0, 8)}`, error instanceof Error ? error.name : 'error');
          }
        }
      }
    } catch (error) {
      done.failures += 1;
      console.warn(`[meetings-morning] org ${row.org_id.slice(0, 8)}`, codeOf(error));
    }
  }
  return done;
}
