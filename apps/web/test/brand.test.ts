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
    // The home hero line is held until the owner picks it (#2409), so it is not asserted here.
    for (const dict of [vi, en]) {
      expect(dict.agents.team.members.map((m) => m.name), dict.lang).toEqual(team(dict.lang === 'vi' ? 'vi' : 'en').map((m) => m.name));
      expect(dict.agents.team.members[0]?.name, dict.lang).toBe(N.gm);
      expect(dict.modules.crm.suggest, dict.lang).toContain(N.sales);
      expect(dict.faq.items.find((i) => /ghi sổ|post/i.test(i.q))?.a, dict.lang).toContain(N.finance);
      expect(dict.trust.title, dict.lang).toMatch(/đồng nghiệp AI|AI coworkers/i);
    }
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

  it('names the products Ludy Accounting and Ludy CRM', () => {
    expect([vi.modules.finance.name, vi.modules.crm.name]).toEqual(['Ludy Kế toán', 'Ludy CRM']);
    expect([en.modules.finance.name, en.modules.crm.name]).toEqual(['Ludy Accounting', 'Ludy CRM']);
  });
});
