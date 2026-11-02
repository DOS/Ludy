// SPDX-License-Identifier: AGPL-3.0-only
// The words of the Ads items of Home (#2378 slice 2, shape of #2383): each title key `ads.today` returns (modules/ads/src/today.ts) has its text in
// both languages, built from the params that read sends.
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';

// The keys and params of modules/ads/src/today.ts, as `title` carries them.
const day = { ratio: '2.00', day: '2026-11-09' };
const TITLES: Array<{ key: string; params: Record<string, string | number> }> = [
  { key: 'ads.paceOrg', params: {} },
  { key: 'ads.paceAccount', params: { account: 'Cửa hàng' } },
  { key: 'ads.dayOrgDaily', params: day },
  { key: 'ads.dayOrgMonthly', params: day },
  { key: 'ads.dayAccountDaily', params: { account: 'Cửa hàng', ...day } },
  { key: 'ads.dayAccountMonthly', params: { account: 'Cửa hàng', ...day } },
  { key: 'ads.cpr', params: { campaign: 'Chiến dịch A', account: 'Cửa hàng', ratio: '3.00' } },
  { key: 'ads.cprMore', params: { count: 2 } },
];

// The keys come from the read at run time, so the translator is used with plain text keys.
type Say = (key: string, values?: Record<string, string | number>) => string;
const sayIn = (lang: 'en' | 'vi'): Say => translatorFor(lang) as unknown as Say;

describe('the Ads items of Home, in words', () => {
  it('has a text in both languages for every title the read returns, with every param the read sends in it', () => {
    for (const lang of ['en', 'vi'] as const) {
      const say = sayIn(lang);
      for (const title of TITLES) {
        const text = say(`today.items.${title.key}`, title.params);
        // A key the catalog lacks comes back as the key itself.
        expect(text, `${lang} ${title.key}`).not.toContain('today.items');
        expect(text.length, `${lang} ${title.key}`).toBeGreaterThan(10);
        for (const [name, value] of Object.entries(title.params)) expect(text, `${lang} ${title.key} ${name}`).toContain(String(value));
      }
    }
  });

  it('says the cap of the day or of the month by the key the read sends', () => {
    const en = sayIn('en');
    const vi = sayIn('vi');
    expect(en('today.items.ads.paceAccount', { account: 'Cửa hàng' })).toBe('At this pace Cửa hàng passes its monthly spend cap');
    expect(en('today.items.ads.dayAccountDaily', { account: 'Cửa hàng', ...day })).toBe('Cửa hàng spent 2.00 times its share of the daily spend cap on 2026-11-09');
    expect(en('today.items.ads.dayOrgMonthly', day)).toBe('The org spent 2.00 times its share of the monthly spend cap on 2026-11-09');
    expect(vi('today.items.ads.dayOrgMonthly', day)).toBe('Tổ chức đã chi gấp 2.00 lần phần của một ngày theo hạn mức tháng vào 2026-11-09');
    expect(vi('today.items.ads.dayOrgDaily', day)).toContain('hạn mức ngày vào');
    expect(en('today.items.ads.cprMore', { count: 2 })).toBe('2 more campaigns have a jump in cost per result');
    expect(en('today.items.ads.cprMore', { count: 1 })).toBe('1 more campaign has a jump in cost per result');
  });
});
