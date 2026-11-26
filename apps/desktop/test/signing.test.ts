// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  importEphemeralPfx,
  normalizeThumbprintList,
  parseImportedPfxResult,
  removeEphemeralCerts,
  resolveBundledModernSigntool,
} from '../scripts/package.mjs';
import {
  buildPackagerWindowsSign,
  buildWinstallerSignOptions,
  CHECKSUMS_FILENAME,
  createReleaseArtifacts,
  DEFAULT_TIMESTAMP_SERVER,
  extractSigntoolDigestAlgorithm,
  formatSignWithParamsString,
  parseReleasesEntries,
  parseSignWithParamsTokens,
  RELEASE_MANIFEST_FILENAME,
  resolveSigningConfig,
  validateTimestampServer,
  writeReleaseChecksums,
} from '../scripts/signing.mjs';
import { OID_SHA256, parseAuthenticodeCheckResults } from '../src/authenticode.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ludy-signing-test-'));
  tempDirs.push(dir);
  return dir;
}

const THUMB = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';

describe('resolveSigningConfig', () => {
  it('returns disabled when --sign is not requested even without secrets', () => {
    expect(resolveSigningConfig({ sign: false, env: {} })).toEqual({ enabled: false });
  });

  it('fails closed when --sign is requested without credentials or with partial/ambiguous credentials', () => {
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
    expect(() =>
      resolveSigningConfig({ sign: true, env: { WINDOWS_CERT_SHA1: 'short-hex' } }),
    ).toThrow(/40-character hexadecimal/);
    expect(() =>
      resolveSigningConfig({
        sign: true,
        env: { WINDOWS_CERTIFICATE_FILE: 'C:\\missing.pfx', WINDOWS_CERTIFICATE_PASSWORD: 'pw' },
        exists: () => false,
      }),
    ).toThrow(/does not exist/);
  });

  it('builds secret-free thumbprint and custom params configurations', () => {
    const cfg = resolveSigningConfig({
      sign: true,
      env: { WINDOWS_CERT_SHA1: THUMB.toLowerCase() },
    });
    expect(cfg).toEqual({
      enabled: true,
      mode: 'thumbprint',
      thumbprint: THUMB,
      timestampServer: DEFAULT_TIMESTAMP_SERVER,
      signtoolPath: null,
      signWithParams: ['/fd', 'sha256', '/tr', DEFAULT_TIMESTAMP_SERVER, '/td', 'sha256', '/sha1', THUMB],
    });
    expect(buildPackagerWindowsSign(cfg)).toEqual({
      hashes: ['sha256'],
      description: 'Ludy Desktop',
      timestampServer: DEFAULT_TIMESTAMP_SERVER,
      signWithParams: ['/fd', 'sha256', '/tr', DEFAULT_TIMESTAMP_SERVER, '/td', 'sha256', '/sha1', THUMB],
    });
    expect(buildWinstallerSignOptions(cfg)).toEqual({
      signWithParams: `/fd sha256 /tr ${DEFAULT_TIMESTAMP_SERVER} /td sha256 /sha1 ${THUMB}`,
    });

    const paramsCfg = resolveSigningConfig({
      sign: true,
      env: {
        WINDOWS_SIGN_WITH_PARAMS: '/csp "DigiCert Signing Manager KSP" /kc keypair_1',
        WINDOWS_TIMESTAMP_SERVER: 'https://timestamp.digicert.com',
      },
    });
    expect(paramsCfg.enabled).toBe(true);
    if (paramsCfg.enabled && paramsCfg.mode === 'params') {
      expect(paramsCfg.signWithParams).toEqual([
        '/csp',
        'DigiCert Signing Manager KSP',
        '/kc',
        'keypair_1',
        '/fd',
        'sha256',
        '/tr',
        'https://timestamp.digicert.com',
        '/td',
        'sha256',
      ]);
    }
  });

  it('generates secret-free PFX packager & winstaller sign configs without password exposure', () => {
    const secret = 'test-only-password-never-serialized';
    const cfg = resolveSigningConfig({
      sign: true,
      env: { WINDOWS_CERTIFICATE_FILE: 'C:\\signing\\ludy.pfx', WINDOWS_CERTIFICATE_PASSWORD: secret },
      exists: (p) => p === 'C:\\signing\\ludy.pfx',
    });
    expect(buildPackagerWindowsSign(cfg)).toEqual({
      hashes: ['sha256'],
      description: 'Ludy Desktop',
      timestampServer: DEFAULT_TIMESTAMP_SERVER,
      certificateFile: 'C:\\signing\\ludy.pfx',
    });
    expect(buildWinstallerSignOptions(cfg, { WINDOWS_CERTIFICATE_PASSWORD: secret })).toEqual({
      windowsSign: {
        hashes: ['sha256'],
        certificateFile: 'C:\\signing\\ludy.pfx',
        timestampServer: DEFAULT_TIMESTAMP_SERVER,
        description: 'Ludy Desktop',
      },
    });
  });
});

describe('timestamp and parameter formatting', () => {
  it('validates HTTPS timestamp servers and canonicalizes signWithParams flags', () => {
    expect(validateTimestampServer('https://timestamp.sectigo.com/')).toBe('https://timestamp.sectigo.com');
    expect(parseSignWithParamsTokens('/csp "My Provider" /kc mykey /FD SHA256 /TD:SHA256 /TR https://timestamp.digicert.com')).toEqual([
      '/csp',
      'My Provider',
      '/kc',
      'mykey',
      '/fd',
      'sha256',
      '/td',
      'sha256',
      '/tr',
      'https://timestamp.digicert.com',
    ]);
    expect(formatSignWithParamsString(['/csp', 'My Provider', '/sha1', THUMB])).toBe(`/csp "My Provider" /sha1 ${THUMB}`);
  });
});

describe('parseAuthenticodeResults and createReleaseArtifacts', () => {
  it('extracts sha256 digest from signtool verify output and rejects sha1 or empty output', () => {
    expect(extractSigntoolDigestAlgorithm('Signature Index: 0 (Primary Signature)\nHash of file (sha256): ABCD')).toBe('sha256');
    expect(() => extractSigntoolDigestAlgorithm('Hash of file (sha1): ABCD')).toThrow(/non-sha256/);
    expect(() => extractSigntoolDigestAlgorithm('')).toThrow(/empty output/);
  });

  it('requires Valid status, sha256 digest, RFC 3161 timestamp, and matching thumbprints across all binaries', () => {
    const okJson = JSON.stringify([
      {
        path: 'Setup.exe',
        status: 'Valid',
        signatureType: 'Authenticode',
        thumbprint: THUMB,
        hasTimestamp: true,
        fileDigestOid: OID_SHA256,
        signerDigestOid: OID_SHA256,
        timestampType: 'rfc3161',
        tsDigestOid: OID_SHA256,
      },
      {
        path: 'ludy-desktop.exe',
        status: 'Valid',
        signatureType: 'Authenticode',
        thumbprint: THUMB.toLowerCase(),
        hasTimestamp: true,
        fileDigestOid: OID_SHA256,
        signerDigestOid: OID_SHA256,
        timestampType: 'rfc3161',
        tsDigestOid: OID_SHA256,
      },
    ]);
    expect(parseAuthenticodeCheckResults(okJson, ['Setup.exe', 'ludy-desktop.exe'])).toEqual({ thumbprint: THUMB.toLowerCase() });

    expect(() =>
      parseAuthenticodeCheckResults(
        JSON.stringify([
          {
            path: 'Setup.exe',
            status: 'NotSigned',
            signatureType: 'None',
            thumbprint: null,
            hasTimestamp: false,
            fileDigestOid: OID_SHA256,
            signerDigestOid: OID_SHA256,
            timestampType: 'rfc3161',
            tsDigestOid: OID_SHA256,
          },
        ]),
        ['Setup.exe'],
      ),
    ).toThrow(/NotSigned/);

    expect(() =>
      parseAuthenticodeCheckResults(
        JSON.stringify([
          {
            path: 'Setup.exe',
            status: 'Valid',
            signatureType: 'Authenticode',
            thumbprint: THUMB,
            hasTimestamp: false,
            fileDigestOid: OID_SHA256,
            signerDigestOid: OID_SHA256,
            timestampType: 'rfc3161',
            tsDigestOid: OID_SHA256,
          },
        ]),
        ['Setup.exe'],
      ),
    ).toThrow(/timestamp/);

    expect(() =>
      parseAuthenticodeCheckResults(
        JSON.stringify([
          {
            path: 'Setup.exe',
            status: 'Valid',
            signatureType: 'Authenticode',
            thumbprint: THUMB,
            hasTimestamp: true,
            fileDigestOid: '1.3.14.3.2.26',
            signerDigestOid: OID_SHA256,
            timestampType: 'rfc3161',
            tsDigestOid: OID_SHA256,
          },
        ]),
        ['Setup.exe'],
      ),
    ).toThrow(/SHA-256/);

    expect(() =>
      parseAuthenticodeCheckResults(
        JSON.stringify([
          {
            path: 'Setup.exe',
            status: 'Valid',
            signatureType: 'Authenticode',
            thumbprint: THUMB,
            hasTimestamp: true,
            fileDigestOid: OID_SHA256,
            signerDigestOid: OID_SHA256,
            timestampType: 'rfc3161',
            tsDigestOid: OID_SHA256,
          },
          {
            path: 'ludy-desktop.exe',
            status: 'Valid',
            signatureType: 'Authenticode',
            thumbprint: 'f'.repeat(40),
            hasTimestamp: true,
            fileDigestOid: OID_SHA256,
            signerDigestOid: OID_SHA256,
            timestampType: 'rfc3161',
            tsDigestOid: OID_SHA256,
          },
        ]),
        ['Setup.exe', 'ludy-desktop.exe'],
      ),
    ).toThrow(/mismatch/);
  });

  it('generates verified release-manifest.json and SHA256SUMS.txt matching RELEASES', () => {
    const dir = makeTempDir();
    const setupBytes = Buffer.from('setup-binary-payload');
    const nupkgBytes = Buffer.from('nupkg-archive-payload');
    const nupkgSha1 = createHash('sha1').update(nupkgBytes).digest('hex').toUpperCase();
    const nupkgSha256 = createHash('sha256').update(nupkgBytes).digest('hex');
    const setupSha256 = createHash('sha256').update(setupBytes).digest('hex');

    writeFileSync(join(dir, 'LudyDesktop-Setup.exe'), setupBytes);
    writeFileSync(join(dir, 'LudyDesktop-0.1.0-full.nupkg'), nupkgBytes);
    writeFileSync(join(dir, 'RELEASES'), `${nupkgSha1} LudyDesktop-0.1.0-full.nupkg ${nupkgBytes.length}\n`);

    const { manifestPath, checksumsPath } = createReleaseArtifacts({
      installerDir: dir,
      version: '0.1.0',
      signed: true,
      timestampServer: DEFAULT_TIMESTAMP_SERVER,
      publisherThumbprint: THUMB,
    });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest).toEqual({
      schemaVersion: 1,
      product: 'ludy-desktop',
      platform: 'win32',
      arch: 'x64',
      version: '0.1.0',
      signed: true,
      signing: {
        algorithm: 'sha256',
        timestampServer: DEFAULT_TIMESTAMP_SERVER,
        publisherThumbprint: THUMB.toLowerCase(),
      },
      installer: {
        file: 'LudyDesktop-Setup.exe',
        sha256: setupSha256,
        size: setupBytes.length,
      },
      packages: [
        {
          file: 'LudyDesktop-0.1.0-full.nupkg',
          kind: 'full',
          version: '0.1.0',
          sha1: nupkgSha1.toLowerCase(),
          sha256: nupkgSha256,
          size: nupkgBytes.length,
        },
      ],
    });
    const sums = readFileSync(checksumsPath, 'utf8');
    expect(sums).toContain(`${setupSha256}  LudyDesktop-Setup.exe`);
    expect(sums).toContain(`${nupkgSha256}  LudyDesktop-0.1.0-full.nupkg`);
    expect(sums).toContain(RELEASE_MANIFEST_FILENAME);
    expect(checksumsPath.endsWith(CHECKSUMS_FILENAME)).toBe(true);
    expect(parseReleasesEntries(readFileSync(join(dir, 'RELEASES'), 'utf8'))).toHaveLength(1);

    writeFileSync(join(dir, 'release-manifest.ps1'), 'signed-script', 'utf8');
    writeReleaseChecksums(dir);
    expect(readFileSync(checksumsPath, 'utf8')).toContain('release-manifest.ps1');

    // Tampered nupkg must fail closed against RELEASES.
    writeFileSync(join(dir, 'LudyDesktop-0.1.0-full.nupkg'), Buffer.from('tampered-bytes'));
    expect(() =>
      createReleaseArtifacts({
        installerDir: dir,
        version: '0.1.0',
        signed: false,
      }),
    ).toThrow(/does not match RELEASES/);
  });
});

describe('resolveBundledModernSigntool', () => {
  it('resolves vendor/signtool.exe through package root exports without touching unexported subpaths', () => {
    const dir = makeTempDir();
    const packagerDir = join(dir, 'node_modules', '@electron', 'packager');
    const winSignDir = join(packagerDir, 'node_modules', '@electron', 'windows-sign');
    mkdirSync(join(packagerDir, 'dist'), { recursive: true });
    mkdirSync(join(winSignDir, 'dist'), { recursive: true });
    mkdirSync(join(winSignDir, 'vendor'), { recursive: true });
    writeFileSync(
      join(packagerDir, 'package.json'),
      JSON.stringify({ name: '@electron/packager', type: 'module', exports: { '.': './dist/index.js' } }),
    );
    writeFileSync(join(packagerDir, 'dist', 'index.js'), 'export const packager = () => [];\n');
    writeFileSync(
      join(winSignDir, 'package.json'),
      JSON.stringify({ name: '@electron/windows-sign', type: 'module', exports: './dist/index.js' }),
    );
    writeFileSync(join(winSignDir, 'dist', 'index.js'), 'export const sign = () => undefined;\n');
    const expectedSigntool = join(winSignDir, 'vendor', 'signtool.exe');
    writeFileSync(expectedSigntool, 'MZ');

    const localReq = createRequire(join(dir, 'index.js'));
    expect(realpathSync(resolveBundledModernSigntool(localReq))).toBe(realpathSync(expectedSigntool));
  });
});

describe('ephemeral multi-certificate PFX staging and cleanup', () => {
  const leaf = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const intermediate = 'b1c2d3e4f5061728394a5b6c7d8e9f0123456789';

  it('normalizes and parses multi-certificate PFX results and cleans up all newly imported certificates', () => {
    expect(normalizeThumbprintList([leaf, ` ${intermediate} `, leaf.toUpperCase(), 'bad-thumb', ''])).toEqual([
      leaf.toUpperCase(),
      intermediate.toUpperCase(),
    ]);

    const parsed = parseImportedPfxResult(
      JSON.stringify({
        leaf: leaf,
        cleanup: [leaf, intermediate],
      }),
    );
    expect(parsed).toEqual({
      leafThumbprint: leaf.toUpperCase(),
      cleanupThumbprints: [leaf.toUpperCase(), intermediate.toUpperCase()],
    });

    expect(() => parseImportedPfxResult('')).toThrow(/empty output/);
    expect(() => parseImportedPfxResult('not-json')).toThrow(/malformed metadata/);
    expect(() => parseImportedPfxResult(JSON.stringify({ leaf: 'short' }))).toThrow(/invalid leaf thumbprint/);

    let seenImportScript = '';
    let seenImportEnv = {};
    const recordFile = join(makeTempDir(), 'cleanup-record.txt');
    const staged = importEphemeralPfx(
      'C:\\tmp\\bundle.pfx',
      (psScript, env) => {
        seenImportScript = psScript;
        seenImportEnv = env;
        return JSON.stringify({ leaf, cleanup: [leaf, intermediate] });
      },
      recordFile,
    );
    expect(staged.leafThumbprint).toBe(leaf.toUpperCase());
    expect(staged.cleanupThumbprints).toEqual([leaf.toUpperCase(), intermediate.toUpperCase()]);
    expect(seenImportEnv).toEqual({ LUDY_PFX_FILE: 'C:\\tmp\\bundle.pfx', LUDY_CERT_RECORD_FILE: recordFile });
    expect(seenImportScript).toContain('X509Certificate2Collection');
    expect(seenImportScript).toContain(
      '$col.Import($env:LUDY_PFX_FILE, $env:WINDOWS_CERTIFICATE_PASSWORD, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)',
    );
    expect(seenImportScript).not.toMatch(/\$col\.Import\([^)]*\$secure/);
    expect(seenImportScript).toContain('$_.HasPrivateKey');
    expect(seenImportScript).toContain('$leaves.Count -ne 1');
    expect(seenImportScript).toContain('$preExisting.ContainsKey($leafThumb)');
    expect(seenImportScript).toContain('LUDY_CERT_RECORD_FILE');
    expect(seenImportScript).toContain('Remove-Item -LiteralPath $p -DeleteKey');

    let seenCleanupScript = '';
    let seenCleanupEnv = {};
    removeEphemeralCerts([leaf, intermediate, 'not-hex'], (psScript, env) => {
      seenCleanupScript = psScript;
      seenCleanupEnv = env;
      return '';
    });
    expect(seenCleanupScript).toContain('Remove-Item -LiteralPath $storePath -DeleteKey -ErrorAction Stop');
    expect(seenCleanupScript).not.toContain('SilentlyContinue');
    expect(seenCleanupEnv).toEqual({
      LUDY_CERT_THUMBPRINTS: `${leaf.toUpperCase()},${intermediate.toUpperCase()}`,
    });
    expect(() =>
      removeEphemeralCerts([leaf], () => {
        throw new Error('Failed deleting temporary signing certificate(s)');
      }),
    ).toThrow(/Failed deleting temporary signing certificate/);
  });

  it('reconciles effective timestamp server from WINDOWS_SIGN_WITH_PARAMS /tr and rejects conflicts with WINDOWS_TIMESTAMP_SERVER', () => {
    const customTs = 'https://timestamp.sectigo.com';
    const fromParamsOnly = resolveSigningConfig({
      sign: true,
      env: { WINDOWS_SIGN_WITH_PARAMS: `/csp "Test KSP" /tr ${customTs}` },
    });
    expect(fromParamsOnly.enabled && fromParamsOnly.timestampServer).toBe(customTs);

    const matchingEnv = resolveSigningConfig({
      sign: true,
      env: { WINDOWS_SIGN_WITH_PARAMS: `/csp "Test KSP" /tr ${customTs}`, WINDOWS_TIMESTAMP_SERVER: customTs },
    });
    expect(matchingEnv.enabled && matchingEnv.timestampServer).toBe(customTs);

    expect(() =>
      resolveSigningConfig({
        sign: true,
        env: { WINDOWS_SIGN_WITH_PARAMS: `/csp "Test KSP" /tr ${customTs}`, WINDOWS_TIMESTAMP_SERVER: DEFAULT_TIMESTAMP_SERVER },
      }),
    ).toThrow(/Conflicting timestamp servers/);
  });
});
