// SPDX-License-Identifier: AGPL-3.0-only
// The sweep of the minutes webhook (meetings integrations A6, issue #3164), every minute in the worker. It reaches no URL: it reads the deliveries waiting in the database and hands them to the
// queue (meeting-hook.ts sends them), through commands of the system actor.
//   1. A delivery stored at publish and never handed over, or handed over but never taken up for three minutes, goes to the queue ('send'); one still waiting after eight hours, longer than the
//      retries last, is failed ('expire'). So a delivery is stored once and sent at least once.
// A failure for one delivery never stops the others, and a failure of the queue leaves the delivery stored, to be handed over again.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import type { MeetingHookJob } from './meeting-hook.ts';

export const MEETING_HOOK_SWEEP_CRON = '* * * * *';
export const MEETING_HOOK_SWEEP_EXPIRE_SECONDS = 120;
// Deliveries one pass handles at most; the rest wait for the next minute.
const PER_PASS = 200;

const ACTOR = { type: 'system' as const, component: 'meetings.hook' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

export interface MeetingHookSweepDeps {
  runtime: Runtime;
  workerDb: Db;
  // Hands one delivery to the kernel-meeting-hook queue (a singleton job per delivery).
  send: (job: MeetingHookJob) => Promise<unknown>;
}

// One pass. Returns what it did, for the log and the tests.
export async function runMeetingHookSweep(deps: MeetingHookSweepDeps): Promise<{ handedOver: number; expired: number; failures: number }> {
  const done = { handedOver: 0, expired: 0, failures: 0 };
  const open = await sql<{ org_id: string; id: string; kind: 'send' | 'expire' }>`SELECT org_id, id, kind FROM crove_meetings.hook_open(${PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of open.rows) {
    const ctx = { actor: ACTOR, orgId: row.org_id };
    try {
      if (row.kind === 'expire') {
        await deps.runtime.execute('meetings.hook.record', { id: row.id, outcome: 'expired' }, ctx);
        done.expired += 1;
      } else {
        await deps.send({ orgId: row.org_id, id: row.id });
        await deps.runtime.execute('meetings.hook.queued', { id: row.id }, ctx);
        done.handedOver += 1;
      }
    } catch (error) {
      done.failures += 1;
      console.warn(`[meeting-hook-sweep] delivery ${row.id.slice(0, 8)}`, codeOf(error));
    }
  }
  return done;
}
