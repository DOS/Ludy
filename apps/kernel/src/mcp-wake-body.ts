// SPDX-License-Identifier: AGPL-3.0-only
// The only builder of a wake-up's body (ADR-0051 decision 4, issue #3024): ids, an event type, instants, dates, a day count and decimal-string amounts, and
// nothing else. A body is checked against a strict schema, key by key and value by value, so a name, a note, a message or a bank account cannot ride in any
// field whatever it is called: an unknown key is refused, and every value must be an id, a date, a number or one of a few fixed words. The delivery sends what
// this function returns, the sweep stores what it checks, and the database holds the same shapes (crove_kernel.mcp_wake_body_ok). The invariant suite
// (test/invariant/mcp-wake.test.ts) feeds this function hostile input.
import { z } from 'zod';
import { DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SUPPLIER_BANK_CHANGED_READ } from '@crove/kernel';

// The rules the kernel runs: a new rule is a change here, in the database function and in the invariant test.
export const WAKE_RULES = [DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SUPPLIER_BANK_CHANGED_READ] as const;
export const WAKE_TYPES = ['signal.fired', 'schedule.due', 'ping'] as const;
export const WAKE_ITEMS_MAX = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const zId = z.string().regex(UUID);
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
// A decimal string with no leading zero, so an account number is no amount.
const zAmount = z.string().regex(/^-?(0|[1-9]\d{0,17})(\.\d{1,4})?$/);
// A rule's short name and the ids it is about: lower-case words, then one to three ids.
const zKey = z.string().regex(/^[a-z]+(_[a-z]+)*(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}$/);

const zItem = z.strictObject({
  rule: z.enum(WAKE_RULES),
  key: zKey,
  severity: z.enum(['info', 'warn', 'block']),
  party_id: zId.optional(),
  deal_id: zId.optional(),
  invoice_id: zId.optional(),
  amount: zAmount.optional(),
  due_on: zDate.optional(),
  days: z.number().int().min(0).max(3650).optional(),
});

const head = { id: zId, created_at: zInstant, org: zId, grant: zId };
const zEvent = z.discriminatedUnion('type', [
  z.strictObject({ ...head, type: z.literal('signal.fired'), data: z.strictObject({ items: z.array(zItem).min(1).max(WAKE_ITEMS_MAX) }) }),
  z.strictObject({ ...head, type: z.literal('schedule.due'), data: z.strictObject({ date: zDate }) }),
  z.strictObject({ ...head, type: z.literal('ping'), data: z.strictObject({}) }),
]);

export type WakeEvent = z.infer<typeof zEvent>;
export type WakeItem = z.infer<typeof zItem>;

// The event as a plain object, in the order the receiver reads it, or a throw naming the first thing that does not fit.
export function wakeEvent(input: unknown): WakeEvent {
  const parsed = zEvent.parse(input);
  return { id: parsed.id, type: parsed.type, created_at: parsed.created_at, org: parsed.org, grant: parsed.grant, data: parsed.data } as WakeEvent;
}

// The text the receiver gets, and the delivery signs.
export function wakeBody(input: unknown): string {
  return JSON.stringify(wakeEvent(input));
}
