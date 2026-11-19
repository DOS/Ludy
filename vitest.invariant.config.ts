// Runner config for the invariant suite (Decision 7, External-tenant gate T15). On protected-path PRs,
// .github/workflows/protected.yml takes this file, every test/invariant/ directory and the pgTAP gate files
// (supabase/tests/database/_*.test.sql, #1643) from the base branch and runs them against the PR's code, so the
// PR's own vitest.config.ts cannot exclude or weaken them.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Two-step package rename bridge (#3965, ADR-0054): when all workspace packages carry the @ludy/* scope on the PR branch
// while the base-branch invariant suite still imports @crove/*, map @crove/<pkg> to the renamed workspace's exports.
// Refuses duplicate workspace names/slugs and stays inactive whenever any workspace package still uses @crove/*.
function legacyCroveAliases(rootDir: string): Array<{ find: RegExp; replacement: string }> {
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
  const manifests: Array<{
    pkgDir: string;
    name: string;
    exports?: string | Record<string, string | { default?: string; types?: string }>;
  }> = [];

  for (const pkgDir of pkgDirs) {
    const manifestPath = join(pkgDir, 'package.json');
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      exports?: string | Record<string, string | { default?: string; types?: string }>;
    };
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
    manifests.push({ pkgDir, name: pkg.name, exports: pkg.exports });
  }

  // Strictly inactive until every workspace package has left the @crove/* scope.
  if (manifests.some((m) => m.name.startsWith('@crove/'))) return [];

  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  for (const pkg of manifests) {
    if (!pkg.name.startsWith('@ludy/')) continue;
    const legacyName = `@crove/${pkg.name.slice('@ludy/'.length)}`;
    const exportsMap =
      typeof pkg.exports === 'string'
        ? { '.': pkg.exports }
        : (pkg.exports ?? { '.': './src/index.ts' });
    const entries = Object.entries(exportsMap).sort(([a], [b]) => {
      const aStar = a.includes('*') ? 1 : 0;
      const bStar = b.includes('*') ? 1 : 0;
      if (aStar !== bStar) return aStar - bStar;
      return b.length - a.length;
    });
    for (const [subpath, targetRaw] of entries) {
      const targetRel = typeof targetRaw === 'string' ? targetRaw : targetRaw?.default;
      if (!targetRel) continue;
      if (subpath === '.') {
        aliases.push({
          find: new RegExp(`^${escapeRegExp(legacyName)}$`),
          replacement: resolve(pkg.pkgDir, targetRel),
        });
      } else if (subpath.includes('*') && targetRel.includes('*')) {
        const cleanSub = subpath.startsWith('./') ? subpath.slice(2) : subpath;
        const subStar = cleanSub.indexOf('*');
        const subPrefix = cleanSub.slice(0, subStar);
        const subSuffix = cleanSub.slice(subStar + 1);
        const targetStar = targetRel.indexOf('*');
        const beforeStar = targetRel.slice(0, targetStar);
        const resolvedPrefix = resolve(pkg.pkgDir, beforeStar) + (beforeStar.endsWith('/') ? '/' : '');
        const targetSuffix = targetRel.slice(targetStar + 1);
        aliases.push({
          find: new RegExp(`^${escapeRegExp(legacyName)}/${escapeRegExp(subPrefix)}(.+)${escapeRegExp(subSuffix)}$`),
          replacement: `${resolvedPrefix}$1${targetSuffix}`,
        });
      } else {
        const cleanSub = subpath.startsWith('./') ? subpath.slice(2) : subpath;
        aliases.push({
          find: new RegExp(`^${escapeRegExp(legacyName)}/${escapeRegExp(cleanSub)}$`),
          replacement: resolve(pkg.pkgDir, targetRel),
        });
      }
    }
  }
  return aliases;
}

// The context token key of the test suites (#1822), as in vitest.config.ts.
const env = { CROVE_CONTEXT_TOKEN_KEY: Buffer.from('test-only-context-token-key-0123456789').toString('base64') };

export default defineConfig({
  resolve: {
    alias: legacyCroveAliases(ROOT_DIR),
  },
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
