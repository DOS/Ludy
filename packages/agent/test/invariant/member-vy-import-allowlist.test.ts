// SPDX-License-Identifier: AGPL-3.0-only
// Who may import the member-Vy modules of packages/agent (ADR-0049 decision 9, issue #2783): "@crove/agent/member-vy" exports the raw ports,
// privateText and revealPrivateText, so any workspace package could otherwise unwrap a private text or plug in a provider. Outside test
// directories only the kernel's member-Vy wiring may import it; the main entry of the package does not re-export it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ALLOWED = new Set(['apps/kernel/src/member-vy-ports.ts']);
const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'generated', 'coverage']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(path);
  }
  return out;
}

// An import, export-from, dynamic import or require that names the member-Vy entry, by its package path or by a relative path into the folder.
const NAMES_IT = /['"`](?:@crove\/agent\/member-vy|(?:\.\.?\/)+(?:packages\/agent\/)?(?:src\/)?member-vy(?:\/[^'"`]*)?|[^'"`]*packages\/agent\/src\/(?:member-vy|private-text)[^'"`]*)['"`]/;

describe('who imports the member-Vy modules', () => {
  it('flags an import of the entry (the scan is not vacuous)', () => {
    expect(NAMES_IT.test(`import { revealPrivateText } from '@crove/agent/member-vy';`)).toBe(true);
    expect(NAMES_IT.test(`const m = await import('../../../packages/agent/src/member-vy/index.ts');`)).toBe(true);
    expect(NAMES_IT.test(`import { x } from '@crove/agent';`)).toBe(false);
  });

  it('lets only the kernel wiring (and tests) import them', () => {
    const files = ['apps', 'packages', 'modules', 'e2e', 'tools'].flatMap((d) => {
      try {
        return sources(join(ROOT, d));
      } catch {
        return [];
      }
    });
    const outside = files
      .map((file) => relative(ROOT, file))
      .filter((file) => !file.startsWith('packages/agent/src/member-vy/') && !file.startsWith('packages/agent/src/private-text.ts'))
      .filter((file) => !/(^|\/)test\//.test(file) && !ALLOWED.has(file))
      .filter((file) => NAMES_IT.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(outside, 'a module outside the kernel wiring imports the member-Vy entry').toEqual([]);
  });
});
