// SPDX-License-Identifier: AGPL-3.0-only
// The sweep of the wake-up webhook (ADR-0051 decision 4, issue #3024), every minute in the worker. It reaches no URL: it reads and writes the database through commands
// of the system actor and hands deliveries to the queue (mcp-wake.ts sends them).
//   1. Deliveries the queue never got (the sweep stopped between storing one and handing it over) are handed over again three minutes on; one still waiting after eight
//      hours, longer than the retries last, is failed. So a delivery is stored once and sent at least once.
//   2. A schedule that is due sends `schedule.due` (the day, nothing else) and moves to its next time; a gap sends once, not once per missed day.
//   3. A grant's signals are looked at every five minutes: the rules of the kernel are run as the grant itself (an MCP actor), so a rule's read the grant may not reach
//      answers nothing and the wake-up stays quiet (the signal reads declare `mcp` when their line has reviewed what leaves). A signal fires when its key first appears and again
//      only after it went away; up to 20 items go in one event.
// A failure for one grant never stops the others, and a failure of the queue leaves the delivery stored, to be handed over again.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SUPPLIER_BANK_CHANGED_READ } from '@crove/kernel';
import type { TodayItem } from '@crove/kernel-contract';
import { WAKE_ITEMS_MAX, WAKE_RULES, wakeEvent, type WakeItem } from './mcp-wake-body.ts';
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
export type SignalEvaluator = (grant: WakeGrant) => Promise<WakeItem[]>;

export interface WakeSweepDeps {
  runtime: Runtime;
  workerDb: Db;
  // Hands one delivery to the kernel-mcp-wake queue (a singleton job per delivery).
  send: (job: WakeJob) => Promise<unknown>;
  evaluate?: SignalEvaluator;
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
  if (item.amount !== undefined && AMOUNT.test(item.amount)) out.amount = item.amount;
  if (item.dueAt !== undefined) {
    const at = Date.parse(item.dueAt);
    // The day in Vietnam time (UTC+7, no daylight saving).
    if (Number.isFinite(at)) out.due_on = new Date(at + 7 * 3_600_000).toISOString().slice(0, 10);
  }
  const days = item.title.params?.days;
  if (typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= 3650) out.days = days;
  return out;
}

// The default evaluator: each rule of the kernel run as the grant. A rule that does not declare `mcp` is refused by the runtime (rule mcp_scope) and answers nothing.
export function runtimeEvaluator(runtime: Runtime): SignalEvaluator {
  return async (grant) => {
    const actor: UserActor = { type: 'user', userId: grant.userId, aal: 'aal1', mcp: { grantId: grant.grantId, clientId: 'wake-up', clientName: 'Wake-up', scopes: ['ludy.read'] } };
    const items: WakeItem[] = [];
    for (const rule of WAKE_RULES) {
      try {
        const found = await runtime.query<TodayItem[]>(rule, {}, { actor, orgId: grant.orgId });
        for (const item of found) {
          const mapped = wakeItemOf(rule, item);
          if (mapped) items.push(mapped);
        }
      } catch (error) {
        // Refused (not declared for a grant) or the grant is no longer valid: quiet. Anything else is a fault worth a line.
        if (!(error instanceof DomainError) || (error.status >= 500)) console.warn(`[mcp-wake-sweep] rule ${rule} for ${grant.grantId.slice(0, 8)}`, codeOf(error));
      }
    }
    return items;
  };
}

// One pass. Returns what it did, for the log and the tests.
export async function runWakeSweep(deps: WakeSweepDeps): Promise<{ handedOver: number; expired: number; schedules: number; signals: number; failures: number }> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const evaluate = deps.evaluate ?? runtimeEvaluator(deps.runtime);
  const done = { handedOver: 0, expired: 0, schedules: 0, signals: 0, failures: 0 };

  // Stores one event for a grant and hands it over; a replay of the id stores nothing.
  const post = async (grant: WakeGrant, type: 'signal.fired' | 'schedule.due', data: unknown): Promise<void> => {
    const id = newId();
    const body = wakeEvent({ id, type, created_at: now().toISOString(), org: grant.orgId, grant: grant.grantId, data });
    const stored = await deps.runtime.execute<{ stored: boolean }>('kernel.mcp.wake.enqueue', { id, grantId: grant.grantId, type, body }, { actor: ACTOR, orgId: grant.orgId });
    if (stored.stored) await deps.send({ orgId: grant.orgId, id }).catch((error: unknown) => console.warn(`[mcp-wake-sweep] ${id.slice(0, 8)} not handed over, will be again`, codeOf(error)));
  };

  // 1. Deliveries that need the queue again, or have waited too long.
  const open = await sql<{ org_id: string; id: string; kind: 'send' | 'expire' }>`SELECT org_id, id, kind FROM crove_kernel.mcp_wake_open(${PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of open.rows) {
    const ctx = { actor: ACTOR, orgId: row.org_id };
    try {
      if (row.kind === 'expire') {
        await deps.runtime.execute('kernel.mcp.wake.record', { id: row.id, outcome: 'failed' }, ctx);
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
  const due = await sql<{ org_id: string; grant_id: string; user_id: string; schedule_due: boolean; signals_due: boolean }>`
    SELECT org_id, grant_id, user_id, schedule_due, signals_due FROM crove_kernel.mcp_wake_due(${PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of due.rows) {
    const grant: WakeGrant = { orgId: row.org_id, grantId: row.grant_id, userId: row.user_id };
    const ctx = { actor: ACTOR, orgId: grant.orgId };
    try {
      if (row.schedule_due) {
        const { day } = await deps.runtime.execute<{ day: string | null }>('kernel.mcp.wake.schedule_advance', { grantId: grant.grantId }, ctx);
        if (day) {
          await post(grant, 'schedule.due', { date: day });
          done.schedules += 1;
        }
      }
      if (row.signals_due) {
        const items = await evaluate(grant);
        const unique = [...new Map(items.map((i) => [i.key, i])).values()];
        const { fresh } = await deps.runtime.execute<{ fresh: string[] }>('kernel.mcp.wake.signals_sync', { grantId: grant.grantId, keys: unique.map((i) => i.key).slice(0, 200) }, ctx);
        const news = unique.filter((i) => fresh.includes(i.key));
        for (let at = 0; at < news.length; at += WAKE_ITEMS_MAX) {
          await post(grant, 'signal.fired', { items: news.slice(at, at + WAKE_ITEMS_MAX) });
          done.signals += 1;
        }
      }
    } catch (error) {
      done.failures += 1;
      console.warn(`[mcp-wake-sweep] grant ${grant.grantId.slice(0, 8)}`, codeOf(error));
    }
  }
  return done;
}
