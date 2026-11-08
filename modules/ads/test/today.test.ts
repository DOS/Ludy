// SPDX-License-Identifier: AGPL-3.0-only
// The Ads line of Home's "Hôm nay cần bạn" (#2378 slice 2): the flags as the shared items, in the order a member should read them, every
// item valid for the shared schema, and the campaigns grouped past the limit.
import { describe, expect, it } from 'vitest';
import { zTodayItems, type AdsFlag } from '@crove/kernel-contract';
import { TODAY_ADS_CAMPAIGNS, todayItemsOf } from '../src/today.ts';

const accountId = '0190c4a1-0000-7000-8000-000000000001';
const pace = (over: Partial<Extract<AdsFlag, { kind: 'pace' }>> = {}): AdsFlag => ({ kind: 'pace', scope: 'org', adAccountId: null, accountName: null, currency: 'VND', skippedAccounts: 0, cap: '280000', spent: '90000', projected: '300000', elapsedDays: 9, daysInMonth: 30, ...over });
const day = (over: Partial<Extract<AdsFlag, { kind: 'day' }>> = {}): AdsFlag => ({ kind: 'day', scope: 'account', adAccountId: accountId, accountName: 'Cửa hàng', currency: 'USD', skippedAccounts: 0, period: 'daily', cap: '100.00', share: '100.00', day: '2026-11-09', spend: '160.00', ratio: '1.60', ...over });
const cpr = (n: number, ratio: string): AdsFlag => ({ kind: 'cpr', adAccountId: accountId, accountName: 'Cửa hàng', campaignId: `c${String(n).padStart(3, '0')}`, campaignName: `Chiến dịch ${n}`, currency: 'VND', day: '2026-11-09', recentCost: '3000', medianCost: '1000', ratio, recentResults: '300', historyDays: 6 });

describe('the Ads items of Home', () => {
  it('turns a pace flag and a day flag into warnings with their money in their own currency, and links them to the Ads screen', () => {
    const items = todayItemsOf([day(), pace(), pace({ scope: 'account', adAccountId: accountId, accountName: 'Cửa hàng', currency: 'USD', projected: '300.00' })]);
    expect(items).toEqual([
      { kind: 'flag', app: 'ads', id: 'pace:org', title: { key: 'ads.paceOrg', params: {} }, amount: '300000', currency: 'VND', severity: 'warn', href: '/ads' },
      { kind: 'flag', app: 'ads', id: `pace:${accountId}`, title: { key: 'ads.paceAccount', params: { account: 'Cửa hàng' } }, amount: '300.00', currency: 'USD', severity: 'warn', href: '/ads' },
      { kind: 'flag', app: 'ads', id: `day:${accountId}:daily`, title: { key: 'ads.dayAccountDaily', params: { account: 'Cửa hàng', ratio: '1.60', day: '2026-11-09' } }, amount: '160.00', currency: 'USD', severity: 'warn', href: '/ads' },
    ]);
    expect(zTodayItems.safeParse(items).success).toBe(true);
  });

  it('lists the campaigns with the biggest jump first, and groups the rest past the limit with their count', () => {
    const many = Array.from({ length: TODAY_ADS_CAMPAIGNS + 3 }, (_, i) => cpr(i, i === 7 ? '9.50' : '1.60'));
    const items = todayItemsOf(many);
    expect(items).toHaveLength(TODAY_ADS_CAMPAIGNS + 1);
    expect(items[0]).toMatchObject({ id: `cpr:${accountId}:c007`, title: { key: 'ads.cpr', params: { campaign: 'Chiến dịch 7', account: 'Cửa hàng', ratio: '9.50' } } });
    expect(items[TODAY_ADS_CAMPAIGNS]).toEqual({ kind: 'flag', app: 'ads', id: 'cpr:more', title: { key: 'ads.cprMore', params: { count: 3 } }, count: 3, severity: 'warn', href: '/ads' });
    expect(zTodayItems.safeParse(items).success).toBe(true);
    // The same flags in another order give the same list.
    expect(todayItemsOf([...many].reverse())).toEqual(items);
  });

  it('tells a daily and a monthly day flag of one account apart, by their ids and by the key of the title', () => {
    const items = todayItemsOf([day({ period: 'daily' }), day({ period: 'monthly', cap: '3000.00', share: '100.00' })]);
    expect(items.map((i) => i.id)).toEqual([`day:${accountId}:daily`, `day:${accountId}:monthly`]);
    expect(items.map((i) => i.title.key)).toEqual(['ads.dayAccountDaily', 'ads.dayAccountMonthly']);
    expect(todayItemsOf([day({ scope: 'org', adAccountId: null, accountName: null, period: 'monthly' })])[0]?.title).toEqual({ key: 'ads.dayOrgMonthly', params: { ratio: '1.60', day: '2026-11-09' } });
  });

  it('orders equal jumps by account and campaign in code-point order, so two accounts with the same campaign id keep one order', () => {
    const other = '0190c4a1-0000-7000-8000-000000000002';
    const one = cpr(1, '2.00');
    const two = { ...cpr(1, '2.00'), adAccountId: other } as AdsFlag;
    const forward = todayItemsOf([one, two]).map((i) => i.id);
    expect(forward).toEqual([`cpr:${accountId}:c001`, `cpr:${other}:c001`]);
    expect(todayItemsOf([two, one]).map((i) => i.id)).toEqual(forward);
  });

  it('keeps the campaigns when a long list of accounts is cut at the limit, and bounds the id of a campaign with a very long object id', () => {
    const paces = Array.from({ length: 205 }, (_, i) => pace({ scope: 'account', adAccountId: `0190c4a1-0000-7000-8000-${String(i).padStart(12, '0')}`, accountName: `Tài khoản ${i}` }));
    const long = { ...cpr(1, '4.00'), campaignId: 'x'.repeat(200) } as AdsFlag;
    const items = todayItemsOf([...paces, long, cpr(2, '2.00'), ...Array.from({ length: TODAY_ADS_CAMPAIGNS }, (_, i) => cpr(10 + i, '1.60'))]);
    expect(items).toHaveLength(200);
    expect(items.at(-1)).toMatchObject({ id: 'cpr:more', count: 2 });
    expect(items.filter((i) => i.id.startsWith('cpr:'))).toHaveLength(TODAY_ADS_CAMPAIGNS + 1);
    expect(items.every((i) => i.id.length <= 200)).toBe(true);
    expect(zTodayItems.safeParse(items).success).toBe(true);
  });

  it('says nothing when there is no flag, and carries no field the shared item does not allow', () => {
    expect(todayItemsOf([])).toEqual([]);
    for (const item of todayItemsOf([pace(), day(), cpr(1, '2.00')])) expect(Object.keys(item).every((k) => ['kind', 'app', 'id', 'title', 'count', 'amount', 'currency', 'severity', 'href'].includes(k))).toBe(true);
  });
});
