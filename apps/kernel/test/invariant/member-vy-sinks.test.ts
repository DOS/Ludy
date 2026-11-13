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
  'packages/db/src/generated/database.ts': [],
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
  'packages/db/src/schema.ts': ['packages/db/src/cells.ts', 'packages/db/src/index.ts'],
  'packages/db/src/generated/database.ts': ['packages/db/src/schema.ts'],
  'packages/kernel/src/manifest.ts': [
    'packages/kernel/src/agents.ts',
    'packages/kernel/src/inbox-items.ts',
    'packages/kernel/src/index.ts',
    'packages/kernel/src/legal-entities.ts',
    'packages/kernel/src/member-vy.ts',
    'packages/kernel/src/org-address.ts',
    'packages/kernel/src/parties.ts',
    'packages/kernel/src/subject-key-reseal.ts',
    'packages/kernel/src/tax-code.ts',
  ],
  'packages/kernel/src/member-vy.ts': ['packages/kernel/src/agents.ts', 'packages/kernel/src/commands.ts', 'packages/kernel/src/index.ts', 'packages/kernel/src/queries.ts', 'packages/kernel/src/roles.ts'],
  'packages/kernel/src/personal-data.ts': ['packages/kernel/src/commands.ts', 'packages/kernel/src/index.ts', 'packages/kernel/src/notifications.ts'],
};

// The package entries (barrels) that re-export a reader file, with the files that import them: frozen like the others.
// Only the meetings entry is listed: the @crove/kernel and @crove/db entries are imported by nearly every file, and what they export of the Vy files is the kernel's own
// namespaces (member_vy.*, vy_data.*, personal_data.*), which the importers lists above and the namespace check already pin.
const BARREL_IMPORTERS: Record<string, string[]> = {
  'modules/meetings/src/index.ts': ['apps/kernel/src/kernel.ts', 'apps/kernel/src/media-seal.ts', 'apps/kernel/src/meetings-transcribe.ts'],
};

const PRIVATE_ROWS =
  /member_vy_result|member_vy_memory|\bvy_(?:result|memory)|kernel\.member_vy\.result\.get|kernel\.member_vy\.memory\.list|member_vy_(?:['"`]\s*[+,)]|\$\{)|kernel\.member_vy\.[\w.]*\$\{/;
// A name split over string literals ('member' + '_vy_result') is joined before the match; one split over a computed value is caught by the fragments above.
const joinLiterals = (text: string): string => text.replace(/(['"`])\s*\+\s*(['"`])/g, '');
const namesPrivateRow = (text: string): boolean => {
  const s = scrub(text, true);
  return PRIVATE_ROWS.test(s) || PRIVATE_ROWS.test(joinLiterals(s));
};

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

// Everything inside a src folder is scanned, tests and generated code included (a folder named test or generated inside src hides nothing). Only a package's own
// test and build folders beside src, and installed or built output, are skipped.
function sources(dir: string, inSrc = false): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    if (!inSrc && (name === 'test' || name === 'tests')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path, inSrc || name === 'src'));
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(ROOT, path).replace(/\\/g, '/');
const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir))).map((path) => ({ path: rel(path), abs: path, text: readFileSync(path, 'utf8') }));
// Workspace packages by name, so an import of '@crove/mod-meetings' or '@crove/kernel/x' resolves to the file it enters (a barrel's importers are not missed).
const packageEntries: Record<string, string> = {};
const packageNames: Record<string, string[]> = {};
for (const group of ['apps', 'modules', 'packages']) {
  if (!existsSync(join(ROOT, group))) continue;
  for (const dir of readdirSync(join(ROOT, group))) {
    const pj = join(ROOT, group, dir, 'package.json');
    if (!existsSync(pj)) continue;
    const pkg = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; exports?: Record<string, unknown> | string };
    if (!pkg.name) continue;
    const exp = typeof pkg.exports === 'string' ? { '.': pkg.exports } : (pkg.exports ?? {});
    for (const [sub, target] of Object.entries(exp)) {
      if (typeof target !== 'string') continue;
      const file = rel(resolve(join(ROOT, group, dir), target));
      packageEntries[sub === '.' ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, '')}`] = file;
      (packageNames[file] ??= []).push(pkg.name);
    }
  }
}
// The repository files a source imports or re-exports: relative paths and workspace package names, from import, export ... from, import() and require().
function importedFiles(f: { abs: string; text: string }): string[] {
  const out: string[] = [];
  for (const m of scrub(f.text, true).matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1] as string;
    if (spec.startsWith('.')) out.push(rel(resolve(dirname(f.abs), spec.replace(/\.js$/, '.ts'))));
    else if (packageEntries[spec]) out.push(packageEntries[spec] as string);
  }
  return out;
}
const readers = files.filter((f) => namesPrivateRow(f.text));

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

  it('the files that import a reader file, by a relative path or by its package name, are the frozen ones (all reader files, a barrel included)', () => {
    const found: Record<string, string[]> = {};
    for (const f of files) {
      for (const target of importedFiles(f)) if (READER_FILES.includes(target) && target !== f.path) (found[target] ??= []).push(f.path);
    }
    for (const path of READER_FILES) expect([...new Set(found[path] ?? [])].sort(), `importers of ${path}`).toEqual([...(IMPORTERS[path] ?? [])].sort());
    // A package entry that re-exports a reader file is a way in too: the files that import that package by name are frozen as well.
    for (const [entry, importers] of Object.entries(BARREL_IMPORTERS)) {
      const names = packageNames[entry] ?? [];
      expect(names.length, `${entry} is a package entry`).toBeGreaterThan(0);
      const via = files.filter((f) => importedFiles(f).includes(entry) && f.path !== entry).map((f) => f.path);
      expect([...new Set(via)].sort(), `importers of ${entry}`).toEqual([...importers].sort());
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
      'const u = `member_vy_${kind}`;',
      "const v = `kernel.member_vy.${what}.get`;",
      "const w = 'member' + '_vy_result';",
      "const x = 'member_vy' + '_memory';",
      "const z = ['member', 'vy_result'].join('');",
    ]) expect(namesPrivateRow(text), text).toBe(true);
    expect(namesPrivateRow('// member_vy_result\n/* member_vy_memory */ const a = 1;')).toBe(false);
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
