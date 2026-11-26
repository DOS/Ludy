// SPDX-License-Identifier: AGPL-3.0-only
// Type declarations for apps/desktop/scripts/signing.mjs for TypeScript tests.
export const DEFAULT_TIMESTAMP_SERVER: string;
export const RELEASE_MANIFEST_FILENAME: string;
export const CHECKSUMS_FILENAME: string;

export type SigningConfig =
  | { enabled: false }
  | { enabled: true; mode: 'thumbprint'; thumbprint: string; timestampServer: string; signtoolPath: string | null; signWithParams: string[] }
  | { enabled: true; mode: 'params'; timestampServer: string; signtoolPath: string | null; signWithParams: string[] }
  | { enabled: true; mode: 'pfx'; certificateFile: string; timestampServer: string; signtoolPath: string | null }
  | { enabled: true; mode: 'hook'; hookModulePath: string; timestampServer: string; signtoolPath: string | null };

export function validateTimestampServer(value: string): string;
export function parseSignWithParamsTokens(input: string): string[];
export function formatSignWithParamsString(tokens: readonly string[]): string;
export function resolveSigningConfig(options?: {
  sign?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  exists?: (path: string) => boolean;
}): SigningConfig;
export function buildPackagerWindowsSign(signing: SigningConfig): Record<string, unknown> | undefined;
export function buildWinstallerSignOptions(signing: SigningConfig, env?: Readonly<Record<string, string | undefined>>): Record<string, unknown>;
export function extractSigntoolDigestAlgorithm(signtoolOutput: string): 'sha256';
export function parseReleasesEntries(text: string): Array<{ sha1: string; file: string; size: number; version: string; kind: 'full' | 'delta' }>;
export function createReleaseArtifacts(options: {
  installerDir: string;
  version: string;
  signed: boolean;
  timestampServer?: string | null;
  publisherThumbprint?: string | null;
}): { manifest: Record<string, unknown>; manifestPath: string; checksumsPath: string };
export function writeReleaseChecksums(installerDir: string): string;
