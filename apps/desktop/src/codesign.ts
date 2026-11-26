// SPDX-License-Identifier: AGPL-3.0-only
// macOS code-signature, Hardened Runtime, Gatekeeper (spctl), and safe ZIP update archive verification (#4885).
// Never invokes xcrun at runtime (clean Macs may lack Xcode CLT); uses only built-in macOS codesign, spctl, and ditto.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, openSync, closeSync, readdirSync, readlinkSync, readSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
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

function hasAsciiControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function parseCodesignVerifyOutput(output: string): void {
  const normalized = output.replace(/\r?\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('codesign --verify produced empty output');
  }
  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.some((l) => l.endsWith(': valid on disk'))) {
    throw new Error('codesign --verify did not confirm bundle is valid on disk');
  }
  if (!lines.some((l) => l.endsWith(': satisfies its Designated Requirement'))) {
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

interface ParsedCodesignDisplayFields {
  scalars: Map<string, string>;
  authorities: string[];
}

const CODESIGN_DISPLAY_SCALAR_PREFIXES: readonly { key: string; prefix: string }[] = [
  { key: 'Executable=', prefix: 'Executable=' },
  { key: 'Name=', prefix: 'Name=' },
  { key: 'Identifier=', prefix: 'Identifier=' },
  { key: 'Format=', prefix: 'Format=' },
  { key: 'CodeDirectory ', prefix: 'CodeDirectory ' },
  { key: 'VersionPlatform=', prefix: 'VersionPlatform=' },
  { key: 'VersionMin=', prefix: 'VersionMin=' },
  { key: 'VersionSDK=', prefix: 'VersionSDK=' },
  { key: 'Hash type=', prefix: 'Hash type=' },
  { key: 'Hash choices=', prefix: 'Hash choices=' },
  { key: 'CMSDigest=', prefix: 'CMSDigest=' },
  { key: 'CMSDigestType=', prefix: 'CMSDigestType=' },
  { key: 'Page size=', prefix: 'Page size=' },
  { key: 'CDHash=', prefix: 'CDHash=' },
  { key: 'Signature size=', prefix: 'Signature size=' },
  { key: 'Timestamp=', prefix: 'Timestamp=' },
  { key: 'Signed Time=', prefix: 'Signed Time=' },
  { key: 'Notarization Ticket=', prefix: 'Notarization Ticket=' },
  { key: 'Info.plist', prefix: 'Info.plist entries=' },
  { key: 'Info.plist', prefix: 'Info.plist=' },
  { key: 'TeamIdentifier=', prefix: 'TeamIdentifier=' },
  { key: 'Runtime Version=', prefix: 'Runtime Version=' },
  { key: 'Sealed Resources', prefix: 'Sealed Resources ' },
  { key: 'Sealed Resources', prefix: 'Sealed Resources=' },
  { key: 'Internal requirements count=', prefix: 'Internal requirements count=' },
  { key: 'Total signatures=', prefix: 'Total signatures=' },
  { key: 'Chosen signature=', prefix: 'Chosen signature=' },
  { key: 'Platform identifier=', prefix: 'Platform identifier=' },
  { key: 'Digest algorithms=', prefix: 'Digest algorithms=' },
];

const CODESIGN_DISPLAY_MULTI_PREFIXES: readonly string[] = [
  'CandidateCDHash ',
  'CandidateCDHashFull ',
  'Executable Segment ',
  'Launch Constraints ',
  'Launch Constraints(',
  'Launch Constraints (',
  'Launch Constraints=',
  'Entitlements=',
  'Entitlements ',
];

function parseCodesignDisplayFields(output: string): ParsedCodesignDisplayFields {
  const normalized = output.replace(/\r?\n/g, '\n');
  if (!normalized.trim()) {
    throw new Error('codesign --display produced empty output');
  }
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const scalars = new Map<string, string>();
  const authorities: string[] = [];

  for (const line of lines) {
    if (line.startsWith('Authority=')) {
      authorities.push(line.slice('Authority='.length).trim());
      continue;
    }
    const scalarRule = CODESIGN_DISPLAY_SCALAR_PREFIXES.find((rule) => line.startsWith(rule.prefix));
    if (scalarRule) {
      if (scalars.has(scalarRule.key)) {
        throw new Error(`Duplicate codesign --display field: ${scalarRule.key}`);
      }
      scalars.set(scalarRule.key, line.slice(scalarRule.prefix.length).trim());
      continue;
    }
    if (CODESIGN_DISPLAY_MULTI_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      continue;
    }
    throw new Error(`Unexpected codesign --display output line: ${line}`);
  }
  return { scalars, authorities };
}

function parseCodeDirectoryFlags(codeDirLine: string | undefined): string[] {
  if (!codeDirLine) {
    throw new Error('codesign --display missing CodeDirectory flags');
  }
  const flagsMatch = /\bflags=0x[0-9a-f]+\(([^)]+)\)/i.exec(codeDirLine);
  return (flagsMatch?.[1] ?? '').split(',').map((f) => f.trim().toLowerCase());
}

function assertDeveloperIdSignatureCommon(
  fields: ParsedCodesignDisplayFields,
  options: {
    label: string;
    requireHardenedRuntime: boolean;
    expectedTeamId?: string | null | undefined;
  },
): { teamId: string; timestamp: string; flags: string[] } {
  const codeDirLine = fields.scalars.get('CodeDirectory ');
  const flags = parseCodeDirectoryFlags(codeDirLine);
  if (flags.includes('adhoc')) {
    throw new Error('Refused ad-hoc macOS code signature');
  }
  if (options.requireHardenedRuntime && !flags.includes('runtime')) {
    throw new Error(`macOS ${options.label} signature must enable Hardened Runtime`);
  }
  const hashType = fields.scalars.get('Hash type=') ?? '';
  if (!/^sha256(?:\s|$)/i.test(hashType)) {
    throw new Error(`macOS ${options.label} signature must use SHA-256 CodeDirectory digest (got ${hashType || 'none'})`);
  }

  const authorities = fields.authorities;
  if (authorities.length === 0 || !authorities[0]!.startsWith('Developer ID Application:')) {
    throw new Error(
      `macOS ${options.label} signature is not signed with Developer ID Application (got ${authorities[0] ?? 'none'})`,
    );
  }
  const leafMatch = /^Developer ID Application: .+\(([A-Z0-9]{10})\)$/.exec(authorities[0]!);
  if (!leafMatch?.[1]) {
    throw new Error(`macOS ${options.label} Developer ID Application authority missing 10-character Apple Team ID`);
  }
  if (
    authorities.length !== 3 ||
    authorities[1] !== 'Developer ID Certification Authority' ||
    authorities[2] !== 'Apple Root CA'
  ) {
    throw new Error(
      `macOS ${options.label} signature does not chain exclusively to Developer ID Certification Authority and Apple Root CA`,
    );
  }

  const timestamp = fields.scalars.get('Timestamp=') ?? '';
  if (!timestamp) {
    throw new Error(`macOS ${options.label} signature is missing a secure Apple timestamp`);
  }
  const rawTeamId = fields.scalars.get('TeamIdentifier=') ?? '';
  const normalizedTeam = normalizeAppleTeamId(rawTeamId);
  if (!normalizedTeam) {
    throw new Error(`macOS ${options.label} signature has invalid TeamIdentifier: ${rawTeamId || 'not set'}`);
  }
  if (leafMatch[1] !== normalizedTeam) {
    throw new Error(
      `macOS ${options.label} authority Team ID ${leafMatch[1]} does not match TeamIdentifier ${normalizedTeam}`,
    );
  }
  if (options.expectedTeamId) {
    const expectedTeam = normalizeAppleTeamId(options.expectedTeamId);
    if (!expectedTeam || normalizedTeam !== expectedTeam) {
      throw new Error(
        `macOS ${options.label} TeamIdentifier ${normalizedTeam} does not match expected ${options.expectedTeamId}`,
      );
    }
  }
  return { teamId: normalizedTeam, timestamp, flags };
}

export function parseCodesignDisplayOutput(
  output: string,
  options: { expectedIdentifier?: string; expectedTeamId?: string | null; expectedArch?: MacBundleArch | undefined } = {},
): VerifiedMacAppSignature {
  const fields = parseCodesignDisplayFields(output);
  const expectedIdentifier = options.expectedIdentifier ?? APPLE_BUNDLE_ID;

  const identifier = fields.scalars.get('Identifier=') ?? '';
  if (identifier !== expectedIdentifier) {
    throw new Error(`codesign Identifier mismatch: expected ${expectedIdentifier}, got ${identifier || '(missing)'}`);
  }
  const formatLine = fields.scalars.get('Format=') ?? '';
  const arches = formatLine ? parseCodesignFormatArches(formatLine) : [];
  if (options.expectedArch && !arches.includes(options.expectedArch)) {
    throw new Error(
      `macOS app bundle architecture (${arches.join(', ') || 'unknown'}) does not match expected ${options.expectedArch}`,
    );
  }

  const common = assertDeveloperIdSignatureCommon(fields, {
    label: 'app',
    requireHardenedRuntime: true,
    expectedTeamId: options.expectedTeamId,
  });

  const sealedResources = fields.scalars.get('Sealed Resources');
  if (!sealedResources || sealedResources.toLowerCase() === 'none') {
    throw new Error('macOS app signature is missing Sealed Resources metadata');
  }

  return {
    identifier,
    teamId: common.teamId,
    authorities: fields.authorities,
    timestamp: common.timestamp,
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
  const sourceLines = lines.filter((l) => l.startsWith('source='));
  if (sourceLines.length > 1) {
    throw new Error('Gatekeeper spctl output contains duplicate source= fields');
  }
  const sourceLine = sourceLines[0];
  const source = sourceLine ? sourceLine.slice('source='.length).trim() : '';
  if (source !== 'Notarized Developer ID') {
    throw new Error(`Gatekeeper spctl check requires Notarized Developer ID (got ${source || 'none'})`);
  }
  const originLines = lines.filter((l) => l.startsWith('origin='));
  if (originLines.length > 1) {
    throw new Error('Gatekeeper spctl output contains duplicate origin= fields');
  }
  const originLine = originLines[0];
  const origin = originLine ? originLine.slice('origin='.length).trim() : null;
  if (origin !== null || options.requireOrigin !== false) {
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
  isSymlink: boolean;
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
    const diskEntryCount = tail.readUInt16LE(eocdOffset + 8);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const cdSize = tail.readUInt32LE(eocdOffset + 12);
    const cdOffset = tail.readUInt32LE(eocdOffset + 16);

    if (diskNumber !== 0 || cdDiskNumber !== 0) {
      throw new Error('Multi-disk ZIP archives are not supported');
    }
    if (diskEntryCount === 0xffff || entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error('Zip64 archives exceed supported bounds');
    }
    if (diskEntryCount !== entryCount) {
      throw new Error('Split ZIP central directory entry count is not supported');
    }
    if (entryCount <= 0 || entryCount > maxEntries) {
      throw new Error(`ZIP entry count ${entryCount} exceeds allowed limit (${maxEntries})`);
    }
    if (cdSize > 32 * 1024 * 1024 || cdOffset + cdSize !== tailOffset + eocdOffset) {
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
    const topBundle = requiredTopDir.replace(/\/+$/, '');
    for (let idx = 0; idx < entryCount; idx++) {
      if (cursor + 46 > cdBuf.length || cdBuf.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('Malformed ZIP central directory header');
      }
      const versionMadeBy = cdBuf.readUInt16LE(cursor + 4);
      const flags = cdBuf.readUInt16LE(cursor + 8);
      const method = cdBuf.readUInt16LE(cursor + 10);
      const crc32 = cdBuf.readUInt32LE(cursor + 16);
      const compressedSize = cdBuf.readUInt32LE(cursor + 20);
      const uncompressedSize = cdBuf.readUInt32LE(cursor + 24);
      const nameLen = cdBuf.readUInt16LE(cursor + 28);
      const extraLen = cdBuf.readUInt16LE(cursor + 30);
      const commentLen = cdBuf.readUInt16LE(cursor + 32);
      const diskNumberStart = cdBuf.readUInt16LE(cursor + 34);
      const externalFileAttributes = cdBuf.readUInt32LE(cursor + 38);
      const localHeaderOffset = cdBuf.readUInt32LE(cursor + 42);
      const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
      if (headerEnd > cdBuf.length) {
        throw new Error('Truncated ZIP central directory entry');
      }
      if (diskNumberStart !== 0) {
        throw new Error('Multi-disk ZIP entries are not supported');
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
      if (hasAsciiControlChar(rawName) || rawName.includes('\\') || rawName.startsWith('/')) {
        throw new Error(`Unsafe ZIP entry path: ${rawName}`);
      }
      const segments = rawName.split('/');
      const pathSegments = rawName.endsWith('/') ? segments.slice(0, -1) : segments;
      if (pathSegments.length === 0 || pathSegments.some((seg) => seg === '' || seg === '..' || seg === '.')) {
        throw new Error(`Path traversal segment in ZIP entry: ${rawName}`);
      }
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
      const creatorOs = versionMadeBy >>> 8;
      let isSymlink = false;
      if (creatorOs === 3 || creatorOs === 19) {
        const unixMode = (externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o6000) !== 0) {
          throw new Error(`Unsafe setuid/setgid UNIX mode in ZIP entry: ${rawName}`);
        }
        const fileType = unixMode & 0o170000;
        if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000 && fileType !== 0o120000) {
          throw new Error(`Unsupported special UNIX file type in ZIP entry (${fileType.toString(8)}): ${rawName}`);
        }
        if (fileType === 0o120000) {
          if (rawName.endsWith('/')) {
            throw new Error(`ZIP symlink entry must not end with slash: ${rawName}`);
          }
          const norm = rawName.replace(/\/+$/, '');
          if (norm === topBundle || !norm.startsWith(`${topBundle}/`)) {
            throw new Error(`ZIP symlink entry outside bundle contents is not allowed: ${rawName}`);
          }
          isSymlink = true;
        }
      }
      const lowerKey = rawName.replace(/\/+$/, '').toLowerCase();
      if (seenLowerNames.has(lowerKey)) {
        throw new Error(`Duplicate ZIP entry path: ${rawName}`);
      }
      seenLowerNames.add(lowerKey);
      entries.push({
        name: rawName,
        flags,
        method,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isSymlink,
      });
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

const MAX_ZIP_SYMLINK_TARGET_BYTES = 4096;

function assertSafePreExtractionSymlinkTarget(entryName: string, topBundle: string, payloadBuf: Buffer): string {
  if (payloadBuf.byteLength === 0 || payloadBuf.byteLength > MAX_ZIP_SYMLINK_TARGET_BYTES) {
    throw new Error(`Pre-extraction ZIP symlink target size out of bounds for ${entryName}`);
  }
  const target = payloadBuf.toString('utf8');
  if (hasAsciiControlChar(target) || target.startsWith('/') || target.startsWith('\\') || target.includes('\\')) {
    throw new Error(`Unsafe pre-extraction ZIP symlink target for ${entryName}`);
  }
  const normEntry = entryName.replace(/\/+$/, '');
  const resolvedTarget = posix.resolve('/', posix.dirname(normEntry), target).slice(1);
  if (!resolvedTarget.startsWith(`${topBundle}/`) || resolvedTarget === topBundle) {
    throw new Error(`Escaping pre-extraction ZIP symlink target for ${entryName}: ${target}`);
  }
  return normEntry;
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
  const topBundle = (options.requiredTopDir ?? `${MAC_APP_BUNDLE_NAME}/`).replace(/\/+$/, '');
  const parsed = parseZipCentralDirectoryEntries(zipPath, options);
  const sortedEntries = [...parsed.entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  const fd = openSync(zipPath, 'r');
  try {
    const lh = Buffer.alloc(30);
    let actualTotalBytes = 0;
    let expectedOffset = 0;
    const symlinkPaths: string[] = [];
    for (const entry of sortedEntries) {
      if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(`Unsupported ZIP compression method (${entry.method}) for ${entry.name}`);
      }
      if (entry.isSymlink && (entry.uncompressedSize <= 0 || entry.uncompressedSize > MAX_ZIP_SYMLINK_TARGET_BYTES)) {
        throw new Error(`Pre-extraction ZIP symlink target size out of bounds for ${entry.name}`);
      }
      if (entry.localHeaderOffset !== expectedOffset) {
        throw new Error(
          `ZIP local file headers are not contiguous before ${entry.name} (expected offset ${expectedOffset}, got ${entry.localHeaderOffset})`,
        );
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
      let ddLen = 0;
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
        ddLen = hasSig ? 16 : 12;
        if (ddOffset + ddLen > parsed.cdOffset) {
          throw new Error(`ZIP data descriptor out of bounds for ${entry.name}`);
        }
        if (
          dd.readUInt32LE(ddBase) !== entry.crc32 ||
          dd.readUInt32LE(ddBase + 4) !== entry.compressedSize ||
          dd.readUInt32LE(ddBase + 8) !== entry.uncompressedSize
        ) {
          throw new Error(`ZIP data descriptor metadata mismatch for ${entry.name}`);
        }
      }
      expectedOffset = dataStart + entry.compressedSize + ddLen;

      if (entry.method === 0) {
        if (entry.compressedSize !== entry.uncompressedSize) {
          throw new Error(`Stored ZIP entry size mismatch for ${entry.name}`);
        }
        let storedCrc = 0;
        const symlinkChunks: Buffer[] = [];
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
            const slice = ioBuf.subarray(0, bytesRead);
            storedCrc = zlibCrc32(slice, storedCrc);
            if (entry.isSymlink) {
              symlinkChunks.push(Buffer.from(slice));
            }
            pos += bytesRead;
            remaining -= bytesRead;
          }
        }
        if ((storedCrc >>> 0) !== entry.crc32) {
          throw new Error(`ZIP entry ${entry.name} CRC-32 mismatch`);
        }
        if (entry.isSymlink) {
          symlinkPaths.push(assertSafePreExtractionSymlinkTarget(entry.name, topBundle, Buffer.concat(symlinkChunks)));
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
      const symlinkChunks: Buffer[] = [];
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
          if (entry.isSymlink) {
            if (entryBytes > MAX_ZIP_SYMLINK_TARGET_BYTES) {
              fail(new Error(`Pre-extraction ZIP symlink target size out of bounds for ${entry.name}`));
              return;
            }
            symlinkChunks.push(chunk);
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
      if (entry.isSymlink) {
        symlinkPaths.push(assertSafePreExtractionSymlinkTarget(entry.name, topBundle, Buffer.concat(symlinkChunks)));
      }
    }
    if (expectedOffset !== parsed.cdOffset) {
      throw new Error(
        `ZIP contains unreferenced bytes before central directory (ended at ${expectedOffset}, central directory at ${parsed.cdOffset})`,
      );
    }
    if (symlinkPaths.length > 0) {
      for (const entry of parsed.entries) {
        const norm = entry.name.replace(/\/+$/, '');
        for (const symPath of symlinkPaths) {
          if (norm.startsWith(`${symPath}/`)) {
            throw new Error(`ZIP entry traverses through symlink ${symPath}: ${entry.name}`);
          }
        }
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

  const verifyOut = await execCmd('codesign', ['--verify', '--verbose=2', dmgPath]);
  parseCodesignVerifyOutput(`${verifyOut.stdout}\n${verifyOut.stderr}`);
  const displayOut = await execCmd('codesign', ['--display', '--verbose=4', dmgPath]);
  const fields = parseCodesignDisplayFields(`${displayOut.stdout}\n${displayOut.stderr}`);
  assertDeveloperIdSignatureCommon(fields, {
    label: '.dmg',
    requireHardenedRuntime: false,
    expectedTeamId: expected,
  });

  const spctlOut = await execCmd('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmgPath]);
  parseSpctlAssessOutput(`${spctlOut.stdout}\n${spctlOut.stderr}`, {
    expectedTeamId: expected,
    requireOrigin: false,
  });
}
