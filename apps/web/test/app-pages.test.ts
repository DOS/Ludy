// SPDX-License-Identifier: AGPL-3.0-only
// The app pages (/ke-toan, /en/accounting, and the pages that follow): each is listed once in content/site.ts and then
// found everywhere it must be, in both languages: the sitemap with its hreflang twin, a card of the home page, the
// footer, its own title and description, and the copy of both languages in step. The rendered pages are checked in
// a11y.spec.ts (axe, language) and perf.spec.ts (budget).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sitemap from '../src/app/sitemap';
import { accountingEn } from '../src/content/accounting-en';
import { accountingVi } from '../src/content/accounting-vi';
import type { AppPageCopy } from '../src/content/app-page';
import { en } from '../src/content/en';
import { engageEn } from '../src/content/engage-en';
import { engageVi } from '../src/content/engage-vi';
import { notesEn } from '../src/content/notes-en';
import { notesVi } from '../src/content/notes-vi';
import { APP_PAGES, RETIRED_PAGES, SITE_URL, type AppPageKey } from '../src/content/site';
import { vi } from '../src/content/vi';

const COPY: Record<AppPageKey, { vi: AppPageCopy; en: AppPageCopy }> = {
  accounting: { vi: accountingVi, en: accountingEn },
  engage: { vi: engageVi, en: engageEn },
  notes: { vi: notesVi, en: notesEn },
};
const KEYS = Object.keys(APP_PAGES) as AppPageKey[];
const app = join(import.meta.dirname, '..', 'src', 'app');

describe('app pages', () => {
  it('have copy in both languages, for every entry of the list and nothing else', () => {
    expect(Object.keys(COPY).sort()).toEqual([...KEYS].sort());
  });

  it('live under their own route, with their own social preview image, in each language', () => {
    for (const key of KEYS) {
      const { path: viPath, enRoute: enPath }: { path: string; enRoute: string } = APP_PAGES[key];
      expect(viPath.startsWith('/') && !viPath.startsWith('/en/') && viPath !== '/en').toBe(true);
      expect(enPath.startsWith('/en/')).toBe(true);
      for (const [group, path] of [['(vi)', viPath], ['(en)', enPath]] as const) {
        const dir = join(app, group, ...path.split('/').filter(Boolean));
        expect(existsSync(join(dir, 'page.tsx')), `${path} page`).toBe(true);
        expect(existsSync(join(dir, 'opengraph-image.tsx')), `${path} opengraph-image`).toBe(true);
      }
    }
  });

  it('keep every retired address pointing at a live page, and out of the sitemap', () => {
    const live = new Set<string>(KEYS.map((key) => APP_PAGES[key].path));
    for (const [from, to] of Object.entries(RETIRED_PAGES)) {
      expect(live.has(to), `${from} leads to ${to}`).toBe(true);
      expect(live.has(from), `${from} is retired`).toBe(false);
      expect(sitemap().map((entry) => entry.url)).not.toContain(`${SITE_URL}${from}`);
    }
  });

  it('are in the sitemap once, at the one address of both languages, with no /en entry and no alternates', () => {
    const entries = sitemap();
    expect(entries.map((entry) => entry.url).sort()).toEqual([`${SITE_URL}/`, ...KEYS.map((key) => `${SITE_URL}${APP_PAGES[key].path}`)].sort());
    for (const entry of entries) {
      expect(entry.url, entry.url).not.toMatch(/\/en(\/|$)/);
      expect(entry.alternates, entry.url).toBeUndefined();
    }
  });

  it('each have a title that names the product, and a description, of their own', () => {
    const titles = new Set<string>([vi.meta.title, en.meta.title]);
    for (const key of KEYS) {
      for (const lang of ['vi', 'en'] as const) {
        const copy = COPY[key][lang];
        const name = (lang === 'vi' ? vi : en).modules[APP_PAGES[key].module].name;
        expect(copy.appName, `${key} ${lang}`).toBe(name);
        expect(copy.meta.title, `${key} ${lang}`).toMatch(new RegExp(`^${name}: `));
        expect(copy.meta.description.length, `${key} ${lang}`).toBeGreaterThan(80);
        expect(copy.meta.description.length, `${key} ${lang}`).toBeLessThanOrEqual(320);
        expect(titles.has(copy.meta.title), `${key} ${lang} title is new`).toBe(false);
        titles.add(copy.meta.title);
        expect(copy.faq.items.length, `${key} ${lang} FAQ`).toBeGreaterThanOrEqual(3);
        expect(copy.faq.items.length, `${key} ${lang} FAQ`).toBeLessThanOrEqual(6);
      }
    }
  });

  it('have the same groups, points and questions in both languages', () => {
    for (const key of KEYS) {
      const { vi: a, en: b } = COPY[key];
      expect(b.groups.items.length).toBe(a.groups.items.length);
      a.groups.items.forEach((group, i) => expect(b.groups.items[i]?.points.length, `${key} group ${i}`).toBe(group.points.length));
      expect(b.faq.items.length).toBe(a.faq.items.length);
      expect(b.how.steps.length).toBe(a.how.steps.length);
      expect(b.soon?.items.length).toBe(a.soon?.items.length);
    }
  });

  it('say no dash, no hype word and nothing about a price (DESIGN.md 10)', () => {
    for (const key of KEYS) {
      for (const lang of ['vi', 'en'] as const) {
        const text = JSON.stringify(COPY[key][lang]);
        expect(text, `${key} ${lang}`).not.toMatch(/[–—]/);
        expect(text.toLowerCase(), `${key} ${lang}`).not.toMatch(/siêu|đột phá|supercharge|revolution|game-chang|\bmiễn phí\b.*\bgói\b|\$\d|\d+\s?(?:₫|vnd)\s?\/\s?(?:tháng|month)/);
      }
    }
  });

  it('are linked from the home page card and the footer in each language', () => {
    const footer = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'landing', 'site-footer.tsx'), 'utf8');
    // The footer lists every page from the registry; the home page's app cards (components/landing/app-cards.tsx) name theirs in the copy, so
    // every page has a card in each language, and the card component links it through the registry.
    expect(footer).toContain('Object.keys(APP_PAGES)');
    const cards = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'landing', 'app-cards.tsx'), 'utf8');
    expect(cards).toContain('appPagePath(item.page');
    for (const dict of [vi, en]) for (const key of KEYS) expect(dict.appCards.items.some((item) => item.page === key), `${dict.lang} ${key}`).toBe(true);
  });
});
