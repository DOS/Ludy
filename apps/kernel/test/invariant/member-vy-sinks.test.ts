// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): the sinks of a member's Vy (ADR-0049 decision 4, ADR-0047 point 8; issue #2822). What Vy wrote for one member is private
// to the member, and a command that reads it and writes where others can see is on the kernel's MEMBER_VY_SINKS list or it does not exist. This is a
// ratchet: the consumers that existed before the list did are MEMBER_VY_KNOWN_CONSUMERS, frozen here (FROZEN_BASELINE), so the list can only shrink.
// The scan reads the sources of every app, module and package, finds each command definition (a defineCommand call, brace-matched) and asks whether its
// code names the private rows: the tables member_vy_result and member_vy_memory, or the queries kernel.member_vy.result.get and kernel.member_vy.memory.list.
// Keep this directory self-contained: no imports from outside test/invariant/ but the code under test.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEMBER_VY_KNOWN_CONSUMERS, MEMBER_VY_SINKS } from '@crove/kernel';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCANNED = [...readdirSync(join(ROOT, 'apps')).map((app) => `apps/${app}/src`), 'modules', 'packages'].filter((dir) => existsSync(join(ROOT, dir)));

// The consumers that existed when the list was made (#2941). Frozen: MEMBER_VY_KNOWN_CONSUMERS may hold these and nothing else, so it can only shrink.
const FROZEN_BASELINE = ['meetings.summary.copy_result', 'meetings.summary.start', 'meetings.transcript.copy_result', 'meetings.transcript.start'];

// The kernel's own: the Vy commands themselves, the sweeps that delete (kernel.vy_data.*), and the personal-data erasure, which only deletes.
const KERNEL_OWNED = (name: string) => name.startsWith('kernel.member_vy.') || name.startsWith('kernel.vy_data.') || name === 'kernel.personal_data.erase';

const PRIVATE_ROWS = /member_vy_result|member_vy_memory|kernel\.member_vy\.result\.get|kernel\.member_vy\.memory\.list/;

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
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

// Every defineCommand block of a source: its name and its code, brace-matched from the opening of the object.
export function commandBlocks(text: string): { name: string; block: string }[] {
  const body = code(text);
  const out: { name: string; block: string }[] = [];
  for (const m of body.matchAll(/defineCommand\s*(?:<[^>]*>)?\s*\(\s*\{/g)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    while (i < body.length && depth > 0) {
      const ch = body[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const block = body.slice(m.index ?? 0, i);
    const name = /name:\s*['"]([^'"]+)['"]/.exec(block)?.[1];
    if (name) out.push({ name, block });
  }
  return out;
}

// What a sink's source must show: the copied text stays tainted and the row points at the run it came from.
export function sinkProblems(block: string): string[] {
  const problems: string[] = [];
  if (!/\btainted\b/.test(block)) problems.push('keeps no taint on what it copies');
  if (!/\bsource_ref\b|\bsourceRef\b|\bsource_run_id\b|\bsourceRunId\b/.test(block)) problems.push('carries no source_ref to the run');
  return problems;
}

const all = SCANNED.flatMap((dir) => sources(join(ROOT, dir)).map((path) => ({ path: relative(ROOT, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') })));
const commands = all.flatMap((f) => commandBlocks(f.text).map((c) => ({ ...c, path: f.path })));

describe('commands that read what a member’s Vy wrote are sinks or known consumers', () => {
  it('the scan finds commands, and the kernel’s own Vy commands among the readers', () => {
    expect(SCANNED).toEqual(expect.arrayContaining(['apps/kernel/src', 'modules', 'packages']));
    expect(commands.length).toBeGreaterThan(100);
    expect(commands.filter((c) => PRIVATE_ROWS.test(c.block) && KERNEL_OWNED(c.name)).map((c) => c.name)).toEqual(expect.arrayContaining(['kernel.member_vy.result.store']));
  });

  it('no command outside the kernel’s Vy namespaces reads the private rows unless it is a sink or a known consumer', () => {
    const readers = commands.filter((c) => PRIVATE_ROWS.test(c.block) && !KERNEL_OWNED(c.name)).map((c) => `${c.name} (${c.path})`);
    const allowed = new Set([...MEMBER_VY_SINKS, ...MEMBER_VY_KNOWN_CONSUMERS]);
    expect(readers.filter((r) => !allowed.has(r.split(' ')[0] as string))).toEqual([]);
  });

  it('the known consumers are frozen: nothing outside the baseline, each still a command, none also a sink', () => {
    const names = new Set(commands.map((c) => c.name));
    expect(MEMBER_VY_KNOWN_CONSUMERS.filter((n) => !FROZEN_BASELINE.includes(n))).toEqual([]);
    expect(MEMBER_VY_KNOWN_CONSUMERS.filter((n) => !names.has(n))).toEqual([]);
    expect(MEMBER_VY_KNOWN_CONSUMERS.filter((n) => MEMBER_VY_SINKS.includes(n))).toEqual([]);
    expect(new Set(MEMBER_VY_KNOWN_CONSUMERS).size).toBe(MEMBER_VY_KNOWN_CONSUMERS.length);
  });

  it('every sink is a real command that keeps taint and carries a source_ref to the run', () => {
    for (const sink of MEMBER_VY_SINKS) {
      const found = commands.filter((c) => c.name === sink);
      expect(found.length, `${sink} is a command`).toBe(1);
      expect(sinkProblems(found[0]?.block ?? ''), sink).toEqual([]);
    }
    expect(new Set(MEMBER_VY_SINKS).size).toBe(MEMBER_VY_SINKS.length);
  });
});

describe('the scan recognizes what it must', () => {
  const reader = `export const x = defineCommand({ name: 'a.b.c', input: z.object({}), handler: async (ctx) => { await ctx.query('kernel.member_vy.result.get', {}); } });`;
  const tableReader = `const y = defineCommand<I, O>({ name: 'a.b.d', handler: async (ctx) => { await ctx.trx.selectFrom('crove_kernel.member_vy_result as v').selectAll().execute(); } });`;
  const bystander = `const z1 = defineCommand({ name: 'a.b.e', handler: async () => { return 1; } });`;

  it('finds the commands that name a private row, by query or by table, and not the others', () => {
    const found = commandBlocks(`${reader}\n${tableReader}\n${bystander}`).filter((c) => PRIVATE_ROWS.test(c.block)).map((c) => c.name);
    expect(found).toEqual(['a.b.c', 'a.b.d']);
  });

  it('ignores a comment that names a private row', () => {
    expect(commandBlocks(`// member_vy_result\nconst c = defineCommand({ name: 'a.b.f', handler: async () => 1 });`).filter((c) => PRIVATE_ROWS.test(c.block))).toEqual([]);
  });

  it('a sink must show taint and a source_ref', () => {
    expect(sinkProblems(`defineCommand({ name: 's.x', handler: async () => { insert({ tainted: true, source_ref: runId }); } })`)).toEqual([]);
    expect(sinkProblems(`defineCommand({ name: 's.y', handler: async () => { insert({ source_ref: runId }); } })`)).toEqual(['keeps no taint on what it copies']);
    expect(sinkProblems(`defineCommand({ name: 's.z', handler: async () => { insert({ tainted: true }); } })`)).toEqual(['carries no source_ref to the run']);
    expect(sinkProblems(`defineCommand({ name: 's.w', handler: async () => 1 })`)).toHaveLength(2);
  });
});
