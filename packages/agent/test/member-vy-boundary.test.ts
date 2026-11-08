// SPDX-License-Identifier: AGPL-3.0-only
// The stage A write boundary of Vy working for one member (ADR-0049, "The write boundary of stage A", decision 4 layer 3
// and decision 9; issue #2754). In stage A a member-Vy run is the member's whole user context, so the line is held in
// code and pinned here, in the pattern of meter-coverage.test.ts:
//   - a member-Vy feature module (packages/agent/src/member-vy/**) is pure: it imports no runtime, no database client and
//     no vendor SDK, names no command and no table, and never calls execute();
//   - features reach the model, memory and knowledge through the provider ports, never a vendor client (decision 9);
//   - the org-level features outside that directory take plain strings: none imports a member-Vy module or the branded
//     PrivateText type (decision 4 layer 3).
// The directory may not exist yet: the scan then has nothing to read, and the scanner's own cases below keep it honest.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(ROOT, 'packages/agent/src');
const MEMBER_VY = join(SRC, 'member-vy');

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (m) => (m[1] ?? m[2] ?? m[3]) as string,
  );

// What a member-Vy feature module must never import: the command runtime and the kernel, the database, and the vendors behind the ports.
const BANNED_IMPORT = /^(?:node:(?:https?|http2|net|tls|dgram)$|https?$|undici$|axios$|@crove\/(?:kernel|kernel-runtime|kernel-contract|db|mod-[a-z-]+)(?:\/|$)|kysely$|pg$|ai$|@ai-sdk\/|openai$|@anthropic-ai\/|mem0|@mem0\/|zep|@getzep\/|langchain|@langchain\/)/;

// The violations of one member-Vy feature module's source, as short reasons.
export function memberVyViolations(text: string): string[] {
  const out: string[] = [];
  for (const spec of specifiers(text)) if (BANNED_IMPORT.test(spec)) out.push(`imports ${spec}`);
  // A command name: a module namespace and two or more further segments in a string (kernel.member_vy.result.store, notes.todo.create). A feature key has two (notes.summary).
  for (const m of text.matchAll(/['"`]((?:kernel|notes|meetings|finance|crm|hr|social|projects|calendar|desk)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)['"`]/g)) out.push(`names the command or path ${m[1]}`);
  // A table name, and a call that runs a command.
  if (/\bcrove_[a-z]+\./.test(text)) out.push('names a crove_ table');
  if (/\bexecute\s*\(/.test(text)) out.push('calls execute()');
  // A direct network call: the provider interface (decision 9) is the only way out.
  if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(text)) out.push('calls the network directly');
  return out;
}

// What org-level features outside member-vy/ must never reach for: a member-Vy module, or the private-text brand.
export function orgFeatureViolations(text: string): string[] {
  const out: string[] = [];
  for (const spec of specifiers(text)) if (/(^|\/)member-vy(\/|$)|(^|\/)private-text(\.ts)?$/.test(spec)) out.push(`imports ${spec}`);
  if (/\bPrivateText\b/.test(text)) out.push('names PrivateText');
  return out;
}

describe('member-Vy feature modules are pure (ADR-0049, stage A write boundary)', () => {
  it('flags what a pure feature must not do (the scanner is not vacuous)', () => {
    expect(memberVyViolations(`import { Runtime } from '@crove/kernel-runtime';`)).toEqual(['imports @crove/kernel-runtime']);
    expect(memberVyViolations(`import { generateText } from 'ai';\nimport z from 'zod';`)).toEqual(['imports ai']);
    expect(memberVyViolations(`import mem from 'mem0ai';`)).toEqual(['imports mem0ai']);
    expect(memberVyViolations(`const c = 'notes.todo.create';`)).toEqual(['names the command or path notes.todo.create']);
    expect(memberVyViolations('await runtime.execute(cmd, input, ctx);')).toEqual(['calls execute()']);
    expect(memberVyViolations(`const t = 'crove_kernel.member_vy_result';`)).toContain('names a crove_ table');
    expect(memberVyViolations('const q = `\nINSERT INTO crove_kernel.member_vy_memory\n`;')).toContain('names a crove_ table');
    expect(memberVyViolations('const { execute } = rt; await execute(c);')).toContain('calls execute()');
    expect(memberVyViolations(`await fetch('https://x.test');`)).toEqual(['calls the network directly']);
    expect(memberVyViolations(`import https from 'node:https';`)).toEqual(['imports node:https']);
    // What is allowed: zod, a relative module, a two-segment feature key, plain text.
    expect(memberVyViolations(`import { z } from 'zod';\nimport { metered } from '../meter.ts';\nconst f = 'notes.summary';`)).toEqual([]);
    expect(orgFeatureViolations(`import { x } from './member-vy/summary.ts';`)).toEqual(['imports ./member-vy/summary.ts']);
    expect(orgFeatureViolations(`import type { PrivateText } from './private-text.ts';`)).toEqual(['imports ./private-text.ts', 'names PrivateText']);
    expect(orgFeatureViolations(`import { z } from 'zod';`)).toEqual([]);
  });

  it('keeps every module under packages/agent/src/member-vy pure', () => {
    const bad = sources(MEMBER_VY).flatMap((file) => memberVyViolations(readFileSync(file, 'utf8')).map((v) => `${relative(ROOT, file)}: ${v}`));
    expect(bad).toEqual([]);
  });

  it('keeps every org-level feature to plain strings: none imports a member-Vy module or the PrivateText brand', () => {
    const bad = sources(SRC)
      .filter((file) => !file.startsWith(`${MEMBER_VY}/`) && !file.endsWith('/private-text.ts'))
      .flatMap((file) => orgFeatureViolations(readFileSync(file, 'utf8')).map((v) => `${relative(ROOT, file)}: ${v}`));
    expect(bad).toEqual([]);
  });
});
