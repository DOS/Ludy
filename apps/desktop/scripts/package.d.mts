// SPDX-License-Identifier: AGPL-3.0-only
// Type declarations for apps/desktop/scripts/package.mjs for TypeScript tests.
export function parsePackageArgs(argv?: readonly string[]): { version: string | undefined; skipNative: boolean; sign: boolean };
export function verifyPrebuiltNative(prebuilt: string): void;
export function resolveBundledModernSigntool(req?: NodeRequire): string;
