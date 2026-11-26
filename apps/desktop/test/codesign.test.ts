// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for macOS code-signature, Hardened Runtime, Gatekeeper (spctl), and safe ZIP verification (#4885).
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPLE_BUNDLE_ID,
  inspectZipCentralDirectory,
  MAC_APP_BUNDLE_NAME,
  normalizeAppleTeamId,
  parseCodesignDisplayOutput,
  parseCodesignVerifyOutput,
  parseInfoPlistJson,
  parseSpctlAssessOutput,
  resolveMacAppBundlePath,
  verifyExtractedDirectorySymlinks,
  verifyMacAppBundle,
  verifyMacDmgPackage,
  verifyMacSignedPackage,
  type MacExecCmd,
} from '../src/codesign.ts';

const TEAM_ID = 'A1B2C3D4E5';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = 'ludy-codesign-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function validVerifyOutput(): string {
  return [
    '/Applications/Ludy Desktop.app: valid on disk',
    '/Applications/Ludy Desktop.app: satisfies its Designated Requirement',
  ].join('\n');
}

function validDisplayOutput(overrides: Partial<{
  identifier: string;
  flags: string;
  hashType: string;
  authorities: string[];
  timestamp: string;
  teamId: string;
  sealedResources: boolean;
}> = {}): string {
  const identifier = overrides.identifier ?? APPLE_BUNDLE_ID;
  const flags = overrides.flags ?? 'flags=0x10000(runtime)';
  const hashType = overrides.hashType ?? 'sha256 size=32';
  const authorities = overrides.authorities ?? [
    `Developer ID Application: Ludy Test (${TEAM_ID})`,
    'Developer ID Certification Authority',
    'Apple Root CA',
  ];
  const timestamp = overrides.timestamp ?? 'Nov 26, 2026 at 10:00:00';
  const teamId = overrides.teamId ?? TEAM_ID;
  const sealedResources = overrides.sealedResources ?? true;

  const lines = [
    `Executable=/Applications/Ludy Desktop.app/Contents/MacOS/Ludy Desktop`,
    `Identifier=${identifier}`,
    `Format=app bundle with Mach-O thin (arm64)`,
    `CodeDirectory v=20500 size=1024 ${flags} hashes=20+7 location=embedded`,
    `Hash type=${hashType}`,
    `CDHash=0123456789abcdef0123456789abcdef01234567`,
    `Signature size=8976`,
    ...authorities.map((a) => `Authority=${a}`),
    ...(timestamp ? [`Timestamp=${timestamp}`] : []),
    `TeamIdentifier=${teamId}`,
    ...(sealedResources ? ['Sealed Resources version=2 rules=13 files=42'] : []),
  ];
  return lines.join('\n');
}

function validSpctlOutput(teamId = TEAM_ID): string {
  return [
    '/Applications/Ludy Desktop.app: accepted',
    'source=Notarized Developer ID',
    `origin=Developer ID Application: Ludy Test (${teamId})`,
  ].join('\n');
}

interface SyntheticZipEntry {
  name: string;
  dataSize?: number;
  uncompressedSizeOverride?: number;
  compressedSizeOverride?: number;
}

function buildSyntheticZip(
  entries: SyntheticZipEntry[],
  overrides: {
    diskNumber?: number;
    entryCount?: number;
    cdOffset?: number;
    cdSize?: number;
    trailingCdBytes?: Buffer;
  } = {},
): Buffer {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const size = entry.dataSize ?? 4;
    const localHeader = Buffer.alloc(30 + nameBuf.length + size);
    const payloadCrc = size > 0 ? zlibCrc32(localHeader.subarray(30 + nameBuf.length)) >>> 0 : 0;
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(payloadCrc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(localHeader, 30);

    const cdHeader = Buffer.alloc(46 + nameBuf.length);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt32LE(payloadCrc, 16);
    cdHeader.writeUInt32LE(entry.compressedSizeOverride ?? size, 20);
    cdHeader.writeUInt32LE(entry.uncompressedSizeOverride ?? size, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(cdHeader, 46);

    localChunks.push(localHeader);
    cdChunks.push(cdHeader);
    offset += localHeader.length;
  }

  if (overrides.trailingCdBytes) {
    cdChunks.push(overrides.trailingCdBytes);
  }
  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(overrides.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(overrides.diskNumber ?? 0, 6);
  eocd.writeUInt16LE(overrides.entryCount ?? entries.length, 8);
  eocd.writeUInt16LE(overrides.entryCount ?? entries.length, 10);
  eocd.writeUInt32LE(overrides.cdSize ?? cdBuf.length, 12);
  eocd.writeUInt32LE(overrides.cdOffset ?? offset, 16);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

describe('macOS codesign verification', () => {
  it('resolves the .app bundle path only from a Contents/MacOS executable path', () => {
    expect(resolveMacAppBundlePath('/Applications/Ludy Desktop.app/Contents/MacOS/Ludy Desktop')).toBe(
      '/Applications/Ludy Desktop.app',
    );
    expect(resolveMacAppBundlePath('/Users/test/Desktop/Ludy Desktop.app/Contents/MacOS/Ludy Desktop')).toBe(
      '/Users/test/Desktop/Ludy Desktop.app',
    );
    expect(resolveMacAppBundlePath('')).toBeNull();
    expect(resolveMacAppBundlePath('/usr/local/bin/node')).toBeNull();
    expect(resolveMacAppBundlePath('/Applications/Ludy.dir/Contents/MacOS/Ludy')).toBeNull();
    expect(resolveMacAppBundlePath('/Applications/Ludy Desktop.app/Contents/Resources/app')).toBeNull();
  });

  it('normalizes 10-character Apple Team IDs and rejects invalid values', () => {
    expect(normalizeAppleTeamId('  a1b2c3d4e5  ')).toBe('A1B2C3D4E5');
    expect(normalizeAppleTeamId('')).toBeNull();
    expect(normalizeAppleTeamId('SHORT')).toBeNull();
    expect(normalizeAppleTeamId('A1B2C3D4E5Z')).toBeNull();
    expect(normalizeAppleTeamId('A1B2C-D4E5')).toBeNull();
  });

  it('validates codesign --verify output across LF and CRLF line endings', () => {
    expect(() => parseCodesignVerifyOutput(validVerifyOutput())).not.toThrow();
    expect(() => parseCodesignVerifyOutput(validVerifyOutput().replaceAll('\n', '\r\n'))).not.toThrow();
    expect(() => parseCodesignVerifyOutput('')).toThrow(/empty output/);
    expect(() => parseCodesignVerifyOutput('/Applications/Ludy Desktop.app: satisfies its Designated Requirement')).toThrow(
      /valid on disk/,
    );
    expect(() => parseCodesignVerifyOutput('/Applications/Ludy Desktop.app: valid on disk')).toThrow(
      /Designated Requirement/,
    );
  });

  it('parses Developer ID codesign --display output and rejects ad-hoc, non-runtime, SHA-1, and Team ID mismatches', () => {
    const parsed = parseCodesignDisplayOutput(validDisplayOutput().replaceAll('\n', '\r\n'), {
      expectedTeamId: TEAM_ID.toLowerCase(),
    });
    expect(parsed).toEqual({
      identifier: APPLE_BUNDLE_ID,
      teamId: TEAM_ID,
      authorities: [
        `Developer ID Application: Ludy Test (${TEAM_ID})`,
        'Developer ID Certification Authority',
        'Apple Root CA',
      ],
      timestamp: 'Nov 26, 2026 at 10:00:00',
      hashType: 'sha256',
      hardenedRuntime: true,
      arches: ['arm64'],
    });

    expect(() =>
      parseCodesignDisplayOutput(validDisplayOutput(), { expectedTeamId: TEAM_ID, expectedArch: 'x64' }),
    ).toThrow(/architecture \(arm64\) does not match expected x64/);

    const universal = parseCodesignDisplayOutput(
      validDisplayOutput().replace(
        'Format=app bundle with Mach-O thin (arm64)',
        'Format=app bundle with Mach-O universal (x86_64 arm64)',
      ),
      { expectedTeamId: TEAM_ID, expectedArch: 'x64' },
    );
    expect(universal.arches).toEqual(['x64', 'arm64']);

    expect(() =>
      parseInfoPlistJson(
        JSON.stringify({ CFBundleIdentifier: APPLE_BUNDLE_ID, CFBundleShortVersionString: '0.1.9' }),
        { expectedVersion: '0.2.0' },
      ),
    ).toThrow(/version mismatch/);
    expect(() =>
      parseInfoPlistJson(
        JSON.stringify({ CFBundleIdentifier: 'com.evil.app', CFBundleShortVersionString: '0.2.0' }),
        { expectedVersion: '0.2.0' },
      ),
    ).toThrow(/CFBundleIdentifier mismatch/);

    expect(() => parseCodesignDisplayOutput('')).toThrow(/empty output/);
    expect(() => parseCodesignDisplayOutput(validDisplayOutput({ identifier: 'com.evil.app' }))).toThrow(/Identifier mismatch/);
    expect(() => parseCodesignDisplayOutput(validDisplayOutput({ flags: 'flags=0x2(adhoc)' }))).toThrow(/ad-hoc/);
    expect(() => parseCodesignDisplayOutput(validDisplayOutput({ flags: 'flags=0x0(none)' }))).toThrow(/Hardened Runtime/);
    expect(() => parseCodesignDisplayOutput(validDisplayOutput({ hashType: 'sha1 size=20' }))).toThrow(/SHA-256/);
    expect(() => parseCodesignDisplayOutput(validDisplayOutput({ sealedResources: false }))).toThrow(/Sealed Resources/);
    expect(() =>
      parseCodesignDisplayOutput(
        validDisplayOutput({
          authorities: ['Apple Development: Dev User (A1B2C3D4E5)', 'Apple Worldwide Developer Relations Certification Authority'],
        }),
      ),
    ).toThrow(/Developer ID Application/);
    expect(() =>
      parseCodesignDisplayOutput(
        validDisplayOutput({
          authorities: [`Developer ID Application: Ludy Test (${TEAM_ID})`, 'Self Signed Root'],
        }),
      ),
    ).toThrow(/Apple Root CA/);
    expect(() => parseCodesignDisplayOutput(validDisplayOutput({ timestamp: '' }))).toThrow(/timestamp/);
    expect(() => parseCodesignDisplayOutput(validDisplayOutput({ teamId: 'not set' }))).toThrow(/TeamIdentifier/);
    expect(() =>
      parseCodesignDisplayOutput(validDisplayOutput({ teamId: TEAM_ID }), { expectedTeamId: 'Z9Y8X7W6V5' }),
    ).toThrow(/does not match expected/);
  });

  it('validates spctl Gatekeeper output and enforces Notarized Developer ID + Team ID', () => {
    expect(parseSpctlAssessOutput(validSpctlOutput().replaceAll('\n', '\r\n'), { expectedTeamId: TEAM_ID })).toEqual({
      source: 'Notarized Developer ID',
      origin: `Developer ID Application: Ludy Test (${TEAM_ID})`,
    });

    expect(() => parseSpctlAssessOutput('')).toThrow(/empty output/);
    expect(() => parseSpctlAssessOutput('/app: rejected\nsource=no usable signature')).toThrow(/did not accept/);
    expect(() =>
      parseSpctlAssessOutput('/app: accepted\nsource=Unnotarized Developer ID\norigin=Developer ID Application: X (A1B2C3D4E5)'),
    ).toThrow(/Notarized Developer ID/);
    expect(() => parseSpctlAssessOutput('/app: accepted\nsource=Notarized Developer ID')).toThrow(/missing Developer ID Application/);
    expect(() =>
      parseSpctlAssessOutput(validSpctlOutput('OTHERTEAM1'), { expectedTeamId: TEAM_ID }),
    ).toThrow(/does not match expected/);
  });

  it('inspects ZIP central directories and blocks traversal, Zip64, duplicates, bombs, and outside paths', () => {
    const dir = makeTempDir();

    const goodZip = join(dir, 'good.zip');
    writeFileSync(
      goodZip,
      buildSyntheticZip([
        { name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist`, dataSize: 120 },
        { name: `${MAC_APP_BUNDLE_NAME}/Contents/MacOS/Ludy Desktop`, dataSize: 280 },
      ]),
    );
    expect(inspectZipCentralDirectory(goodZip)).toEqual({ entryCount: 2, totalUncompressedBytes: 400 });

    const traversalZip = join(dir, 'traversal.zip');
    writeFileSync(traversalZip, buildSyntheticZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/../../../etc/passwd` }]));
    expect(() => inspectZipCentralDirectory(traversalZip)).toThrow(/Path traversal/);

    const backslashZip = join(dir, 'backslash.zip');
    writeFileSync(backslashZip, buildSyntheticZip([{ name: `${MAC_APP_BUNDLE_NAME}\\Contents\\Info.plist` }]));
    expect(() => inspectZipCentralDirectory(backslashZip)).toThrow(/Unsafe ZIP entry/);

    const outsideZip = join(dir, 'outside.zip');
    writeFileSync(outsideZip, buildSyntheticZip([{ name: 'Evil.app/Contents/Info.plist' }]));
    expect(() => inspectZipCentralDirectory(outsideZip)).toThrow(/Unexpected ZIP entry outside/);

    const duplicateZip = join(dir, 'dup.zip');
    writeFileSync(
      duplicateZip,
      buildSyntheticZip([
        { name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` },
        { name: `${MAC_APP_BUNDLE_NAME}/contents/info.plist` },
      ]),
    );
    expect(() => inspectZipCentralDirectory(duplicateZip)).toThrow(/Duplicate ZIP entry/);

    const multiDiskZip = join(dir, 'multidisk.zip');
    writeFileSync(
      multiDiskZip,
      buildSyntheticZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` }], { diskNumber: 1 }),
    );
    expect(() => inspectZipCentralDirectory(multiDiskZip)).toThrow(/Multi-disk/);

    const zip64Eocd = join(dir, 'zip64.zip');
    writeFileSync(
      zip64Eocd,
      buildSyntheticZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` }], { entryCount: 0xffff }),
    );
    expect(() => inspectZipCentralDirectory(zip64Eocd)).toThrow(/Zip64/);

    const zip64Entry = join(dir, 'zip64-entry.zip');
    writeFileSync(
      zip64Entry,
      buildSyntheticZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist`, uncompressedSizeOverride: 0xffffffff }]),
    );
    expect(() => inspectZipCentralDirectory(zip64Entry)).toThrow(/Zip64 entry sizes/);

    const bombZip = join(dir, 'bomb.zip');
    writeFileSync(
      bombZip,
      buildSyntheticZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Resources/blob`, uncompressedSizeOverride: 500_000_000 }]),
    );
    expect(() => inspectZipCentralDirectory(bombZip, { maxTotalUncompressedBytes: 1024 * 1024 })).toThrow(/safety limit/);

    const dittoSeqZip = join(dir, 'ditto-seq.zip');
    writeFileSync(
      dittoSeqZip,
      buildSyntheticZip([
        { name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist`, dataSize: 120 },
        { name: '__MACOSX/', dataSize: 0 },
        { name: `__MACOSX/${MAC_APP_BUNDLE_NAME}/Contents/._Info.plist`, dataSize: 64 },
      ]),
    );
    expect(inspectZipCentralDirectory(dittoSeqZip).entryCount).toBe(3);

    const evilAppleDoubleZip = join(dir, 'evil-appledouble.zip');
    writeFileSync(evilAppleDoubleZip, buildSyntheticZip([{ name: '__MACOSX/Evil.app/payload' }]));
    expect(() => inspectZipCentralDirectory(evilAppleDoubleZip)).toThrow(/Unexpected ZIP entry outside/);

    const truncatedHeaderZip = join(dir, 'truncated-cd.zip');
    writeFileSync(
      truncatedHeaderZip,
      buildSyntheticZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` }], { cdSize: 10 }),
    );
    expect(() => inspectZipCentralDirectory(truncatedHeaderZip)).toThrow(/Malformed ZIP central directory header/);

    const trailingBytesZip = join(dir, 'trailing-cd.zip');
    writeFileSync(
      trailingBytesZip,
      buildSyntheticZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/Info.plist` }], {
        trailingCdBytes: Buffer.from('junk'),
      }),
    );
    expect(() => inspectZipCentralDirectory(trailingBytesZip)).toThrow(/unexpected trailing bytes/);

    const nonZip = join(dir, 'empty.zip');
    writeFileSync(nonZip, Buffer.from('not-a-zip'));
    expect(() => inspectZipCentralDirectory(nonZip)).toThrow(/Invalid macOS update archive/);
  });

  it('verifies extracted bundle symlinks contain no absolute or escaping links', () => {
    const dir = makeTempDir();
    const bundleRoot = join(dir, MAC_APP_BUNDLE_NAME);
    const macOsDir = join(bundleRoot, 'Contents', 'MacOS');
    const resourcesDir = join(bundleRoot, 'Contents', 'Resources');
    mkdirSync(macOsDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });
    writeFileSync(join(resourcesDir, 'app.txt'), 'ok');

    if (process.platform !== 'win32') {
      symlinkSync('../Resources/app.txt', join(macOsDir, 'safe-link'));
      expect(() => verifyExtractedDirectorySymlinks(bundleRoot)).not.toThrow();

      symlinkSync('/etc/passwd', join(macOsDir, 'abs-link'));
      expect(() => verifyExtractedDirectorySymlinks(bundleRoot)).toThrow(/absolute symlink/);
      rmSync(join(macOsDir, 'abs-link'));

      const outsideFile = join(dir, 'outside-secret.txt');
      writeFileSync(outsideFile, 'secret');
      symlinkSync('../../../outside-secret.txt', join(macOsDir, 'escape-link'));
      expect(() => verifyExtractedDirectorySymlinks(bundleRoot)).toThrow(/escaping symlink/);

      const realExternalApp = join(dir, 'External.app');
      mkdirSync(realExternalApp, { recursive: true });
      const symlinkRoot = join(dir, 'SymlinkRoot.app');
      symlinkSync(realExternalApp, symlinkRoot);
      expect(() => verifyExtractedDirectorySymlinks(symlinkRoot)).toThrow(/Refused symlink/);
    } else {
      expect(() => verifyExtractedDirectorySymlinks(bundleRoot)).not.toThrow();
    }
  });

  it('verifies bundle and signed ZIP package without ever calling xcrun, and cleans up temp dir on failure', async () => {
    const dir = makeTempDir();
    const appDir = join(dir, MAC_APP_BUNDLE_NAME);
    mkdirSync(join(appDir, 'Contents', 'MacOS'), { recursive: true });

    await expect(
      verifyMacAppBundle(appDir, { expectedTeamId: TEAM_ID, platform: 'win32' }),
    ).rejects.toThrow(/only supported on macOS/);

    const calls: string[][] = [];
    const okExec: MacExecCmd = async (file, args) => {
      expect(file).not.toBe('xcrun');
      calls.push([file, ...args]);
      if (file === 'codesign' && args.includes('--verify')) {
        return { stdout: '', stderr: validVerifyOutput() };
      }
      if (file === 'codesign' && args.includes('--display')) {
        return { stdout: '', stderr: validDisplayOutput() };
      }
      if (file === 'plutil') {
        return {
          stdout: JSON.stringify({
            CFBundleIdentifier: APPLE_BUNDLE_ID,
            CFBundleShortVersionString: '0.1.0',
          }),
          stderr: '',
        };
      }
      if (file === 'spctl') {
        return { stdout: validSpctlOutput(), stderr: '' };
      }
      throw new Error(`unexpected command: ${file}`);
    };

    const sig = await verifyMacAppBundle(appDir, {
      expectedTeamId: TEAM_ID,
      expectedVersion: '0.1.0',
      expectedArch: 'arm64',
      platform: 'darwin',
      execCmd: okExec,
    });
    expect(sig.teamId).toBe(TEAM_ID);
    expect(sig.hardenedRuntime).toBe(true);
    expect(sig.bundleVersion).toBe('0.1.0');
    expect(sig.arches).toEqual(['arm64']);
    expect(calls.map((c) => c[0])).toEqual(['codesign', 'codesign', 'plutil', 'spctl']);

    await expect(
      verifyMacAppBundle(appDir, {
        expectedTeamId: TEAM_ID,
        expectedVersion: '0.9.9',
        expectedArch: 'arm64',
        platform: 'darwin',
        execCmd: okExec,
      }),
    ).rejects.toThrow(/version mismatch/);

    await expect(
      verifyMacAppBundle(appDir, {
        expectedTeamId: TEAM_ID,
        expectedVersion: '0.1.0',
        expectedArch: 'x64',
        platform: 'darwin',
        execCmd: okExec,
      }),
    ).rejects.toThrow(/architecture \(arm64\) does not match expected x64/);

    const zipDir = makeTempDir('ludy-zip-pkg-');
    const zipPath = join(zipDir, 'LudyDesktop-0.1.0-darwin-arm64.zip');
    writeFileSync(
      zipPath,
      buildSyntheticZip([{ name: `${MAC_APP_BUNDLE_NAME}/Contents/MacOS/Ludy Desktop` }]),
    );

    await expect(
      verifyMacSignedPackage(zipPath, null, { platform: 'darwin' }),
    ).rejects.toThrow(/without an expected Apple Team ID/);

    const packageExec: MacExecCmd = async (file, args) => {
      expect(file).not.toBe('xcrun');
      if (file === 'ditto') {
        const dest = args[3]!;
        mkdirSync(join(dest, MAC_APP_BUNDLE_NAME, 'Contents', 'MacOS'), { recursive: true });
        return { stdout: '', stderr: '' };
      }
      return okExec(file, args);
    };
    const pkgSig = await verifyMacSignedPackage(zipPath, TEAM_ID, {
      expectedVersion: '0.1.0',
      expectedArch: 'arm64',
      platform: 'darwin',
      execCmd: packageExec,
    });
    expect(pkgSig.teamId).toBe(TEAM_ID);
    expect(pkgSig.bundleVersion).toBe('0.1.0');
    expect(readdirSync(zipDir)).toEqual(['LudyDesktop-0.1.0-darwin-arm64.zip']);

    if (process.platform !== 'win32') {
      const symExtractExec: MacExecCmd = async (file, args) => {
        if (file === 'ditto') {
          symlinkSync(appDir, join(args[3]!, MAC_APP_BUNDLE_NAME));
          return { stdout: '', stderr: '' };
        }
        return okExec(file, args);
      };
      await expect(
        verifyMacSignedPackage(zipPath, TEAM_ID, { platform: 'darwin', execCmd: symExtractExec }),
      ).rejects.toThrow(/Refused symlink/);
    }

    const badDittoExec: MacExecCmd = async (file, args) => {
      if (file === 'ditto') {
        const dest = args[3]!;
        mkdirSync(join(dest, MAC_APP_BUNDLE_NAME), { recursive: true });
        writeFileSync(join(dest, 'hijack.txt'), 'bad');
        return { stdout: '', stderr: '' };
      }
      return okExec(file, args);
    };
    await expect(
      verifyMacSignedPackage(zipPath, TEAM_ID, { platform: 'darwin', execCmd: badDittoExec }),
    ).rejects.toThrow(/must contain only/);
    expect(readdirSync(zipDir)).toEqual(['LudyDesktop-0.1.0-darwin-arm64.zip']);

    const dmgPath = join(zipDir, 'LudyDesktop-0.1.0-darwin-arm64.dmg');
    await expect(
      verifyMacDmgPackage(dmgPath, TEAM_ID, {
        platform: 'darwin',
        execCmd: async (file, args) => {
          if (file === 'codesign' && args.includes('--verify')) return { stdout: '', stderr: '' };
          if (file === 'codesign' && args.includes('--display')) return { stdout: '', stderr: validDisplayOutput() };
          if (file === 'spctl') return { stdout: `${dmgPath}: accepted\nsource=Notarized Developer ID\n`, stderr: '' };
          throw new Error(`unexpected: ${file}`);
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      verifyMacDmgPackage(dmgPath, TEAM_ID, {
        platform: 'darwin',
        execCmd: async (file, args) => {
          if (file === 'codesign' && args.includes('--verify')) return { stdout: '', stderr: '' };
          if (file === 'codesign' && args.includes('--display')) {
            return { stdout: '', stderr: validDisplayOutput({ timestamp: '' }) };
          }
          return { stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/missing secure Apple timestamp/);
  });
});
