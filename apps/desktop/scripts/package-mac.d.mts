// SPDX-License-Identifier: AGPL-3.0-only
// Type declarations for apps/desktop/scripts/package-mac.mjs for TypeScript tests.
export function parseMacPackageArgs(argv?: readonly string[]): {
  version: string | undefined;
  arches: Array<'arm64' | 'x64'>;
  sign: boolean;
};
