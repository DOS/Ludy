// SPDX-License-Identifier: AGPL-3.0-only
// Splits the Playwright spec files into CI shards of about the same run time (#2788). One job ran all 130 tests one after
// another in 23 minutes against a 25-minute timeout. Each shard is its own job with its own docker compose stack, so a
// spec file never runs in two shards and never waits for another job; files keep their alphabetical order inside a shard,
// as in one run. Assignment is by measured time (longest first, to the lightest shard) from tools/ci/e2e-test-times.json; a
// file with no measured time counts as the median. Nothing is skipped: every spec file is in exactly one shard.
//
// Usage: node tools/ci/e2e-shards.mjs <index> <count>      prints the shard's files (relative to e2e/), one per line
//        node tools/ci/e2e-shards.mjs --plan <count>        prints each shard's file count and planned seconds (markdown)
//
// Refreshing the times: sum the per-test durations of a green run by file (the `list` reporter prints
// `tests/<file>:<line> › title (N.Ns)`) and rewrite e2e-test-times.json. A stale file only makes the split less even.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assignShards } from './db-shards.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Spec files under e2e/tests, as `tests/<name>.spec.ts` (the form Playwright's filter and the times file use).
export function specFiles(root = ROOT) {
  return readdirSync(new URL('e2e/tests/', pathToFileURL(root.endsWith('/') ? root : `${root}/`)))
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => `tests/${f}`)
    .sort();
}

export function loadTimes(root = ROOT) {
  return JSON.parse(readFileSync(new URL('tools/ci/e2e-test-times.json', pathToFileURL(root.endsWith('/') ? root : `${root}/`)), 'utf8'));
}

export function plan(count, root = ROOT) {
  return assignShards(specFiles(root), loadTimes(root), count);
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
      console.error('usage: node tools/ci/e2e-shards.mjs <index> <count> | --plan <count>');
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
