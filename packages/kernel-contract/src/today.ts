// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" (issue #2383): what needs a member today, across the apps. Each line (finance, CRM, notes, Social,
// Ads, the conversation core) exposes one small read query that returns these items, R0 and scoped to what the member
// could open, with no write; Home only merges them. This file is the one shape all of those reads import, so none
// defines its own. Nothing here reads or writes: it is the schema and the type.
import { z } from 'zod';
import { COWORKER_BY_MODULE, type CoworkerKey } from './coworkers.ts';
import { zId, zLocalDate, zMoney } from './schemas.ts';

export const TODAY_KINDS = ['proposal', 'flag', 'message', 'deadline'] as const;
export type TodayKind = (typeof TODAY_KINDS)[number];

// The app whose read returned the item (`conversations` is the Service inbox of the conversation core, a code id that
// stays whatever the app is called on screen). Each line's read returns only what the member could open there, so an app
// the member cannot see, or one with no read yet, simply adds no items.
export const TODAY_APPS = ['finance', 'crm', 'notes', 'projects', 'social', 'ads', 'conversations'] as const;
export type TodayApp = (typeof TODAY_APPS)[number];

export const TODAY_SEVERITIES = ['info', 'warn', 'block'] as const;
export type TodaySeverity = (typeof TODAY_SEVERITIES)[number];

// Money has no conversion: an item in USD stays in USD, and a missing currency means VND.
export const TODAY_DEFAULT_CURRENCY = 'VND';

// What the item says is a message key with its parameters, never rendered text, so Home shows it in the viewer's
// language and no read carries free text (a customer's words, a name someone typed) into the list.
export const zTodayTitle = z.strictObject({
  key: z.string().min(1).max(200),
  params: z.record(z.string().min(1).max(100), z.union([z.string().max(500), z.number()])).optional(),
});
export type TodayTitle = z.infer<typeof zTodayTitle>;

// An address inside the app (`/ke-toan/...`): a path, never a full URL, a `//host` form or a `/\host` form (a browser
// reads a backslash as a slash), and no whitespace, control or invisible character, so a read cannot send the member
// off the site or dress a link up. It carries the legal entity when the screen depends on one.
export const zTodayHref = z
  .string()
  .max(2000)
  .regex(/^\/(?![/\\])[^\\\s\p{C}]*$/u, 'an in-app path');

// The object without its currency rule: a line that needs a variant extends this one (`.extend()` on `zTodayItem`
// would drop the rule) and applies `zTodayItem`'s refine itself. Unknown keys are refused, so a read that adds a field
// (a customer's name) fails its own test instead of being stripped silently.
export const zTodayItemBase = z.strictObject({
  kind: z.enum(TODAY_KINDS),
  app: z.enum(TODAY_APPS),
  // Stable within the app, so a refresh keeps an item's place and a list key does not repeat.
  id: z.string().min(1).max(200),
  title: zTodayTitle,
  // When the item groups several (a vendor's proposals, an inbox): how many.
  count: z.number().int().positive().optional(),
  // A decimal string, in `currency`; present when money is involved.
  amount: zMoney.optional(),
  // ISO 4217; VND when absent (TODAY_DEFAULT_CURRENCY). Only with an amount.
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'ISO 4217')
    .optional(),
  // For a deadline or a reply window, with an offset (`+07:00` or `Z`).
  dueAt: z.iso.datetime({ offset: true }).optional(),
  // For a flag.
  severity: z.enum(TODAY_SEVERITIES).optional(),
  // The screen where it is acted on. Batch approval stays there: the list approves nothing itself.
  href: zTodayHref,
});

export const zTodayItem = zTodayItemBase.refine((item) => item.currency === undefined || item.amount !== undefined, {
  message: 'currency needs an amount',
  path: ['currency'],
});
export type TodayItem = z.infer<typeof zTodayItem>;

// The most items a line's read returns, and Home's list holds (a read groups before it lists, so a long list is a sign it did not).
export const TODAY_ITEMS_MAX = 200;

// The result of a line's `<module>.today` read: the most urgent items first.
export const zTodayItems = z.array(zTodayItem).max(TODAY_ITEMS_MAX);

export const todayCurrency = (item: Pick<TodayItem, 'currency'>): string => item.currency ?? TODAY_DEFAULT_CURRENCY;

// Home lists the kinds in this order: what is wrong first, then what waits for a decision, then what waits for an answer,
// then what is coming.
export const TODAY_KIND_ORDER: readonly TodayKind[] = ['flag', 'proposal', 'message', 'deadline'];
const SEVERITY_RANK: Record<TodaySeverity, number> = { block: 0, warn: 1, info: 2 };

// The list as Home shows it: grouped by kind in TODAY_KIND_ORDER, inside a group the more severe first (an item with no
// severity counts as info), then the nearer dueAt (none last), then the larger count, then app and id so the order never
// depends on which read answered first. Returns a new array.
export function sortTodayItems(items: readonly TodayItem[]): TodayItem[] {
  const due = (item: TodayItem) => (item.dueAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(item.dueAt));
  return [...items].sort(
    (a, b) =>
      TODAY_KIND_ORDER.indexOf(a.kind) - TODAY_KIND_ORDER.indexOf(b.kind) ||
      SEVERITY_RANK[a.severity ?? 'info'] - SEVERITY_RANK[b.severity ?? 'info'] ||
      (due(a) === due(b) ? 0 : due(a) < due(b) ? -1 : 1) ||
      (b.count ?? 1) - (a.count ?? 1) ||
      (a.app < b.app ? -1 : a.app > b.app ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// The AI coworker that raised an item (Vy plan C1a, issue #3265): the coworker of the item's app in COWORKER_BY_MODULE (finance Ly,
// crm and conversations Dy, social and ads Uy), and Vy, the general manager, for an app with none of its own (Notes, Projects). Deterministic: no model.
export type TodayCoworkerKey = Exclude<CoworkerKey, 'system'>;
export function todayCoworkerKey(app: TodayApp): TodayCoworkerKey {
  return Object.hasOwn(COWORKER_BY_MODULE, app) ? (COWORKER_BY_MODULE[app] as TodayCoworkerKey) : 'gm';
}

// The coworkers' names now, by what each covers (never by name, so a rename changes one value here and nothing else): the display name
// of the org's own agent of that coworker, or the roster's default when the org has none. `gm` is Vy, who also stands for the summary
// line. The hidden system coworker is not listed. Home reads a name from here for each item and for the brief; no item carries one.
export const zTodayCoworkers = z.strictObject({
  gm: z.string().min(1).max(200),
  finance: z.string().min(1).max(200),
  sales: z.string().min(1).max(200),
  marketing: z.string().min(1).max(200),
});
export type TodayCoworkers = z.infer<typeof zTodayCoworkers>;

// The answer of the Home read: the merged, ordered items (at most TODAY_ITEMS_MAX), how many items a line sent that did
// not match the shape (never shown; above 0 is a bug in that line's read), how many were cut after the merge for being
// past the cap (the least urgent ones), and how many lines' reads refused (a DomainError other than not registered).
// coworkers: the names of the AI coworkers now, so Home labels each item with the one that raised it (todayCoworkerKey) and the brief with Vy.
export const zTodayList = z.object({
  items: zTodayItems,
  coworkers: zTodayCoworkers,
  dropped: z.number().int().nonnegative(),
  truncated: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type TodayList = z.infer<typeof zTodayList>;

// "Since yesterday" on Home (Vy plan C1c, issue #3256): what each AI coworker prepared for the org over the last day, as a count
// of the activity rows its commands left (`activity.agent_id`), read in the member's own context, so the count is of the rows
// that member can open (the activity table's own policy: org and legal-entity scope). Counts only: no row's text, no record, no
// name but the coworker's current one (the agent's display name, which a rename changes). A coworker with no rows is not listed.
// The same list holds with AI off: nothing here calls a model.
export const SINCE_YESTERDAY_HOURS = 24;
// The most coworkers one answer lists (an org holds a handful of agents; the cut ones are the ones that prepared least).
export const SINCE_YESTERDAY_MAX = 20;
export const zSinceYesterdayItem = z.strictObject({
  agentId: zId,
  // The agent's display name now (1 to 200 characters).
  name: z.string().min(1).max(200),
  count: z.number().int().positive(),
  // Where the prepared items wait for the member: an in-app path (the AI inbox).
  href: zTodayHref,
});
export type SinceYesterdayItem = z.infer<typeof zSinceYesterdayItem>;
export const zSinceYesterday = z.object({ items: z.array(zSinceYesterdayItem).max(SINCE_YESTERDAY_MAX) });
export type SinceYesterday = z.infer<typeof zSinceYesterday>;

// Vy's daily brief (#2383): written from the same items, shown above the list. writtenBy says who wrote it ('vy': the
// model, every number checked against the figures; 'template': built from the figures with no model); null with no
// sentences when there is nothing to say (no items) or the AI budget of the month is spent (budgetSpent), when Home shows
// the list alone. Nothing is stored.
export const zTodayBriefInput = z.object({ language: z.enum(['vi', 'en']) });
export const zTodayBrief = z.object({
  writtenBy: z.enum(['vy', 'template']).nullable(),
  sentences: z.array(z.string().max(300)).max(4),
  budgetSpent: z.boolean(),
  // false: a fallback a later call may improve on (the model was asked and gave nothing usable, or the member is asking too
  // often); the app does not keep it.
  final: z.boolean(),
});
export type TodayBrief = z.infer<typeof zTodayBrief>;

// "Tuần này" on Home (Vy plan C5, slice V6, #3257): how the business did in the last 7 days, in figures computed by code from the lines' own reads in the
// member's own context, and a few sentences by Vy over them. The window is the 7 days ending today in Vietnam (`from` to `to`, both inclusive); the money is
// compared with the end of the day before the window (`before`). Every group is null when the member cannot open what it reads (no right, a book they may not
// see, a module that is off, a read that would have been cut by its cap): a figure the member cannot see is never shown as 0. Nothing is stored.
export const WEEKLY_DAYS = 7;
// The days of the week the card shows by itself (Vietnam time, 1 = Monday): Monday to Wednesday. On the other days a member asks for it.
export const WEEKLY_DEFAULT_WEEKDAYS: readonly number[] = [1, 2, 3];

/** Whether the "Tuần này" card is shown without being asked on a Vietnam calendar day (YYYY-MM-DD): Monday to Wednesday. */
export function weeklyShownByDefault(day: string): boolean {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at)) return false;
  const weekday = new Date(at).getUTCDay() || 7;
  return WEEKLY_DEFAULT_WEEKDAYS.includes(weekday);
}

const zWeeklyBalance = z.strictObject({ amount: zMoney, previous: zMoney });
export const zWeeklyFigures = z.strictObject({
  from: zLocalDate,
  to: zLocalDate,
  before: zLocalDate,
  // Deals won in the window (their number and the sum of their amounts) and deals still open now; `open` is null alone when the list was cut by its cap.
  deals: z.strictObject({ won: z.strictObject({ count: z.number().int().nonnegative(), amount: zMoney }), open: z.number().int().nonnegative().nullable() }).nullable(),
  // Cash (111, 112), receivables from customers (131) and payables to suppliers (331) at the end of `to`, and at the end of `before`, in the book currency.
  money: z.strictObject({ cash: zWeeklyBalance, receivables: zWeeklyBalance, payables: zWeeklyBalance }).nullable(),
  // The member's own open tasks that are past their due time now.
  tasks: z.strictObject({ late: z.number().int().nonnegative() }).nullable(),
});
export type WeeklyFigures = z.infer<typeof zWeeklyFigures>;

// What Home shows: the figures (so the card can show them as numbers beside the sentences), and the sentences by Vy or the template built from the figures alone.
// writtenBy null with no sentences: the month's AI budget is spent (budgetSpent) or there is nothing to say (no figure at all); the figures still show. `final` as in the brief.
export const zTodayWeeklyInput = z.object({ language: z.enum(['vi', 'en']) });
export const zTodayWeekly = z.object({
  figures: zWeeklyFigures,
  writtenBy: z.enum(['vy', 'template']).nullable(),
  sentences: z.array(z.string().max(600)).max(5),
  budgetSpent: z.boolean(),
  final: z.boolean(),
});
export type TodayWeekly = z.infer<typeof zTodayWeekly>;

// The member's own opt-in to the daily brief by email (#2406): off by default, set from their own notification settings. The
// server sends the mail only when it has SMTP; the app reads that from its config.
export const zTodayMailSetting = z.object({ enabled: z.boolean() });
export type TodayMailSetting = z.infer<typeof zTodayMailSetting>;
// Turning it on may name the language of the mail (the member's language in the app); left out, a row already on keeps its own, else Vietnamese.
export const zTodayMailSet = zTodayMailSetting.extend({ language: z.enum(['vi', 'en']).optional() });
export type TodayMailSet = z.infer<typeof zTodayMailSet>;
