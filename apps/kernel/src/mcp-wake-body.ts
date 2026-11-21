// SPDX-License-Identifier: AGPL-3.0-only
// The only builder of a wake-up's body (ADR-0051 decision 4, issue #3024): ids, an event type, instants, dates, a day count and decimal-string amounts, and
// nothing else. A body is checked against a strict schema, key by key and value by value, so a name, a note, a message or a bank account cannot ride in any
// field whatever it is called: an unknown key is refused, and every value must be an id, a date, a number or one of a few fixed words. The delivery sends what
// this function returns, the sweep stores what it checks, and the database holds the same shapes (crove_kernel.mcp_wake_body_ok). The invariant suite
// (test/invariant/mcp-wake.test.ts) feeds this function hostile input.
import { z } from 'zod';
import { DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SUPPLIER_BANK_CHANGED_READ } from '@ludy/kernel';

// The rules the kernel runs: a new rule is a change here, in the database function and in the invariant test.
export const WAKE_RULES = [DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SUPPLIER_BANK_CHANGED_READ] as const;
export const WAKE_ITEMS_MAX = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const zId = z.string().regex(UUID);
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
// A decimal string with no leading zero, so an account number is no amount.
const zAmount = z.string().regex(/^-?(0|[1-9]\d{0,17})(\.\d{1,4})?$/);
// A rule's short name and the ids it is about: lower-case words, then one to three ids.
const zKey = z.string().regex(/^[a-z]+(_[a-z]+)*(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}$/);

const zItemBase = z.strictObject({
  rule: z.enum(WAKE_RULES),
  key: zKey,
  severity: z.enum(['info', 'warn', 'block']),
  party_id: zId.optional(),
  deal_id: zId.optional(),
  invoice_id: zId.optional(),
  amount: zAmount.optional(),
  // The unit of the amount (ISO 4217), present only with one; Home leaves VND out, so a missing currency in a Home item is VND and is sent as such.
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  due_on: zDate.optional(),
  days: z.number().int().min(0).max(3650).optional(),
});
const zItem = zItemBase.refine((item) => item.currency === undefined || item.amount !== undefined, { message: 'a currency needs an amount' });

const head = { id: zId, created_at: zInstant, org: zId, grant: zId };
const zEvent = z.discriminatedUnion('type', [
  z.strictObject({ ...head, type: z.literal('signal.fired'), data: z.strictObject({ items: z.array(zItem).min(1).max(WAKE_ITEMS_MAX) }) }),
  z.strictObject({ ...head, type: z.literal('schedule.due'), data: z.strictObject({ date: zDate }) }),
  z.strictObject({ ...head, type: z.literal('ping'), data: z.strictObject({}) }),
]);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Line events (#3858 slice e, ADR-0051 decision 13): a line (Engage, Ads, Social) registers an event type for the wake-up of a grant that holds one of its write scopes: a name in the line's own namespace
// (`engage.conversation_unanswered`) and the fields of its `data`, each an id, a date, an amount or one of a fixed list of words, every field present and no other key. Nothing else can ride in it: no name, note,
// message or free text, whatever a field is called. The registry is code the line ships (a test pins it equal to the database's crove_kernel.mcp_wake_event_type, which holds the same list and the scope), a grant
// cannot register a type, and a body with an unregistered type or an unlisted field is not built, so it is not stored (the delivery table's CHECK) and not sent. Engage's, Social's and Ads' wake rules register theirs below (#3862).
// ---------------------------------------------------------------------------------------------------------------------------------------------
// An `amount` field is a bare decimal string with no unit: a line that needs one registers an enum field for it (a currency code as a word, for example `vnd`, `usd`).
export type LineFieldKind = 'id' | 'date' | 'amount' | readonly string[];
export const LINE_WAKE_SCOPES = ['ludy.social.draft', 'ludy.engage.write', 'ludy.ads.draft'] as const;
export interface LineWakeEventType {
  // The write scope a grant must hold to be woken by this type (its line's: `ludy.engage.write` is `engage`).
  scope: (typeof LINE_WAKE_SCOPES)[number];
  fields: Readonly<Record<string, LineFieldKind>>;
}
export type LineWakeRegistry = Readonly<Record<string, LineWakeEventType>>;
// The currencies of an amount (an ad's, a deal's), as words (an `amount` field has no unit of its own, N5 of the #4025 review: a line that needs one registers an enum field for it); any other currency is `other`.
export const WAKE_CURRENCIES = ['vnd', 'usd', 'eur', 'gbp', 'jpy', 'krw', 'cny', 'thb', 'sgd', 'myr', 'idr', 'php', 'aud', 'twd', 'other'] as const;
const ENGAGE = 'ludy.engage.write' as const;
const SOCIAL = 'ludy.social.draft' as const;
const ADS = 'ludy.ads.draft' as const;
// Engage's wake rules (#3862, E3 of epic #3857): what each event carries is ids, days, amounts and enum words (the migration 20270122200000 registers the same list in the catalog, and a test keeps the two equal).
// The rules, their windows and the "seen" key of each are in mcp-wake-engage.ts.
export const LINE_WAKE_EVENTS: LineWakeRegistry = Object.freeze({
  'engage.conversation_new': { scope: ENGAGE, fields: { conversation_id: 'id', kind: ['direct', 'email'], since: 'date' } },
  'engage.conversation_unanswered': { scope: ENGAGE, fields: { conversation_id: 'id', kind: ['direct', 'email'], since: 'date' } },
  'engage.reply_window_closing': { scope: ENGAGE, fields: { conversation_id: 'id', closes_on: 'date' } },
  'engage.quote_unanswered': { scope: ENGAGE, fields: { deal_id: 'id', next_step_id: 'id', since: 'date', deal_amount: 'amount', currency: WAKE_CURRENCIES } },
  'engage.booking_tomorrow': { scope: ENGAGE, fields: { booking_id: 'id', on: 'date' } },
  'social.post_comment_new': { scope: SOCIAL, fields: { conversation_id: 'id', since: 'date' } },
  'ads.pace_over': { scope: ADS, fields: { subject_id: 'id', scope: ['org', 'account'], month: 'date', projected: 'amount', cap: 'amount', currency: WAKE_CURRENCIES } },
  'ads.daily_cap_over': { scope: ADS, fields: { subject_id: 'id', scope: ['org', 'account'], day: 'date', spend: 'amount', cap: 'amount', currency: WAKE_CURRENCIES } },
  'ads.monthly_cap_over': { scope: ADS, fields: { subject_id: 'id', scope: ['org', 'account'], day: 'date', spend: 'amount', cap: 'amount', currency: WAKE_CURRENCIES } },
});

const LINE_TYPE = /^[a-z]+(\.[a-z_]+){1,3}$/;
const FIELD_NAME = /^[a-z][a-z_]{0,30}$/;
const FIXED_TYPES: readonly string[] = ['signal.fired', 'schedule.due', 'ping'];

// Whether a registry entry is well formed: the type in the namespace of the scope's line and not a fixed type, one to twelve fields, each of a known kind.
export function lineTypeProblem(type: string, entry: LineWakeEventType): string | null {
  if (!LINE_TYPE.test(type) || FIXED_TYPES.includes(type)) return 'the type is not a line type';
  if (type.split('.')[0] !== entry.scope.split('.')[1]) return 'the type is not in the namespace of its scope';
  const names = Object.keys(entry.fields);
  if (names.length < 1 || names.length > 12) return 'a type has one to twelve fields';
  for (const name of names) {
    if (!FIELD_NAME.test(name)) return `field ${name}: not a plain name`;
    const kind = entry.fields[name] as LineFieldKind;
    if (typeof kind === 'string') {
      if (kind !== 'id' && kind !== 'date' && kind !== 'amount') return `field ${name}: unknown kind`;
    } else if (!Array.isArray(kind) || kind.length < 1 || kind.length > 16 || kind.some((w) => typeof w !== 'string' || !FIELD_NAME.test(w))) {
      return `field ${name}: an enum is one to sixteen plain words`;
    }
  }
  return null;
}

function lineSchema(type: string, entry: LineWakeEventType) {
  const problem = lineTypeProblem(type, entry);
  if (problem) throw new Error(`line wake type ${type}: ${problem}`);
  const fields: Record<string, z.ZodType<string>> = {};
  for (const [name, kind] of Object.entries(entry.fields)) fields[name] = kind === 'id' ? zId : kind === 'date' ? zDate : kind === 'amount' ? zAmount : z.enum(kind as [string, ...string[]]);
  return z.strictObject({ ...head, type: z.literal(type), data: z.strictObject(fields) });
}

export interface LineWakeEventBody {
  id: string;
  type: string;
  created_at: string;
  org: string;
  grant: string;
  data: Record<string, string>;
}
export type WakeEvent = z.infer<typeof zEvent> | LineWakeEventBody;
export type WakeItem = z.infer<typeof zItem>;

// The event as a plain object, in the order the receiver reads it, or a throw naming the first thing that does not fit. A type that is none of the three fixed ones must be in the registry (`registry` is
// the line registry; a test passes its own), else it is refused.
export function wakeEvent(input: unknown, registry: LineWakeRegistry = LINE_WAKE_EVENTS): WakeEvent {
  const type = typeof input === 'object' && input !== null ? (input as { type?: unknown }).type : undefined;
  if (typeof type === 'string' && !FIXED_TYPES.includes(type) && Object.hasOwn(registry, type)) {
    const parsed = lineSchema(type, registry[type] as LineWakeEventType).parse(input);
    return { id: parsed.id, type: parsed.type, created_at: parsed.created_at, org: parsed.org, grant: parsed.grant, data: parsed.data as Record<string, string> };
  }
  const parsed = zEvent.parse(input);
  return { id: parsed.id, type: parsed.type, created_at: parsed.created_at, org: parsed.org, grant: parsed.grant, data: parsed.data } as WakeEvent;
}

// The text the receiver gets, and the delivery signs.
export function wakeBody(input: unknown, registry: LineWakeRegistry = LINE_WAKE_EVENTS): string {
  return JSON.stringify(wakeEvent(input, registry));
}
