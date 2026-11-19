// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { legacyCroveInvariantBridge } from '../../vitest.invariant.config.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('legacyCroveInvariantBridge (#3965 step 1 of 2)', () => {
  it('rejects missing package names, duplicate full names, and cross-scope slug collisions', () => {
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
  });

  it('stays inactive while any @crove/* manifest exists and leaves non-invariant importers untouched', async () => {
    const mixed = makeTempDir('ludy-bridge-mixed-');
    writeManifest(mixed, 'packages/kernel', { name: '@crove/kernel' });
    writeManifest(mixed, 'packages/db', { name: '@ludy/db' });
    const mixedBridge = legacyCroveInvariantBridge(mixed);
    const noopCtx = { resolve: async () => ({ id: '/never' }) };
    await expect(
      mixedBridge.resolveId.call(noopCtx, '@crove/db', join(mixed, 'apps/kernel/test/invariant/x.test.ts')),
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

  it('fails closed when a mapped @ludy/* package is missing, unresolvable, or outside the package dir even if @crove/* resolves', async () => {
    const root = makeTempDir('ludy-bridge-fail-');
    const dbDir = writeManifest(root, 'packages/db', { name: '@ludy/db' });
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

    // Real Vitest run where node_modules/@crove/stale resolves on disk while @ludy/stale does not exist in workspace.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(root, 'vitest.invariant.config.ts'), readFileSync(join(REPO_ROOT, 'vitest.invariant.config.ts')));
    mkdirSync(join(root, 'node_modules/@crove/stale/src'), { recursive: true });
    for (const entry of readdirSync(join(REPO_ROOT, 'node_modules'))) {
      if (entry !== '@crove') symlinkSync(resolve(REPO_ROOT, 'node_modules', entry), join(root, 'node_modules', entry));
    }
    writeFileSync(join(root, 'node_modules/@crove/stale/package.json'), JSON.stringify({ name: '@crove/stale', type: 'module', exports: { '.': './src/index.ts' } }));
    writeFileSync(join(root, 'node_modules/@crove/stale/src/index.ts'), 'export const OK = true;\n');

    mkdirSync(join(root, 'apps/kernel/test/invariant'), { recursive: true });
    writeFileSync(
      join(root, 'apps/kernel/test/invariant/stale-fallback.test.ts'),
      "import { expect, it } from 'vitest';\nimport { OK } from '@crove/stale';\nit('never loads stale @crove/*', () => { expect(OK).toBe(true); });\n",
    );

    const run = spawnSync(
      process.execPath,
      [VITEST_BIN, 'run', '--config', 'vitest.invariant.config.ts', 'apps/kernel/test/invariant/stale-fallback.test.ts'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/missing workspace package @ludy\/stale/);
  }, 30_000);
});
