// SPDX-License-Identifier: AGPL-3.0-only
// The events of an app that is off wait, and flow when it is back on (ADR-0053 section 4, slice c C3b). The relay claims an event and queues its jobs in one
// transaction; for an org whose app is off those jobs would be refused and ended quietly, and the event lost. So the relay parks such an event
// (crove_kernel.outbox_hold) instead of queueing anything, and the held sweep puts the parked events back on the outbox, oldest first, once the app is on again
// (the choice and the entitlement, asked here in TypeScript). An event parked for longer than HOLD_TTL_DAYS is dropped.
import { sql, type Transaction } from 'kysely';
import type { Database } from '@crove/db';

type Db = Pick<Transaction<Database>, 'executeQuery'> & { getExecutor: Transaction<Database>['getExecutor'] };

/** How long a parked event waits before it is dropped: an alert or a reminder older than that is no use. */
export const HOLD_TTL_DAYS = 14;
/** How often the worker looks for parked events whose app is on again. */
export const HELD_SWEEP_MS = 10_000;
const RELEASE_BATCH = 500;
const PAIRS_PER_SWEEP = 200;

// The events that keep a duty while their app is off, or that must reach their consumer whatever the switch says: never parked (the keeping events of ADR-0053, and
// the takedown of a published post, which stops exposure: its consumer declares runsWhenOff in C3c).
export const NEVER_HELD_EVENTS: ReadonlySet<string> = new Set([
  'ads.pause.queued',
  'kernel.member.removed',
  'kernel.member.role_changed',
  'social.variant.remove_requested',
]);

// The kernel events whose consumer is an app's job: the extraction of an uploaded file is Finance's, so a file stored while Finance is off is read when it is back.
const KERNEL_EVENT_APPS: Readonly<Record<string, string>> = {
  'kernel.file.ingested': 'finance',
  'kernel.file.reextract_requested': 'finance',
};

// An app's own events carry its id as their prefix (the module that emits them). Meetings is not here: its events are bound to a time (a transcription or live notes
// of a meeting that is happening), so they are dropped when the app is off, not parked for later.
const HOLDING_PREFIXES: Readonly<Record<string, string>> = { 'finance.': 'finance', 'social.': 'social', 'crm.': 'crm', 'ads.': 'ads' };

/** The app whose events wait while it is off, for this event type, or null when the event is never parked. */
export function heldAppOf(type: string): string | null {
  if (NEVER_HELD_EVENTS.has(type)) return null;
  const kernel = KERNEL_EVENT_APPS[type];
  if (kernel) return kernel;
  for (const [prefix, app] of Object.entries(HOLDING_PREFIXES)) if (type.startsWith(prefix)) return app;
  return null;
}

export interface HeldRow {
  org_id: string;
  event_id: string;
  type: string;
}

/**
 * Which of the claimed rows to park: those of an app that this deployment runs and the org has off now (a fresh read per org and app, once for the whole batch). A read that
 * cannot answer counts as on: the event is queued, as before, never lost to a failed read.
 */
export async function planHolds<R extends HeldRow>(
  rows: readonly R[],
  appOn: (orgId: string, app: string) => Promise<boolean>,
  installed: (app: string) => boolean,
): Promise<{ held: Array<{ row: R; app: string }>; rest: R[] }> {
  const answers = new Map<string, Promise<boolean>>();
  const on = (orgId: string, app: string) => {
    const key = `${orgId}:${app}`;
    let answer = answers.get(key);
    if (!answer) answer = appOn(orgId, app).catch(() => true);
    answers.set(key, answer);
    return answer;
  };
  const held: Array<{ row: R; app: string }> = [];
  const rest: R[] = [];
  for (const row of rows) {
    const app = heldAppOf(row.type);
    if (app !== null && installed(app) && !(await on(row.org_id, app))) held.push({ row, app });
    else rest.push(row);
  }
  return { held, rest };
}

/** Parks the events, on the relay's own transaction: they leave the outbox with the claim and wait here, or none of it happens. */
export async function holdEvents(trx: Db, held: ReadonlyArray<{ row: HeldRow; app: string }>): Promise<number> {
  let parked = 0;
  for (let i = 0; i < held.length; i += 1000) {
    const batch = held.slice(i, i + 1000);
    const { rows } = await sql<{ n: number }>`
      SELECT crove_kernel.outbox_hold(${batch.map((h) => h.row.org_id)}::uuid[], ${batch.map((h) => h.row.event_id)}::uuid[], ${batch.map((h) => h.app)}::text[]) AS n`.execute(trx as never);
    parked += rows[0]?.n ?? 0;
  }
  return parked;
}

/**
 * The held sweep: for each org and app with parked events, puts them back on the outbox (oldest first, in batches) once the app is on; drops the ones older than the
 * expiry. Returns what it did. A pair whose app is still off is left as it is; a failed read of the app leaves it too (the next sweep asks again).
 */
export async function releaseHeld(
  db: Db,
  appOn: (orgId: string, app: string) => Promise<boolean>,
): Promise<{ released: number; expired: number }> {
  let released = 0;
  let expired = 0;
  const { rows: gone } = await sql<{ n: number }>`SELECT crove_kernel.outbox_hold_expire(${HOLD_TTL_DAYS}::int) AS n`.execute(db as never);
  expired += gone[0]?.n ?? 0;
  const { rows: pairs } = await sql<{ org_id: string; module: string }>`SELECT org_id, module FROM crove_kernel.outbox_hold_pairs(${PAIRS_PER_SWEEP}::int)`.execute(db as never);
  for (const pair of pairs) {
    let on = false;
    try {
      on = await appOn(pair.org_id, pair.module);
    } catch {
      continue;
    }
    if (!on) continue;
    for (;;) {
      const { rows } = await sql<{ released: number; expired: number }>`
        SELECT released, expired FROM crove_kernel.outbox_release(${pair.org_id}::uuid, ${pair.module}::text, ${RELEASE_BATCH}::int, ${HOLD_TTL_DAYS}::int)`.execute(db as never);
      released += rows[0]?.released ?? 0;
      expired += rows[0]?.expired ?? 0;
      if ((rows[0]?.released ?? 0) < RELEASE_BATCH) break;
    }
  }
  return { released, expired };
}
