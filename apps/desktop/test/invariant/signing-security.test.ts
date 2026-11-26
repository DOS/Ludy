// SPDX-License-Identifier: AGPL-3.0-only
// Security invariant suite for Windows and macOS installer signing credential isolation, flag normalization,
// timestamp server validation, ephemeral Keychain lifecycle, minimal entitlements, and artifact checksum integrity (#4884, #4885).
// Self-contained under test/invariant/: imports only the modules under test and Node built-ins.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMacExtendInfo,
  buildMacPackagerOsxSign,
  buildNotaryLogArgs,
  buildNotarySubmitArgs,
  createMacReleaseArtifacts,
  escapeSecurityInteractiveArg,
  formatSecurityImportCommands,
  MAC_DARWIN_ENTITLEMENTS_PATH,
  MAC_HELPER_ENTITLEMENTS_PATH,
  parseCodesignIdentities,
  resolveMacSigningConfig,
  runSecurityInteractiveLines,
  selectMacEntitlementsForFile,
  withEphemeralMacKeychain,
} from '../../scripts/macos-signing.mjs';
import {
  buildPackagerWindowsSign,
  buildWinstallerSignOptions,
  createReleaseArtifacts,
  DEFAULT_TIMESTAMP_SERVER,
  extractSigntoolDigestAlgorithm,
  parseSignWithParamsTokens,
  resolveSigningConfig,
  validateTimestampServer,
} from '../../scripts/signing.mjs';
import { OID_SHA256, parseAuthenticodeCheckResults } from '../../src/authenticode.ts';
import { parseCodesignDisplayOutput, parseSpctlAssessOutput } from '../../src/codesign.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ludy-inv-sign-'));
  tempDirs.push(dir);
  return dir;
}

const THUMB = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('Windows signing credential and parameter security invariants', () => {
  it('fails closed when --sign has missing, partial, invalid, or ambiguous credentials', () => {
    expect(() => resolveSigningConfig({ sign: true, env: {} })).toThrow(/no signing credentials/);
    expect(() =>
      resolveSigningConfig({ sign: true, env: { WINDOWS_CERTIFICATE_FILE: 'C:\\cert.pfx' }, exists: () => true }),
    ).toThrow(/must both be set/);
    expect(() =>
      resolveSigningConfig({ sign: true, env: { WINDOWS_CERTIFICATE_PASSWORD: 'secret' }, exists: () => true }),
    ).toThrow(/must both be set/);
    expect(() =>
      resolveSigningConfig({
        sign: true,
        env: { WINDOWS_CERT_SHA1: THUMB, WINDOWS_SIGN_WITH_PARAMS: '/csp "Test KSP"' },
      }),
    ).toThrow(/Ambiguous/);
    expect(() => resolveSigningConfig({ sign: true, env: { WINDOWS_CERT_SHA1: 'short-hex' } })).toThrow(/40-character hexadecimal/);
  });

  it('never leaks PFX password into resolved config, packager, or winstaller options', () => {
    const secret = 'test-only-password-never-serialized';
    const cfg = resolveSigningConfig({
      sign: true,
      env: { WINDOWS_CERTIFICATE_FILE: 'C:\\signing\\ludy.pfx', WINDOWS_CERTIFICATE_PASSWORD: secret },
      exists: (p) => p === 'C:\\signing\\ludy.pfx',
    });
    expect(JSON.stringify(cfg)).not.toContain(secret);
    const packagerSign = buildPackagerWindowsSign(cfg);
    expect(JSON.stringify(packagerSign)).not.toContain(secret);
    const winstallerSign = buildWinstallerSignOptions(cfg, { WINDOWS_CERTIFICATE_PASSWORD: secret });
    expect(JSON.stringify(winstallerSign)).not.toContain(secret);
    expect(() => buildWinstallerSignOptions(cfg, {})).toThrow(/WINDOWS_CERTIFICATE_PASSWORD is missing/);
  });

  it('rejects private timestamp URLs, shell metacharacters, weak /fd, legacy /t, and /p passwords, and normalizes uppercase flags', () => {
    for (const badTs of [
      '',
      'ftp://timestamp.digicert.com',
      'http://127.0.0.1/ts',
      'http://127.0.0.1./ts',
      'http://169.254.169.254/ts',
      'http://localhost./ts',
      'http://metadata.google.internal./ts',
      'http://intranet./ts',
      'http://printer.local./ts',
      'http://[::1]/ts',
      'http://[::127.0.0.1]/ts',
      'http://[::ffff:0:127.0.0.1]/ts',
      'http://[fe81::1]/ts',
      'http://[2002:7f00:1::1]/ts',
      'http://timestamp.digicert.com?x=1',
      'http://user:pw@timestamp.digicert.com',
      'http://timestamp.digicert.com & calc',
    ]) {
      expect(() => validateTimestampServer(badTs), badTs).toThrow();
    }

    for (const badParams of [
      '',
      '/csp "unclosed',
      '/csp a & calc',
      '/f a.pfx /p secret',
      '/fd\nsha256',
      '/fd sha1',
      '/fd:md5',
      '/td sha1',
      '/t http://timestamp.digicert.com',
      '/tr http://127.0.0.1/ts',
    ]) {
      expect(() => parseSignWithParamsTokens(badParams), badParams).toThrow();
    }

    const upperCfg = resolveSigningConfig({
      sign: true,
      env: { WINDOWS_SIGN_WITH_PARAMS: '/CSP "KSP" /FD SHA256 /TR https://timestamp.digicert.com /TD:SHA256' },
    });
    expect(upperCfg.enabled).toBe(true);
    if (upperCfg.enabled && upperCfg.mode === 'params') {
      expect(upperCfg.signWithParams).toEqual([
        '/CSP',
        'KSP',
        '/fd',
        'sha256',
        '/tr',
        'https://timestamp.digicert.com',
        '/td',
        'sha256',
      ]);
      expect(upperCfg.signWithParams.filter((t) => t === '/fd')).toHaveLength(1);
    }
  });

  it('rejects SHA-1 Authenticode digests, mismatched thumbprints, and tampered nupkg artifacts', () => {
    expect(() => extractSigntoolDigestAlgorithm('Hash of file (sha1): ABCD')).toThrow(/non-sha256/);
    expect(() =>
      parseAuthenticodeCheckResults(
        JSON.stringify([
          {
            path: 'Setup.exe',
            status: 'NotSigned',
            thumbprint: null,
            hasTimestamp: false,
            fileDigestOid: OID_SHA256,
            timestampType: 'rfc3161',
            tsDigestOid: OID_SHA256,
          },
        ]),
        ['Setup.exe'],
      ),
    ).toThrow(/NotSigned/);

    const dir = makeTempDir();
    const setupBytes = Buffer.from('setup-binary-payload');
    const nupkgBytes = Buffer.from('nupkg-archive-payload');
    const sha1 = createHash('sha1').update(nupkgBytes).digest('hex').toUpperCase();
    writeFileSync(join(dir, 'LudyDesktop-Setup.exe'), setupBytes);
    writeFileSync(join(dir, 'LudyDesktop-0.1.0-full.nupkg'), Buffer.from('tampered-bytes'));
    writeFileSync(join(dir, 'RELEASES'), `${sha1} LudyDesktop-0.1.0-full.nupkg ${nupkgBytes.length}\n`);
    expect(() =>
      createReleaseArtifacts({
        installerDir: dir,
        version: '0.1.0',
        signed: false,
        timestampServer: DEFAULT_TIMESTAMP_SERVER,
      }),
    ).toThrow(/does not match RELEASES/);
  });
});

describe('macOS signing credential, Keychain, entitlements, and ATS security invariants', () => {
  const MAC_TEAM_ID = 'A1B2C3D4E5';
  const MAC_HASH = '0123456789ABCDEF0123456789ABCDEF01234567';
  const MAC_UUID = '12345678-1234-4abc-9def-0123456789ab';

  it('fails closed when --sign has missing, partial, invalid, or ambiguous macOS credentials', () => {
    expect(() => resolveMacSigningConfig({ sign: true, env: {} })).toThrow(/APPLE_TEAM_ID/);
    expect(() => resolveMacSigningConfig({ sign: true, env: { APPLE_TEAM_ID: '123' } })).toThrow(/10-character/);
    expect(() => resolveMacSigningConfig({ sign: true, env: { APPLE_TEAM_ID: MAC_TEAM_ID } })).toThrow(/no signing credentials/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: { APPLE_TEAM_ID: MAC_TEAM_ID, APPLE_CERT_P12_FILE: '/tmp/cert.p12' },
        exists: () => true,
      }),
    ).toThrow(/must both be set/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: MAC_TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_CODESIGN_IDENTITY: `Developer ID Application: Ludy (${MAC_TEAM_ID})`,
          APPLE_ID: 'dev@example.com',
          APPLE_APP_SPECIFIC_PASSWORD: 'app-pw',
        },
        exists: () => true,
      }),
    ).toThrow(/Ambiguous/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: MAC_TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_API_KEY_FILE: '/tmp/key.p8',
          APPLE_API_KEY_ID: 'ABC1234567',
          APPLE_API_ISSUER_ID: MAC_UUID,
          APPLE_ID: 'dev@example.com',
          APPLE_APP_SPECIFIC_PASSWORD: 'app-pw',
        },
        exists: () => true,
      }),
    ).toThrow(/Ambiguous Apple notarization/);
    expect(() =>
      resolveMacSigningConfig({
        sign: true,
        env: {
          APPLE_TEAM_ID: MAC_TEAM_ID,
          APPLE_CERT_P12_FILE: '/tmp/cert.p12 & rm',
          APPLE_CERT_P12_PASSWORD: 'pw',
          APPLE_API_KEY_FILE: '/tmp/key.p8',
          APPLE_API_KEY_ID: 'ABC1234567',
          APPLE_API_ISSUER_ID: MAC_UUID,
        },
        exists: () => true,
      }),
    ).toThrow(/unsafe characters/);
  });

  it('never leaks .p12 or App-Specific Passwords into resolved config, osxSign, or notarytool CLI argv', () => {
    const p12Value = 'test-only-p12-value';
    const appValue = 'test-only-app-value';

    const cfg = resolveMacSigningConfig({
      sign: true,
      env: {
        APPLE_TEAM_ID: MAC_TEAM_ID,
        APPLE_CERT_P12_FILE: '/tmp/cert.p12',
        APPLE_CERT_P12_PASSWORD: p12Value,
        APPLE_ID: 'dev@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: appValue,
      },
      exists: () => true,
    });
    expect(JSON.stringify(cfg)).not.toContain(p12Value);
    expect(JSON.stringify(cfg)).not.toContain(appValue);
    if (!cfg.enabled) throw new Error('expected enabled');

    const osxSign = buildMacPackagerOsxSign({ identity: MAC_HASH, keychainPath: '/tmp/kc.keychain-db' });
    expect(JSON.stringify(osxSign)).not.toContain(p12Value);
    expect(JSON.stringify(osxSign)).not.toContain(appValue);
    expect(osxSign['continueOnError']).toBe(false);
    expect(osxSign['preAutoEntitlements']).toBe(false);

    const submitArgs = buildNotarySubmitArgs({
      targetPath: '/tmp/app.dmg',
      signing: cfg,
      notaryKeychainPath: '/tmp/kc.keychain-db',
      notaryProfile: 'ludy-notary-profile',
    });
    const logArgs = buildNotaryLogArgs({
      submissionId: MAC_UUID,
      signing: cfg,
      notaryKeychainPath: '/tmp/kc.keychain-db',
      notaryProfile: 'ludy-notary-profile',
    });
    expect([...submitArgs, ...logArgs].join(' ')).not.toContain(appValue);
    expect(submitArgs).not.toContain('--password');

    expect(() => escapeSecurityInteractiveArg('bad\nnewline')).toThrow(/NUL or newline/);
    const cmds = formatSecurityImportCommands({
      keychainPath: '/tmp/kc.keychain-db',
      keychainPassword: 'kc"value',
      p12Path: '/tmp/cert.p12',
      p12Password: p12Value,
    });
    expect(cmds).toContain('set-key-partition-list -S apple-tool:,apple:,codesign:');

    const executedSecurityLines: string[] = [];
    expect(() =>
      runSecurityInteractiveLines(
        'create-keychain -p "a" "/tmp/kc.keychain-db"\nset-keychain-settings -lut 21600 "/tmp/kc.keychain-db"\nunlock-keychain -p "a" "/tmp/kc.keychain-db"\n',
        (_cmd, _args, opts) => {
          executedSecurityLines.push(opts.input.trim());
          if (opts.input.startsWith('set-keychain-settings')) {
            return { status: 50, stderr: 'set-keychain-settings failed' };
          }
          return { status: 0, stdout: '' };
        },
      ),
    ).toThrow(/security interactive set-keychain-settings failed/);
    expect(executedSecurityLines).toHaveLength(2);
  });

  it('enforces ephemeral Keychain anti-clobber and fail-closed cleanup', async () => {
    const dir = makeTempDir();
    const existingKc = join(dir, 'preexisting.keychain-db');
    writeFileSync(existingKc, 'existing');
    const cfg = resolveMacSigningConfig({
      sign: true,
      env: {
        APPLE_TEAM_ID: MAC_TEAM_ID,
        APPLE_CERT_P12_FILE: join(dir, 'cert.p12'),
        APPLE_CERT_P12_PASSWORD: 'pw',
        APPLE_API_KEY_FILE: join(dir, 'key.p8'),
        APPLE_API_KEY_ID: 'ABC1234567',
        APPLE_API_ISSUER_ID: MAC_UUID,
      },
      exists: () => true,
    });
    if (!cfg.enabled) throw new Error('expected enabled');

    await expect(
      withEphemeralMacKeychain({
        signing: cfg,
        env: { LUDY_MAC_EPHEMERAL_KEYCHAIN: existingKc },
        run: async () => undefined,
      }),
    ).rejects.toThrow(/Refused to clobber/);

    const freshKc = join(dir, 'fresh.keychain-db');
    let searchList = ['/Users/runner/Library/Keychains/login.keychain-db'];
    let kcExists = false;
    await expect(
      withEphemeralMacKeychain({
        signing: cfg,
        env: { LUDY_MAC_EPHEMERAL_KEYCHAIN: freshKc, APPLE_CERT_P12_PASSWORD: 'pw' },
        exists: (p) => (p === freshKc ? kcExists : true),
        runSecurityInteractive: () => {
          kcExists = true;
        },
        exec: (_file, args) => {
          if (args[0] === 'list-keychains' && !args.includes('-s')) {
            return searchList.map((p) => `    "${p}"`).join('\n');
          }
          if (args[0] === 'list-keychains' && args.includes('-s')) {
            searchList = args.slice(4);
            return '';
          }
          if (args[0] === 'find-identity') {
            return `  1) ${MAC_HASH} "Developer ID Application: Ludy (${MAC_TEAM_ID})"`;
          }
          if (args[0] === 'delete-keychain') {
            throw new Error('delete-keychain denied');
          }
          return '';
        },
        run: async () => 'ok',
      }),
    ).rejects.toThrow(/Failed cleaning up ephemeral macOS Keychain/);
  });

  it('keeps macOS Hardened Runtime entitlements minimal, locks ATS to 127.0.0.1, and verifies codesign/spctl invariants', () => {
    const mainPlist = readFileSync(MAC_DARWIN_ENTITLEMENTS_PATH, 'utf8');
    const helperPlist = readFileSync(MAC_HELPER_ENTITLEMENTS_PATH, 'utf8');
    expect(selectMacEntitlementsForFile('/tmp/Ludy Desktop.app')).toBe(MAC_DARWIN_ENTITLEMENTS_PATH);
    expect(selectMacEntitlementsForFile('/tmp/Ludy Desktop.app/Contents/Frameworks/Ludy Desktop Helper (GPU).app')).toBe(
      MAC_HELPER_ENTITLEMENTS_PATH,
    );
    expect(
      selectMacEntitlementsForFile('/tmp/Ludy Desktop.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'),
    ).toBe(MAC_HELPER_ENTITLEMENTS_PATH);
    expect(
      selectMacEntitlementsForFile(
        '/tmp/Ludy Desktop.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
      ),
    ).toBe(MAC_HELPER_ENTITLEMENTS_PATH);

    for (const forbidden of [
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.get-task-allow',
      'com.apple.security.device.camera',
      'com.apple.security.device.bluetooth',
      'com.apple.security.personal-information.location',
      'com.apple.security.assets.pictures.read-only',
      'com.apple.security.device.usb',
      'com.apple.security.print',
    ]) {
      expect(mainPlist, forbidden).not.toContain(forbidden);
      expect(helperPlist, forbidden).not.toContain(forbidden);
    }
    expect(mainPlist).toContain('com.apple.security.device.audio-input');
    expect(helperPlist).not.toContain('com.apple.security.device.audio-input');

    const extendInfo = buildMacExtendInfo();
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

    // Enforce codesign/spctl parser guardrails directly inside signing invariant suite as well.
    expect(() =>
      parseCodesignIdentities(`  1) ${MAC_HASH} "Developer ID Application: Ludy (${MAC_TEAM_ID})"`, 'OTHERTEAM1'),
    ).toThrow(/does not match/);
    expect(() =>
      parseCodesignDisplayOutput(
        [
          'Identifier=vn.ludy.desktop',
          'CodeDirectory v=20500 size=100 flags=0x2(adhoc)',
          'Hash type=sha256 size=32',
          `Authority=Developer ID Application: Ludy (${MAC_TEAM_ID})`,
          'Authority=Developer ID Certification Authority',
          'Authority=Apple Root CA',
          'Timestamp=Nov 26, 2026 at 10:00:00',
          `TeamIdentifier=${MAC_TEAM_ID}`,
          'Sealed Resources version=2 rules=13 files=10',
        ].join('\n'),
        { expectedTeamId: MAC_TEAM_ID },
      ),
    ).toThrow(/ad-hoc/);
    expect(() =>
      parseCodesignDisplayOutput(
        [
          'Identifier=vn.ludy.desktop',
          'CodeDirectory v=20500 size=100 flags=0x10000(runtime)',
          'Hash type=sha1 size=20',
          `Authority=Developer ID Application: Ludy (${MAC_TEAM_ID})`,
          'Authority=Developer ID Certification Authority',
          'Authority=Apple Root CA',
          'Timestamp=Nov 26, 2026 at 10:00:00',
          `TeamIdentifier=${MAC_TEAM_ID}`,
          'Sealed Resources version=2 rules=13 files=10',
        ].join('\n'),
        { expectedTeamId: MAC_TEAM_ID },
      ),
    ).toThrow(/SHA-256/);
    expect(() =>
      parseCodesignDisplayOutput(
        [
          'Identifier=vn.ludy.desktop',
          'CodeDirectory v=20500 size=100 flags=0x10000(runtime)',
          'Hash type=sha256 size=32',
          `Authority=Developer ID Application: Ludy (${MAC_TEAM_ID})`,
          'Authority=Self Signed Root',
          'Timestamp=Nov 26, 2026 at 10:00:00',
          `TeamIdentifier=${MAC_TEAM_ID}`,
          'Sealed Resources version=2 rules=13 files=10',
        ].join('\n'),
        { expectedTeamId: MAC_TEAM_ID },
      ),
    ).toThrow(/Apple Root CA/);
    expect(() =>
      parseCodesignDisplayOutput(
        [
          'Identifier=vn.ludy.desktop',
          'CodeDirectory v=20500 size=100 flags=0x10000(runtime)',
          'Hash type=sha256 size=32',
          `Authority=Developer ID Application: Ludy (${MAC_TEAM_ID})`,
          'Authority=Developer ID Certification Authority',
          'Authority=Apple Root CA',
          `TeamIdentifier=${MAC_TEAM_ID}`,
          'Sealed Resources version=2 rules=13 files=10',
        ].join('\n'),
        { expectedTeamId: MAC_TEAM_ID },
      ),
    ).toThrow(/timestamp/);
    expect(() =>
      parseSpctlAssessOutput('/app: accepted\nsource=Unnotarized Developer ID\norigin=Developer ID Application: X (A1B2C3D4E5)'),
    ).toThrow(/Notarized Developer ID/);

    const dir = makeTempDir();
    const dmg = join(dir, 'LudyDesktop-0.1.0-darwin-arm64.dmg');
    const zip = join(dir, 'LudyDesktop-0.1.0-darwin-arm64.zip');
    writeFileSync(dmg, 'dmg-bytes');
    writeFileSync(zip, 'zip-bytes');
    expect(() =>
      createMacReleaseArtifacts({
        archDir: dir,
        arch: 'arm64',
        version: '0.1.0',
        signed: true,
        teamId: MAC_TEAM_ID,
        hardenedRuntime: true,
        notarized: false,
      }),
    ).toThrow(/notarized/);
    const out = createMacReleaseArtifacts({
      archDir: dir,
      arch: 'arm64',
      version: '0.1.0',
      signed: true,
      teamId: MAC_TEAM_ID,
      hardenedRuntime: true,
      notarized: true,
    });
    const sums = readFileSync(out.checksumsPath, 'utf8');
    const dmgSha = createHash('sha256').update('dmg-bytes').digest('hex');
    expect(sums).toContain(`${dmgSha}  LudyDesktop-0.1.0-darwin-arm64.dmg`);
    expect(fileURLToPath(new URL('../../scripts/macos-signing.mjs', import.meta.url))).toContain('macos-signing.mjs');
  });
});
