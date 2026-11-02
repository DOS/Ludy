// SPDX-License-Identifier: AGPL-3.0-only
// The words of the CRM items of Home (#2381, shape of #2383): each title key `crm.today` returns (modules/crm/src/today.ts) has its text in both languages,
// built from the params that read sends, and none of them names an AI coworker.
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';

// The keys and params of modules/crm/src/today.ts, as `title` carries them.
const TITLES: Array<{ key: string; params: Record<string, string | number> }> = [
  { key: 'crm.noActivity', params: { days: 14 } },
  { key: 'crm.pastClose', params: { days: 3 } },
  { key: 'crm.nextStepsMore', params: { count: 4 } },
  { key: 'crm.dealClosesToday', params: {} },
  { key: 'crm.booking', params: { time: '14:30' } },
];

// The keys come from the read at run time, so the translator is used with plain text keys.
type Say = (key: string, values?: Record<string, string | number>) => string;
const sayIn = (lang: 'en' | 'vi'): Say => translatorFor(lang) as unknown as Say;

describe('the CRM items of Home, in words', () => {
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

  it('says days and counts with the right plural, and the clock time of an appointment', () => {
    const en = sayIn('en');
    const vi = sayIn('vi');
    expect(en('today.items.crm.noActivity', { days: 1 })).toBe('Reminder: this deal has had no update for 1 day');
    expect(en('today.items.crm.noActivity', { days: 14 })).toBe('Reminder: this deal has had no update for 14 days');
    expect(vi('today.items.crm.noActivity', { days: 14 })).toBe('Nhắc: deal này đã 14 ngày chưa có cập nhật');
    expect(vi('today.items.crm.pastClose', { days: 3 })).toBe('Nhắc: deal này đã quá ngày dự kiến chốt 3 ngày');
    expect(en('today.items.crm.nextStepsMore', { count: 1 })).toBe('1 more deal needs a follow-up');
    expect(en('today.items.crm.nextStepsMore', { count: 4 })).toBe('4 more deals need a follow-up');
    expect(vi('today.items.crm.booking', { time: '14:30' })).toBe('Lịch hẹn lúc 14:30');
  });
});
