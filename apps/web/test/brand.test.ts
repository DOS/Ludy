// The landing page names the product Ludy and its AI coworkers, Vy the general manager (#1683, #2409): no copy, metadata or component text says
// Crove, the old name, but the places listed below, each waiting for a step of #1682 that is not this one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/content/en';
import { vi } from '../src/content/vi';
import { N, ROSTER, team } from '../src/content/roster';

// Copy that may say Crove, by its path in the dictionary, with the reason.
// None since the repository was renamed to DOS/Ludy (owner, 2026-10-28).
const ALLOWED_COPY: Readonly<Record<string, string>> = {};

// Source lines outside the copy that may say Crove, by file under src/, with the reason.
const ALLOWED_SOURCE: Readonly<Record<string, RegExp>> = {};

const src = join(import.meta.dirname, '..', 'src');
// The copy, which the first test reads as data.
const COPY_FILES = new Set(['content/vi.ts', 'content/en.ts']);

function strings(value: unknown, path: string): Array<[path: string, text: string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => strings(item, path ? `${path}.${key}` : key));
  return [];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

// The code of a line without its comment, as in the app's brand test: a whole-line comment, or the part after ` // `,
// a JSX comment or a one-line block comment.
function code(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return line.replace(/\{\/\*.*?\*\/\}/g, '').replace(/\/\*.*?\*\//g, '').replace(/(^|\s)\/\/\s.*$/, '');
}

describe('brand on the landing page (#1683)', () => {
  it('no copy says Crove', () => {
    for (const dict of [vi, en]) {
      const offenders = strings(dict, '').filter(([path, text]) => /\bCrove\b/.test(text) && !(path in ALLOWED_COPY));
      expect(offenders, dict.lang).toEqual([]);
      expect(dict.meta.title, dict.lang).toMatch(/^Ludy: /);
      expect(dict.footer.copyright, dict.lang).toContain('Ludy');
    }
  });

  it('no component, page or style says Crove', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(src)) {
      const name = relative(src, file).replaceAll('\\', '/');
      if (COPY_FILES.has(name)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bCrove\b/.test(code(line)) && !ALLOWED_SOURCE[name]?.test(line.trim())) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every exception in use, so the list does not outlive the copy', () => {
    for (const dict of [vi, en]) {
      const copy = Object.fromEntries(strings(dict, ''));
      for (const path of Object.keys(ALLOWED_COPY)) expect(copy[path], `${dict.lang} ${path}`).toMatch(/\bCrove\b/);
    }
    for (const [name, line] of Object.entries(ALLOWED_SOURCE)) {
      expect(readFileSync(join(src, name), 'utf8').split('\n').some((text) => line.test(text.trim())), name).toBe(true);
    }
  });

  it('presents the AI as a team of coworkers led by Vy, in both languages', () => {
    // The owner's final hero (2026-11-02, #2409): the names in the lead come from the roster, never from the copy.
    const NB = String.fromCharCode(0xa0);
    expect(vi.hero.title.replaceAll(NB, ' ')).toBe('Hệ điều hành doanh nghiệp trọn gói');
    expect(vi.hero.tagline.replaceAll(NB, ' ')).toBe('mỗi phòng ban một đội AI.');
    expect(vi.hero.lead.replaceAll(NB, ' ')).toBe(`${N.gm} điều phối cả đội: ${N.finance} lo kế toán, ${N.sales} lo hộp thư, khách hàng và bán hàng, ${N.marketing} lo marketing. Bạn chỉ duyệt.`);
    expect(en.hero.title).toBe('All-in-one Business OS');
    expect(en.hero.tagline).toBe('with an AI team for every department.');
    expect(en.hero.lead).toBe(`${N.gm} runs the team: ${N.finance} keeps your books, ${N.sales} works your inbox, customers and sales, ${N.marketing} runs marketing. You approve.`);
    expect(vi.meta.title).toBe('Ludy: hệ điều hành doanh nghiệp trọn gói, mỗi phòng ban một đội AI');
    expect(en.meta.title).toBe('Ludy: the all-in-one Business OS, with an AI team for every department');
    for (const dict of [vi, en]) expect(dict.meta.description, dict.lang).toContain(dict.hero.lead.replaceAll(NB, ' '));
    for (const dict of [vi, en]) {
      expect(dict.agents.team.members.map((m) => m.name), dict.lang).toEqual(team(dict.lang === 'vi' ? 'vi' : 'en').map((m) => m.name));
      expect(dict.agents.team.members[0]?.name, dict.lang).toBe(N.gm);
      expect(dict.modules.sales.suggest, dict.lang).toContain(N.sales);
      expect(dict.faq.items.find((i) => /ghi sổ|post/i.test(i.q))?.a, dict.lang).toContain(N.finance);
      expect(dict.trust.title, dict.lang).toMatch(/đồng nghiệp AI|AI coworkers/i);
    }
  });

  it('shows Dy for the Inbox, customers and sales, and Uy for marketing, in both languages (#2440)', () => {
    const scopeOf = (lang: 'vi' | 'en', name: string) => team(lang).find((m) => m.name === name)?.scope ?? '';
    expect(scopeOf('en', N.sales)).toMatch(/Inbox.*customers.*sales/);
    expect(scopeOf('vi', N.sales)).toMatch(/[Hh]ộp thư.*khách hàng.*bán hàng/);
    expect(scopeOf('en', N.marketing)).toMatch(/marketing/);
    expect(scopeOf('vi', N.marketing)).toMatch(/marketing/);
    for (const lang of ['vi', 'en'] as const) expect(team(lang).map((m) => m.name), lang).not.toContain(N.system);
  });

  it('keeps the roster by role and no name written in the copy', () => {
    expect(Object.keys(ROSTER).sort()).toEqual(['finance', 'gm', 'marketing', 'sales', 'system']);
    // The copy reads names from content/roster.ts (`${N.finance}`): a name typed into a string is the edit a rename must not need.
    const names = new RegExp(`\\b(${Object.values(ROSTER).map((c) => c.name).join('|')})\\b(?! work)`);
    const written = sourceFiles(join(src, 'content'))
      .filter((file) => !file.endsWith('roster.ts'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((text, i) => (names.test(code(text)) ? [`${relative(src, file)}:${i + 1}: ${text.trim().slice(0, 90)}`] : [])),
      );
    expect(written).toEqual([]);
  });

  it('never calls the AI an assistant: no "assistant" or "trợ lý" in the copy or the pages that render it', () => {
    // Every source file of the site, comments included, read as NFC so decomposed Vietnamese is caught (owner decision 2026-11-02, #2409).
    const files = sourceFiles(src);
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((text, i) => (/assistant|trợ lý/i.test(text.normalize('NFC')) ? [`${relative(src, file)}:${i + 1}: ${text.trim().slice(0, 100)}`] : [])),
    );
    expect(found).toEqual([]);
  });

  it('names the Social app Ludy Engage', () => {
    expect(vi.modules.social.name).toBe('Ludy Engage');
    expect(en.modules.social.name).toBe('Ludy Engage');
  });

  it('names the products Ludy Accounting and Ludy Engage', () => {
    expect([vi.modules.finance.name, vi.modules.social.name]).toEqual(['Ludy Kế toán', 'Ludy Engage']);
    expect([en.modules.finance.name, en.modules.social.name]).toEqual(['Ludy Accounting', 'Ludy Engage']);
  });
});
