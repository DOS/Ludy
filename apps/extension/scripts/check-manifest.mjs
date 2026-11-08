// SPDX-License-Identifier: AGPL-3.0-only
// Checks a built manifest against the fixed permission list (src/manifest-policy.ts). CI runs it on dist/manifest.json.
import { readFileSync } from 'node:fs';
import { manifestViolations } from '../src/manifest-policy.ts';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/check-manifest.mjs <path to manifest.json>');
const problems = manifestViolations(JSON.parse(readFileSync(file, 'utf8')));
if (problems.length > 0) {
  for (const problem of problems) console.error(`manifest: ${problem}`);
  process.exit(1);
}
console.log(`${file}: permissions match the fixed list`);
