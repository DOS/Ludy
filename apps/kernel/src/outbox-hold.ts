// SPDX-License-Identifier: AGPL-3.0-only
// The events of an app that is off wait, and flow when it is back on (ADR-0053 section 4, slice c C3b). The relay claims an event and queues its jobs in one
// transaction; for an org whose app is off those jobs would be refused and ended quietly, and the event lost. So the relay parks such an event
// (crove_kernel.outbox_hold) instead of queueing anything, and the held sweep puts the parked events back on the outbox, oldest first, once the app is on again
// (the choice and the entitlement, asked here in TypeScript). There is no expiry: an event that nothing finds again is held, not dropped (ADR-0053 section 4).
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '@crove/db';

type Db = Transaction<Database> | Kysely<Database>;

/** How often the worker looks for parked events whose app is on again. */
export const HELD_SWEEP_MS = 10_000;
const RELEASE_BATCH = 500;
const PAIRS_PER_PAGE = 200;
// A sweep looks at no more pairs than this, so one pass stays short; the next pass starts from the first page again.
const MAX_PAIR_PAGES = 25;

// The events that keep a duty while their app is off, or that must reach their consumer whatever the switch says: never parked (the keeping events of ADR-0053, and
// the takedown of a published post, which stops exposure: its consumer declares runsWhenOff in C3c).
export const NEVER_HELD_EVENTS: ReadonlySet<string> = new Set([
  'ads.pause.queued',
  'kernel.member.removed',
  'kernel.member.role_changed',
  'social.variant.remove_requested',
]);

// The events that act in public at the time they are handled, which a person asked for then: a retry of a comment or a thread, an edit of a published post. Run days later
// they would post or change something nobody expects any more, so they are dropped when the app is off (ADR-0053: time-sensitive work never runs late on its own), not parked.
const TIME_BOUND_EVENTS: ReadonlySet<string> = new Set(['social.comment.retry_requested', 'social.thread.retry_requested', 'social.variant.edit_requested']);

// The events of an app that finds its own pending work again when it is switched on: Sign's inspection and sealing are queued by its own sweep on `kernel.org.apps_changed`
// (the worker's relay step for that event), so its events are not parked.
export const SELF_RECOVERING_EVENTS: ReadonlySet<string> = new Set(['sign.envelope.inspect_queued', 'sign.envelope.seal_queued']);

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
  if (NEVER_HELD_EVENTS.has(type) || TIME_BOUND_EVENTS.has(type) || SELF_RECOVERING_EVENTS.has(type)) return null;
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
  // Each distinct org and app is read once, all at the same time: a slow read of the billing port delays the batch by one timeout, not by one for every org.
  const pairs = new Map<string, { org: string; app: string }>();
  for (const row of rows) {
    const app = heldAppOf(row.type);
    if (app !== null && installed(app)) pairs.set(`${row.org_id}:${app}`, { org: row.org_id, app });
  }
  const answers = new Map(await Promise.all([...pairs].map(async ([key, p]) => [key, await Promise.resolve().then(() => appOn(p.org, p.app)).catch(() => true)] as const)));
  const held: Array<{ row: R; app: string }> = [];
  const rest: R[] = [];
  for (const row of rows) {
    const app = heldAppOf(row.type);
    if (app !== null && installed(app) && answers.get(`${row.org_id}:${app}`) === false) held.push({ row, app });
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
      SELECT crove_kernel.outbox_hold(${batch.map((h) => h.row.org_id)}::uuid[], ${batch.map((h) => h.row.event_id)}::uuid[], ${batch.map((h) => h.app)}::text[]) AS n`.execute(trx);
    parked += rows[0]?.n ?? 0;
  }
  return parked;
}

/**
 * The held sweep: for each org and app with parked events (active orgs, in key order, a bounded number of pages), puts them back on the outbox once the app is on, oldest
 * first in batches. Returns what it did and how many events wait in all (of the pairs it looked at). A pair whose app is still off is left as it is; a failed read of the
 * app leaves it too (the next sweep asks again).
 */
export async function releaseHeld(
  db: Db,
  appOn: (orgId: string, app: string) => Promise<boolean>,
): Promise<{ released: number; waiting: number; pairs: number }> {
  let released = 0;
  let waiting = 0;
  let seen = 0;
  let after = null as { org: string; module: string } | null;
  for (let page = 0; page < MAX_PAIR_PAGES; page++) {
    const { rows: pairs } = await sql<{ org_id: string; module: string; waiting: string }>`
      SELECT org_id, module, waiting FROM crove_kernel.outbox_hold_pairs(${PAIRS_PER_PAGE}::int, ${after?.org ?? null}::uuid, ${after?.module ?? null}::text)`.execute(db);
    for (const pair of pairs) {
      seen += 1;
      let on = false;
      try {
        on = await appOn(pair.org_id, pair.module);
      } catch {
        waiting += Number(pair.waiting);
        continue;
      }
      if (!on) {
        waiting += Number(pair.waiting);
        continue;
      }
      for (;;) {
        const { rows } = await sql<{ n: number }>`SELECT crove_kernel.outbox_release(${pair.org_id}::uuid, ${pair.module}::text, ${RELEASE_BATCH}::int) AS n`.execute(db);
        const n = rows[0]?.n ?? 0;
        released += n;
        if (n < RELEASE_BATCH) break;
      }
    }
    const last = pairs.at(-1);
    if (!last || pairs.length < PAIRS_PER_PAGE) break;
    after = { org: last.org_id, module: last.module };
  }
  return { released, waiting, pairs: seen };
}
