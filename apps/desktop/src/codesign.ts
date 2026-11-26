// SPDX-License-Identifier: AGPL-3.0-only
// macOS code-signature, Hardened Runtime, Gatekeeper (spctl), and safe ZIP update archive verification (#4885).
// Never invokes xcrun at runtime (clean Macs may lack Xcode CLT); uses only built-in macOS codesign, spctl, and ditto.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, openSync, closeSync, readdirSync, readlinkSync, readSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createInflateRaw, crc32 as zlibCrc32 } from 'node:zlib';

export const APPLE_BUNDLE_ID = 'vn.ludy.desktop';
export const MAC_APP_BUNDLE_NAME = 'Ludy Desktop.app';
export const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
export const MAX_ZIP_ENTRIES = 20_000;
export const MAX_ZIP_EXTRACTED_BYTES = 1024 * 1024 * 1024;

export type MacBundleArch = 'arm64' | 'x64';

export interface VerifiedMacAppSignature {
  identifier: string;
  teamId: string;
  authorities: string[];
  timestamp: string;
  hashType: 'sha256';
  hardenedRuntime: true;
  arches: MacBundleArch[];
  bundleVersion?: string | undefined;
}

export type MacExecResult = { stdout: string; stderr: string };
export type MacExecCmd = (file: string, args: readonly string[]) => Promise<MacExecResult>;

function defaultMacExecCmd(file: string, args: readonly string[]): Promise<MacExecResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || stdout.trim() || error.message;
          reject(new Error(`${file} failed: ${detail}`));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

export function resolveMacAppBundlePath(execPath: string): string | null {
  if (!execPath) return null;
  const macOsDir = dirname(execPath);
  const contentsDir = dirname(macOsDir);
  const bundleDir = dirname(contentsDir);
  if (basename(macOsDir) !== 'MacOS' || basename(contentsDir) !== 'Contents' || !bundleDir.endsWith('.app')) {
    return null;
  }
  return bundleDir;
}

export function normalizeAppleTeamId(value: string): string | null {
  const clean = value.trim().toUpperCase();
  return APPLE_TEAM_ID_PATTERN.test(clean) ? clean : null;
}

export function parseCodesignVerifyOutput(output: string): void {
  const normalized = output.replace(/\r?\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('codesign --verify produced empty output');
  }
  if (!normalized.includes('valid on disk')) {
    throw new Error('codesign --verify did not confirm bundle is valid on disk');
  }
  if (!normalized.includes('satisfies its Designated Requirement')) {
    throw new Error('codesign --verify did not confirm Designated Requirement');
  }
}

function parseCodesignFormatArches(formatLine: string): MacBundleArch[] {
  const m = /\(([^)]+)\)\s*$/.exec(formatLine);
  if (!m?.[1]) return [];
  const tokens = m[1].trim().split(/\s+/);
  const arches: MacBundleArch[] = [];
  for (const tok of tokens) {
    const clean = tok.toLowerCase();
    if ((clean === 'arm64' || clean.startsWith('arm64e')) && !arches.includes('arm64')) {
      arches.push('arm64');
    } else if (clean === 'x86_64' && !arches.includes('x64')) {
      arches.push('x64');
    }
  }
  return arches;
}

export function parseCodesignDisplayOutput(
  output: string,
  options: { expectedIdentifier?: string; expectedTeamId?: string | null; expectedArch?: MacBundleArch | undefined } = {},
): VerifiedMacAppSignature {
  const normalized = output.replace(/\r?\n/g, '\n');
  if (!normalized.trim()) {
    throw new Error('codesign --display produced empty output');
  }
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const expectedIdentifier = options.expectedIdentifier ?? APPLE_BUNDLE_ID;

  let identifier = '';
  let formatLine = '';
  let codeDirLine = '';
  let hashType = '';
  const authorities: string[] = [];
  let timestamp = '';
  let teamId = '';
  let hasSealedResources = false;

  for (const line of lines) {
    if (line.startsWith('Identifier=')) {
      identifier = line.slice('Identifier='.length).trim();
    } else if (line.startsWith('Format=')) {
      formatLine = line.slice('Format='.length).trim();
    } else if (line.startsWith('CodeDirectory ')) {
      codeDirLine = line;
    } else if (line.startsWith('Hash type=')) {
      hashType = line.slice('Hash type='.length).trim();
    } else if (line.startsWith('Authority=')) {
      authorities.push(line.slice('Authority='.length).trim());
    } else if (line.startsWith('Timestamp=')) {
      timestamp = line.slice('Timestamp='.length).trim();
    } else if (line.startsWith('TeamIdentifier=')) {
      teamId = line.slice('TeamIdentifier='.length).trim();
    } else if (line.startsWith('Sealed Resources ')) {
      hasSealedResources = true;
    }
  }

  if (identifier !== expectedIdentifier) {
    throw new Error(`codesign Identifier mismatch: expected ${expectedIdentifier}, got ${identifier || '(missing)'}`);
  }
  const arches = formatLine ? parseCodesignFormatArches(formatLine) : [];
  if (options.expectedArch && !arches.includes(options.expectedArch)) {
    throw new Error(
      `macOS app bundle architecture (${arches.join(', ') || 'unknown'}) does not match expected ${options.expectedArch}`,
    );
  }
  if (!codeDirLine) {
    throw new Error('codesign --display missing CodeDirectory flags');
  }
  const flagsMatch = /\bflags=0x[0-9a-f]+\(([^)]+)\)/i.exec(codeDirLine);
  const flags = (flagsMatch?.[1] ?? '').split(',').map((f) => f.trim().toLowerCase());
  if (flags.includes('adhoc')) {
    throw new Error('Refused ad-hoc macOS code signature');
  }
  if (!flags.includes('runtime')) {
    throw new Error('macOS app signature must enable Hardened Runtime');
  }
  if (!hashType.toLowerCase().startsWith('sha256')) {
    throw new Error(`macOS app signature must use SHA-256 CodeDirectory digest (got ${hashType || 'none'})`);
  }
  if (!hasSealedResources) {
    throw new Error('macOS app signature is missing Sealed Resources metadata');
  }
  if (authorities.length === 0 || !authorities[0]!.startsWith('Developer ID Application:')) {
    throw new Error(`macOS app signature is not signed with Developer ID Application (got ${authorities[0] ?? 'none'})`);
  }
  if (!authorities.includes('Developer ID Certification Authority') || !authorities.includes('Apple Root CA')) {
    throw new Error('macOS app signature does not chain to Developer ID Certification Authority and Apple Root CA');
  }
  if (!timestamp) {
    throw new Error('macOS app signature is missing a secure Apple timestamp');
  }
  const normalizedTeam = normalizeAppleTeamId(teamId);
  if (!normalizedTeam) {
    throw new Error(`macOS app signature has invalid TeamIdentifier: ${teamId || 'not set'}`);
  }
  if (options.expectedTeamId) {
    const expectedTeam = normalizeAppleTeamId(options.expectedTeamId);
    if (!expectedTeam || normalizedTeam !== expectedTeam) {
      throw new Error(`macOS app TeamIdentifier ${normalizedTeam} does not match expected ${options.expectedTeamId}`);
    }
  }

  return {
    identifier,
    teamId: normalizedTeam,
    authorities,
    timestamp,
    hashType: 'sha256',
    hardenedRuntime: true,
    arches,
  };
}

export function parseInfoPlistJson(
  rawJson: string,
  options: { expectedIdentifier?: string | undefined; expectedVersion?: string | undefined } = {},
): { bundleIdentifier: string; bundleVersion: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('macOS bundle Info.plist conversion returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('macOS bundle Info.plist must be a dictionary object');
  }
  const record = parsed as Record<string, unknown>;
  const bundleIdentifier = typeof record.CFBundleIdentifier === 'string' ? record.CFBundleIdentifier.trim() : '';
  const bundleVersion = typeof record.CFBundleShortVersionString === 'string' ? record.CFBundleShortVersionString.trim() : '';
  const expectedIdentifier = options.expectedIdentifier ?? APPLE_BUNDLE_ID;
  if (bundleIdentifier !== expectedIdentifier) {
    throw new Error(
      `macOS Info.plist CFBundleIdentifier mismatch: expected ${expectedIdentifier}, got ${bundleIdentifier || '(missing)'}`,
    );
  }
  if (!bundleVersion) {
    throw new Error('macOS Info.plist is missing CFBundleShortVersionString');
  }
  if (options.expectedVersion && bundleVersion !== options.expectedVersion) {
    throw new Error(
      `macOS app version mismatch: expected ${options.expectedVersion}, got ${bundleVersion} in Info.plist`,
    );
  }
  return { bundleIdentifier, bundleVersion };
}

export function parseSpctlAssessOutput(
  output: string,
  options: { expectedTeamId?: string | null; requireOrigin?: boolean } = {},
): { source: string; origin: string | null } {
  const normalized = output.replace(/\r?\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('spctl Gatekeeper check produced empty output');
  }
  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.some((l) => l.endsWith(': accepted'))) {
    throw new Error(`Gatekeeper spctl check did not accept target: ${normalized}`);
  }
  const sourceLine = lines.find((l) => l.startsWith('source='));
  const source = sourceLine ? sourceLine.slice('source='.length).trim() : '';
  if (source !== 'Notarized Developer ID') {
    throw new Error(`Gatekeeper spctl check requires Notarized Developer ID (got ${source || 'none'})`);
  }
  const originLine = lines.find((l) => l.startsWith('origin='));
  const origin = originLine ? originLine.slice('origin='.length).trim() : null;
  if (options.requireOrigin !== false) {
    if (!origin || !origin.startsWith('Developer ID Application:')) {
      throw new Error(`Gatekeeper spctl check missing Developer ID Application origin (got ${origin ?? 'none'})`);
    }
    const teamMatch = /\(([A-Z0-9]{10})\)\s*$/.exec(origin);
    if (!teamMatch?.[1]) {
      throw new Error(`Gatekeeper origin missing 10-character Apple Team ID: ${origin}`);
    }
    if (options.expectedTeamId) {
      const expectedTeam = normalizeAppleTeamId(options.expectedTeamId);
      if (!expectedTeam || teamMatch[1] !== expectedTeam) {
        throw new Error(`Gatekeeper Team ID ${teamMatch[1]} does not match expected ${options.expectedTeamId}`);
      }
    }
  }
  return { source, origin };
}

interface ParsedZipEntryMeta {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function parseZipCentralDirectoryEntries(
  zipPath: string,
  options: {
    requiredTopDir?: string | undefined;
    maxEntries?: number | undefined;
    maxTotalUncompressedBytes?: number | undefined;
  } = {},
): {
  entryCount: number;
  totalUncompressedBytes: number;
  cdOffset: number;
  entries: ParsedZipEntryMeta[];
} {
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxTotalBytes = options.maxTotalUncompressedBytes ?? MAX_ZIP_EXTRACTED_BYTES;
  const requiredTopDir = options.requiredTopDir ?? `${MAC_APP_BUNDLE_NAME}/`;

  let stat;
  try {
    stat = lstatSync(zipPath);
  } catch {
    throw new Error(`Invalid macOS update archive: ${zipPath}`);
  }
  if (!stat.isFile() || stat.size < 22) {
    throw new Error(`Invalid macOS update archive: ${zipPath}`);
  }

  const fd = openSync(zipPath, 'r');
  try {
    const tailLen = Math.min(stat.size, 65_557);
    const tailOffset = stat.size - tailLen;
    const tail = Buffer.alloc(tailLen);
    if (readSync(fd, tail, 0, tailLen, tailOffset) !== tailLen) {
      throw new Error('Failed reading ZIP end-of-central-directory tail');
    }

    let eocdOffset = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        const commentLen = tail.readUInt16LE(i + 20);
        if (i + 22 + commentLen === tailLen) {
          eocdOffset = i;
          break;
        }
      }
    }
    if (eocdOffset === -1) {
      throw new Error('ZIP archive is missing End of Central Directory record');
    }

    const diskNumber = tail.readUInt16LE(eocdOffset + 4);
    const cdDiskNumber = tail.readUInt16LE(eocdOffset + 6);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const cdSize = tail.readUInt32LE(eocdOffset + 12);
    const cdOffset = tail.readUInt32LE(eocdOffset + 16);

    if (diskNumber !== 0 || cdDiskNumber !== 0) {
      throw new Error('Multi-disk ZIP archives are not supported');
    }
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error('Zip64 archives exceed supported bounds');
    }
    if (entryCount <= 0 || entryCount > maxEntries) {
      throw new Error(`ZIP entry count ${entryCount} exceeds allowed limit (${maxEntries})`);
    }
    if (cdSize > 32 * 1024 * 1024 || cdOffset + cdSize > tailOffset + eocdOffset) {
      throw new Error('ZIP central directory bounds are invalid');
    }

    const cdBuf = Buffer.alloc(cdSize);
    if (readSync(fd, cdBuf, 0, cdSize, cdOffset) !== cdSize) {
      throw new Error('Failed reading ZIP central directory');
    }

    let cursor = 0;
    let totalUncompressedBytes = 0;
    const seenLowerNames = new Set<string>();
    const entries: ParsedZipEntryMeta[] = [];
    for (let idx = 0; idx < entryCount; idx++) {
      if (cursor + 46 > cdBuf.length || cdBuf.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('Malformed ZIP central directory header');
      }
      const flags = cdBuf.readUInt16LE(cursor + 8);
      const method = cdBuf.readUInt16LE(cursor + 10);
      const crc32 = cdBuf.readUInt32LE(cursor + 16);
      const compressedSize = cdBuf.readUInt32LE(cursor + 20);
      const uncompressedSize = cdBuf.readUInt32LE(cursor + 24);
      const nameLen = cdBuf.readUInt16LE(cursor + 28);
      const extraLen = cdBuf.readUInt16LE(cursor + 30);
      const commentLen = cdBuf.readUInt16LE(cursor + 32);
      const localHeaderOffset = cdBuf.readUInt32LE(cursor + 42);
      const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
      if (headerEnd > cdBuf.length) {
        throw new Error('Truncated ZIP central directory entry');
      }
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error('Zip64 entry sizes are not supported');
      }
      if (uncompressedSize > maxTotalBytes) {
        throw new Error('ZIP entry uncompressed size exceeds safety limit');
      }
      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > maxTotalBytes) {
        throw new Error(`ZIP total uncompressed size exceeds safety limit (${maxTotalBytes} bytes)`);
      }

      const rawName = cdBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
      if ((flags & 0x0001) !== 0) {
        throw new Error(`Encrypted ZIP entry is not supported: ${rawName}`);
      }
      if (rawName.includes('\0') || rawName.includes('\\') || rawName.startsWith('/')) {
        throw new Error(`Unsafe ZIP entry path: ${rawName}`);
      }
      const segments = rawName.split('/');
      if (segments.some((seg) => seg === '..' || seg === '.')) {
        throw new Error(`Path traversal segment in ZIP entry: ${rawName}`);
      }
      const topBundle = requiredTopDir.replace(/\/+$/, '');
      const allowedAppEntry = rawName === topBundle || rawName.startsWith(`${topBundle}/`);
      const allowedAppleDoubleEntry =
        rawName === '__MACOSX' ||
        rawName === '__MACOSX/' ||
        rawName === `__MACOSX/${topBundle}` ||
        rawName.startsWith(`__MACOSX/${topBundle}/`) ||
        rawName === `__MACOSX/._${topBundle}`;
      if (!allowedAppEntry && !allowedAppleDoubleEntry) {
        throw new Error(`Unexpected ZIP entry outside ${requiredTopDir}: ${rawName}`);
      }
      const lowerKey = rawName.replace(/\/+$/, '').toLowerCase();
      if (seenLowerNames.has(lowerKey)) {
        throw new Error(`Duplicate ZIP entry path: ${rawName}`);
      }
      seenLowerNames.add(lowerKey);
      entries.push({ name: rawName, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
      cursor = headerEnd;
    }
    if (cursor !== cdBuf.length) {
      throw new Error('ZIP central directory contains unexpected trailing bytes');
    }
    return { entryCount, totalUncompressedBytes, cdOffset, entries };
  } finally {
    closeSync(fd);
  }
}

export function inspectZipCentralDirectory(
  zipPath: string,
  options: {
    requiredTopDir?: string;
    maxEntries?: number;
    maxTotalUncompressedBytes?: number;
  } = {},
): { entryCount: number; totalUncompressedBytes: number } {
  const parsed = parseZipCentralDirectoryEntries(zipPath, options);
  return { entryCount: parsed.entryCount, totalUncompressedBytes: parsed.totalUncompressedBytes };
}

export async function verifyZipDecompressedSizeBounds(
  zipPath: string,
  options: {
    requiredTopDir?: string;
    maxEntries?: number;
    maxTotalUncompressedBytes?: number;
  } = {},
): Promise<{ entryCount: number; actualDecompressedBytes: number }> {
  const maxTotalBytes = options.maxTotalUncompressedBytes ?? MAX_ZIP_EXTRACTED_BYTES;
  const parsed = parseZipCentralDirectoryEntries(zipPath, options);
  const fd = openSync(zipPath, 'r');
  try {
    const lh = Buffer.alloc(30);
    let actualTotalBytes = 0;
    for (const entry of parsed.entries) {
      if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(`Unsupported ZIP compression method (${entry.method}) for ${entry.name}`);
      }
      if (entry.localHeaderOffset + 30 > parsed.cdOffset) {
        throw new Error(`ZIP local file header out of bounds for ${entry.name}`);
      }
      if (readSync(fd, lh, 0, 30, entry.localHeaderOffset) !== 30 || lh.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local file header for ${entry.name}`);
      }
      const lhFlags = lh.readUInt16LE(6);
      const lhMethod = lh.readUInt16LE(8);
      const lhCrc32 = lh.readUInt32LE(14);
      const lhCompressedSize = lh.readUInt32LE(18);
      const lhUncompressedSize = lh.readUInt32LE(22);
      const lhNameLen = lh.readUInt16LE(26);
      const lhExtraLen = lh.readUInt16LE(28);
      if ((lhFlags & 0x0001) !== 0) {
        throw new Error(`Encrypted ZIP local entry is not supported: ${entry.name}`);
      }
      if ((lhFlags & 0x0008) !== (entry.flags & 0x0008)) {
        throw new Error(`ZIP local header flags mismatch for ${entry.name}`);
      }
      if (lhMethod !== entry.method) {
        throw new Error(`ZIP local header compression method mismatch for ${entry.name}`);
      }
      const dataStart = entry.localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      if (dataStart > parsed.cdOffset || dataStart + entry.compressedSize > parsed.cdOffset) {
        throw new Error(`ZIP compressed entry extends past central directory for ${entry.name}`);
      }
      const lhNameBuf = Buffer.alloc(lhNameLen);
      if (lhNameLen > 0 && readSync(fd, lhNameBuf, 0, lhNameLen, entry.localHeaderOffset + 30) !== lhNameLen) {
        throw new Error(`Failed reading ZIP local header filename for ${entry.name}`);
      }
      if (lhNameBuf.toString('utf8') !== entry.name) {
        throw new Error(`ZIP local header filename mismatch for ${entry.name}`);
      }
      if ((lhFlags & 0x0008) === 0) {
        if (
          lhCompressedSize !== entry.compressedSize ||
          lhUncompressedSize !== entry.uncompressedSize ||
          lhCrc32 !== entry.crc32
        ) {
          throw new Error(`ZIP local header metadata mismatch for ${entry.name}`);
        }
      } else {
        if (lhCompressedSize !== 0 || lhUncompressedSize !== 0 || lhCrc32 !== 0) {
          throw new Error(`ZIP local header with data descriptor must zero inline fields for ${entry.name}`);
        }
        const ddOffset = dataStart + entry.compressedSize;
        if (ddOffset + 12 > parsed.cdOffset) {
          throw new Error(`ZIP data descriptor out of bounds for ${entry.name}`);
        }
        const dd = Buffer.alloc(Math.min(16, parsed.cdOffset - ddOffset));
        if (readSync(fd, dd, 0, dd.length, ddOffset) !== dd.length) {
          throw new Error(`Failed reading ZIP data descriptor for ${entry.name}`);
        }
        const hasSig = dd.length >= 16 && dd.readUInt32LE(0) === 0x08074b50;
        const ddBase = hasSig ? 4 : 0;
        if (
          dd.readUInt32LE(ddBase) !== entry.crc32 ||
          dd.readUInt32LE(ddBase + 4) !== entry.compressedSize ||
          dd.readUInt32LE(ddBase + 8) !== entry.uncompressedSize
        ) {
          throw new Error(`ZIP data descriptor metadata mismatch for ${entry.name}`);
        }
      }

      if (entry.method === 0) {
        if (entry.compressedSize !== entry.uncompressedSize) {
          throw new Error(`Stored ZIP entry size mismatch for ${entry.name}`);
        }
        let storedCrc = 0;
        if (entry.uncompressedSize > 0) {
          const ioBuf = Buffer.alloc(65_536);
          let remaining = entry.uncompressedSize;
          let pos = dataStart;
          while (remaining > 0) {
            const toRead = Math.min(remaining, ioBuf.length);
            const bytesRead = readSync(fd, ioBuf, 0, toRead, pos);
            if (bytesRead <= 0) {
              throw new Error(`Unexpected EOF reading stored ZIP entry ${entry.name}`);
            }
            storedCrc = zlibCrc32(ioBuf.subarray(0, bytesRead), storedCrc);
            pos += bytesRead;
            remaining -= bytesRead;
          }
        }
        if ((storedCrc >>> 0) !== entry.crc32) {
          throw new Error(`ZIP entry ${entry.name} CRC-32 mismatch`);
        }
        actualTotalBytes += entry.uncompressedSize;
        if (actualTotalBytes > maxTotalBytes) {
          throw new Error(`ZIP actual decompressed size exceeds safety limit (${maxTotalBytes} bytes)`);
        }
        continue;
      }

      if (entry.compressedSize === 0) {
        throw new Error(`Invalid empty deflate stream for ${entry.name}`);
      }
      const entryActualBytes = await new Promise<number>((resolveStream, rejectStream) => {
        const inflate = createInflateRaw();
        let entryBytes = 0;
        let runningCrc = 0;
        let settled = false;
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          inflate.destroy();
          rejectStream(err);
        };
        inflate.on('error', (err) => fail(err));
        inflate.on('data', (chunk: Buffer) => {
          runningCrc = zlibCrc32(chunk, runningCrc);
          entryBytes += chunk.byteLength;
          actualTotalBytes += chunk.byteLength;
          if (entryBytes > entry.uncompressedSize) {
            fail(new Error(`ZIP entry ${entry.name} actual decompressed size exceeds safety limit (${entry.uncompressedSize})`));
            return;
          }
          if (actualTotalBytes > maxTotalBytes) {
            fail(new Error(`ZIP actual decompressed size exceeds safety limit (${maxTotalBytes} bytes)`));
          }
        });
        inflate.on('end', () => {
          if (settled) return;
          settled = true;
          if (entryBytes !== entry.uncompressedSize) {
            rejectStream(
              new Error(`ZIP entry ${entry.name} decompressed size (${entryBytes}) does not match declared (${entry.uncompressedSize})`),
            );
            return;
          }
          if ((runningCrc >>> 0) !== entry.crc32) {
            rejectStream(new Error(`ZIP entry ${entry.name} CRC-32 mismatch`));
            return;
          }
          resolveStream(entryBytes);
        });
        (async () => {
          const ioBuf = Buffer.alloc(65_536);
          let remaining = entry.compressedSize;
          let pos = dataStart;
          while (remaining > 0 && !settled) {
            const toRead = Math.min(remaining, ioBuf.length);
            const bytesRead = readSync(fd, ioBuf, 0, toRead, pos);
            if (bytesRead <= 0) {
              fail(new Error(`Unexpected EOF reading ZIP entry ${entry.name}`));
              return;
            }
            pos += bytesRead;
            remaining -= bytesRead;
            const slice = ioBuf.subarray(0, bytesRead);
            if (!inflate.write(slice) && !settled) {
              await new Promise<void>((resDrain) => {
                const onDrain = (): void => {
                  inflate.off('close', onClose);
                  resDrain();
                };
                const onClose = (): void => {
                  inflate.off('drain', onDrain);
                  resDrain();
                };
                inflate.once('drain', onDrain);
                inflate.once('close', onClose);
              });
            }
          }
          if (!settled) inflate.end();
        })().catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
      });
      if (entryActualBytes > maxTotalBytes) {
        throw new Error(`ZIP actual decompressed size exceeds safety limit (${maxTotalBytes} bytes)`);
      }
    }
    return { entryCount: parsed.entryCount, actualDecompressedBytes: actualTotalBytes };
  } finally {
    closeSync(fd);
  }
}

export function verifyExtractedDirectorySymlinks(rootDir: string): void {
  const rootStat = lstatSync(rootDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refused symlink or non-directory at macOS bundle root: ${rootDir}`);
  }
  const realRoot = realpathSync(rootDir);
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      const st = lstatSync(fullPath);
      if (st.isSymbolicLink()) {
        const linkTarget = readlinkSync(fullPath);
        if (linkTarget.startsWith('/')) {
          throw new Error(`Refused absolute symlink inside macOS bundle: ${fullPath} -> ${linkTarget}`);
        }
        const resolved = resolve(dirname(fullPath), linkTarget);
        const relLex = relative(rootDir, resolved);
        if (relLex === '..' || relLex.startsWith('../') || relLex.startsWith('..\\')) {
          throw new Error(`Refused escaping symlink inside macOS bundle: ${fullPath} -> ${linkTarget}`);
        }
        if (existsSync(fullPath)) {
          const realTarget = realpathSync(fullPath);
          const relReal = relative(realRoot, realTarget);
          if (relReal === '..' || relReal.startsWith('../') || relReal.startsWith('..\\')) {
            throw new Error(`Refused escaping symlink target inside macOS bundle: ${fullPath}`);
          }
        }
      } else if (st.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
}

export async function verifyMacAppBundle(
  appPath: string,
  options: {
    expectedTeamId?: string | null | undefined;
    expectedVersion?: string | undefined;
    expectedArch?: MacBundleArch | undefined;
    requireGatekeeper?: boolean | undefined;
    execCmd?: MacExecCmd | undefined;
    platform?: NodeJS.Platform | undefined;
  } = {},
): Promise<VerifiedMacAppSignature> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new Error('macOS codesign verification is only supported on macOS');
  }
  let rootStat;
  try {
    rootStat = lstatSync(appPath);
  } catch {
    throw new Error(`macOS app bundle does not exist: ${appPath}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refused symlink or non-directory macOS app bundle: ${appPath}`);
  }
  const execCmd = options.execCmd ?? defaultMacExecCmd;

  const verifyOut = await execCmd('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  parseCodesignVerifyOutput(`${verifyOut.stdout}\n${verifyOut.stderr}`);

  const displayOut = await execCmd('codesign', ['--display', '--verbose=4', appPath]);
  const parsed = parseCodesignDisplayOutput(`${displayOut.stdout}\n${displayOut.stderr}`, {
    expectedIdentifier: APPLE_BUNDLE_ID,
    expectedTeamId: options.expectedTeamId ?? null,
    expectedArch: options.expectedArch,
  });

  if (options.expectedVersion) {
    const plistOut = await execCmd('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents', 'Info.plist')]);
    const plist = parseInfoPlistJson(plistOut.stdout, {
      expectedIdentifier: APPLE_BUNDLE_ID,
      expectedVersion: options.expectedVersion,
    });
    parsed.bundleVersion = plist.bundleVersion;
  }

  if (options.requireGatekeeper !== false) {
    const spctlOut = await execCmd('spctl', ['-a', '-t', 'exec', '-vv', appPath]);
    parseSpctlAssessOutput(`${spctlOut.stdout}\n${spctlOut.stderr}`, {
      expectedTeamId: options.expectedTeamId ?? parsed.teamId,
      requireOrigin: true,
    });
  }

  return parsed;
}

export async function verifyMacSignedPackage(
  zipPath: string,
  expectedTeamId: string | null,
  options: {
    expectedVersion?: string | undefined;
    expectedArch?: MacBundleArch | undefined;
    execCmd?: MacExecCmd | undefined;
    platform?: NodeJS.Platform | undefined;
  } = {},
): Promise<VerifiedMacAppSignature> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new Error('macOS package verification is only supported on macOS');
  }
  if (!expectedTeamId) {
    throw new Error('Refused macOS signed update verification without an expected Apple Team ID');
  }
  await verifyZipDecompressedSizeBounds(zipPath, { requiredTopDir: `${MAC_APP_BUNDLE_NAME}/` });

  const extractDir = mkdtempSync(join(dirname(zipPath), 'verify-mac-zip-'));
  const execCmd = options.execCmd ?? defaultMacExecCmd;
  try {
    await execCmd('ditto', ['-x', '-k', zipPath, extractDir]);
    const topEntries = readdirSync(extractDir);
    if (topEntries.length !== 1 || topEntries[0] !== MAC_APP_BUNDLE_NAME) {
      throw new Error(`macOS update archive must contain only ${MAC_APP_BUNDLE_NAME}`);
    }
    const appPath = join(extractDir, MAC_APP_BUNDLE_NAME);
    verifyExtractedDirectorySymlinks(appPath);
    return await verifyMacAppBundle(appPath, {
      expectedTeamId,
      expectedVersion: options.expectedVersion,
      expectedArch: options.expectedArch,
      requireGatekeeper: true,
      execCmd,
      platform,
    });
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export async function verifyMacDmgPackage(
  dmgPath: string,
  expectedTeamId: string,
  options: {
    execCmd?: MacExecCmd | undefined;
    platform?: NodeJS.Platform | undefined;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new Error('macOS .dmg verification is only supported on macOS');
  }
  const expected = normalizeAppleTeamId(expectedTeamId);
  if (!expected) {
    throw new Error(`Invalid expected Apple Team ID for .dmg verification: ${expectedTeamId}`);
  }
  const execCmd = options.execCmd ?? defaultMacExecCmd;

  await execCmd('codesign', ['--verify', '--verbose=2', dmgPath]);
  const displayOut = await execCmd('codesign', ['--display', '--verbose=4', dmgPath]);
  const lines = `${displayOut.stdout}\n${displayOut.stderr}`
    .replace(/\r?\n/g, '\n')
    .split('\n')
    .map((l) => l.trim());
  const teamLine = lines.find((l) => l.startsWith('TeamIdentifier='));
  const foundTeam = teamLine ? normalizeAppleTeamId(teamLine.slice('TeamIdentifier='.length)) : null;
  if (!foundTeam || foundTeam !== expected) {
    throw new Error(`.dmg TeamIdentifier ${foundTeam ?? 'missing'} does not match expected ${expectedTeamId}`);
  }
  if (!lines.some((l) => l.startsWith('Authority=Developer ID Application:'))) {
    throw new Error(`.dmg signature is missing Developer ID Application authority: ${dmgPath}`);
  }
  if (!lines.some((l) => l.startsWith('Timestamp=') && l.slice('Timestamp='.length).trim().length > 0)) {
    throw new Error(`.dmg signature is missing secure Apple timestamp: ${dmgPath}`);
  }

  const spctlOut = await execCmd('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmgPath]);
  parseSpctlAssessOutput(`${spctlOut.stdout}\n${spctlOut.stderr}`, {
    expectedTeamId: expected,
    requireOrigin: false,
  });
}
