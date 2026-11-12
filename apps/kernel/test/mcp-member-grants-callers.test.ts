// SPDX-License-Identifier: AGPL-3.0-only
// crove_kernel.mcp_member_grants_for_user(user) answers, for a user id it is given, which orgs that user belongs to and whether each lets members connect their own AI app
// (ADR-0051 decision 2, slice 3, step 3b-3). It is safe only when called with the signed-in user's own id, never one taken from a request. This pins the call sites: it is
// called from exactly one place, apps/kernel/src/mcp-endpoint.ts, and there only with `user.userId` of the signed-in user.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

describe('the callers of mcp_member_grants_for_user (#2975, slice 3, step 3b-3)', () => {
  it('is called from the MCP endpoint alone, and only with the signed-in user\'s own id', () => {
    const hits: Array<{ file: string; call: string }> = [];
    for (const dir of ['apps', 'packages', 'modules']) {
      for (const file of sources(join(ROOT, dir))) {
        if (file.includes(join('apps', 'kernel', 'test')) || file.includes(join('e2e'))) continue;
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/mcp_member_grants_for_user\(([^)]*)\)/g)) hits.push({ file: relative(ROOT, file), call: m[1] ?? '' });
      }
    }
    expect(hits.map((h) => h.file)).toEqual([join('apps', 'kernel', 'src', 'mcp-endpoint.ts')]);
    expect(hits.map((h) => h.call.trim())).toEqual(['${user.userId}::uuid']);
  });
});
