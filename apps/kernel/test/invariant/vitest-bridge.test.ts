// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { legacyCroveInvariantBridge } from '../../../../vitest.invariant.config.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const VITEST_BIN = resolve(REPO_ROOT, 'node_modules/vitest/vitest.mjs');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function writeManifest(rootDir: string, relDir: string, pkg: Record<string, unknown>): string {
  const dir = join(rootDir, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

function linkVitestRuntime(tempRoot: string): void {
  mkdirSync(join(tempRoot, 'node_modules'), { recursive: true });
  for (const entry of readdirSync(join(REPO_ROOT, 'node_modules'))) {
    // Share installed dependencies via .pnpm and direct packages while keeping .vite/.vitest-cache local to tempRoot.
    if (entry === '@crove' || entry === '@ludy') continue;
    if (entry.startsWith('.') && entry !== '.pnpm') continue;
    symlinkSync(resolve(REPO_ROOT, 'node_modules', entry), join(tempRoot, 'node_modules', entry));
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('legacyCroveInvariantBridge (#3965 step 1 of 2)', () => {
  it('rejects missing package names, duplicate names/slugs, unexpected scopes, mixed scopes, and symlinks outside repo', () => {
    const missing = makeTempDir('ludy-bridge-missing-');
    writeManifest(missing, 'packages/bad', {});
    expect(() => legacyCroveInvariantBridge(missing)).toThrow(/has no package name/);

    const dupName = makeTempDir('ludy-bridge-dup-name-');
    writeManifest(dupName, 'packages/agent', { name: '@ludy/agent' });
    writeManifest(dupName, 'apps/shadow', { name: '@ludy/agent' });
    expect(() => legacyCroveInvariantBridge(dupName)).toThrow(/duplicate workspace package name/);

    const dupSlug = makeTempDir('ludy-bridge-dup-slug-');
    writeManifest(dupSlug, 'packages/kernel-runtime', { name: '@crove/kernel-runtime' });
    writeManifest(dupSlug, 'apps/shadow', { name: '@ludy/kernel-runtime' });
    expect(() => legacyCroveInvariantBridge(dupSlug)).toThrow(/duplicate workspace package slug/);

    const badScope = makeTempDir('ludy-bridge-bad-scope-');
    writeManifest(badScope, 'packages/db', { name: '@ludy/db' });
    writeManifest(badScope, 'apps/web', { name: 'web' });
    expect(() => legacyCroveInvariantBridge(badScope)).toThrow(/unexpected workspace package scope \(web\)/);

    const mixed = makeTempDir('ludy-bridge-mixed-');
    writeManifest(mixed, 'packages/kernel', { name: '@crove/kernel' });
    writeManifest(mixed, 'packages/db', { name: '@ludy/db' });
    expect(() => legacyCroveInvariantBridge(mixed)).toThrow(/mixed @crove\/\* and @ludy\/\*/);

    const escaping = makeTempDir('ludy-bridge-escape-');
    const externalTarget = makeTempDir('ludy-bridge-external-');
    writeFileSync(join(externalTarget, 'package.json'), JSON.stringify({ name: '@ludy/kernel-runtime' }));
    mkdirSync(join(escaping, 'apps'), { recursive: true });
    symlinkSync(externalTarget, join(escaping, 'apps/escaped'));
    expect(() => legacyCroveInvariantBridge(escaping)).toThrow(/resolves outside repo root/);

    const escapingManifest = makeTempDir('ludy-bridge-escape-manifest-');
    mkdirSync(join(escapingManifest, 'apps/local'), { recursive: true });
    symlinkSync(join(externalTarget, 'package.json'), join(escapingManifest, 'apps/local/package.json'));
    expect(() => legacyCroveInvariantBridge(escapingManifest)).toThrow(/resolves outside repo root/);
  });

  it('stays inactive when all packages use @crove/* and leaves non-invariant importers untouched', async () => {
    const legacy = makeTempDir('ludy-bridge-legacy-');
    writeManifest(legacy, 'packages/kernel', { name: '@crove/kernel' });
    writeManifest(legacy, 'packages/db', { name: '@crove/db' });
    const legacyBridge = legacyCroveInvariantBridge(legacy);
    const noopCtx = { resolve: async () => ({ id: '/never' }) };
    await expect(
      legacyBridge.resolveId.call(noopCtx, '@crove/db', join(legacy, 'apps/kernel/test/invariant/x.test.ts')),
    ).resolves.toBeNull();

    const activeRoot = makeTempDir('ludy-bridge-scope-');
    const pkgDir = writeManifest(activeRoot, 'packages/db', { name: '@ludy/db' });
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    const targetFile = join(pkgDir, 'src/index.ts');
    writeFileSync(targetFile, 'export {};\n');

    const activeBridge = legacyCroveInvariantBridge(activeRoot);
    const okCtx = { resolve: async () => ({ id: `${targetFile}?t=1` }) };

    await expect(
      activeBridge.resolveId.call(okCtx, '@crove/db', join(activeRoot, 'apps/kernel/src/main.ts')),
    ).resolves.toBeNull();
    await expect(
      activeBridge.resolveId.call(okCtx, '@crove/db', join(activeRoot, 'packages/agent/src/test/invariant/decoy.ts')),
    ).resolves.toBeNull();
    await expect(
      activeBridge.resolveId.call(okCtx, '@crove/db', join(activeRoot, 'apps/kernel/test/unit.test.ts')),
    ).resolves.toBeNull();
    await expect(
      activeBridge.resolveId.call(okCtx, '@crove/db', join(activeRoot, 'apps/kernel/test/invariant/check.test.ts?import')),
    ).resolves.toEqual({ id: `${targetFile}?t=1` });
  });

  it('fails closed on missing or outside packages and resolves renamed packages with subpaths in real Vitest runs', async () => {
    const root = makeTempDir('ludy-bridge-e2e-');
    const dbDir = writeManifest(root, 'packages/db', {
      name: '@ludy/db',
      type: 'module',
      exports: {
        '.': { import: './src/index.ts', default: './src/fallback.ts' },
        './migrate': './src/migrate.ts',
      },
    });
    mkdirSync(join(dbDir, 'src'), { recursive: true });
    writeFileSync(join(dbDir, 'src/index.ts'), "export const DB_TOKEN = 'db-esm';\nexport const SHARED_STATE = { status: 'commentary' };\n");
    writeFileSync(join(dbDir, 'src/fallback.ts'), "export const DB_TOKEN = 'db-fallback';\nexport const SHARED_STATE = { status: 'commentary' };\n");
    writeFileSync(join(dbDir, 'src/migrate.ts'), "export const MIGRATE_TOKEN = 'migrate-ok';\nexport const MIGRATE_OBJ = { kind: 'migrate' };\n");

    const elsewhere = join(root, 'outside.ts');
    writeFileSync(elsewhere, 'export {};\n');

    const bridge = legacyCroveInvariantBridge(root);
    const invFile = join(root, 'apps/kernel/test/invariant/x.test.ts');

    await expect(bridge.resolveId.call({ resolve: async () => ({ id: join(dbDir, 'src/index.ts') }) }, '@crove/missing', invFile)).rejects.toThrow(
      /missing workspace package @ludy\/missing/,
    );
    await expect(bridge.resolveId.call({ resolve: async () => null }, '@crove/db', invFile)).rejects.toThrow(
      /failed to resolve @ludy\/db/,
    );
    await expect(bridge.resolveId.call({ resolve: async () => ({ id: elsewhere }) }, '@crove/db', invFile)).rejects.toThrow(
      /resolved outside/,
    );

    // Real Vitest workspace with renamed @ludy/db (including ./migrate subpath) plus a stale @crove/stale package.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(root, 'vitest.invariant.config.ts'), readFileSync(join(REPO_ROOT, 'vitest.invariant.config.ts')));
    linkVitestRuntime(root);

    mkdirSync(join(root, 'node_modules/@ludy'), { recursive: true });
    symlinkSync(dbDir, join(root, 'node_modules/@ludy/db'));

    mkdirSync(join(root, 'node_modules/@crove/stale/src'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@crove/stale/package.json'), JSON.stringify({ name: '@crove/stale', type: 'module', exports: { '.': './src/index.ts' } }));
    writeFileSync(join(root, 'node_modules/@crove/stale/src/index.ts'), 'export const OK = true;\n');

    mkdirSync(join(root, 'apps/kernel/test/invariant'), { recursive: true });
    writeFileSync(
      join(root, 'apps/kernel/test/invariant/rename-success.test.ts'),
      [
        "import { expect, it, vi } from 'vitest';",
        "import { DB_TOKEN, SHARED_STATE } from '@crove/db';",
        "import { DB_TOKEN as LUDY_TOKEN, SHARED_STATE as LUDY_STATE } from '@ludy/db';",
        "import { MIGRATE_TOKEN, MIGRATE_OBJ } from '@crove/db/migrate';",
        "import { MIGRATE_TOKEN as LUDY_MIGRATE, MIGRATE_OBJ as LUDY_MIGRATE_OBJ } from '@ludy/db/migrate';",
        "vi.mock('@crove/db', async (importOriginal) => {",
        "  const real = await importOriginal();",
        "  return { ...real, SHARED_STATE: { status: 'mocked' } };",
        "});",
        "it('resolves @crove/* root and subpath imports to the exact same mocked @ludy/* module instances', () => {",
        "  expect(DB_TOKEN).toBe('db-esm');",
        '  expect(DB_TOKEN).toBe(LUDY_TOKEN);',
        '  expect(SHARED_STATE).toBe(LUDY_STATE);',
        "  expect(LUDY_STATE.status).toBe('mocked');",
        "  SHARED_STATE.status = 'confirmed';",
        "  expect(LUDY_STATE.status).toBe('confirmed');",
        "  expect(MIGRATE_TOKEN).toBe('migrate-ok');",
        '  expect(MIGRATE_TOKEN).toBe(LUDY_MIGRATE);',
        '  expect(MIGRATE_OBJ).toBe(LUDY_MIGRATE_OBJ);',
        '});',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'apps/kernel/test/invariant/stale-fallback.test.ts'),
      "import { expect, it } from 'vitest';\nimport { OK } from '@crove/stale';\nit('never loads stale @crove/*', () => { expect(OK).toBe(true); });\n",
    );

    const okRun = spawnSync(
      process.execPath,
      [VITEST_BIN, 'run', '--config', 'vitest.invariant.config.ts', 'apps/kernel/test/invariant/rename-success.test.ts'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(okRun.status, `${okRun.stdout}\n${okRun.stderr}`).toBe(0);

    const staleRun = spawnSync(
      process.execPath,
      [VITEST_BIN, 'run', '--config', 'vitest.invariant.config.ts', 'apps/kernel/test/invariant/stale-fallback.test.ts'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(staleRun.status).not.toBe(0);
    expect(`${staleRun.stdout}\n${staleRun.stderr}`).toMatch(/missing workspace package @ludy\/stale/);
  }, 30_000);
});
