// SPDX-License-Identifier: AGPL-3.0-only
// Type declarations for apps/desktop/scripts/package.mjs for TypeScript tests.
export function parsePackageArgs(argv?: readonly string[]): { version: string | undefined; skipNative: boolean; sign: boolean };
export function verifyPrebuiltNative(prebuilt: string): void;
export function resolveBundledModernSigntool(req?: NodeRequire): string;
export function normalizeThumbprintList(raw: unknown): string[];
export function parseImportedPfxResult(rawOutput: string): { leafThumbprint: string; cleanupThumbprints: string[] };
export function importEphemeralPfx(
  pfxFile: string,
  runPowerShell?: (psScript: string, env: Record<string, string>) => string,
  cleanupRecordFile?: string,
): { leafThumbprint: string; cleanupThumbprints: string[] };
export function removeEphemeralCerts(
  thumbprints: readonly string[] | string,
  runPowerShell?: (psScript: string, env: Record<string, string>) => string,
): void;
