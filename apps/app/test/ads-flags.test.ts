// SPDX-License-Identifier: AGPL-3.0-only
// What the Ads screen says about a flag (#2378): the numbers each flag is based on, in the reader's language and in the flag's own currency.
import { describe, expect, it } from 'vitest';
import type { AdsFlag } from '@crove/kernel-contract';
import { flagKey, flagText, type FlagFormat } from '../src/lib/ads-flags.ts';
import { translatorFor } from '../src/i18n/runtime.ts';

const inEn = translatorFor('en');
const inVi = translatorFor('vi');
const f: FlagFormat = { money: (value, currency) => `${value} ${currency ?? ''}`.trim(), date: (value) => value ?? '' };

const pace: AdsFlag = { kind: 'pace', scope: 'org', adAccountId: null, accountName: null, currency: 'VND', skippedAccounts: 0, cap: '280000', spent: '90000', projected: '300000', elapsedDays: 9, daysInMonth: 30 };
const paceAccount: AdsFlag = { ...pace, scope: 'account', adAccountId: '0190c4a1-0000-7000-8000-000000000001', accountName: 'Cửa hàng', currency: 'USD', cap: '250.00', spent: '90.00', projected: '300.00' };
const day: AdsFlag = { kind: 'day', scope: 'account', adAccountId: '0190c4a1-0000-7000-8000-000000000001', accountName: 'Cửa hàng', currency: 'VND', skippedAccounts: 0, period: 'daily', cap: '5000', share: '5000', day: '2026-11-09', spend: '10000', ratio: '2.00' };
const cpr: AdsFlag = { kind: 'cpr', adAccountId: '0190c4a1-0000-7000-8000-000000000001', accountName: 'Cửa hàng', campaignId: 'c1', campaignName: 'Chiến dịch A', currency: 'VND', day: '2026-11-09', recentCost: '3000', medianCost: '1000', ratio: '3.00', recentResults: '300', historyDays: 6 };

describe('the words of a flag', () => {
  it('says where the month is heading against the cap, with the numbers, for the org and for an account, each in its own currency', () => {
    expect(flagText(inEn, f, pace)).toBe('At this pace the org spends 300000 VND this month, above its monthly cap of 280000 VND: 90000 VND in the first 9 days of 30.');
    expect(flagText(inEn, f, paceAccount)).toBe('At this pace Cửa hàng spends 300.00 USD this month, above its monthly cap of 250.00 USD: 90.00 USD in the first 9 days of 30.');
    expect(flagText(inVi, f, pace)).toContain('vượt hạn mức tháng 280000 VND');
    expect(flagText(inVi, f, pace)).toContain('đã chi 90000 VND trong 9 ngày đầu của 30 ngày');
  });

  it('says what a day spent against its share of a cap, and what a campaign’s cost per result did', () => {
    expect(flagText(inEn, f, day)).toBe('Cửa hàng spent 10000 VND on 2026-11-09, 2.00 times its share of the daily cap (5000 VND a day; cap 5000 VND).');
    expect(flagText(inVi, f, day)).toContain('gấp 2.00 lần phần của một ngày theo hạn mức ngày');
    expect(flagText(inEn, f, { ...day, scope: 'org', adAccountId: null, accountName: null, period: 'monthly' })).toContain('The org spent 10000 VND on 2026-11-09, 2.00 times its share of the monthly cap');
    // The text names the last day of the 3 days, so a flag still on screen after midnight is not read as the current days.
    expect(flagText(inEn, f, cpr)).toBe('Chiến dịch A (Cửa hàng): the 3 days to 2026-11-09 cost 3000 VND per result (300 results), 3.00 times the median of 1000 VND over the 14 days before.');
    expect(flagText(inVi, f, cpr)).toContain('3 ngày tính đến 2026-11-09 tốn 3000 VND cho mỗi kết quả (300 kết quả), gấp 3.00 lần mức trung vị 1000 VND');
  });

  it('says how many accounts an org flag leaves out, because they have not read up to yesterday', () => {
    expect(flagText(inEn, f, { ...pace, skippedAccounts: 2 })).toMatch(/ Not counted: accounts that have not read up to yesterday \(2\)\.$/);
    expect(flagText(inVi, f, { ...day, scope: 'org', adAccountId: null, accountName: null, skippedAccounts: 1 })).toMatch(/ Chưa tính: các tài khoản chưa cập nhật đến hôm qua \(1\)\.$/);
    expect(flagText(inEn, f, pace)).not.toContain('Not counted');
  });

  it('keys a list by what each flag is about, so two flags of one account and kind do not collide', () => {
    const keys = [pace, paceAccount, day, { ...day, period: 'monthly' as const }, cpr, { ...cpr, campaignId: 'c2' }].map(flagKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
