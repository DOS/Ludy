// SPDX-License-Identifier: AGPL-3.0-only
// Engage's wake rules, the part the sweep runs (#3862, E3 of epic #3857; ADR-0051 decision 13): the deterministic rules, with no model, that tell the AI coworkers (Dy for Engage, Uy for Social and Ads) there is work.
// The sweep (mcp-wake-sweep.ts) offers this feed to every company grant whose wake-up is due; for each it reads the rules' answers AS THE GRANT (an MCP actor holding the grant's own scopes, so each read runs in the
// grant's sealed read-only context and the database's own policies decide what it may see), turns them into events of the types registered in mcp-wake-body.ts, and the sweep sends each only if it is new for the
// grant (the item's own "seen" rule: an item, the day of its window, kept with the event: crove_kernel.mcp_wake_line_check and mcp_wake_enqueue).
//
// What an event carries is ids, a day, an amount and enum words: never a customer's name, a message, a subject, a deal's title, a booking's guest or a note. This file builds the data from the reads' strict
// shapes (packages/kernel-contract/src/engage-wake.ts), and the builder (mcp-wake-body.ts) and the database refuse anything else.
//   engage.conversation_new         a direct or email thread nobody has answered, started in the last day              window: the day it started
//   engage.conversation_unanswered  a customer who waited more than N hours (N set in Settings, default 4)             window: the day the wait started
//   engage.reply_window_closing     the platform's reply window closes within N hours (default 3)                     window: the day it closes
//   engage.quote_unanswered         the follow-up of a sent quote, raised after N days (default 5), with the deal's amount and currency   window: the day the quote was sent
//   engage.booking_tomorrow         a confirmed booking that starts tomorrow                                          window: the day of the booking
//   social.post_comment_new         a comment under a published post, in the last day                                 window: the day it arrived
//   ads.pace_over                   a monthly cap on course to be passed (from ads.mcp.flags, as the Ads screen)       window: the month
//   ads.daily_cap_over              a day that spent more than its share of a daily cap (from ads.mcp.flags)           window: the day
//   ads.monthly_cap_over            a day that spent more than its share of a monthly cap (from ads.mcp.flags)         window: the day
import { money, toMoney } from '@ludy/l10n-vn';
import { ENGAGE_WAKE_PAGES_MAX, ENGAGE_WAKE_ROWS_MAX, vietnamDayOf, zEngageWakeConversations, zEngageWakeCrm, zAdsFlag, type AdsFlag, type EngageWakeConversations, type EngageWakeCrm } from '@ludy/kernel-contract';
import { DomainError, type Runtime, type UserActor } from '@ludy/kernel-runtime';
import type { McpWakeLinePlan } from '@ludy/kernel';
import type { LineWakeFeed, LineWakeItem, WakeGrant } from './mcp-wake-sweep.ts';
import { WAKE_CURRENCIES } from './mcp-wake-body.ts';

const ENGAGE_SCOPE = 'ludy.engage.write';
const SOCIAL_SCOPE = 'ludy.social.draft';
const ADS_SCOPE = 'ludy.ads.draft';

// The key of an item: the type's name (dots as underscores), the id the item is about and the day of its window. Nothing a person typed.
export const wakeKey = (type: string, id: string, day: string): string => `${type.replaceAll('.', '_')}:${id}:${day}`;
const item = (type: string, id: string, day: string, data: Record<string, string>): LineWakeItem => ({ type, key: wakeKey(type, id, day), data });

// A decimal string a wake body may carry (four decimals at most, at most 18 digits), or null when the figure does not fit: the item is then left out rather than sent with a wrong number.
export function wakeAmount(value: string): string | null {
  try {
    const out = toMoney(money(value));
    return /^-?(0|[1-9]\d{0,17})(\.\d{1,4})?$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
const currencyWord = (code: string): string => {
  const word = code.toLowerCase();
  return (WAKE_CURRENCIES as readonly string[]).includes(word) ? word : 'other';
};

// The four conversation rules (the inbox's read) as events.
export function conversationItems(read: EngageWakeConversations): LineWakeItem[] {
  const out: LineWakeItem[] = [];
  for (const r of read.newInbound) out.push(item('engage.conversation_new', r.id, vietnamDayOf(r.since), { conversation_id: r.id, kind: r.kind, since: vietnamDayOf(r.since) }));
  for (const r of read.unanswered) out.push(item('engage.conversation_unanswered', r.id, vietnamDayOf(r.since), { conversation_id: r.id, kind: r.kind, since: vietnamDayOf(r.since) }));
  for (const r of read.replyWindow) out.push(item('engage.reply_window_closing', r.id, vietnamDayOf(r.closesAt), { conversation_id: r.id, closes_on: vietnamDayOf(r.closesAt) }));
  for (const r of read.comments) out.push(item('social.post_comment_new', r.id, vietnamDayOf(r.since), { conversation_id: r.id, since: vietnamDayOf(r.since) }));
  return out;
}

// The CRM's rules (a sent quote with no answer, a booking tomorrow) as events.
export function crmItems(read: EngageWakeCrm): LineWakeItem[] {
  const out: LineWakeItem[] = [];
  for (const s of read.quoteSteps) {
    // The deal's amount in the deal's own currency (the quote's total is the quote's, and Ludy's deals are VND today): the field says so.
    const dealAmount = wakeAmount(s.dealAmount);
    if (dealAmount !== null) out.push(item('engage.quote_unanswered', s.stepId, s.sinceOn, { deal_id: s.dealId, next_step_id: s.stepId, since: s.sinceOn, deal_amount: dealAmount, currency: currencyWord(s.currency) }));
  }
  for (const b of read.bookingsTomorrow) out.push(item('engage.booking_tomorrow', b.bookingId, b.on, { booking_id: b.bookingId, on: b.on }));
  return out;
}

// The Ads screen's flags (the same read, ads.mcp.flags) as events: a cap on course to be passed this month, and a day over its share of a cap. The cost-per-result flags are not about pace or a cap and are left to the
// owner's Home. An org-wide flag is about the org itself, so its subject is the org's own id.
export function adsItems(flags: readonly AdsFlag[], orgId: string, now: Date): LineWakeItem[] {
  const out: LineWakeItem[] = [];
  const month = `${vietnamDayOf(now).slice(0, 7)}-01`;
  for (const f of flags) {
    if (f.kind === 'cpr') continue;
    const subject = f.adAccountId ?? orgId;
    const scope = f.adAccountId === null ? 'org' : 'account';
    const cap = wakeAmount(f.cap);
    if (cap === null) continue;
    if (f.kind === 'pace') {
      const projected = wakeAmount(f.projected);
      if (projected !== null) out.push(item('ads.pace_over', subject, month, { subject_id: subject, scope, month, projected, cap, currency: currencyWord(f.currency) }));
    } else {
      const spend = wakeAmount(f.spend);
      // The daily and the monthly share of one account on one day are two types, so their keys never meet.
      const type = f.period === 'daily' ? 'ads.daily_cap_over' : 'ads.monthly_cap_over';
      if (spend !== null) out.push(item(type, subject, f.day, { subject_id: subject, scope, day: f.day, spend, cap, currency: currencyWord(f.currency) }));
    }
  }
  return out;
}

// The grant as an actor: the consenting user and the scopes the grant holds, in the worker's own sealed entry (the runtime's `mcpEntry: 'worker'`).
function grantActor(grant: WakeGrant, plan: McpWakeLinePlan): UserActor {
  return { type: 'user', userId: grant.userId, aal: 'aal1', mcp: { grantId: grant.grantId, clientId: 'wake-up', clientName: 'Wake-up', scopes: plan.scopes } };
}

// A read that is not available (the module is off, the grant may not read it) gives nothing; a fault is worth a line and the other reads still run.
async function readOrNull<T>(runtime: Runtime, name: string, input: unknown, grant: WakeGrant, plan: McpWakeLinePlan): Promise<T | null> {
  try {
    return await runtime.query<T>(name, input, { actor: grantActor(grant, plan), orgId: grant.orgId });
  } catch (error) {
    if (!(error instanceof DomainError) || error.status >= 500 || error.status === 403) console.warn(`[mcp-wake-engage] ${name} for ${grant.grantId.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
    return null;
  }
}

// A read gives one page of at most ENGAGE_WAKE_ROWS_MAX rows of each list, so the next page is asked for while any list came back full (at most ENGAGE_WAKE_PAGES_MAX pages), and the pages are put together: no
// qualifying thread, quote or booking is hidden behind the first hundred. `lists` names the lists of the answer; `parse` holds it to the contract.
async function readPages<T>(runtime: Runtime, name: string, base: Record<string, unknown>, grant: WakeGrant, plan: McpWakeLinePlan, parse: (raw: unknown) => T | null, merge: (pages: T[]) => T, full: (page: T) => boolean): Promise<T | null> {
  const pages: T[] = [];
  for (let page = 0; page < ENGAGE_WAKE_PAGES_MAX; page += 1) {
    const raw = await readOrNull<unknown>(runtime, name, { ...base, offset: page * ENGAGE_WAKE_ROWS_MAX }, grant, plan);
    const parsed = raw === null ? null : parse(raw);
    if (parsed === null) break;
    pages.push(parsed);
    if (!full(parsed)) break;
  }
  return pages.length === 0 ? null : merge(pages);
}

export function engageWakeFeed(runtime: Runtime, now: () => Date = () => new Date()): LineWakeFeed {
  return {
    types: ['engage.conversation_new', 'engage.conversation_unanswered', 'engage.reply_window_closing', 'engage.quote_unanswered', 'engage.booking_tomorrow', 'social.post_comment_new', 'ads.pace_over', 'ads.daily_cap_over', 'ads.monthly_cap_over'],
    read: async (grant, plan) => {
      const out: LineWakeItem[] = [];
      const scopes = plan.scopes;
      const engage = scopes.includes(ENGAGE_SCOPE);
      const social = scopes.includes(SOCIAL_SCOPE);
      const ads = scopes.includes(ADS_SCOPE);
      // An app the org switched off wakes no coworker (ADR-0053): the inbox's rules and the comments are the Social app's, and the CRM's and Ads' own reads are refused by the runtime when their app is off.
      const inboxOn = !plan.appsOff.includes('social');
      if ((engage || social) && inboxOn) {
        // The inbox's rules: one read for the four (and so one scan of the threads).
        const read = await readPages<EngageWakeConversations>(
          runtime,
          'kernel.wake.conversations',
          { unansweredHours: plan.unansweredHours, replyWindowHours: plan.replyWindowHours },
          grant,
          plan,
          (raw) => {
            const parsed = zEngageWakeConversations.safeParse(raw);
            return parsed.success ? parsed.data : null;
          },
          (pages) => ({ newInbound: pages.flatMap((p) => p.newInbound), unanswered: pages.flatMap((p) => p.unanswered), replyWindow: pages.flatMap((p) => p.replyWindow), comments: pages.flatMap((p) => p.comments) }),
          (p) => [p.newInbound, p.unanswered, p.replyWindow, p.comments].some((list) => list.length >= ENGAGE_WAKE_ROWS_MAX),
        );
        if (read) {
          for (const it of conversationItems(read)) {
            if (it.type.startsWith('engage.') ? engage : social) out.push(it);
          }
        }
      }
      if (engage) {
        const crm = await readPages<EngageWakeCrm>(
          runtime,
          'crm.wake.facts',
          {},
          grant,
          plan,
          (raw) => {
            const parsed = zEngageWakeCrm.safeParse(raw);
            return parsed.success ? parsed.data : null;
          },
          (pages) => ({ quoteSteps: pages.flatMap((p) => p.quoteSteps), bookingsTomorrow: pages.flatMap((p) => p.bookingsTomorrow) }),
          (p) => p.quoteSteps.length >= ENGAGE_WAKE_ROWS_MAX || p.bookingsTomorrow.length >= ENGAGE_WAKE_ROWS_MAX,
        );
        if (crm) out.push(...crmItems(crm));
      }
      if (ads) {
        const raw = await readOrNull<{ flags?: unknown }>(runtime, 'ads.mcp.flags', {}, grant, plan);
        const flags = Array.isArray(raw?.flags) ? raw.flags.map((f) => zAdsFlag.safeParse(f)).flatMap((p) => (p.success ? [p.data] : [])) : [];
        out.push(...adsItems(flags, grant.orgId, now()));
      }
      return out;
    },
  };
}
