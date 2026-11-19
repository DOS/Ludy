// Runner config for the invariant suite (Decision 7, External-tenant gate T15). On protected-path PRs,
// .github/workflows/protected.yml takes this file, every test/invariant/ directory and the pgTAP gate files
// (supabase/tests/database/_*.test.sql, #1643) from the base branch and runs them against the PR's code, so the
// PR's own vitest.config.ts cannot exclude or weaken them.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const INVARIANT_IMPORTER_RE = /^(?:apps|packages|modules)\/[^/]+\/test\/invariant\//;

// Two-step package rename bridge (#3965, ADR-0054): once all workspace packages carry the @ludy/* scope,
// rewrite @crove/<pkg> imports originating inside the base-branch invariant suite (never in PR application code)
// to @ludy/<pkg> and let Vite's standard package/exports resolver select the exact same module entry.
export function legacyCroveInvariantBridge(rootDir: string) {
  const pkgDirs: string[] = [];
  if (existsSync(join(rootDir, 'e2e', 'package.json'))) pkgDirs.push(join(rootDir, 'e2e'));
  for (const group of ['apps', 'modules', 'packages']) {
    const groupDir = join(rootDir, group);
    if (!existsSync(groupDir)) continue;
    for (const dir of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, dir);
      if (existsSync(join(pkgDir, 'package.json'))) pkgDirs.push(pkgDir);
    }
  }

  const seenNames = new Set<string>();
  const seenSlugs = new Set<string>();
  const names: string[] = [];
  const ludyPkgDirs = new Map<string, string>();
  for (const pkgDir of pkgDirs) {
    const manifestPath = join(pkgDir, 'package.json');
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
    if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
      throw new Error(`vitest.invariant.config.ts: ${manifestPath} has no package name`);
    }
    if (seenNames.has(pkg.name)) {
      throw new Error(`vitest.invariant.config.ts: duplicate workspace package name ${pkg.name} (${manifestPath})`);
    }
    seenNames.add(pkg.name);
    const slug = pkg.name.replace(/^@(?:crove|ludy)\//, '');
    if (seenSlugs.has(slug)) {
      throw new Error(`vitest.invariant.config.ts: duplicate workspace package slug ${slug} (${manifestPath})`);
    }
    seenSlugs.add(slug);
    names.push(pkg.name);
    if (pkg.name.startsWith('@ludy/')) {
      ludyPkgDirs.set(pkg.name.slice('@ludy/'.length), realpathSync(pkgDir));
    }
  }

  const bridgeActive = !names.some((name) => name.startsWith('@crove/'));

  return {
    name: 'legacy-crove-invariant-bridge',
    enforce: 'pre' as const,
    async resolveId(
      this: {
        resolve: (
          source: string,
          importer?: string,
          options?: { skipSelf?: boolean },
        ) => Promise<{ id: string } | null>;
      },
      source: string,
      importer?: string,
    ) {
      if (!bridgeActive || !importer || !source.startsWith('@crove/')) return null;
      const cleanImporter = importer.split(/[?#]/, 1)[0] ?? '';
      const relImporter = relative(rootDir, cleanImporter).replaceAll('\\', '/');
      if (!INVARIANT_IMPORTER_RE.test(relImporter)) return null;
      const rest = source.slice('@crove/'.length);
      const slug = rest.split('/', 1)[0] ?? '';
      const expectedDir = ludyPkgDirs.get(slug);
      if (!expectedDir) {
        throw new Error(`legacy-crove-invariant-bridge: missing workspace package @ludy/${slug} for ${source} imported from ${relImporter}`);
      }
      const target = `@ludy/${rest}`;
      const resolved = await this.resolve(target, importer, { skipSelf: true });
      if (!resolved) {
        throw new Error(`legacy-crove-invariant-bridge: failed to resolve ${target} from ${relImporter}`);
      }
      const resolvedFile = resolved.id.split(/[?#]/, 1)[0] ?? resolved.id;
      const resolvedReal = existsSync(resolvedFile) ? realpathSync(resolvedFile) : resolvedFile;
      if (!resolvedReal.startsWith(`${expectedDir}${sep}`) && resolvedReal !== expectedDir) {
        throw new Error(`legacy-crove-invariant-bridge: ${target} resolved outside ${expectedDir} (${resolvedReal})`);
      }
      return resolved;
    },
  };
}

// The context token key of the test suites (#1822), as in vitest.config.ts.
const env = { CROVE_CONTEXT_TOKEN_KEY: Buffer.from('test-only-context-token-key-0123456789').toString('base64') };

export default defineConfig({
  plugins: [legacyCroveInvariantBridge(ROOT_DIR)],
  test: {
    env,
    root: ROOT_DIR,
    include: ['apps/*/test/invariant/**/*.test.ts', 'packages/*/test/invariant/**/*.test.ts', 'modules/*/test/invariant/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    fileParallelism: false,
    testTimeout: 30_000,
    // A suite's beforeAll builds a database from every migration, about 10 s on CI by November 2026; 60 s leaves room.
    hookTimeout: 60_000,
    // An empty suite must fail the gate; the workflow also fails when any invariant test is skipped.
    passWithNoTests: false,
  },
});
