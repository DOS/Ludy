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
import type { PrivacyBlock, PrivacyCopy } from '../src/content/privacy';
import { privacyEn } from '../src/content/privacy-en';
import { privacyVi } from '../src/content/privacy-vi';
import { APP_PAGES, LEGAL_PAGES, PRIVACY_CONTACT_EMAIL, PRIVACY_UPDATED, PRIVACY_VERSION, RETIRED_PAGES, SITE_URL, type AppPageKey } from '../src/content/site';
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
    expect(entries.map((entry) => entry.url).sort()).toEqual([`${SITE_URL}/`, ...KEYS.map((key) => `${SITE_URL}${APP_PAGES[key].path}`), ...Object.values(LEGAL_PAGES).map((page) => `${SITE_URL}${page.path}`)].sort());
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

// The privacy page (/privacy): the address the Chrome Web Store listing of the Ludy extension links. ludy.vn and ludy.so
// both serve this app, so the one path works on both hosts (no host check in src/proxy.ts).
const textOf = (copy: PrivacyCopy) => JSON.stringify(copy);
// Every string of the copy on its own line, so a pattern can look for punctuation without meeting the JSON's own.
const stringsOf = (value: unknown): string[] => (typeof value === 'string' ? [value] : value !== null && typeof value === 'object' ? Object.values(value).flatMap(stringsOf) : []);
const blockCount = (block: PrivacyBlock) => (block.kind === 'p' ? 1 : block.kind === 'list' ? block.items.length : block.rows.length);

describe('privacy page', () => {
  it('lives at /privacy and /en/privacy, each with its own social preview image', () => {
    expect(LEGAL_PAGES.privacy.path).toBe('/privacy');
    expect(LEGAL_PAGES.privacy.enRoute).toBe('/en/privacy');
    for (const dir of [join(app, '(vi)', 'privacy'), join(app, '(en)', 'en', 'privacy')]) {
      expect(existsSync(join(dir, 'page.tsx')), dir).toBe(true);
      expect(existsSync(join(dir, 'opengraph-image.tsx')), dir).toBe(true);
    }
  });

  it('is in the sitemap once, at the public address, and is linked from the footer in both languages', () => {
    expect(sitemap().filter((entry) => entry.url === `${SITE_URL}/privacy`)).toHaveLength(1);
    const footer = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'landing', 'site-footer.tsx'), 'utf8');
    expect(footer).toContain('LEGAL_PAGES.privacy.path');
    expect(vi.footer.privacy.length).toBeGreaterThan(0);
    expect(en.footer.privacy.length).toBeGreaterThan(0);
  });

  it('has the same sections, lists, tables and rows in both languages', () => {
    expect(privacyEn.sections.map((section) => section.id)).toEqual(privacyVi.sections.map((section) => section.id));
    privacyVi.sections.forEach((section, i) => {
      const twin = privacyEn.sections[i]!;
      expect(twin.blocks.map((block) => block.kind), section.id).toEqual(section.blocks.map((block) => block.kind));
      expect(twin.blocks.map(blockCount), section.id).toEqual(section.blocks.map(blockCount));
    });
  });

  it('covers the extension fully: what it records, consent first, where it goes, who reads, retention, revoke', () => {
    expect(privacyVi.sections.map((section) => section.id)).toEqual(['summary', 'extension', 'storage', 'readers', 'transcription', 'retention', 'rights', 'cloud', 'changes']);
    const vietnamese = textOf(privacyVi);
    const english = textOf(privacyEn);
    for (const must of ['app.ludy.vn', '30 ngày', '7 ngày', '12 tháng', '90 ngày', 'Ghi cả video', 'thiết bị đã kết nối', 'không bán dữ liệu', 'không theo dõi']) expect(vietnamese.toLowerCase(), must).toContain(must.toLowerCase());
    for (const must of ['app.ludy.vn', '30 days', '7 days', '12 months', '90 days', 'Record video too', 'connected devices', 'does not sell data', 'track you']) expect(english.toLowerCase(), must).toContain(must.toLowerCase());
  });

  it('shows the version and the day, and says the policy is under review, in both languages', () => {
    expect(PRIVACY_VERSION).toMatch(/^\d+\.\d+$/);
    expect(PRIVACY_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [y, m, d] = PRIVACY_UPDATED.split('-') as [string, string, string];
    expect(privacyVi.versionLine).toContain(`Phiên bản ${PRIVACY_VERSION}`);
    expect(privacyVi.versionLine).toContain(`${d}/${m}/${y}`);
    expect(privacyEn.versionLine).toContain(`Version ${PRIVACY_VERSION}`);
    expect(privacyEn.versionLine).toContain(`${Number(d)} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(m) - 1]} ${y}`);
    expect(privacyVi.reviewNotice).toMatch(/đang được rà soát và có thể được cập nhật/);
    expect(privacyEn.reviewNotice).toMatch(/being reviewed and may be updated/);
  });

  it('holds no placeholder, no dash and no value the repository does not have', () => {
    for (const [lang, copy] of [['vi', privacyVi], ['en', privacyEn]] as const) {
      const text = stringsOf(copy).join('\n');
      expect(text, lang).not.toMatch(/[–—]/);
      // No bracketed fill-in, no to-do marker, no ellipsis stand-in.
      expect(text, lang).not.toMatch(/\[[^\]]*\]|\bTODO\b|\bTBD\b|\bXXX\b|\.\.\./);
      // No email address, no phone number and no street address was given to write here: the contact line comes from PRIVACY_CONTACT_EMAIL alone.
      expect(text, lang).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text.toLowerCase(), lang).not.toMatch(/siêu|đột phá|supercharge|revolution|game-chang/);
    }
  });

  it('has a title and a description of its own, in length for a search result', () => {
    const titles = new Set<string>([vi.meta.title, en.meta.title]);
    for (const copy of [privacyVi, privacyEn]) {
      expect(titles.has(copy.meta.title)).toBe(false);
      titles.add(copy.meta.title);
      expect(copy.meta.description.length).toBeGreaterThan(80);
      expect(copy.meta.description.length).toBeLessThanOrEqual(320);
    }
  });

  it('shows a contact email only when the owner named one, and then it is a plain address', () => {
    if (PRIVACY_CONTACT_EMAIL !== null) expect(PRIVACY_CONTACT_EMAIL).toMatch(/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/);
    const page = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'privacy-page.tsx'), 'utf8');
    expect(page).toContain('contactEmail !== null');
  });
});
