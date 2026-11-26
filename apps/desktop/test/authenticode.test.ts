// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractEmbeddedPkcs7Der,
  formatSignedReleaseManifestScript,
  OID_SHA256,
  parseAuthenticodeCheckResults,
  parseSignedReleaseManifestScript,
  verifyWindowsSignedManifest,
  verifyWindowsSignedPackage,
} from '../src/authenticode.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ludy-authcode-test-'));
  tempDirs.push(dir);
  return dir;
}

const THUMB = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA1_OID = '1.3.14.3.2.26';

function buildMinimalSignedPe(cmsDer: Buffer): Buffer {
  const peOffset = 0x80;
  const optOffset = peOffset + 24;
  const secDirOffset = optOffset + 112 + 4 * 8;
  const winCertOffset = 0x200;
  const winCertLen = 8 + cmsDer.length;
  const buf = Buffer.alloc(winCertOffset + winCertLen);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32LE(0x00004550, peOffset);
  buf.writeUInt16LE(0x020b, optOffset);
  buf.writeUInt32LE(16, optOffset + 108);
  buf.writeUInt32LE(winCertOffset, secDirOffset);
  buf.writeUInt32LE(winCertLen, secDirOffset + 4);
  buf.writeUInt32LE(winCertLen, winCertOffset);
  buf.writeUInt16LE(0x0200, winCertOffset + 4);
  buf.writeUInt16LE(0x0002, winCertOffset + 6);
  cmsDer.copy(buf, winCertOffset + 8);
  return buf;
}

function buildValidSha256Rfc3161CmsDer(): Buffer {
  const tlv = (tag: number, content: Buffer): Buffer => {
    const len = content.length;
    const hdr = len < 0x80 ? Buffer.from([tag, len]) : len < 256 ? Buffer.from([tag, 0x81, len]) : Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
    return Buffer.concat([hdr, content]);
  };
  const oidTlv = (dotted: string): Buffer => {
    const parts = dotted.split('.').map(Number);
    const out: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
    for (const n of parts.slice(2)) {
      const stack: number[] = [n & 0x7f];
      let v = n >> 7;
      while (v > 0) {
        stack.push((v & 0x7f) | 0x80);
        v >>= 7;
      }
      out.push(...stack.reverse());
    }
    return tlv(0x06, Buffer.from(out));
  };
  const algId = (oid: string): Buffer => tlv(0x30, Buffer.concat([oidTlv(oid), tlv(0x05, Buffer.alloc(0))]));
  const spcIndirect = tlv(
    0x30,
    Buffer.concat([tlv(0x30, oidTlv('1.3.6.1.4.1.311.2.1.15')), tlv(0x30, Buffer.concat([algId(OID_SHA256), tlv(0x04, Buffer.alloc(32, 1))]))]),
  );
  const encryptedSignature = Buffer.from('test-authenticode-encrypted-digest');
  const signatureSha256 = createHash('sha256').update(encryptedSignature).digest();
  const tstInfo = tlv(
    0x30,
    Buffer.concat([tlv(0x02, Buffer.from([1])), oidTlv('1.2.3.4'), tlv(0x30, Buffer.concat([algId(OID_SHA256), tlv(0x04, signatureSha256)]))]),
  );
  const tsEncap = tlv(0x30, Buffer.concat([oidTlv('1.2.840.113549.1.9.16.1.4'), tlv(0xa0, tlv(0x04, tstInfo))]));
  const tsSignedData = tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([3])), tlv(0x31, algId(OID_SHA256)), tsEncap, tlv(0x31, tlv(0x30, algId(OID_SHA256)))]));
  const tsToken = tlv(0x30, Buffer.concat([oidTlv('1.2.840.113549.1.7.2'), tlv(0xa0, tsSignedData)]));
  const unsignedAttr = tlv(0xa1, tlv(0x30, Buffer.concat([oidTlv('1.3.6.1.4.1.311.3.3.1'), tlv(0x31, tsToken)])));
  const sid = tlv(0x30, Buffer.concat([tlv(0x30, Buffer.alloc(0)), tlv(0x02, Buffer.from([1]))]));
  const signerInfo = tlv(
    0x30,
    Buffer.concat([tlv(0x02, Buffer.from([1])), sid, algId(OID_SHA256), algId('1.2.840.113549.1.1.11'), tlv(0x04, encryptedSignature), unsignedAttr]),
  );
  const encap = tlv(0x30, Buffer.concat([oidTlv('1.3.6.1.4.1.311.2.1.4'), tlv(0xa0, spcIndirect)]));
  const signedData = tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([1])), tlv(0x31, algId(OID_SHA256)), encap, tlv(0x31, signerInfo)]));
  return tlv(0x30, Buffer.concat([oidTlv('1.2.840.113549.1.7.2'), tlv(0xa0, signedData)]));
}

describe('parseAuthenticodeCheckResults', () => {
  it('accepts single and array valid SHA-256 RFC 3161 results matching expected thumbprint', () => {
    const single = JSON.stringify({
      path: 'ludy-desktop.exe',
      status: 'Valid',
      thumbprint: THUMB.toUpperCase(),
      hasTimestamp: true,
      fileDigestOid: OID_SHA256,
      timestampType: 'rfc3161',
      tsDigestOid: OID_SHA256,
    });
    expect(parseAuthenticodeCheckResults(single, ['ludy-desktop.exe'], THUMB)).toEqual({ thumbprint: THUMB });

    const multi = JSON.stringify([
      {
        path: 'ludy-desktop.exe',
        status: 'Valid',
        thumbprint: THUMB,
        hasTimestamp: true,
        fileDigestOid: OID_SHA256,
        timestampType: 'rfc3161',
        tsDigestOid: OID_SHA256,
      },
      {
        path: 'Squirrel.exe',
        status: 'Valid',
        thumbprint: THUMB.toUpperCase(),
        hasTimestamp: true,
        fileDigestOid: OID_SHA256,
        timestampType: 'rfc3161',
        tsDigestOid: OID_SHA256,
      },
    ]);
    expect(parseAuthenticodeCheckResults(multi, ['ludy-desktop.exe', 'Squirrel.exe'], null)).toEqual({ thumbprint: THUMB });
  });

  it('fails closed on invalid status, legacy timestamps, SHA-1 digests, or thumbprint mismatch', () => {
    const okRow = {
      path: 'a.exe',
      status: 'Valid',
      thumbprint: THUMB,
      hasTimestamp: true,
      fileDigestOid: OID_SHA256,
      timestampType: 'rfc3161',
      tsDigestOid: OID_SHA256,
    };

    expect(() => parseAuthenticodeCheckResults(JSON.stringify([{ ...okRow, status: 'HashMismatch' }]), ['a.exe'])).toThrow(/HashMismatch/);
    expect(() => parseAuthenticodeCheckResults(JSON.stringify([{ ...okRow, hasTimestamp: false }]), ['a.exe'])).toThrow(/missing a timestamp/);
    expect(() => parseAuthenticodeCheckResults(JSON.stringify([{ ...okRow, timestampType: 'authenticode-legacy' }]), ['a.exe'])).toThrow(/RFC 3161/);
    expect(() => parseAuthenticodeCheckResults(JSON.stringify([{ ...okRow, fileDigestOid: SHA1_OID }]), ['a.exe'])).toThrow(/SHA-256/);
    expect(() => parseAuthenticodeCheckResults(JSON.stringify([{ ...okRow, tsDigestOid: SHA1_OID }]), ['a.exe'])).toThrow(/SHA-256/);
    expect(() =>
      parseAuthenticodeCheckResults(
        JSON.stringify([okRow, { ...okRow, path: 'b.exe', thumbprint: 'f'.repeat(40) }]),
        ['a.exe', 'b.exe'],
      ),
    ).toThrow(/mismatch/);
    expect(() => parseAuthenticodeCheckResults(JSON.stringify([okRow]), ['a.exe'], 'e'.repeat(40))).toThrow(/does not match expected/);
  });
});

describe('release-manifest.ps1 formatting, PKCS#7 extraction, and package verification', () => {
  it('round-trips JSON payload and extracts PKCS#7 DER from signed .ps1 scripts', async () => {
    const dir = makeTempDir();
    const manifestJson = JSON.stringify({ schemaVersion: 1, version: '0.1.2', signed: true });
    const unsignedScript = formatSignedReleaseManifestScript(manifestJson);
    expect(parseSignedReleaseManifestScript(unsignedScript).toString('utf8')).toBe(manifestJson);

    const cmsDer = buildValidSha256Rfc3161CmsDer();
    const signedScript = `${unsignedScript}# SIG # Begin signature block\r\n# ${cmsDer.toString('base64')}\r\n# SIG # End signature block\r\n`;
    const ps1Path = join(dir, 'release-manifest.ps1');
    writeFileSync(ps1Path, signedScript, 'utf8');

    expect(extractEmbeddedPkcs7Der(ps1Path).equals(cmsDer)).toBe(true);
    expect(parseSignedReleaseManifestScript(readFileSync(ps1Path, 'utf8')).toString('utf8')).toBe(manifestJson);

    const mockPs = async () =>
      JSON.stringify({ path: ps1Path, status: 'Valid', thumbprint: THUMB, hasTimestamp: true });
    await expect(verifyWindowsSignedManifest(ps1Path, Buffer.from(manifestJson), THUMB, mockPs, 'win32')).resolves.toEqual({ thumbprint: THUMB });
  });

  it('extracts required PE targets case-insensitively and verifies embedded WIN_CERTIFICATE PKCS#7 signatures', async () => {
    const dir = makeTempDir();
    const pkg = join(dir, 'LudyDesktop-0.1.1-full.nupkg');
    writeFileSync(pkg, 'stub-nupkg');
    await expect(verifyWindowsSignedPackage(pkg, THUMB, async () => '', 'linux')).rejects.toThrow(/only supported on Windows/);
    await expect(verifyWindowsSignedPackage(pkg, THUMB, async () => '', 'win32')).rejects.toThrow(/missing lib\/net45/);

    const peBytes = buildMinimalSignedPe(buildValidSha256Rfc3161CmsDer());
    let sawStdinPaths: string[] = [];
    const happyPs = async (_script: string, extraEnv: Record<string, string>, stdinText?: string) => {
      if (extraEnv.LUDY_UNZIP_DST) {
        const net45 = join(extraEnv.LUDY_UNZIP_DST, 'lib', 'net45');
        const binDir = join(net45, 'resources', 'app.asar.unpacked', 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(net45, 'ludy-desktop.exe'), peBytes);
        writeFileSync(join(net45, 'Squirrel.exe'), peBytes);
        writeFileSync(join(binDir, 'ludy-wasapi-loopback.exe'), peBytes);
        return '';
      }
      sawStdinPaths = JSON.parse(stdinText ?? '[]') as string[];
      return JSON.stringify(sawStdinPaths.map((p) => ({ path: p, status: 'Valid', thumbprint: THUMB, hasTimestamp: true })));
    };
    await verifyWindowsSignedPackage(pkg, THUMB, happyPs, 'win32');
    expect(sawStdinPaths).toHaveLength(3);
  });

  it('rejects duplicate signature markers or payload blocks in signed .ps1 scripts and malformed PE headers', () => {
    const dir = makeTempDir();
    const manifestJson = JSON.stringify({ schemaVersion: 1, version: '0.1.2', signed: true });
    const baseScript = formatSignedReleaseManifestScript(manifestJson);
    const cmsB64 = buildValidSha256Rfc3161CmsDer().toString('base64');

    const dupBlock = `${baseScript}${baseScript}# SIG # Begin signature block\r\n# ${cmsB64}\r\n# SIG # End signature block\r\n`;
    expect(() => parseSignedReleaseManifestScript(dupBlock)).toThrow(/exactly one JSON payload block/);

    const dupSig = `${baseScript}# SIG # Begin signature block\r\n# ${cmsB64}\r\n# SIG # End signature block\r\n# SIG # Begin signature block\r\n# ${cmsB64}\r\n# SIG # End signature block\r\n`;
    expect(() => parseSignedReleaseManifestScript(dupSig)).toThrow(/duplicate signature block/);
    const dupSigPath = join(dir, 'dup-sig.ps1');
    writeFileSync(dupSigPath, dupSig, 'utf8');
    expect(() => extractEmbeddedPkcs7Der(dupSigPath)).toThrow(/duplicate signature block/);

    const truncatedPe = join(dir, 'truncated-headers.exe');
    const smallPe = Buffer.alloc(176);
    smallPe.writeUInt16LE(0x5a4d, 0);
    smallPe.writeUInt32LE(0x80, 0x3c);
    smallPe.writeUInt32LE(0x00004550, 0x80);
    // peOffset + 176 exceeds 176 bytes, so header extraction must fail closed.
    writeFileSync(truncatedPe, smallPe);
    expect(() => extractEmbeddedPkcs7Der(truncatedPe)).toThrow(/Corrupt PE header offset/);

    const tinyRvaPe = join(dir, 'no-secdir.exe');
    const validSizedPe = buildMinimalSignedPe(buildValidSha256Rfc3161CmsDer());
    validSizedPe.writeUInt32LE(4, 0x80 + 24 + 108);
    writeFileSync(tinyRvaPe, validSizedPe);
    expect(() => extractEmbeddedPkcs7Der(tinyRvaPe)).toThrow(/DataDirectory entry 4/);

    const oversizedSecPe = join(dir, 'oversized-secdir.exe');
    const oversizedPe = buildMinimalSignedPe(buildValidSha256Rfc3161CmsDer());
    oversizedPe.writeUInt32LE(16 * 1024 * 1024 + 1, 0x80 + 24 + 112 + 4 * 8 + 4);
    writeFileSync(oversizedSecPe, oversizedPe);
    expect(() => extractEmbeddedPkcs7Der(oversizedSecPe)).toThrow(/security directory/);
  });
});
