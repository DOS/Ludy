// SPDX-License-Identifier: AGPL-3.0-only
// Engage's wake rules (#3862, E3 of epic #3857; ADR-0051 decision 13): the deterministic rules, with no model, that tell an AI coworker (Dy, Uy) there is work, as a colleague is told. The same rules show on Home with
// no agent connected. This file is the one place the numbers and the shapes of those rules live; the reads (kernel, CRM), the sweep that wakes a grant and Home all import it.
//
// What a rule gives is ids, dates, amounts and enum words and nothing else: never a customer's name, a message, a subject or a note. The row shapes below hold nothing more, and the wake body is checked again
// by the builder and the database (apps/kernel/src/mcp-wake-body.ts, ludy_kernel.mcp_wake_body_ok).
import { z } from 'zod';
import { zId } from './schemas.ts';

// The org's N for the three rules that have one, with the product's defaults. Set in Settings by an owner or admin (kernel.conversation.wake_rules_set); with no choice the defaults apply.
//   unansweredHours   a customer message nobody answered for this many hours is `engage.conversation_unanswered`
//   replyWindowHours  a platform's reply window that closes within this many hours is `engage.reply_window_closing`
//   quoteDays         a sent quote with no answer for this many days raises the follow-up `engage.quote_unanswered` (the CRM's next step, which is also what Home shows)
export const ENGAGE_WAKE_DEFAULTS = Object.freeze({ unansweredHours: 4, replyWindowHours: 3, quoteDays: 5 });
export const ENGAGE_WAKE_BOUNDS = Object.freeze({ unansweredHours: [1, 72], replyWindowHours: [1, 23], quoteDays: [2, 30] } as const);

export const zEngageWakeRules = z.strictObject({
  unansweredHours: z.number().int().min(ENGAGE_WAKE_BOUNDS.unansweredHours[0]).max(ENGAGE_WAKE_BOUNDS.unansweredHours[1]),
  replyWindowHours: z.number().int().min(ENGAGE_WAKE_BOUNDS.replyWindowHours[0]).max(ENGAGE_WAKE_BOUNDS.replyWindowHours[1]),
  quoteDays: z.number().int().min(ENGAGE_WAKE_BOUNDS.quoteDays[0]).max(ENGAGE_WAKE_BOUNDS.quoteDays[1]),
});
export type EngageWakeRules = z.infer<typeof zEngageWakeRules>;
export const zEngageWakeRulesView = zEngageWakeRules.extend({ isDefault: z.boolean() });
export type EngageWakeRulesView = z.infer<typeof zEngageWakeRulesView>;

// How far back a rule looks, so a rule that is switched on late, or a wake-up connected late, does not wake the coworker about the whole backlog: an old item is a person's to clear, not news.
export const ENGAGE_WAKE_LOOKBACK_DAYS = 7;
// A new inbound conversation and a new comment are news for a day.
export const ENGAGE_WAKE_FRESH_HOURS = 24;
// The most items one read returns for each rule (newest first).
export const ENGAGE_WAKE_ROWS_MAX = 100;
// The most pages the sweep reads of a rule in a pass (so at most 500 rows of a rule); a longer list is a person's to clear, and Home shows the first page.
export const ENGAGE_WAKE_PAGES_MAX = 5;

export const ENGAGE_WAKE_KINDS = ['direct', 'email'] as const;

// What the conversation read answers (kernel.wake.conversations): instants, never text. The sweep turns an instant into a day in Vietnam's calendar.
const zInstant = z.iso.datetime({ offset: true });
const zReadKind = z.enum(['direct', 'email', 'comment_thread']);
export const zEngageWakeConversations = z.strictObject({
  // Direct and email threads nobody has answered yet that started in the last day.
  newInbound: z.array(z.strictObject({ id: zId, kind: zReadKind, since: zInstant })).max(ENGAGE_WAKE_ROWS_MAX),
  // Direct and email threads whose oldest customer message waits for more than N hours (and less than a week).
  unanswered: z.array(z.strictObject({ id: zId, kind: zReadKind, since: zInstant })).max(ENGAGE_WAKE_ROWS_MAX),
  // Threads whose customer waits for an answer and whose platform reply window closes within N hours.
  replyWindow: z.array(z.strictObject({ id: zId, closesAt: zInstant })).max(ENGAGE_WAKE_ROWS_MAX),
  // Comment threads under a published post that got their first comment in the last day and nobody has answered.
  comments: z.array(z.strictObject({ id: zId, since: zInstant })).max(ENGAGE_WAKE_ROWS_MAX),
});
export type EngageWakeConversations = z.infer<typeof zEngageWakeConversations>;
export const zEngageWakeConversationsInput = z.strictObject({
  unansweredHours: zEngageWakeRules.shape.unansweredHours,
  replyWindowHours: zEngageWakeRules.shape.replyWindowHours,
  // Where in each list to start: a read gives at most ENGAGE_WAKE_ROWS_MAX rows of a rule, so the sweep asks for the next page (the same offset for every list) while a list came back full.
  offset: z.number().int().min(0).max(ENGAGE_WAKE_PAGES_MAX * ENGAGE_WAKE_ROWS_MAX).default(0),
});

// What the CRM's read answers (crm.wake.facts).
export const zEngageWakeCrm = z.strictObject({
  // Open next steps of a sent quote nobody answered: the step, its deal, the day the quote was sent (Vietnam's calendar), and the DEAL's amount (not the quote's total) as a decimal string in the deal's own currency (ISO 4217).
  quoteSteps: z.array(z.strictObject({ stepId: zId, dealId: zId, sinceOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dealAmount: z.string().regex(/^-?(0|[1-9]\d{0,17})(\.\d{1,4})?$/), currency: z.string().regex(/^[A-Z]{3}$/) })).max(ENGAGE_WAKE_ROWS_MAX),
  // Confirmed bookings that start tomorrow (Vietnam's calendar).
  bookingsTomorrow: z.array(z.strictObject({ bookingId: zId, on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).max(ENGAGE_WAKE_ROWS_MAX),
});
export type EngageWakeCrm = z.infer<typeof zEngageWakeCrm>;
export const zEngageWakeCrmInput = z.strictObject({ offset: z.number().int().min(0).max(ENGAGE_WAKE_PAGES_MAX * ENGAGE_WAKE_ROWS_MAX).default(0) });

// The day in Vietnam's calendar (UTC+7, no daylight saving) an instant falls on.
export const vietnamDayOf = (instant: string | Date): string => new Date((typeof instant === 'string' ? Date.parse(instant) : instant.getTime()) + 7 * 3_600_000).toISOString().slice(0, 10);

// The wake types of the rules, in one list: the type, the scope a grant must hold to be woken by it, and the rule's short name used in Home's message keys. The registry in apps/kernel/src/mcp-wake-body.ts
// holds the fields; a test keeps that, the database's catalog and this list equal.
export const ENGAGE_WAKE_RULES = [
  { type: 'engage.conversation_new', scope: 'ludy.engage.write' },
  { type: 'engage.conversation_unanswered', scope: 'ludy.engage.write' },
  { type: 'engage.reply_window_closing', scope: 'ludy.engage.write' },
  { type: 'engage.quote_unanswered', scope: 'ludy.engage.write' },
  { type: 'engage.booking_tomorrow', scope: 'ludy.engage.write' },
  { type: 'social.post_comment_new', scope: 'ludy.social.draft' },
  { type: 'ads.pace_over', scope: 'ludy.ads.draft' },
  { type: 'ads.daily_cap_over', scope: 'ludy.ads.draft' },
  { type: 'ads.monthly_cap_over', scope: 'ludy.ads.draft' },
] as const;
export type EngageWakeType = (typeof ENGAGE_WAKE_RULES)[number]['type'];
