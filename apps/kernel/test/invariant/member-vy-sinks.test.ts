// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): the sinks of a member's Vy (ADR-0049 decision 4, ADR-0047 point 8; issue #2822). What Vy wrote for one member is private to the
// member, and a command that reads it and writes where others can see is on the kernel's MEMBER_VY_SINKS list or it does not exist. This is a ratchet: the
// consumers that existed before the list did are MEMBER_VY_KNOWN_CONSUMERS, frozen here (FROZEN_BASELINE), so the list can only shrink.
// The scan is per FILE, against frozen lists, so it does not depend on how a command is written: a file that names the private rows (the tables member_vy_result
// and member_vy_memory, the queries kernel.member_vy.result.get and kernel.member_vy.memory.list, or a name built with member_vy_ + ...) must be in READER_FILES;
// every command defined in a reader file outside the kernel's own Vy files must be on a list; and the files that import a reader file are frozen too (a helper in a
// reader file does not give a command outside it a way in). Strings, template literals, regular expressions and comments are scrubbed by a small lexer before braces
// are matched, so a } in a string hides nothing. The SQL half (functions that read the rows) is in member-vy-background.db.test.ts.
// Keep this directory self-contained: no imports from outside test/invariant/ but the code under test.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEMBER_VY_KNOWN_CONSUMERS, MEMBER_VY_SINKS, kernelCommands } from '@crove/kernel';
import { meetingsCommands } from '@crove/mod-meetings';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCANNED = [...readdirSync(join(ROOT, 'apps')).map((app) => `apps/${app}/src`), 'modules', 'packages'].filter((dir) => existsSync(join(ROOT, dir)));

// The consumers that existed when the list was made (#2941). Frozen: MEMBER_VY_KNOWN_CONSUMERS may hold these and nothing else, so it can only shrink.
const FROZEN_BASELINE = ['meetings.draft.review', 'meetings.summary.copy_result', 'meetings.summary.start', 'meetings.transcript.copy_result', 'meetings.transcript.start'];

// The kernel's own files that name the private rows, each with the command namespaces it may define; and the other files that name them. Frozen: a file not here that
// names a private row fails, so the list changes only by an owner decision.
const KERNEL_FILES: Record<string, string[]> = {
  'packages/kernel/src/member-vy.ts': ['kernel.member_vy.', 'kernel.vy_data.'],
  'packages/kernel/src/personal-data.ts': ['kernel.personal_data.'],
  'packages/kernel/src/manifest.ts': [],
  'packages/db/src/schema.ts': [],
  'apps/kernel/src/member-vy-ports.ts': [],
  'apps/kernel/src/member-vy-worker.ts': [],
};
const CONSUMER_FILES = ['modules/meetings/src/summary.ts', 'modules/meetings/src/transcribe.ts'];
const READER_FILES = [...Object.keys(KERNEL_FILES), ...CONSUMER_FILES];
// The files that import a reader file whose helpers could carry the private rows out (the kernel's internals and the db package import their own files freely).
const IMPORTERS: Record<string, string[]> = {
  'apps/kernel/src/member-vy-ports.ts': ['apps/kernel/src/http.ts', 'apps/kernel/src/kernel.ts', 'apps/kernel/src/rpc.ts'],
  'apps/kernel/src/member-vy-worker.ts': ['apps/kernel/src/worker.ts'],
  'modules/meetings/src/summary.ts': ['modules/meetings/src/index.ts', 'modules/meetings/src/meetings.ts'],
  'modules/meetings/src/transcribe.ts': ['modules/meetings/src/index.ts', 'modules/meetings/src/meetings.ts'],
};

const PRIVATE_ROWS = /member_vy_result|member_vy_memory|kernel\.member_vy\.result\.get|kernel\.member_vy\.memory\.list|member_vy_['"`]\s*\+/;

// Blanks comments and, unless keepStrings, the inside of strings, template text and regular expressions, keeping every character's position and the line breaks.
export function scrub(text: string, keepStrings: boolean): string {
  const out = text.split('');
  const n = text.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const REGEX_PREV = /[(,=:[!&|?{};+\-*%<>~^]$/;
  let lastSig = '';
  const template = (start: number): number => {
    let j = start + 1;
    while (j < n) {
      const c = text[j] as string;
      if (c === '\\') {
        if (!keepStrings) blank(j, j + 2);
        j += 2;
        continue;
      }
      if (c === '`') return j + 1;
      if (c === '$' && text[j + 1] === '{') {
        j = code(j + 2, true);
        continue;
      }
      if (!keepStrings) blank(j, j + 1);
      j++;
    }
    return j;
  };
  const code = (from: number, inTemplateExpr: boolean): number => {
    let depth = inTemplateExpr ? 1 : 0;
    let j = from;
    while (j < n) {
      const c = text[j] as string;
      const d = text[j + 1];
      if (c === '/' && d === '/') {
        const e = text.indexOf('\n', j);
        const end = e < 0 ? n : e;
        blank(j, end);
        j = end;
        continue;
      }
      if (c === '/' && d === '*') {
        const e = text.indexOf('*/', j + 2);
        const end = e < 0 ? n : e + 2;
        blank(j, end);
        j = end;
        continue;
      }
      if (c === "'" || c === '"') {
        let k = j + 1;
        while (k < n && text[k] !== c && text[k] !== '\n') {
          if (text[k] === '\\') k++;
          k++;
        }
        if (!keepStrings) blank(j + 1, k);
        j = k + 1;
        lastSig = c;
        continue;
      }
      if (c === '`') {
        j = template(j);
        lastSig = '`';
        continue;
      }
      if (c === '/' && (lastSig === '' || REGEX_PREV.test(lastSig) || /\b(return|typeof|in|of)$/.test(text.slice(Math.max(0, j - 7), j).trimEnd()))) {
        let k = j + 1;
        let cls = false;
        while (k < n && text[k] !== '\n') {
          if (text[k] === '\\') {
            k += 2;
            continue;
          }
          if (text[k] === '[') cls = true;
          else if (text[k] === ']') cls = false;
          else if (text[k] === '/' && !cls) break;
          k++;
        }
        if (!keepStrings) blank(j + 1, k);
        j = k + 1;
        while (/[a-z]/.test(text[j] ?? '')) j++;
        lastSig = '/';
        continue;
      }
      if (inTemplateExpr) {
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) return j + 1;
        }
      }
      if (!/\s/.test(c)) lastSig = c;
      j++;
    }
    return j;
  };
  code(0, false);
  return out.join('');
}

// Every defineCommand call of a source: its literal name (null when the name is not a plain string) and its code.
export function commandBlocks(original: string): { name: string | null; block: string }[] {
  const s = scrub(original, false);
  const out: { name: string | null; block: string }[] = [];
  for (const m of s.matchAll(/defineCommand\s*(?:<[^()]*?>)?\s*\(\s*\{/g)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    while (i < s.length && depth > 0) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
      i++;
    }
    const block = original.slice(m.index ?? 0, i);
    const name = /\bname:\s*(['"`])([^'"`$\\]+)\1\s*,/.exec(block)?.[2] ?? null;
    out.push({ name, block });
  }
  return out;
}

// What a sink's source must show: the copied text stays tainted and the row points at the run it came from.
export function sinkProblems(block: string): string[] {
  const body = scrub(block, true);
  const problems: string[] = [];
  if (!/\btainted\b/.test(body)) problems.push('keeps no taint on what it copies');
  if (!/\bsource_ref\b|\bsourceRef\b|\bsource_run_id\b|\bsourceRunId\b/.test(body)) problems.push('carries no source_ref to the run');
  return problems;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'dist' || name === '.next' || name === 'generated') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(ROOT, path).replace(/\\/g, '/');
const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir))).map((path) => ({ path: rel(path), abs: path, text: readFileSync(path, 'utf8') }));
const readers = files.filter((f) => PRIVATE_ROWS.test(scrub(f.text, true)));

describe('what a member’s Vy wrote is named only by the files that may, and read only by sinks and known consumers', () => {
  it('the scan reads the sources and finds the reader files', () => {
    expect(SCANNED).toEqual(expect.arrayContaining(['apps/kernel/src', 'modules', 'packages']));
    expect(files.length).toBeGreaterThan(500);
    expect(readers.map((f) => f.path)).toEqual(expect.arrayContaining(['packages/kernel/src/member-vy.ts', 'modules/meetings/src/transcribe.ts']));
  });

  it('no file outside the frozen list names a private row (a constant, a helper or a command in any other file is caught here)', () => {
    expect(readers.map((f) => f.path).filter((p) => !READER_FILES.includes(p))).toEqual([]);
    for (const path of READER_FILES) expect(existsSync(join(ROOT, path)), `${path} exists`).toBe(true);
  });

  it('the kernel’s own files define only commands of their own namespaces', () => {
    for (const [path, prefixes] of Object.entries(KERNEL_FILES)) {
      const file = files.find((f) => f.path === path);
      const names = commandBlocks(file?.text ?? '').map((c) => c.name);
      expect(names.filter((n) => n === null || !prefixes.some((p) => n.startsWith(p))), path).toEqual([]);
    }
  });

  it('every command defined in a consumer file has a literal name and is a sink or a known consumer', () => {
    const allowed = new Set([...MEMBER_VY_SINKS, ...MEMBER_VY_KNOWN_CONSUMERS]);
    for (const path of CONSUMER_FILES) {
      const file = files.find((f) => f.path === path);
      const found = commandBlocks(file?.text ?? '');
      expect(found.length, `${path} defines commands`).toBeGreaterThan(0);
      expect(found.filter((c) => c.name === null).length, `${path}: a command named by a variable`).toBe(0);
      expect(found.map((c) => c.name as string).filter((n) => !allowed.has(n)), path).toEqual([]);
    }
  });

  it('the files that import a reader file are the frozen ones', () => {
    for (const [target, importers] of Object.entries(IMPORTERS)) {
      const found = files
        .filter((f) => [...scrub(f.text, true).matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)].some((m) => resolve(dirname(f.abs), (m[1] as string).replace(/\.js$/, '.ts')) === join(ROOT, target)))
        .map((f) => f.path)
        .sort();
      expect(found, `importers of ${target}`).toEqual([...importers].sort());
    }
  });

  it('the known consumers are frozen: nothing outside the baseline, each still a registered command, none also a sink', () => {
    const registered = new Set([...kernelCommands, ...meetingsCommands].map((c) => c.name));
    expect(MEMBER_VY_KNOWN_CONSUMERS.filter((n) => !FROZEN_BASELINE.includes(n))).toEqual([]);
    expect(MEMBER_VY_KNOWN_CONSUMERS.filter((n) => !registered.has(n))).toEqual([]);
    expect(MEMBER_VY_KNOWN_CONSUMERS.filter((n) => MEMBER_VY_SINKS.includes(n))).toEqual([]);
    expect(new Set(MEMBER_VY_KNOWN_CONSUMERS).size).toBe(MEMBER_VY_KNOWN_CONSUMERS.length);
  });

  it('every sink is a registered command whose source keeps taint and carries a source_ref to the run', () => {
    const registered = new Set([...kernelCommands, ...meetingsCommands].map((c) => c.name));
    const blocks = files.flatMap((f) => commandBlocks(f.text));
    for (const sink of MEMBER_VY_SINKS) {
      expect(registered.has(sink), `${sink} is registered`).toBe(true);
      const found = blocks.filter((c) => c.name === sink);
      expect(found.length, `${sink} is defined once with a literal name`).toBe(1);
      expect(sinkProblems(found[0]?.block ?? ''), sink).toEqual([]);
    }
    expect(new Set(MEMBER_VY_SINKS).size).toBe(MEMBER_VY_SINKS.length);
  });
});

describe('the scan recognizes what it must', () => {
  const reader = `export const x = defineCommand({ name: 'a.b.c', input: z.object({}), handler: async (ctx) => { await ctx.query('kernel.member_vy.result.get', {}); } });`;

  it('finds a private row by query, by table, by a constant and by a built name, and ignores a comment', () => {
    for (const text of [
      reader,
      `const y = defineCommand<I, O>({ name: 'a.b.d', handler: async (ctx) => { await ctx.trx.selectFrom('crove_kernel.member_vy_result as v').execute(); } });`,
      `const T = 'member_vy_result';`,
      "const t = 'member_vy_' + kind;",
    ]) expect(PRIVATE_ROWS.test(scrub(text, true)), text).toBe(true);
    expect(PRIVATE_ROWS.test(scrub('// member_vy_result\n/* member_vy_memory */ const a = 1;', true))).toBe(false);
  });

  it('matches braces correctly around a } or a { in a string, a template, a regular expression and a comment', () => {
    const tricky = `const a = defineCommand({ name: 'a.b.g', handler: async () => { const s = "}"; const t = \`}\${'}'}\`; const r = /}/; /* } */ return s + t + r; } });\nconst b = defineCommand({ name: 'a.b.h', handler: async () => 1 });`;
    expect(commandBlocks(tricky).map((c) => c.name)).toEqual(['a.b.g', 'a.b.h']);
    expect(commandBlocks(tricky)[0]?.block).toContain('/* } */');
  });

  it('reports a command named by a variable as having no literal name', () => {
    expect(commandBlocks(`defineCommand({ name: NAME, handler: async () => 1 });`).map((c) => c.name)).toEqual([null]);
  });

  it('a sink must show taint and a source_ref, and a word in a comment does not count', () => {
    expect(sinkProblems(`defineCommand({ name: 's.x', handler: async () => { insert({ tainted: true, source_ref: runId }); } })`)).toEqual([]);
    expect(sinkProblems(`defineCommand({ name: 's.y', handler: async () => { insert({ source_ref: runId }); } })`)).toEqual(['keeps no taint on what it copies']);
    expect(sinkProblems(`defineCommand({ name: 's.z', handler: async () => { insert({ tainted: true }); } })`)).toEqual(['carries no source_ref to the run']);
    expect(sinkProblems(`defineCommand({ name: 's.w', handler: async () => { /* tainted source_ref */ } })`)).toHaveLength(2);
  });
});
