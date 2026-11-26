// SPDX-License-Identifier: AGPL-3.0-only
// Type declarations for apps/desktop/scripts/macos-signing.mjs for TypeScript tests.
export const APPLE_HELPER_BUNDLE_ID: string;
export const SUPPORTED_MAC_ARCHES: readonly ('arm64' | 'x64')[];
export const MAC_RELEASE_MANIFEST_FILENAME: string;
export const MAC_CHECKSUMS_FILENAME: string;
export const MAC_DARWIN_ENTITLEMENTS_PATH: string;
export const MAC_HELPER_ENTITLEMENTS_PATH: string;

export type MacNotaryConfig =
  | { notaryMode: 'api-key'; apiKeyFile: string; apiKeyId: string; apiIssuerId: string }
  | { notaryMode: 'apple-id'; appleId: string };

export type MacSigningConfig =
  | { enabled: false }
  | {
      enabled: true;
      teamId: string;
      bundleId: string;
      certMode: 'p12';
      p12File: string;
      notary: MacNotaryConfig;
    }
  | {
      enabled: true;
      teamId: string;
      bundleId: string;
      certMode: 'identity';
      identity: string;
      keychainPath: string | null;
      notary: MacNotaryConfig;
    };

export function selectMacEntitlementsForFile(filePath: string): string;
export function buildMacExtendInfo(): Record<string, unknown>;
export function resolveMacSigningConfig(options?: {
  sign?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  exists?: (path: string) => boolean;
}): MacSigningConfig;
export function escapeSecurityInteractiveArg(value: string): string;
export function formatSecurityImportCommands(options: {
  keychainPath: string;
  keychainPassword: string;
  p12Path: string;
  p12Password: string;
}): string;
export function parseCodesignIdentities(
  findIdentityOutput: string,
  expectedTeamId?: string | null,
): { hash: string; name: string; teamId: string };
export function parseKeychainSearchList(output: string): string[];
export function buildMacPackagerOsxSign(options: { identity: string; keychainPath?: string | null }): Record<string, unknown>;
export function parseNotaryToolSubmitResult(rawOutput: string): { id: string; status: string; message: string };
export function buildNotarySubmitArgs(options: {
  targetPath: string;
  signing: Extract<MacSigningConfig, { enabled: true }>;
  notaryKeychainPath?: string | null;
  notaryProfile?: string | null;
}): string[];
export function buildNotaryLogArgs(options: {
  submissionId: string;
  signing: Extract<MacSigningConfig, { enabled: true }>;
  notaryKeychainPath?: string | null;
  notaryProfile?: string | null;
}): string[];
export function withEphemeralMacKeychain<T>(options: {
  signing: Extract<MacSigningConfig, { enabled: true }>;
  env?: Readonly<Record<string, string | undefined>>;
  exists?: (path: string) => boolean;
  exec?: (file: string, args: readonly string[], options?: Record<string, unknown>) => string;
  runSecurityInteractive?: (commands: string) => void;
  storeNotaryProfile?: (opts: {
    profileName: string;
    appleId: string;
    teamId: string;
    keychainPath: string;
    appSpecificPassword: string;
  }) => void;
  run: (ctx: {
    identity: string;
    keychainPath: string | null;
    notaryKeychainPath?: string | null;
    notaryProfile: string | null;
  }) => Promise<T>;
}): Promise<T>;
export function createMacReleaseArtifacts(options: {
  archDir: string;
  arch: 'arm64' | 'x64';
  version: string;
  signed: boolean;
  teamId?: string | null;
  bundleId?: string;
  hardenedRuntime?: boolean;
  notarized?: boolean;
}): { manifest: Record<string, unknown>; manifestPath: string; checksumsPath: string };
export function writeMacReleaseChecksums(archDir: string, files: readonly string[]): string;
