// SPDX-License-Identifier: AGPL-3.0-only
// The words of the Projects items of Home (#2596): every title key `projects.today` returns (modules/projects/src/today.ts)
// has its text in both languages, built from the numeric params the read sends, and never duplicates Vy's name or uses forbidden copy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { translatorFor } from '../src/i18n/runtime.ts';

const TITLES: Array<{ key: string; params: Record<string, string | number> }> = [
  { key: 'projects.taskOverdue', params: {} },
  { key: 'projects.taskOverdueDays', params: { days: 2 } },
  { key: 'projects.taskDueToday', params: {} },
  { key: 'projects.ownerTaskOverdue', params: {} },
  { key: 'projects.ownerTaskOverdueDays', params: { days: 4 } },
  { key: 'projects.vacantSeat', params: {} },
  { key: 'projects.waitingStuck', params: { days: 3 } },
  { key: 'projects.more', params: { count: 5 } },
];

type Say = (key: string, values?: Record<string, string | number>) => string;
const sayIn = (lang: 'en' | 'vi'): Say => translatorFor(lang) as unknown as Say;

const source = readFileSync(fileURLToPath(new URL('../../../modules/projects/src/today.ts', import.meta.url)), 'utf8');
const sourceKeys = [...new Set([...source.matchAll(/key:\s*'(projects\.[A-Za-z]+)'/g)].map((m) => m[1] as string))];

describe('the Projects items of Home, in words (#2596)', () => {
  it('covers every title key emitted by modules/projects/src/today.ts in both catalogs', () => {
    expect(sourceKeys.sort()).toEqual(TITLES.map((t) => t.key).sort());
    for (const [locale, catalog] of [
      ['en', en],
      ['vi', vi],
    ] as const) {
      const projects = (catalog as unknown as { today: { items: { projects: Record<string, unknown> } } }).today.items.projects;
      for (const fullKey of sourceKeys) {
        const subKey = fullKey.replace(/^projects\./, '');
        expect(typeof projects[subKey], `${locale} ${fullKey}`).toBe('string');
      }
    }
  });

  it('has text in both languages with every param rendered and no coworker or forbidden terms', () => {
    for (const lang of ['en', 'vi'] as const) {
      const say = sayIn(lang);
      for (const title of TITLES) {
        const text = say(`today.items.${title.key}`, title.params);
        expect(text, `${lang} ${title.key}`).not.toContain('today.items');
        expect(text.length, `${lang} ${title.key}`).toBeGreaterThan(10);
        // TodayRow already prints "Từ Vy" / "From Vy" from todayCoworkerKey('projects') === 'gm'.
        expect(text, `${lang} ${title.key}`).not.toMatch(/\b(Vy|Ly|Dy|Uy)\b/);
        expect(text, `${lang} ${title.key}`).not.toMatch(/assistant|trợ lý/i);
        for (const [name, value] of Object.entries(title.params)) {
          expect(text, `${lang} ${title.key} ${name}`).toContain(String(value));
        }
      }
    }
  });

  it('renders singular and plural day and count forms cleanly', () => {
    const enSay = sayIn('en');
    const viSay = sayIn('vi');
    expect(enSay('today.items.projects.taskOverdueDays', { days: 1 })).toBe(
      'A project task assigned to your seat is 1 day overdue',
    );
    expect(enSay('today.items.projects.taskOverdueDays', { days: 5 })).toBe(
      'A project task assigned to your seat is 5 days overdue',
    );
    expect(viSay('today.items.projects.taskOverdueDays', { days: 5 })).toBe(
      'Một việc dự án của vị trí bạn giữ đã quá hạn 5 ngày',
    );
    expect(enSay('today.items.projects.waitingStuck', { days: 3 })).toBe(
      'A task in a project you own has been waiting without an update for 3 days',
    );
    expect(viSay('today.items.projects.waitingStuck', { days: 3 })).toBe(
      'Một việc trong dự án bạn phụ trách đang chờ 3 ngày chưa có cập nhật',
    );
    expect(enSay('today.items.projects.more', { count: 1 })).toBe('1 more project task needs your attention');
    expect(enSay('today.items.projects.more', { count: 4 })).toBe('4 more project tasks need your attention');
  });
});
