// SPDX-License-Identifier: AGPL-3.0-only
// Splits the database test files into shards of about the same run time (#2769). vitest's own `--shard=i/n` splits by file
// name, not by time, and the two halves of the old split ran 13 and 19 minutes against a 20-minute timeout. This script
// assigns each file to a shard by its measured time (longest first, always to the lightest shard), from
// tools/ci/db-test-times.json. A file with no measured time counts as the median, so a new file lands somewhere sensible
// until the times are refreshed. Every file goes to exactly one shard; nothing is skipped.
//
// Usage: node tools/ci/db-shards.mjs <index> <count>      prints the shard's files, one per line (index from 1)
//        node tools/ci/db-shards.mjs --plan <count>        prints each shard's file count and planned seconds (markdown)
//
// Refreshing the times: take the per-file durations from the vitest output of a green main run (the job log lists
// `<file> (N tests) NNNms`) and rewrite db-test-times.json; the plan stays valid if it is stale, only less even.
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The same patterns as the `db` project of vitest.config.ts (a test checks they still match).
export const DB_TEST_GLOBS = ['packages/*/test/**/*.db.test.ts', 'modules/*/test/**/*.db.test.ts', 'apps/kernel/test/**/*.db.test.ts'];
// The two files the "heavy files" job runs on their own (see ci.yml); they are not part of the shards.
export const HEAVY_FILES = ['apps/kernel/test/finance-search.db.test.ts', 'apps/kernel/test/archive.db.test.ts'];

export function dbTestFiles(root = ROOT) {
  const files = new Set();
  for (const pattern of DB_TEST_GLOBS) for (const f of globSync(pattern, { cwd: root, exclude: (name) => name === 'node_modules' })) files.add(f.split('\\').join('/'));
  return [...files].sort();
}

export function loadTimes(root = ROOT) {
  return JSON.parse(readFileSync(new URL('tools/ci/db-test-times.json', pathToFileURL(root.endsWith('/') ? root : `${root}/`)), 'utf8'));
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? 1 : s[Math.floor(s.length / 2)];
};

// Longest-processing-time-first: the classic greedy for balancing, within 4/3 of the best possible split.
export function assignShards(files, times, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`bad shard count ${count}`);
  const fallback = median(Object.values(times));
  const weight = (f) => times[f] ?? fallback;
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = shards.reduce((best, s) => (s.seconds < best.seconds ? s : best));
    lightest.files.push(f);
    lightest.seconds += weight(f);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

export function plan(count, root = ROOT) {
  const heavy = new Set(HEAVY_FILES);
  return assignShards(
    dbTestFiles(root).filter((f) => !heavy.has(f)),
    loadTimes(root),
    count,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [a, b] = process.argv.slice(2);
  if (a === '--plan') {
    const shards = plan(Number(b));
    console.log('| shard | files | planned seconds |\n| --- | --- | --- |');
    shards.forEach((s, i) => console.log(`| ${i + 1} of ${shards.length} | ${s.files.length} | ${Math.round(s.seconds)} |`));
  } else {
    const index = Number(a);
    const count = Number(b);
    if (!Number.isInteger(index) || !Number.isInteger(count) || index < 1 || index > count) {
      console.error('usage: node tools/ci/db-shards.mjs <index> <count> | --plan <count>');
      process.exit(2);
    }
    const files = plan(count)[index - 1]?.files ?? [];
    if (files.length === 0) {
      console.error(`shard ${index} of ${count} has no files`);
      process.exit(1);
    }
    console.log(files.join('\n'));
  }
}
