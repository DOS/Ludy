// SPDX-License-Identifier: AGPL-3.0-only
// The version of an extension release tag (#3009): `ext-v1.2.3` gives `1.2.3`. A manifest version is one to four dot-separated integers, each 0 to 65535 and with no
// leading zero (the Chrome Web Store refuses anything else), so any other tag fails before anything is built. No dependencies: run it with plain node.
//
//   node tools/extension-version.mjs ext-v1.2.3     prints 1.2.3, or exits 1 with the reason on stderr

import { pathToFileURL } from 'node:url';

const TAG = /^ext-v((?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){0,3})$/;
const PART_MAX = 65535;

/**
 * The manifest version a release tag stands for, or why it stands for none.
 * @param {string} tag
 * @returns {{ ok: true, version: string } | { ok: false, reason: string }}
 */
export function versionOfTag(tag) {
  const match = TAG.exec(tag);
  if (!match) return { ok: false, reason: `'${tag}' is not an extension release tag: ext-v followed by one to four integers separated by dots, none with a leading zero` };
  const version = match[1];
  if (version.split('.').some((part) => Number(part) > PART_MAX)) return { ok: false, reason: `'${tag}' has a part above ${PART_MAX}, which a manifest version cannot hold` };
  return { ok: true, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = versionOfTag(process.argv[2] ?? '');
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(result.version);
}
