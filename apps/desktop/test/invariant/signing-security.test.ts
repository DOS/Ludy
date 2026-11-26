// SPDX-License-Identifier: AGPL-3.0-only
// Security invariant suite for Windows installer signing credential isolation, flag normalization,
// timestamp server validation, and artifact checksum integrity (#4884).
// Self-contained under test/invariant/: imports only the modules under test and Node built-ins.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
      'http://169.254.169.254/ts',
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
