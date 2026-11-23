// SPDX-License-Identifier: AGPL-3.0-only
// The sweep of the wake-up webhook (ADR-0051 decision 4, issue #3024), every minute in the worker. It reaches no URL: it reads and writes the database through commands
// of the system actor and hands deliveries to the queue (mcp-wake.ts sends them).
//   1. Deliveries the queue never got (the sweep stopped between storing one and handing it over) are handed over again three minutes on; one still waiting after eight
//      hours, longer than the retries last, is failed. So a delivery is stored once and sent at least once.
//   2. A schedule that is due sends `schedule.due` (the day, nothing else); the event and the move to its next time are one transaction (a gap sends once, not once per missed day,
//      and two passes never both send it).
//   3. A grant's signals are looked at every five minutes: the rules of the kernel are run as the grant itself (an MCP actor), so a rule's read the grant may not reach
//      answers nothing and the wake-up stays quiet (the signal reads declare `mcp` when their line has reviewed what leaves). A signal fires when its key first appears and again
//      only after it went away; up to 20 items go in one event, stored in one transaction with the keys it carries, so a failure fires it again and never loses it.
//      A key is forgotten only when its rule answered in full; a rule that failed or answered in part leaves its keys as they were.
//   4. The lines' own events (Engage's wake rules, #3862: mcp-wake-engage.ts). The feeds are read for a company grant that holds the line's scope, AS the grant, BEFORE the signals are looked at (the worker's entry
//      into a company grant's sealed context closes once the signals were checked: its `signals_checked_at`), and each item is sent only if its own "seen" key (an item and the day of its window) is new for
//      the grant; the key is noted in the transaction that stores the event, so two sweeps never both send it.
// A failure for one grant never stops the others, and a failure of the queue leaves the delivery stored, to be handed over again.
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import { DomainError, type Runtime, type UserActor } from '@ludy/kernel-runtime';
import { DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SUPPLIER_BANK_CHANGED_READ, kernelQueries } from '@ludy/kernel';
import type { TodayItem } from '@ludy/kernel-contract';
import type { McpWakeLinePlan } from '@ludy/kernel';
import { LINE_WAKE_EVENTS, WAKE_ITEMS_MAX, WAKE_RULES, wakeEvent, type LineWakeRegistry, type WakeItem } from './mcp-wake-body.ts';
import type { WakeJob } from './mcp-wake.ts';

export const MCP_WAKE_SWEEP_CRON = '* * * * *';
export const MCP_WAKE_SWEEP_EXPIRE_SECONDS = 120;
// Grants and deliveries one pass handles at most; the rest wait for the next minute.
const PER_PASS = 200;

const ACTOR = { type: 'system' as const, component: 'kernel.mcp.wake' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

export interface WakeGrant {
  orgId: string;
  grantId: string;
  userId: string;
}

// What a rule gives for a grant: the items it flags, as the grant itself may read them. A rule the grant may not read, or a grant that no longer stands, gives none.
export interface SignalAnswer {
  items: WakeItem[];
  // The short names (the part of a key before the first colon) of the rules that answered in full: no error, no grouped or unchecked placeholder, nothing cut.
  complete: string[];
}
export type SignalEvaluator = (grant: WakeGrant) => Promise<SignalAnswer>;

// A line's source of wake events (Engage's wake rules, #3862; ADR-0051 decision 13): the `data` of each event of ONE registered line type for one grant, built from ids, enum words, dates and amounts of the line's
// own rows, read as the grant itself (an MCP actor in its sealed read-only context, so the database's own policies decide which items it may read: slice b). The sweep stores an event only if its type is registered, the body
// fits the registered fields exactly and the grant holds the type's scope (the database refuses the rest, and the runtime writes no refusal row for it); up to 20 events of a source go out in one pass.
// The sources are offered to every due grant that gets signals (a company grant), and the database says which are not for it, so a source reads once more for a grant without the scope (a read in that grant's own
// sealed read-only context, nothing stored, no refusal row); a line's source should check the grant's scopes first when it can. NO deduplication yet: an event stored for a line type carries no signal keys, so a rule that still holds would wake the receiver again on the next look. A line's source (Engage E3, #3862) must bring its own
// "seen" rule (a key table like the signals', or a source that returns an event only when the condition first appears) before it ships.
export interface LineWakeSource {
  type: string;
  events: (grant: WakeGrant) => Promise<Array<Record<string, string>>>;
}

// One event a line's feed wants sent: the registered type, its data (ids, days, amounts, enum words) and the item's own key (`<type>:<id>:<day of the window>`, see mcp-wake-engage.ts wakeKey), which is what makes it fire once per
// item per window.
export interface LineWakeItem {
  type: string;
  data: Record<string, string>;
  key: string;
}
// A line's feed (#3862): all its rules in one pass over one grant. `read` runs AS THE GRANT, in its sealed context (the plan says what the grant is and holds), before the signals are looked at; it returns the items that
// hold now, newest first within each type. The sweep sends only the registered types the grant's scopes allow, and only the keys that are new.
export interface LineWakeFeed {
  types: readonly string[];
  read: (grant: WakeGrant, plan: McpWakeLinePlan) => Promise<LineWakeItem[]>;
}
// The most keys one check takes (the database's own limit), the most checks a pass makes for a grant, and the most events of one type it sends (WAKE_ITEMS_MAX, as a signal's event holds); the rest wait for the next look.
const FEED_KEYS_MAX = 200;
const FEED_CHECKS_MAX = 8;
const FEED_PER_TYPE = WAKE_ITEMS_MAX;

export interface WakeSweepDeps {
  runtime: Runtime;
  workerDb: Db;
  // Hands one delivery to the kernel-mcp-wake queue (a singleton job per delivery).
  send: (job: WakeJob) => Promise<unknown>;
  evaluate?: SignalEvaluator;
  // The lines' sources of events; none until a line ships one.
  lines?: readonly LineWakeSource[];
  // The lines' feeds with their own "seen" rules (Engage's wake rules, #3862); none by default.
  feeds?: readonly LineWakeFeed[];
  // The registry the sources' types are checked against and bodies built with (the lines' own, by default; a test gives its own).
  lineRegistry?: LineWakeRegistry;
  now?: () => Date;
  newId?: () => string;
}

const SHORT: Record<(typeof WAKE_RULES)[number], { prefix: string; entity: 'deal_id' | 'party_id' }> = {
  [DEAL_WITHOUT_INVOICE_READ]: { prefix: 'won-deal-no-invoice', entity: 'deal_id' },
  [RECEIVABLE_WITH_OPEN_DEAL_READ]: { prefix: 'overdue-receivable-open-deal', entity: 'party_id' },
  [SUPPLIER_BANK_CHANGED_READ]: { prefix: 'supplier-bank-changed', entity: 'party_id' },
};
const KEY_NAME: Record<(typeof WAKE_RULES)[number], string> = {
  [DEAL_WITHOUT_INVOICE_READ]: 'deal_without_invoice',
  [RECEIVABLE_WITH_OPEN_DEAL_READ]: 'receivable_with_open_deal',
  [SUPPLIER_BANK_CHANGED_READ]: 'supplier_bank_changed',
};
const AMOUNT = /^-?(0|[1-9]\d{0,17})(\.\d{1,4})?$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// A Home item of a rule as a wake-up item: ids, the severity, the amount and the day it falls due, and the day count. The grouped items ("and N more", "not checked") name no
// record and are left out: the receiver reads the current state through the endpoint. Nothing a person typed is in a Home item, and nothing but these fields is copied.
export function wakeItemOf(rule: (typeof WAKE_RULES)[number], item: TodayItem): WakeItem | null {
  const short = SHORT[rule];
  const m = item.id.match(new RegExp(`^signal:${short.prefix}:(${UUID})$`));
  if (!m) return null;
  const id = m[1] as string;
  const out: WakeItem = { rule, key: `${KEY_NAME[rule]}:${id}`, severity: item.severity ?? 'warn', [short.entity]: id };
  if (item.amount !== undefined && AMOUNT.test(item.amount)) {
    out.amount = item.amount;
    // A Home item without a currency is in VND; the receiver is told so, as a bare number would read as the wrong unit.
    out.currency = item.currency ?? 'VND';
  }
  if (item.dueAt !== undefined) {
    const at = Date.parse(item.dueAt);
    // The day in Vietnam time (UTC+7, no daylight saving).
    if (Number.isFinite(at)) out.due_on = new Date(at + 7 * 3_600_000).toISOString().slice(0, 10);
  }
  const days = item.title.params?.days;
  if (typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= 3650) out.days = days;
  return out;
}

// Whether the worker can enter an MCP grant's own sealed context (ADR-0051, #2975, step S5): the worker's runtime enters a company grant's context through its own entry
// (`enter_mcp_wake_company_context`, the worker login's alone), so the signal wake-ups run. A member-bound grant is never entered from the sweep: mcp_wake_due asks no signals for it (signals_due is false) and the worker's entry refuses any grant that is not a company grant.
export const SIGNAL_WAKE_WORKER_ENTRY = true;

// The rules of the kernel the sweep asks: those whose query declares `mcp`, once the worker can enter the grant's context. A rule that does not declare it is never asked, which keeps a
// refusal from being written against the owner.
export function declaredRules(queries: readonly { name: string; mcp?: unknown }[], workerEntry: boolean = SIGNAL_WAKE_WORKER_ENTRY): (typeof WAKE_RULES)[number][] {
  if (!workerEntry) return [];
  return WAKE_RULES.filter((rule) => queries.some((q) => q.name === rule && q.mcp !== undefined));
}

// The grouped or unchecked items of a rule ("and N more", "not checked", "partial"): the rule did not answer in full.
const PLACEHOLDER = /^signal:[a-z-]+:(more|partial|unchecked)$/;

// The default evaluator: each declared rule run as the grant (an MCP actor, in the request's own transaction), a rule at a time. A rule that fails is left out of `complete`.
export function runtimeEvaluator(runtime: Runtime, rules: readonly (typeof WAKE_RULES)[number][]): SignalEvaluator {
  return async (grant) => {
    const actor: UserActor = { type: 'user', userId: grant.userId, aal: 'aal1', mcp: { grantId: grant.grantId, clientId: 'wake-up', clientName: 'Wake-up', scopes: ['ludy.read'] } };
    const items: WakeItem[] = [];
    const complete: string[] = [];
    for (const rule of rules) {
      try {
        const found = await runtime.query<TodayItem[]>(rule, {}, { actor, orgId: grant.orgId });
        let whole = true;
        for (const item of found) {
          if (PLACEHOLDER.test(item.id)) whole = false;
          const mapped = wakeItemOf(rule, item);
          if (mapped) items.push(mapped);
        }
        if (whole) complete.push(KEY_NAME[rule]);
      } catch (error) {
        // The grant is no longer valid, or the rule failed: its keys stay as they were. A fault is worth a line.
        if (!(error instanceof DomainError) || error.status >= 500 || error.status === 403) console.warn(`[mcp-wake-sweep] rule ${rule} for ${grant.grantId.slice(0, 8)}`, codeOf(error));
      }
    }
    return { items, complete };
  };
}

// One pass. Returns what it did, for the log and the tests.
export async function runWakeSweep(deps: WakeSweepDeps): Promise<{ handedOver: number; expired: number; schedules: number; signals: number; lines: number; failures: number }> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const evaluate = deps.evaluate ?? runtimeEvaluator(deps.runtime, declaredRules(kernelQueries({ inboundDomain: null }) as readonly { name: string; mcp?: unknown }[]));
  const done = { handedOver: 0, expired: 0, schedules: 0, signals: 0, lines: 0, failures: 0 };

  // Stores one event for a grant (with the keys it carries, or moving a due schedule on, in the same transaction) and hands it over; a replay of the id, or a schedule
  // another pass already took, stores nothing.
  const post = async (grant: WakeGrant, type: string, data: unknown, keys?: string[]): Promise<boolean> => {
    const id = newId();
    const body = wakeEvent({ id, type, created_at: now().toISOString(), org: grant.orgId, grant: grant.grantId, data }, deps.lineRegistry ?? LINE_WAKE_EVENTS);
    const stored = await deps.runtime.execute<{ stored: boolean }>('kernel.mcp.wake.enqueue', { id, grantId: grant.grantId, type, body, ...(keys ? { keys } : {}) }, { actor: ACTOR, orgId: grant.orgId });
    if (stored.stored) await deps.send({ orgId: grant.orgId, id }).catch((error: unknown) => console.warn(`[mcp-wake-sweep] ${id.slice(0, 8)} not handed over, will be again`, codeOf(error)));
    return stored.stored;
  };

  const registry = deps.lineRegistry ?? LINE_WAKE_EVENTS;
  // What the feeds say for a grant: nothing for a member-bound grant (it reads only what its member may, and has no line events), or one without the read scope. A feed that fails costs its own items, not the signals.
  const readFeeds = async (grant: WakeGrant): Promise<LineWakeItem[]> => {
    if (!deps.feeds || deps.feeds.length === 0) return [];
    let plan: McpWakeLinePlan;
    try {
      plan = await deps.runtime.query<McpWakeLinePlan>('kernel.mcp.wake.line_plan', { grantId: grant.grantId }, { actor: ACTOR, orgId: grant.orgId });
    } catch (error) {
      console.warn(`[mcp-wake-sweep] plan for ${grant.grantId.slice(0, 8)}`, codeOf(error));
      return [];
    }
    if (plan.kind !== 'company' || !plan.scopes.includes('ludy.read')) return [];
    const out: LineWakeItem[] = [];
    for (const feed of deps.feeds) {
      // A feed is read only if the grant holds the scope of one of its types.
      if (!feed.types.some((t) => Object.hasOwn(registry, t) && plan.scopes.includes((registry[t] as { scope: string }).scope))) continue;
      try {
        for (const it of await feed.read(grant, plan)) {
          // Defense in depth: only a registered type, only a scope the grant holds, only the type the feed declares.
          const entry = Object.hasOwn(registry, it.type) ? registry[it.type] : undefined;
          if (entry && feed.types.includes(it.type) && plan.scopes.includes(entry.scope)) out.push(it);
        }
      } catch (error) {
        console.warn(`[mcp-wake-sweep] feed for ${grant.grantId.slice(0, 8)}`, codeOf(error));
      }
    }
    return out;
  };
  // The keys of a batch that are new for the grant, in ONE check. A key the database refuses (not reachable today: the keys are made of ids and days) refuses the whole check, so the batch is then checked a type at a
  // time and only the type that holds the bad key is left out; it is logged by its type and the error's code, never by a key or a value.
  const freshKeys = async (grant: WakeGrant, batch: readonly LineWakeItem[]): Promise<Set<string>> => {
    const ctx = { actor: ACTOR, orgId: grant.orgId };
    const check = async (items: readonly LineWakeItem[]) => (await deps.runtime.execute<{ fresh: string[] }>('kernel.mcp.wake.line_check', { grantId: grant.grantId, keys: items.map((it) => it.key) }, ctx)).fresh;
    try {
      return new Set(await check(batch));
    } catch (error) {
      console.warn(`[mcp-wake-sweep] line check for ${grant.grantId.slice(0, 8)} refused, checking a type at a time`, codeOf(error));
    }
    const out = new Set<string>();
    for (const type of new Set(batch.map((it) => it.type))) {
      try {
        for (const key of await check(batch.filter((it) => it.type === type))) out.add(key);
      } catch (error) {
        done.failures += 1;
        console.warn(`[mcp-wake-sweep] line check of ${type} for ${grant.grantId.slice(0, 8)}`, codeOf(error));
      }
    }
    return out;
  };
  // The items that are new for the grant become events, each with its one key (stored with it). The candidates are taken in the reads' own urgency order (newest wait first, the window closing soonest first), the types
  // dealt round-robin so one type cannot fill the batch, and checked for newness in ONE `line_check` per grant of up to FEED_KEYS_MAX keys (a command writes an audit row, so one a pass, not one a type). The new ones are
  // sent in that same order, at most FEED_PER_TYPE (WAKE_ITEMS_MAX) of a type; only when a type still has room and candidates are left is the next batch checked (at most FEED_CHECKS_MAX in a pass, which covers the up to 500
  // rows the feed reads for each of eight types). So a type whose newest items were all sent already never hides an older one that is new, and the rest go in the next pass.
  const sendFeedItems = async (grant: WakeGrant, items: readonly LineWakeItem[]): Promise<number> => {
    if (items.length === 0) return 0;
    const lanes = new Map<string, LineWakeItem[]>();
    const keys = new Set<string>();
    for (const it of items) {
      if (keys.has(it.key)) continue;
      keys.add(it.key);
      const lane = lanes.get(it.type) ?? [];
      lane.push(it);
      lanes.set(it.type, lane);
    }
    const ordered: LineWakeItem[] = [];
    for (let row = 0; ordered.length < keys.size; row += 1) for (const lane of lanes.values()) if (row < lane.length) ordered.push(lane[row] as LineWakeItem);
    const sentOf = new Map<string, number>();
    let sent = 0;
    for (let at = 0, checks = 0; at < ordered.length && checks < FEED_CHECKS_MAX; at += FEED_KEYS_MAX, checks += 1) {
      if (!ordered.slice(at).some((it) => (sentOf.get(it.type) ?? 0) < FEED_PER_TYPE)) break;
      const batch = ordered.slice(at, at + FEED_KEYS_MAX);
      const isNew = await freshKeys(grant, batch);
      for (const it of batch) {
        if (!isNew.has(it.key) || (sentOf.get(it.type) ?? 0) >= FEED_PER_TYPE) continue;
        sentOf.set(it.type, (sentOf.get(it.type) ?? 0) + 1);
        try {
          if (await post(grant, it.type, it.data, [it.key])) sent += 1;
        } catch (error) {
          // The grant does not hold the type's scope (the database says so), or the data does not fit: this item is left, the rest still go.
          done.failures += 1;
          console.warn(`[mcp-wake-sweep] ${it.type} for ${grant.grantId.slice(0, 8)}`, codeOf(error));
        }
      }
    }
    return sent;
  };

  // 1. Deliveries that need the queue again, or have waited too long.
  const open = await sql<{ org_id: string; id: string; kind: 'send' | 'expire' }>`SELECT org_id, id, kind FROM ludy_kernel.mcp_wake_open(${PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of open.rows) {
    const ctx = { actor: ACTOR, orgId: row.org_id };
    try {
      if (row.kind === 'expire') {
        await deps.runtime.execute('kernel.mcp.wake.record', { id: row.id, outcome: 'expired' }, ctx);
        done.expired += 1;
      } else {
        await deps.send({ orgId: row.org_id, id: row.id });
        await deps.runtime.execute('kernel.mcp.wake.queued', { id: row.id }, ctx);
        done.handedOver += 1;
      }
    } catch (error) {
      done.failures += 1;
      console.warn(`[mcp-wake-sweep] delivery ${row.id.slice(0, 8)}`, codeOf(error));
    }
  }

  // 2 and 3. The wake-ups with a schedule due or signals to look at.
  const due = await sql<{ org_id: string; grant_id: string; user_id: string; schedule_due: boolean; due_day: string | null; signals_due: boolean }>`
    SELECT org_id, grant_id, user_id, schedule_due, due_day, signals_due FROM ludy_kernel.mcp_wake_due(${PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of due.rows) {
    const grant: WakeGrant = { orgId: row.org_id, grantId: row.grant_id, userId: row.user_id };
    const ctx = { actor: ACTOR, orgId: grant.orgId };
    try {
      if (row.schedule_due && row.due_day && (await post(grant, 'schedule.due', { date: row.due_day }))) done.schedules += 1;
      if (row.signals_due) {
        const { items, complete } = await evaluate(grant);
        // The feeds read now, as the grant, while its sealed context can still be entered (signals_check below moves `signals_checked_at`).
        const feedItems = await readFeeds(grant);
        const unique = [...new Map(items.map((i) => [i.key, i])).values()].slice(0, 200);
        const { fresh } = await deps.runtime.execute<{ fresh: string[] }>('kernel.mcp.wake.signals_check', { grantId: grant.grantId, keys: unique.map((i) => i.key), complete }, ctx);
        const news = unique.filter((i) => fresh.includes(i.key));
        for (let at = 0; at < news.length; at += WAKE_ITEMS_MAX) {
          const chunk = news.slice(at, at + WAKE_ITEMS_MAX);
          if (await post(grant, 'signal.fired', { items: chunk }, chunk.map((i) => i.key))) done.signals += 1;
        }
        done.lines += await sendFeedItems(grant, feedItems);
        // The lines' own events (inside the signal look, so never for a member-bound grant, which has none, and every five minutes at most): a source of a type the registry does not list is never asked, and a grant that does not hold the type's scope is refused by the database (MCP_WAKE_SCOPE) and left alone.
        for (const source of deps.lines ?? []) {
          if (!Object.hasOwn(deps.lineRegistry ?? LINE_WAKE_EVENTS, source.type)) continue;
          try {
            for (const data of (await source.events(grant)).slice(0, WAKE_ITEMS_MAX)) await post(grant, source.type, data);
          } catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'MCP_WAKE_SCOPE') throw error;
          }
        }
      }
    } catch (error) {
      done.failures += 1;
      console.warn(`[mcp-wake-sweep] grant ${grant.grantId.slice(0, 8)}`, codeOf(error));
    }
  }
  return done;
}
