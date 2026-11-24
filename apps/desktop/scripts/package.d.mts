// SPDX-License-Identifier: AGPL-3.0-only
// Type definitions for apps/desktop/scripts/package.mjs for TypeScript tests.
export function parsePackageArgs(argv?: readonly string[]): { version: string | undefined; skipNative: boolean };
export function verifyPrebuiltNative(prebuilt: string): void;
