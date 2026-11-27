// SPDX-License-Identifier: AGPL-3.0-only
// The license header check for new source files (#1953): which files it reads, the line it accepts, and the line it asks
// for.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HEADER_LINE, IDENTIFIER, checkedPaths, defaultBase, escapeData, escapeProperty, hasHeader, headerFor, missingHeaders } from '../ci/spdx-header.mjs';

describe('SPDX header check', () => {
  it('reads new TypeScript, JavaScript and SQL sources, but not third-party files or other kinds', () => {
    expect(
      checkedPaths([
        'packages/kernel/src/new.ts',
        'apps/app/src/routes/new.tsx',
        'tools/ci/new.mjs',
        'supabase/migrations/20261107000000_crove_kernel_x.sql',
        'supabase/migrations/20261107010000_crove_jobs_pgboss_v47.sql',
        'supabase/migrations/20261107020000_ludy_kernel_x.sql',
        'supabase/migrations/20261107030000_ludy_jobs_pgboss_v48.sql',
        'packages/db/test/invariant/pgtap/pgtap.sql',
        'docs/plan/new.md',
        'apps/app/src/styles.css',
        'packages/agent/test/fixtures/extraction/new.json',
      ]),
    ).toEqual([
      'packages/kernel/src/new.ts',
      'apps/app/src/routes/new.tsx',
      'tools/ci/new.mjs',
      'supabase/migrations/20261107000000_crove_kernel_x.sql',
      'supabase/migrations/20261107020000_ludy_kernel_x.sql',
    ]);
  });

  it('accepts the AGPL-3.0-only line near the top, in the file kind\'s comment', () => {
    // The pattern names the identifier the check asks for.
    expect(HEADER_LINE.test(`// SPDX-License-Identifier: ${IDENTIFIER}`)).toBe(true);
    expect(hasHeader('// SPDX-License-Identifier: AGPL-3.0-only\n// The module.\nexport {};\n')).toBe(true);
    expect(hasHeader('#!/usr/bin/env node\n// SPDX-License-Identifier: AGPL-3.0-only\n')).toBe(true);
    expect(hasHeader('-- SPDX-License-Identifier: AGPL-3.0-only\r\n-- Crove kernel (issue #1).\r\n')).toBe(true);
    expect(hasHeader('/* SPDX-License-Identifier: AGPL-3.0-only */\n')).toBe(true);
    // Another license, a near miss, a line too far down, or none.
    expect(hasHeader('// SPDX-License-Identifier: MIT\n')).toBe(false);
    expect(hasHeader('// SPDX-License-Identifier: AGPL-3.0-or-later\n')).toBe(false);
    expect(hasHeader('// SPDX-License-Identifier: AGPL-3.0-only-ish\n')).toBe(false);
    expect(hasHeader(`${'// x\n'.repeat(5)}// SPDX-License-Identifier: AGPL-3.0-only\n`)).toBe(false);
    expect(hasHeader('export const a = 1;\n')).toBe(false);
  });

  it('names each new file without the line, and the line to add', () => {
    const files: Record<string, string> = {
      'a.ts': '// SPDX-License-Identifier: AGPL-3.0-only\n',
      'b.ts': 'export {};\n',
      'c.sql': 'SELECT 1;\n',
      'README.md': 'no header\n',
    };
    expect(missingHeaders(Object.keys(files), (path: string) => files[path] ?? '')).toEqual(['b.ts', 'c.sql']);
    expect(headerFor('b.ts')).toBe('// SPDX-License-Identifier: AGPL-3.0-only');
    expect(headerFor('c.sql')).toBe('-- SPDX-License-Identifier: AGPL-3.0-only');
  });

  it('escapes a path in the annotation, so it cannot end it or start another command', () => {
    expect(escapeProperty('a,b:c%d\n::error::x.ts')).toBe('a%2Cb%3Ac%25d%0A%3A%3Aerror%3A%3Ax.ts');
    expect(escapeData('line\r\n::warning::x')).toBe('line%0D%0A::warning::x');
  });
});

describe('defaultBase', () => {
  let dir = '';
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function initRepo(): string {
    dir = mkdtempSync(join(tmpdir(), 'crove-spdx-header-'));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    run('config', 'core.hooksPath', join(dir, '.no-hooks'));
    run('config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'README.md'), 'init\n');
    run('add', 'README.md');
    run('commit', '-q', '-m', 'init');
    return run('rev-parse', 'HEAD').trim();
  }

  it('returns origin/dev when both refs/remotes/origin/dev and refs/remotes/origin/main exist', () => {
    const head = initRepo();
    run('update-ref', 'refs/remotes/origin/main', head);
    run('update-ref', 'refs/remotes/origin/dev', head);
    expect(defaultBase(dir)).toBe('origin/dev');
  }, 60_000);

  it('falls back to origin/main when refs/remotes/origin/dev is absent', () => {
    const head = initRepo();
    run('update-ref', 'refs/remotes/origin/main', head);
    expect(defaultBase(dir)).toBe('origin/main');
  }, 60_000);
});
