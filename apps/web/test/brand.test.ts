// The landing page names the product Ludy and its AI coworkers, Vy the general manager (#1683, #2409): no copy, metadata or component text says
// Crove, the old name, but the places listed below, each waiting for a step of #1682 that is not this one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/content/en';
import { vi } from '../src/content/vi';

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
    const NB = String.fromCharCode(0xa0);
    expect(vi.hero.title.replaceAll(NB, ' ')).toBe('Cả doanh nghiệp trong một bộ ứng dụng, mỗi phòng ban có một đồng nghiệp AI.');
    expect(vi.hero.lead).toBe('Vy điều phối cả đội: Ly lo tài chính, My lo marketing, Thy lo bán hàng, Duy lo khách hàng. Bạn chỉ duyệt.');
    expect(en.hero.title).toBe('Your whole business in one suite, with an AI coworker in every department.');
    expect(en.hero.lead).toBe('Vy coordinates the whole team: Ly handles finance, My marketing, Thy sales and Duy customers. You only approve.');
    for (const dict of [vi, en]) {
      expect(dict.agents.team.members.map((m) => m.name), dict.lang).toEqual(['Vy', 'Ly', 'My', 'Thy', 'Duy', 'Hy']);
      expect(dict.meta.title, dict.lang).toContain(dict.lang === 'vi' ? 'đồng nghiệp AI' : 'AI coworker');
      expect(dict.modules.crm.suggest, dict.lang).toMatch(/\bThy\b/);
      expect(dict.faq.items[1]?.a, dict.lang).toMatch(/\bLy\b/);
    }
  });

  it('never calls the AI an assistant: no "assistant" or "trợ lý" in the copy or the pages that render it', () => {
    // The copy files, the app pages' copy and the components that print any of it (owner decision 2026-11-02, #2409).
    const files = [...sourceFiles(join(src, 'content')), ...sourceFiles(join(src, 'components')), ...sourceFiles(join(src, 'app'))];
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((text, i) => (/assistant|trợ lý/i.test(text) ? [`${relative(src, file)}:${i + 1}: ${text.trim().slice(0, 100)}`] : [])),
    );
    expect(found).toEqual([]);
  });

  it('names the products Ludy Accounting and Ludy CRM', () => {
    expect([vi.modules.finance.name, vi.modules.crm.name]).toEqual(['Ludy Kế toán', 'Ludy CRM']);
    expect([en.modules.finance.name, en.modules.crm.name]).toEqual(['Ludy Accounting', 'Ludy CRM']);
  });
});
