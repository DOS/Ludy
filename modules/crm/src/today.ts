// SPDX-License-Identifier: AGPL-3.0-only
// The CRM's part of Home's "Hôm nay cần bạn" (issues #2381 and #2383): one small R0 read that answers the member's own items, in the shape every line
// shares (packages/kernel-contract/src/today.ts). It reads three things and writes nothing:
//   - the member's open next steps from the stale-deal rule (a deal nobody changed for N days: a flag; a deal past its expected close: a deadline),
//   - the member's own open deals whose expected close is today (a deadline, at the end of the day),
//   - the member's own bookings today that have not ended (a deadline at the booking's start).
// "The member's own" is the screens' rule: the deals they own and the next steps raised for them (for an owner or admin also those of deals nobody
// owns), and the bookings of the types they lead or hold on their calendar. Another member's deals and bookings never appear.
// Nothing a person typed goes into an item: no deal title, no contact's name, no event type's title, no visitor's words. A title is a message key with
// numbers (days, a clock time), and the screen where the item is acted on is `href`, an in-app path relative to the org's screens (MODULE_SCREENS.crm).
// The amount is the deal's, a decimal string in VND.
import { vietnamToday, zTodayItems, type TodayItem } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { z } from 'zod';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { bookingsOfDay } from './bookings.ts';
import { countNextSteps, loadNextSteps } from './next-steps.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// Items of each kind one read lists; a longer next step list ends with one grouped item that carries the rest as a count (a read groups before it lists).
const NEXT_STEP_ITEMS = 20;
const DEAL_ITEMS = 20;
const BOOKING_ITEMS = 20;
const VIETNAM_OFFSET = '+07:00';
const DAY_MS = 86_400_000;

// Whole days from one Vietnam calendar day to a later one.
const daysBetween = (from: string, to: string): number => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS));
// The clock time in Vietnam (no daylight saving), "14:30".
const clockTime = (instant: Date): string => new Date(instant.getTime() + 7 * 3_600_000).toISOString().slice(11, 16);

export const crmToday = defineQuery({
  name: 'crm.today',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const me = ctx.actor.userId;
    const now = new Date();
    const today = vietnamToday(now);
    const items: TodayItem[] = [];

    const steps = await loadNextSteps(ctx, 'mine', null, NEXT_STEP_ITEMS);
    for (const step of steps.items) {
      const days = daysBetween(step.sinceOn, today);
      if (step.reason === 'quote_unanswered' || step.reason === 'quote_expiring') {
        // The follow-up of a sent quote (#2699): a reminder of the deal, with no quote number or amount in it.
        const expiring = step.reason === 'quote_expiring';
        items.push({
          kind: expiring ? 'deadline' : 'flag',
          app: 'crm',
          id: `next-step:${step.id}`,
          title: { key: expiring ? 'crm.quoteExpiring' : 'crm.quoteUnanswered', params: { days } },
          amount: step.amount,
          currency: 'VND',
          ...(expiring ? { dueAt: `${step.sinceOn}T00:00:00${VIETNAM_OFFSET}` } : { severity: 'info' as const }),
          href: '/deals?tab=next',
        } as TodayItem);
      } else if (step.reason === 'past_close') {
        items.push({
          kind: 'deadline',
          app: 'crm',
          id: `next-step:${step.id}`,
          title: { key: 'crm.pastClose', params: { days } },
          amount: step.amount,
          currency: 'VND',
          dueAt: `${step.sinceOn}T00:00:00${VIETNAM_OFFSET}`,
          href: '/deals?tab=next',
        });
      } else {
        items.push({
          kind: 'flag',
          app: 'crm',
          id: `next-step:${step.id}`,
          title: { key: 'crm.noActivity', params: { days } },
          amount: step.amount,
          currency: 'VND',
          severity: 'info',
          href: '/deals?tab=next',
        });
      }
    }
    if (steps.next) {
      const rest = (await countNextSteps(ctx)).mine - steps.items.length;
      if (rest > 0) items.push({ kind: 'flag', app: 'crm', id: 'next-steps-more', title: { key: 'crm.nextStepsMore', params: { count: rest } }, count: rest, severity: 'info', href: '/deals?tab=next' });
    }

    // The member's own open deals that are to close today.
    const closing = await ctx.trx
      .selectFrom('crove_crm.deal as d')
      .select(['d.id', 'd.amount'])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.owner_user_id', '=', me)
      .where('d.closed_at', 'is', null)
      .where('d.expected_close', '=', today)
      .orderBy('d.id')
      .limit(DEAL_ITEMS)
      .execute();
    for (const deal of closing) {
      items.push({
        kind: 'deadline',
        app: 'crm',
        id: `deal-closes:${deal.id}`,
        title: { key: 'crm.dealClosesToday' },
        amount: deal.amount,
        currency: 'VND',
        dueAt: `${today}T23:59:00${VIETNAM_OFFSET}`,
        href: '/deals',
      });
    }

    // The member's own bookings today that have not ended: the types they lead or hold on their calendar.
    const from = new Date(`${today}T00:00:00${VIETNAM_OFFSET}`);
    const bookings = await bookingsOfDay(ctx, me, from, new Date(from.getTime() + DAY_MS));
    for (const booking of bookings.slice(0, BOOKING_ITEMS)) {
      items.push({
        kind: 'deadline',
        app: 'crm',
        id: `booking:${booking.id}`,
        title: { key: 'crm.booking', params: { time: clockTime(new Date(booking.startsAt)) } },
        dueAt: booking.startsAt,
        href: '/bookings',
      });
    }
    return zTodayItems.parse(items);
  },
});
