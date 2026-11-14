// SPDX-License-Identifier: AGPL-3.0-only
// Checks a built manifest against the fixed permission list (src/manifest-policy.ts). CI runs it on dist/manifest.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localeViolations, manifestViolations } from '../src/manifest-policy.ts';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/check-manifest.mjs <path to manifest.json>');
const manifest = JSON.parse(readFileSync(file, 'utf8'));
// The message files sit next to the manifest, one folder per language.
const localesDir = join(dirname(file), '_locales');
const locales = {};
if (existsSync(localesDir)) {
  for (const lang of readdirSync(localesDir)) {
    const messages = join(localesDir, lang, 'messages.json');
    if (existsSync(messages)) locales[lang] = JSON.parse(readFileSync(messages, 'utf8'));
  }
}
const problems = [...manifestViolations(manifest), ...localeViolations(manifest, locales)];
if (problems.length > 0) {
  for (const problem of problems) console.error(`manifest: ${problem}`);
  process.exit(1);
}
console.log(`${file}: permissions match the fixed list, and the locales are complete`);
