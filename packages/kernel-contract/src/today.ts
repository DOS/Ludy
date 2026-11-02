// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" (issue #2383): what needs a member today, across the apps. Each line (finance, CRM, notes, Social,
// Ads, the conversation core) exposes one small read query that returns these items, R0 and scoped to what the member
// could open, with no write; Home only merges them. This file is the one shape all of those reads import, so none
// defines its own. Nothing here reads or writes: it is the schema and the type.
import { z } from 'zod';
import { zMoney } from './schemas.ts';

export const TODAY_KINDS = ['proposal', 'flag', 'message', 'deadline'] as const;
export type TodayKind = (typeof TODAY_KINDS)[number];

// The app whose read returned the item; Home hides an app the member cannot see and shows nothing for one with no read yet.
export const TODAY_APPS = ['finance', 'crm', 'notes', 'social', 'ads'] as const;
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

// The result of a line's `<module>.today` read: the oldest or most urgent items first, at most 200 (a read groups
// before it lists, so a long list is a sign it did not).
export const zTodayItems = z.array(zTodayItem).max(200);

export const todayCurrency = (item: Pick<TodayItem, 'currency'>): string => item.currency ?? TODAY_DEFAULT_CURRENCY;
