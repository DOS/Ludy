// SPDX-License-Identifier: AGPL-3.0-only
// The split of the database tests into CI shards (#2769): every db test file runs in exactly one part (the heavy job or one of
// the shards), the shards are about equally long by measured time, a new file with no measured time still lands somewhere, and
// the file patterns are the ones vitest.config.ts uses. A file in no part would be a test CI never runs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assignShards, dbTestFiles, DB_TEST_GLOBS, HEAVY_FILES, loadTimes, plan } from '../ci/db-shards.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COUNT = 4;

type Shard = { files: string[]; seconds: number };

describe('database test shards', () => {
  const all: string[] = dbTestFiles(ROOT);
  const shards: Shard[] = plan(COUNT, ROOT);

  it('finds the same files as the db project of vitest', () => {
    const config = readFileSync(`${ROOT}vitest.config.ts`, 'utf8');
    for (const pattern of DB_TEST_GLOBS as string[]) expect(config, pattern).toContain(`'${pattern}'`);
    expect(all.length).toBeGreaterThan(100);
  });

  it('runs every file in exactly one part: the heavy job or one shard', () => {
    const heavy: string[] = HEAVY_FILES;
    for (const f of heavy) expect(all, `the heavy file ${f} no longer exists; update HEAVY_FILES and ci.yml`).toContain(f);
    const seen = new Map<string, number>();
    for (const f of [...heavy, ...shards.flatMap((s) => s.files)]) seen.set(f, (seen.get(f) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n !== 1)).toEqual([]);
    expect([...seen.keys()].sort()).toEqual(all);
  });

  it('keeps the shards within 10% of each other by planned time', () => {
    const seconds = shards.map((s) => s.seconds);
    expect(shards.every((s) => s.files.length > 0)).toBe(true);
    expect(Math.max(...seconds) / Math.min(...seconds)).toBeLessThan(1.1);
  });

  it('puts a file with no measured time in a shard, as a median file', () => {
    const times: Record<string, number> = loadTimes(ROOT);
    const files = [...all.filter((f) => !HEAVY_FILES.includes(f)), 'apps/kernel/test/brand-new.db.test.ts'];
    const placed: Shard[] = assignShards(files, times, COUNT);
    expect(placed.flatMap((s) => s.files)).toContain('apps/kernel/test/brand-new.db.test.ts');
    expect(placed.flatMap((s) => s.files)).toHaveLength(files.length);
  });

  it('refuses a shard count that is not a positive whole number', () => {
    expect(() => assignShards(all, {}, 0)).toThrow(/bad shard count/);
    expect(() => assignShards(all, {}, 1.5)).toThrow(/bad shard count/);
  });
});
