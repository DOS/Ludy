// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for macOS packaging CLI args, credential/notarization validation, ephemeral Keychain lifecycle,
// minimal Hardened Runtime entitlements, and release manifest/checksum generation (#4885).
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMacExtendInfo,
  buildMacPackagerOsxSign,
  buildNotaryLogArgs,
  buildNotarySubmitArgs,
  createMacReleaseArtifacts,
  escapeSecurityInteractiveArg,
  formatSecurityImportCommands,
  MAC_CHECKSUMS_FILENAME,
  MAC_DARWIN_ENTITLEMENTS_PATH,
  MAC_HELPER_ENTITLEMENTS_PATH,
  MAC_RELEASE_MANIFEST_FILENAME,
  parseCodesignIdentities,
  parseKeychainSearchList,
  parseNotaryToolSubmitResult,
  resolveMacSigningConfig,
  selectMacEntitlementsForFile,
  withEphemeralMacKeychain,
} from '../scripts/macos-signing.mjs';
import { parseMacPackageArgs } from '../scripts/package-mac.mjs';
import { APPLE_BUNDLE_ID } from '../src/codesign.ts';

const TEAM_ID = 'A1B2C3D4E5';
const CERT_HASH = '0123456789ABCDEF0123456789ABCDEF01234567';
const UUID = '12345678-1234-4abc-9def-0123456789ab';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = 'ludy-mac-sign-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('macOS packaging CLI & signing helpers', () => {
  it('parses package-mac.mjs arguments and rejects invalid flags', () => {
    expect(parseMacPackageArgs([])).toEqual({
      version: undefined,
      arches: ['arm64', 'x64'],
      sign: false,
    });
    expect(parseMacPackageArgs(['--version', '1.2.3', '--arch', 'arm64', '--sign'])).toEqual({
      version: '1.2.3',
      arches: ['arm64'],
      sign: true,
    });
    expect(parseMacPackageArgs(['--arch', 'all'])).toEqual({
      version: undefined,
      arches: ['arm64', 'x64'],
      sign: false,
    });
    expect(() => parseMacPackageArgs(['--version', '1.2'])).toThrow(/X\.Y\.Z/);
    expect(() => parseMacPackageArgs(['--version', '1.0.0', '--version', '2.0.0'])).toThrow(/multiple times/);
    expect(() => parseMacPackageArgs(['--arch', 'ia32'])).toThrow(/arm64, x64, or all/);
    expect(() => parseMacPackageArgs(['--arch', 'x64', '--arch', 'arm64'])).toThrow(/multiple times/);
    expect(() => parseMacPackageArgs(['--unknown'])).toThrow(/Unknown argument/);
  });

  it('selects main vs helper Hardened Runtime entitlements and builds strict ATS ExtendInfo', () => {
    expect(selectMacEntitlementsForFile('/tmp/Ludy Desktop.app')).toBe(MAC_DARWIN_ENTITLEMENTS_PATH);
    expect(selectMacEntitlementsForFile('/tmp/Ludy Desktop.app/Contents/MacOS/Ludy Desktop')).toBe(
      MAC_DARWIN_ENTITLEMENTS_PATH,
    );
    expect(
      selectMacEntitlementsForFile('/tmp/Ludy Desktop.app/Contents/Frameworks/Ludy Desktop Helper (GPU).app'),
    ).toBe(MAC_HELPER_ENTITLEMENTS_PATH);
    expect(
      selectMacEntitlementsForFile('/tmp/Ludy Desktop.app/Contents/Frameworks/Ludy Desktop Helper (Plugin).app'),
    ).toBe(MAC_HELPER_ENTITLEMENTS_PATH);
    expect(
      selectMacEntitlementsForFile('/tmp/Ludy Desktop.app/Contents/Frameworks/Ludy Desktop Helper (Alerts).app'),
    ).toBe(MAC_HELPER_ENTITLEMENTS_PATH);

    const extendInfo = buildMacExtendInfo();
    expect(typeof extendInfo['NSMicrophoneUsageDescription']).toBe('string');
    expect(typeof extendInfo['NSAudioCaptureUsageDescription']).toBe('string');
    expect(typeof extendInfo['NSScreenCaptureUsageDescription']).toBe('string');

    const ats = extendInfo['NSAppTransportSecurity'] as {
      NSAllowsArbitraryLoads: boolean;
      NSExceptionDomains: Record<string, { NSExceptionAllowsInsecureHTTPLoads: boolean; NSIncludesSubdomains: boolean }>;
    };
    expect(ats.NSAllowsArbitraryLoads).toBe(false);
    expect(Object.keys(ats.NSExceptionDomains)).toEqual(['127.0.0.1']);
    expect(ats.NSExceptionDomains['127.0.0.1']).toEqual({
      NSExceptionAllowsInsecureHTTPLoads: true,
      NSIncludesSubdomains: false,
    });
  });

  it('resolves signing configs cleanly and fails closed on missing, partial, malformed, or ambiguous secrets', () => {
    expect(resolveMacSigningConfig({ sign: false, env: {} })).toEqual({ enabled: false });

    expect(() => resolveMacSigningConfig({ sign: true, env: {} })).toThrow(/APPLE_TEAM_ID is required/);
    expect(() => resolveMacSigningConfig({ sign: true, env: { APPLE_TEAM_ID: 'BAD' } })).toThrow(/10-character/);

    expect(() => resolveMacSigningConfig({ sign: true, env: { APPLE_TEAM_ID: TEAM_ID } })).toThrow(
      /no signing credentials/,
    );
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: { APPLE_TEAM_ID: TEAM_ID, APPLE_CERT_P12_FILE: '/tmp/cert.p12' },
        exists: () => true,
      }),
    ).toThrow(/must both be set/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: { APPLE_TEAM_ID: TEAM_ID, APPLE_CERT_P12_PASSWORD: 'pw' },
        exists: () => true,
      }),
    ).toThrow(/must both be set/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_CODESIGN_IDENTITY: `Developer ID Application: Ludy (${TEAM_ID})`,
        },
        exists: () => true,
      }),
    ).toThrow(/Ambiguous macOS signing configuration/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_KEYCHAIN_PATH: '/tmp/kc.keychain-db',
        },
        exists: () => true,
      }),
    ).toThrow(/APPLE_KEYCHAIN_PATH cannot be combined/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: TEAM_ID,
          APPLE_CODESIGN_IDENTITY: 'Developer ID Application: Ludy (OTHERTEAM1)',
          APPLE_ID: 'dev@example.com',
          APPLE_APP_SPECIFIC_PASSWORD: 'app-pw',
        },
      }),
    ).toThrow(/does not match APPLE_TEAM_ID/);

    // Notarization checks
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
        },
        exists: () => true,
      }),
    ).toThrow(/Apple notarization credentials are required/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_API_KEY_FILE: '/tmp/key.p8',
          APPLE_API_KEY_ID: 'ABC1234567',
          APPLE_API_ISSUER_ID: UUID,
          APPLE_ID: 'dev@example.com',
        },
        exists: () => true,
      }),
    ).toThrow(/Ambiguous Apple notarization/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_API_KEY_FILE: '/tmp/key.p8',
          APPLE_API_KEY_ID: 'ABC1234567',
        },
        exists: () => true,
      }),
    ).toThrow(/must all be set together/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_API_KEY_FILE: '/tmp/key.p8',
          APPLE_API_KEY_ID: 'BAD',
          APPLE_API_ISSUER_ID: UUID,
        },
        exists: () => true,
      }),
    ).toThrow(/8-20 uppercase alphanumeric/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_API_KEY_FILE: '/tmp/key.p8',
          APPLE_API_KEY_ID: 'ABC1234567',
          APPLE_API_ISSUER_ID: 'not-a-uuid',
        },
        exists: () => true,
      }),
    ).toThrow(/valid UUID/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_ID: 'not-an-email',
          APPLE_APP_SPECIFIC_PASSWORD: 'pw',
        },
        exists: () => true,
      }),
    ).toThrow(/valid Apple ID/);

    const p12Secret = 'super-secret-p12-passphrase';
    const apiCfg = resolveMacSigningConfig({
      sign: true,
      env: {
        APPLE_TEAM_ID: TEAM_ID.toLowerCase(),
        APPLE_CERT_P12_FILE: '/tmp/cert.p12',
        APPLE_CERT_P12_PASSWORD: p12Secret,
        APPLE_API_KEY_FILE: '/tmp/key.p8',
        APPLE_API_KEY_ID: 'abc1234567',
        APPLE_API_ISSUER_ID: UUID.toUpperCase(),
      },
      exists: () => true,
    });
    expect(apiCfg).toEqual({
      enabled: true,
      teamId: TEAM_ID,
      bundleId: APPLE_BUNDLE_ID,
      certMode: 'p12',
      p12File: '/tmp/cert.p12',
      notary: {
        notaryMode: 'api-key',
        apiKeyFile: '/tmp/key.p8',
        apiKeyId: 'ABC1234567',
        apiIssuerId: UUID,
      },
    });
    expect(JSON.stringify(apiCfg)).not.toContain(p12Secret);

    const appPw = 'app-pw-never-leaked';
    const appleIdCfg = resolveMacSigningConfig({
      sign: true,
      env: {
        APPLE_TEAM_ID: TEAM_ID,
        APPLE_CODESIGN_IDENTITY: `Developer ID Application: Ludy (${TEAM_ID})`,
        APPLE_ID: 'dev@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: appPw,
      },
      exists: () => true,
    });
    expect(appleIdCfg).toEqual({
      enabled: true,
      teamId: TEAM_ID,
      bundleId: APPLE_BUNDLE_ID,
      certMode: 'identity',
      identity: `Developer ID Application: Ludy (${TEAM_ID})`,
      keychainPath: null,
      notary: {
        notaryMode: 'apple-id',
        appleId: 'dev@example.com',
      },
    });
    expect(JSON.stringify(appleIdCfg)).not.toContain(appPw);
  });

  it('escapes security interactive commands safely and refuses control chars', () => {
    expect(escapeSecurityInteractiveArg('pa"ss\\word')).toBe('"pa\\"ss\\\\word"');
    expect(() => escapeSecurityInteractiveArg('bad\nline')).toThrow(/NUL or newline/);
    const commands = formatSecurityImportCommands({
      keychainPath: '/tmp/kc.keychain-db',
      keychainPassword: 'kc"pw',
      p12Path: '/tmp/dev.p12',
      p12Password: 'p12\\pw',
    });
    expect(commands).toContain('create-keychain -p "kc\\"pw" "/tmp/kc.keychain-db"');
    expect(commands).toContain('import "/tmp/dev.p12" -k "/tmp/kc.keychain-db" -f pkcs12 -P "p12\\\\pw"');
    expect(commands).toContain('set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "kc\\"pw" "/tmp/kc.keychain-db"');
  });

  it('parses security identities and keychain lists, and disables unsafe osxSign defaults', () => {
    const idOut = [
      `  1) ${CERT_HASH} "Developer ID Application: Ludy Test (${TEAM_ID})"`,
      '     1 valid identities found',
    ].join('\r\n');
    expect(parseCodesignIdentities(idOut, TEAM_ID.toLowerCase())).toEqual({
      hash: CERT_HASH,
      name: `Developer ID Application: Ludy Test (${TEAM_ID})`,
      teamId: TEAM_ID,
    });

    expect(() => parseCodesignIdentities('0 valid identities found')).toThrow(/No valid Developer ID/);
    const twoIds = [
      `  1) ${CERT_HASH} "Developer ID Application: Ludy Test (${TEAM_ID})"`,
      `  2) FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF "Developer ID Application: Ludy Test 2 (${TEAM_ID})"`,
    ].join('\n');
    expect(() => parseCodesignIdentities(twoIds, TEAM_ID)).toThrow(/Expected exactly 1/);
    expect(() => parseCodesignIdentities(idOut, 'OTHERTEAM1')).toThrow(/does not match expected APPLE_TEAM_ID/);

    expect(
      parseKeychainSearchList(
        '    "/Users/runner/Library/Keychains/login.keychain-db"\r\n    "/Library/Keychains/System.keychain"\r\n',
      ),
    ).toEqual([
      '/Users/runner/Library/Keychains/login.keychain-db',
      '/Library/Keychains/System.keychain',
    ]);

    const osxSign = buildMacPackagerOsxSign({
      identity: CERT_HASH,
      keychainPath: '/tmp/ephemeral.keychain-db',
    });
    expect(osxSign['continueOnError']).toBe(false);
    expect(osxSign['hardenedRuntime']).toBe(true);
    expect(osxSign['strictVerify']).toBe(true);
    expect(osxSign['preAutoEntitlements']).toBe(false);
    expect(osxSign['preEmbedProvisioningProfile']).toBe(false);
    const optionsForFile = osxSign['optionsForFile'] as (p: string) => { entitlements: string; hardenedRuntime: boolean };
    expect(optionsForFile('/app/Ludy Desktop.app')).toEqual({
      entitlements: MAC_DARWIN_ENTITLEMENTS_PATH,
      hardenedRuntime: true,
    });
    expect(optionsForFile('/app/Ludy Desktop Helper (GPU).app')).toEqual({
      entitlements: MAC_HELPER_ENTITLEMENTS_PATH,
      hardenedRuntime: true,
    });
  });

  it('parses notarytool output and omits passwords from submit/log argv', () => {
    expect(parseNotaryToolSubmitResult(JSON.stringify({ id: UUID, status: 'Accepted', message: 'Processing complete' }))).toEqual({
      id: UUID,
      status: 'Accepted',
      message: 'Processing complete',
    });
    expect(() => parseNotaryToolSubmitResult('')).toThrow(/empty output/);
    expect(() => parseNotaryToolSubmitResult('not-json')).toThrow(/malformed JSON/);
    expect(() => parseNotaryToolSubmitResult(JSON.stringify({ status: 'Accepted' }))).toThrow(/missing submission id/);

    const apiSigning = resolveMacSigningConfig({
      sign: true,
      env: {
        APPLE_TEAM_ID: TEAM_ID,
        APPLE_CERT_P12_FILE: '/tmp/cert.p12',
        APPLE_CERT_P12_PASSWORD: 'secret',
        APPLE_API_KEY_FILE: '/tmp/key.p8',
        APPLE_API_KEY_ID: 'ABC1234567',
        APPLE_API_ISSUER_ID: UUID,
      },
      exists: () => true,
    });
    if (!apiSigning.enabled) throw new Error('expected enabled');
    expect(buildNotarySubmitArgs({ targetPath: '/tmp/app.dmg', signing: apiSigning })).toEqual([
      'notarytool',
      'submit',
      '/tmp/app.dmg',
      '--key',
      '/tmp/key.p8',
      '--key-id',
      'ABC1234567',
      '--issuer',
      UUID,
      '--wait',
      '--output-format',
      'json',
    ]);
    expect(buildNotaryLogArgs({ submissionId: UUID, signing: apiSigning })).toContain('/tmp/key.p8');

    const appleIdSigning = resolveMacSigningConfig({
      sign: true,
      env: {
        APPLE_TEAM_ID: TEAM_ID,
        APPLE_CODESIGN_IDENTITY: `Developer ID Application: Ludy (${TEAM_ID})`,
        APPLE_ID: 'dev@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'app-password-secret',
      },
      exists: () => true,
    });
    if (!appleIdSigning.enabled) throw new Error('expected enabled');
    const submitArgs = buildNotarySubmitArgs({
      targetPath: '/tmp/app.zip',
      signing: appleIdSigning,
      notaryKeychainPath: '/tmp/kc.keychain-db',
      notaryProfile: 'ludy-notary-123',
    });
    expect(submitArgs).toContain('--keychain-profile');
    expect(submitArgs.join(' ')).not.toContain('app-password-secret');
    expect(buildNotaryLogArgs({
      submissionId: UUID,
      signing: appleIdSigning,
      notaryKeychainPath: '/tmp/kc.keychain-db',
      notaryProfile: 'ludy-notary-123',
    })).toContain('ludy-notary-123');
    expect(() => buildNotarySubmitArgs({ targetPath: '/tmp/app.zip', signing: appleIdSigning })).toThrow(
      /Missing ephemeral Keychain profile/,
    );
  });

  it('manages ephemeral Keychain safely, refuses clobbering, and fails closed if cleanup breaks', async () => {
    const dir = makeTempDir();
    const existingKc = join(dir, 'already.keychain-db');
    writeFileSync(existingKc, 'existing');
    const requestedKc = join(dir, 'ephemeral.keychain-db');

    const baseSigning = resolveMacSigningConfig({
      sign: true,
      env: {
        APPLE_TEAM_ID: TEAM_ID,
        APPLE_CERT_P12_FILE: join(dir, 'cert.p12'),
        APPLE_CERT_P12_PASSWORD: 'p12-password',
        APPLE_ID: 'dev@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'apple-app-password',
      },
      exists: () => true,
    });
    if (!baseSigning.enabled) throw new Error('expected enabled');

    await expect(
      withEphemeralMacKeychain({
        signing: baseSigning,
        env: { LUDY_MAC_EPHEMERAL_KEYCHAIN: existingKc },
        run: async () => undefined,
      }),
    ).rejects.toThrow(/Refused to clobber/);

    await expect(
      withEphemeralMacKeychain({
        signing: baseSigning,
        env: { LUDY_MAC_EPHEMERAL_KEYCHAIN: join(dir, 'bad-ext.db') },
        run: async () => undefined,
      }),
    ).rejects.toThrow(/must end with \.keychain-db/);

    let currentSearchList = ['/Users/runner/Library/Keychains/login.keychain-db'];
    let kcExistsOnDisk = false;
    const storedProfiles: Array<{ profileName: string; keychainPath: string; appSpecificPassword: string }> = [];

    const result = await withEphemeralMacKeychain({
      signing: baseSigning,
      env: {
        LUDY_MAC_EPHEMERAL_KEYCHAIN: requestedKc,
        APPLE_CERT_P12_PASSWORD: 'p12-password',
        APPLE_APP_SPECIFIC_PASSWORD: 'apple-app-password',
      },
      exists: (p) => (p === requestedKc ? kcExistsOnDisk : true),
      runSecurityInteractive: () => {
        kcExistsOnDisk = true;
      },
      storeNotaryProfile: (opts) => {
        storedProfiles.push(opts);
      },
      exec: (_file, args) => {
        if (args[0] === 'list-keychains' && !args.includes('-s')) {
          return currentSearchList.map((p) => `    "${p}"`).join('\n');
        }
        if (args[0] === 'list-keychains' && args.includes('-s')) {
          currentSearchList = args.slice(4);
          return '';
        }
        if (args[0] === 'find-identity') {
          return `  1) ${CERT_HASH} "Developer ID Application: Ludy Test (${TEAM_ID})"`;
        }
        if (args[0] === 'delete-keychain') {
          kcExistsOnDisk = false;
          currentSearchList = currentSearchList.filter((p) => p !== args[1]);
          return '';
        }
        throw new Error(`unexpected security args: ${args.join(' ')}`);
      },
      run: async (ctx) => {
        expect(ctx.identity).toBe(CERT_HASH);
        expect(ctx.keychainPath).toBe(requestedKc);
        expect(ctx.notaryKeychainPath).toBe(requestedKc);
        expect(ctx.notaryProfile).toMatch(/^ludy-notary-/);
        expect(currentSearchList[0]).toBe(requestedKc);
        return 'packaged-ok';
      },
    });
    expect(result).toBe('packaged-ok');
    expect(storedProfiles[0]).toMatchObject({ keychainPath: requestedKc, appSpecificPassword: 'apple-app-password' });
    expect(kcExistsOnDisk).toBe(false);
    expect(currentSearchList).toEqual(['/Users/runner/Library/Keychains/login.keychain-db']);

    // Keep signing keychain separate from ephemeral notary keychain when certMode is identity + notaryMode is apple-id
    const customSigningKc = join(dir, 'custom-signing.keychain-db');
    writeFileSync(customSigningKc, 'custom-kc');
    const identityAppleId = resolveMacSigningConfig({
      sign: true,
      env: {
        APPLE_TEAM_ID: TEAM_ID,
        APPLE_CODESIGN_IDENTITY: `Developer ID Application: Ludy Test (${TEAM_ID})`,
        APPLE_KEYCHAIN_PATH: customSigningKc,
        APPLE_ID: 'dev@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'apple-app-password',
      },
      exists: () => true,
    });
    if (!identityAppleId.enabled) throw new Error('expected enabled');
    const notaryOnlyKc = join(dir, 'notary-only.keychain-db');
    let notaryKcExists = false;
    let notarySearchList = ['/Users/runner/Library/Keychains/login.keychain-db'];
    await withEphemeralMacKeychain({
      signing: identityAppleId,
      env: {
        LUDY_MAC_EPHEMERAL_KEYCHAIN: notaryOnlyKc,
        APPLE_APP_SPECIFIC_PASSWORD: 'apple-app-password',
      },
      exists: (p) => (p === notaryOnlyKc ? notaryKcExists : true),
      runSecurityInteractive: () => {
        notaryKcExists = true;
      },
      storeNotaryProfile: () => undefined,
      exec: (_file, args) => {
        if (args[0] === 'list-keychains' && !args.includes('-s')) {
          return notarySearchList.map((p) => `    "${p}"`).join('\n');
        }
        if (args[0] === 'list-keychains' && args.includes('-s')) {
          notarySearchList = args.slice(4);
          return '';
        }
        if (args[0] === 'delete-keychain') {
          notaryKcExists = false;
          notarySearchList = notarySearchList.filter((p) => p !== args[1]);
          return '';
        }
        throw new Error(`unexpected security args: ${args.join(' ')}`);
      },
      run: async (ctx) => {
        expect(ctx.identity).toBe(`Developer ID Application: Ludy Test (${TEAM_ID})`);
        expect(ctx.keychainPath).toBe(customSigningKc);
        expect(ctx.notaryKeychainPath).toBe(notaryOnlyKc);
      },
    });
    expect(notaryKcExists).toBe(false);

    // Fail closed if ephemeral Keychain remains in search list or on disk after cleanup
    let stickySearchList = ['/Users/runner/Library/Keychains/login.keychain-db'];
    await expect(
      withEphemeralMacKeychain({
        signing: baseSigning,
        env: {
          LUDY_MAC_EPHEMERAL_KEYCHAIN: requestedKc,
          APPLE_CERT_P12_PASSWORD: 'p12-password',
          APPLE_APP_SPECIFIC_PASSWORD: 'apple-app-password',
        },
        exists: (p) => (p === requestedKc ? kcExistsOnDisk : true),
        runSecurityInteractive: () => {
          kcExistsOnDisk = true;
        },
        storeNotaryProfile: () => undefined,
        exec: (_file, args) => {
          if (args[0] === 'list-keychains' && !args.includes('-s')) {
            return stickySearchList.map((p) => `    "${p}"`).join('\n');
          }
          if (args[0] === 'list-keychains' && args.includes('-s')) {
            stickySearchList = args.slice(4);
            return '';
          }
          if (args[0] === 'find-identity') {
            return `  1) ${CERT_HASH} "Developer ID Application: Ludy Test (${TEAM_ID})"`;
          }
          if (args[0] === 'delete-keychain') {
            throw new Error('simulated keychain delete failure');
          }
          return '';
        },
        run: async () => 'done',
      }),
    ).rejects.toThrow(/Failed cleaning up ephemeral macOS Keychain/);
  });

  it('creates signed and unsigned macOS release manifests and SHA256SUMS.txt', () => {
    const dir = makeTempDir();
    const dmgPath = join(dir, 'LudyDesktop-0.1.0-darwin-arm64.dmg');
    const zipPath = join(dir, 'LudyDesktop-0.1.0-darwin-arm64.zip');
    writeFileSync(dmgPath, 'dmg-binary');
    writeFileSync(zipPath, 'zip-binary');

    expect(() =>
      createMacReleaseArtifacts({
        archDir: dir,
        arch: 'arm64',
        version: '0.1.0',
        signed: true,
        teamId: null,
      }),
    ).toThrow(/10-character Apple Team ID/);

    expect(() =>
      createMacReleaseArtifacts({
        archDir: dir,
        arch: 'arm64',
        version: '0.1.0',
        signed: true,
        teamId: TEAM_ID,
        hardenedRuntime: true,
        notarized: false,
      }),
    ).toThrow(/Hardened Runtime signed and notarized/);

    const signedOut = createMacReleaseArtifacts({
      archDir: dir,
      arch: 'arm64',
      version: '0.1.0',
      signed: true,
      teamId: TEAM_ID.toLowerCase(),
      hardenedRuntime: true,
      notarized: true,
    });
    expect(existsSync(join(dir, MAC_RELEASE_MANIFEST_FILENAME))).toBe(true);
    expect(existsSync(join(dir, MAC_CHECKSUMS_FILENAME))).toBe(true);
    expect(signedOut.manifest).toMatchObject({
      schemaVersion: 1,
      product: 'ludy-desktop',
      platform: 'darwin',
      arch: 'arm64',
      version: '0.1.0',
      signed: true,
      signing: {
        algorithm: 'sha256',
        teamId: TEAM_ID,
        bundleId: APPLE_BUNDLE_ID,
        hardenedRuntime: true,
        notarized: true,
      },
    });
    const sums = readFileSync(signedOut.checksumsPath, 'utf8').trim().split('\n');
    expect(sums).toHaveLength(3);
    const dmgSha = createHash('sha256').update('dmg-binary').digest('hex');
    expect(sums[0]).toBe(`${dmgSha}  LudyDesktop-0.1.0-darwin-arm64.dmg`);
  });
});
