// SPDX-License-Identifier: AGPL-3.0-only
// The plain helpers of Engage's wake feed (#3862, E3 of epic #3857): the reads' rows become events of the registered types with a key per item and window, amounts keep their own currency, and an item that does
// not fit (an amount of more than 18 digits) is left out instead of being sent wrong. The database side (each rule fires once, who is woken) is in mcp-wake-engage.db.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdsFlag } from '@crove/kernel-contract';
import { LINE_WAKE_EVENTS, wakeBody } from '../src/mcp-wake-body.ts';
import { adsItems, conversationItems, crmItems, wakeAmount, wakeKey } from '../src/mcp-wake-engage.ts';

const KEY = /^(engage|social|ads)(_[a-z]+)+(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}:\d{4}-\d{2}-\d{2}$/;
const head = (type: string) => ({ id: randomUUID(), type, created_at: '2026-11-19T03:00:00.000Z', org: randomUUID(), grant: randomUUID() });

describe('Engage wake feed helpers', () => {
  it('makes a key of the type\'s name (dots as underscores), the item and the day of its window', () => {
    const id = randomUUID();
    expect(wakeKey('engage.conversation_new', id, '2026-11-19')).toBe(`engage_conversation_new:${id}:2026-11-19`);
  });

  it('turns the inbox rows into events by Vietnam\'s day, each a body the builder accepts', () => {
    const [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    // 18:00 UTC is 01:00 the next day in Vietnam.
    const items = conversationItems({
      newInbound: [{ id: a, kind: 'direct', since: '2026-11-18T18:00:00.000Z' }],
      unanswered: [{ id: b, kind: 'email', since: '2026-11-18T10:00:00.000Z' }],
      replyWindow: [{ id: c, closesAt: '2026-11-19T05:00:00.000Z' }],
      comments: [{ id: d, since: '2026-11-19T02:00:00.000Z' }],
    });
    expect(items.map((i) => [i.type, i.key])).toEqual([
      ['engage.conversation_new', `engage_conversation_new:${a}:2026-11-19`],
      ['engage.conversation_unanswered', `engage_conversation_unanswered:${b}:2026-11-18`],
      ['engage.reply_window_closing', `engage_reply_window_closing:${c}:2026-11-19`],
      ['social.post_comment_new', `social_post_comment_new:${d}:2026-11-19`],
    ]);
    for (const i of items) {
      expect(i.key).toMatch(KEY);
      expect(Object.hasOwn(LINE_WAKE_EVENTS, i.type)).toBe(true);
      expect(() => wakeBody({ ...head(i.type), data: i.data })).not.toThrow();
    }
  });

  it('turns the CRM rows into events: the quote follow-up with its amount and currency, a booking tomorrow', () => {
    const [step, deal, booking] = [randomUUID(), randomUUID(), randomUUID()];
    const items = crmItems({ quoteSteps: [{ stepId: step, dealId: deal, sinceOn: '2026-11-14', amount: '15000000.00' }], bookingsTomorrow: [{ bookingId: booking, on: '2026-11-20' }] });
    expect(items.map((i) => i.data)).toEqual([
      { deal_id: deal, next_step_id: step, since: '2026-11-14', amount: '15000000', currency: 'vnd' },
      { booking_id: booking, on: '2026-11-20' },
    ]);
    for (const i of items) {
      expect(i.key).toMatch(KEY);
      expect(() => wakeBody({ ...head(i.type), data: i.data })).not.toThrow();
    }
  });

  it('turns pace and cap flags into events with the currency as a word, leaves cost-per-result alone, and uses the org itself for an org-wide flag', () => {
    const account = randomUUID();
    const org = randomUUID();
    const base = { accountName: 'Tài khoản 1', skippedAccounts: 0 };
    const flags: AdsFlag[] = [
      { ...base, kind: 'pace', scope: 'account', adAccountId: account, currency: 'USD', cap: '5000', spent: '3000', projected: '6200.456789', elapsedDays: 12, daysInMonth: 30 },
      { ...base, kind: 'pace', scope: 'org', adAccountId: null, accountName: null, currency: 'CHF', cap: '5000', spent: '3000', projected: '6200', elapsedDays: 12, daysInMonth: 30 },
      { ...base, kind: 'day', scope: 'account', adAccountId: account, currency: 'VND', period: 'daily', cap: '1000000', share: '33333', day: '2026-11-18', spend: '90000', ratio: '2.7' },
      { ...base, kind: 'day', scope: 'account', adAccountId: account, currency: 'VND', period: 'monthly', cap: '30000000', share: '1000000', day: '2026-11-18', spend: '2400000', ratio: '2.4' },
      { kind: 'cpr', adAccountId: account, accountName: 'x', campaignId: 'c', campaignName: 'x', currency: 'VND', day: '2026-11-18', recentCost: '1', medianCost: '1', ratio: '3', recentResults: '1', historyDays: 7 },
    ];
    const items = adsItems(flags, org, new Date('2026-11-19T03:00:00Z'));
    expect(items.map((i) => i.type)).toEqual(['ads.pace_over', 'ads.pace_over', 'ads.daily_cap_over', 'ads.monthly_cap_over']);
    expect(items[0]?.data).toEqual({ subject_id: account, scope: 'account', month: '2026-11-01', projected: '6200.4568', cap: '5000', currency: 'usd' });
    // An org-wide flag is about the org; a currency the list does not know is `other`.
    expect(items[1]?.data).toMatchObject({ subject_id: org, scope: 'org', currency: 'other' });
    // The daily and monthly share of one account on one day never meet in one key.
    expect(items[2]?.key).not.toBe(items[3]?.key);
    for (const i of items) {
      expect(i.key).toMatch(KEY);
      expect(() => wakeBody({ ...head(i.type), data: i.data })).not.toThrow();
    }
  });

  it('keeps an amount to four decimals and leaves out one that does not fit', () => {
    expect(wakeAmount('1250000.5')).toBe('1250000.5');
    expect(wakeAmount('0.12345')).toBe('0.1235');
    expect(wakeAmount('1234567890123456789')).toBeNull();
    expect(wakeAmount('không phải số')).toBeNull();
  });
});
