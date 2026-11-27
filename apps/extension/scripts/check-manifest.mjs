// SPDX-License-Identifier: AGPL-3.0-only
// Checks a built manifest against the fixed permission list (src/manifest-policy.ts). CI runs it on dist/manifest.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_API_ADDRESS, DEFAULT_APP_ADDRESS, originPattern, parseAddress } from '../src/ludy-address.ts';
import { localeViolations, manifestViolations } from '../src/manifest-policy.ts';

function parseArgs(argv) {
  let file;
  let origin;
  let appOrigin;
  let apiOrigin;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (file) throw new Error(`Unexpected argument: ${arg}`);
      file = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === '--origin') origin = value;
    else if (flag === '--app-origin') appOrigin = value;
    else if (flag === '--api-origin') apiOrigin = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return { file, origin, appOrigin, apiOrigin };
}

function resolveOrigin(input, label) {
  const parsed = parseAddress(input, { allowLoopbackIp: true });
  if ('problem' in parsed) throw new Error(`Invalid ${label} "${input}": ${parsed.problem}`);
  return parsed.origin;
}

const { file, origin, appOrigin, apiOrigin } = parseArgs(process.argv.slice(2));
if (!file) throw new Error('Usage: node scripts/check-manifest.mjs <path to manifest.json> [--origin <url> | --app-origin <url> --api-origin <url>]');
const manifest = JSON.parse(readFileSync(file, 'utf8'));

let expected;
if (origin || appOrigin || apiOrigin) {
  const shared = origin ? resolveOrigin(origin, '--origin') : undefined;
  const resolvedApp = appOrigin ? resolveOrigin(appOrigin, '--app-origin') : (shared ?? DEFAULT_APP_ADDRESS);
  const resolvedApi = apiOrigin ? resolveOrigin(apiOrigin, '--api-origin') : (shared ?? DEFAULT_API_ADDRESS);
  expected = { hostPermissions: [originPattern(resolvedApi)], appMatches: [originPattern(resolvedApp)] };
}

// The message files sit next to the manifest, one folder per language.
const localesDir = join(dirname(file), '_locales');
const locales = {};
if (existsSync(localesDir)) {
  for (const lang of readdirSync(localesDir)) {
    const messages = join(localesDir, lang, 'messages.json');
    if (existsSync(messages)) locales[lang] = JSON.parse(readFileSync(messages, 'utf8'));
  }
}
const problems = [...manifestViolations(manifest, expected), ...localeViolations(manifest, locales)];
if (problems.length > 0) {
  for (const problem of problems) console.error(`manifest: ${problem}`);
  process.exit(1);
}
console.log(`${file}: permissions match the fixed list, and the locales are complete`);
