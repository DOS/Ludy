// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" (issue #2383): what needs a member today, across the apps. Each line (finance, CRM, notes, Social,
// Ads, the conversation core) exposes one small read query that returns these items, R0 and scoped to what the member
// could open, with no write; Home only merges them. This file is the one shape all of those reads import, so none
// defines its own. Nothing here reads or writes: it is the schema and the type.
import { z } from 'zod';
import { zMoney } from './schemas.ts';

export const TODAY_KINDS = ['proposal', 'flag', 'message', 'deadline'] as const;
export type TodayKind = (typeof TODAY_KINDS)[number];

// The app whose read returned the item (`conversations` is the Service inbox of the conversation core, a code id that
// stays whatever the app is called on screen). Each line's read returns only what the member could open there, so an app
// the member cannot see, or one with no read yet, simply adds no items.
export const TODAY_APPS = ['finance', 'crm', 'notes', 'social', 'ads', 'conversations'] as const;
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

// The answer of the Home read: the merged, ordered items (at most TODAY_ITEMS_MAX), how many items a line sent that did
// not match the shape (never shown; above 0 is a bug in that line's read), how many were cut after the merge for being
// past the cap (the least urgent ones), and how many lines' reads refused (a DomainError other than not registered).
export const zTodayList = z.object({
  items: zTodayItems,
  dropped: z.number().int().nonnegative(),
  truncated: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type TodayList = z.infer<typeof zTodayList>;

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

// The member's own opt-in to the daily brief by email (#2406): off by default, set from their own notification settings. The
// server sends the mail only when it has SMTP; the app reads that from its config.
export const zTodayMailSetting = z.object({ enabled: z.boolean() });
export type TodayMailSetting = z.infer<typeof zTodayMailSetting>;
