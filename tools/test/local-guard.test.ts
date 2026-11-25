// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUARD_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../local-guard.mjs');

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CI;
  delete env.LUDY_FULL_LOCAL;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

describe('local-guard (owner order 2026-11-26)', () => {
  it.each([
    ['typecheck', []],
    ['typecheck', ['apps/app']],
    ['test', ['vitest', 'run', '--project', 'unit', '--', 'apps/app/test/foo.test.ts']],
    ['test:db', ['vitest', 'run', '--project', 'db', '--', 'apps/kernel/test/foo.db.test.ts']],
    ['test:e2e', ['pnpm', '--filter', '@ludy/e2e', 'test', '--', 'e2e/tests/home.spec.ts']],
  ])('refuses %s locally even with explicit targets', (name, args) => {
    const res = spawnSync(process.execPath, [GUARD_PATH, name, ...args], {
      env: baseEnv(),
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('2026-11-26');
    expect(res.stderr).toContain('pnpm lint');
  });

  it.each([
    { label: 'CI=true', override: { CI: 'true' } },
    { label: 'LUDY_FULL_LOCAL=1', override: { LUDY_FULL_LOCAL: '1' } },
  ])('forwards command, strips leading -- marker, and propagates exit code under $label', ({ override }) => {
    const env = baseEnv(override);

    const bareTypecheck = spawnSync(process.execPath, [GUARD_PATH, 'typecheck'], {
      env,
      encoding: 'utf8',
    });
    expect(bareTypecheck.status).toBe(0);

    const ok = spawnSync(
      process.execPath,
      [
        GUARD_PATH,
        'test',
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        '--',
        '--',
        'apps/app/test/a.test.ts',
      ],
      { env, encoding: 'utf8' },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('["apps/app/test/a.test.ts"]');

    const fail = spawnSync(
      process.execPath,
      [GUARD_PATH, 'test', process.execPath, '-e', 'process.exit(7)', '--'],
      { env, encoding: 'utf8' },
    );
    expect(fail.status).toBe(7);
  });
});
