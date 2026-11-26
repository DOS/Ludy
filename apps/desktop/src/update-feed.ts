// SPDX-License-Identifier: AGPL-3.0-only
// Update feed URL validation, SSRF/HTTPS/origin pinning, DNS-pinned streaming fetch, Squirrel RELEASES parsing,
// release-manifest verification, and single-download local staging before Squirrel runs.
import { createHash, randomUUID, verify as cryptoVerify } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RELEASE_MANIFEST_SCRIPT_FILENAME } from './authenticode.ts';
import type { FetchLike } from './exchange.ts';

export const RELEASE_MANIFEST_FILENAME = 'release-manifest.json';
export const RELEASE_MANIFEST_SIG_FILENAME = 'release-manifest.json.sig';
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const DOWNLOAD_MAX_TOTAL_MS = 30 * 60_000;

const SHA1_HEX = /^[0-9a-f]{40}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const SEMVER_CORE = /^\d+\.\d+\.\d+$/;
const PACKAGE_FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(full|delta)\.nupkg$/;
const RELEASE_LINE_PATTERN = /^([0-9a-fA-F]{40})\s+(\S+)\s+(\d+)$/;

export type FeedUrlCheck = { ok: true; url: string } | { ok: false; reason: string };
export type HostLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

export interface ReleaseEntry {
  sha1: string;
  file: string;
  downloadUrl: string;
  size: number;
  version: string;
  kind: 'full' | 'delta';
}

export interface ParsedReleasesManifest {
  feedUrl: string;
  entries: ReleaseEntry[];
  latestFull: ReleaseEntry;
}

export interface DesktopReleasePackage {
  file: string;
  kind: 'full' | 'delta';
  version: string;
  sha1: string;
  sha256: string;
  size: number;
}

export interface DesktopReleaseManifest {
  schemaVersion: 1;
  product: 'ludy-desktop';
  platform: 'win32';
  arch: 'x64';
  version: string;
  signed: boolean;
  signing: {
    algorithm: 'sha256';
    timestampServer: string | null;
    publisherThumbprint: string | null;
  };
  installer: {
    file: string;
    sha256: string;
    size: number;
  };
  packages: DesktopReleasePackage[];
}

export interface ValidatedUpdateFeed {
  feedUrl: string;
  releases: ParsedReleasesManifest;
  manifest: DesktopReleaseManifest | null;
  rawManifestBytes?: Buffer | null | undefined;
}

export type PreparedUpdateResult =
  | { status: 'up-to-date'; version: string }
  | { status: 'staged'; version: string; stagingDir: string; packageFile: string; sha1: string; sha256: string; size: number };

export class UpdateFeedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UpdateFeedError';
    this.code = code;
  }
}

// Literal loopback names only: avoids resolver-dependent *.localhost ambiguity on update feeds.
export function isLiteralLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function isDisallowedIpv4Octets(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv4Quad(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function expandIpv6(ip: string): number[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const tokens = side.split(':');
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const v4 = parseIpv4Quad(token);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        out.push(Number.parseInt(token, 16));
      }
    }
    return out;
  };
  const left = parseSide(halves[0] ?? '');
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = parseSide(halves[1] ?? '');
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  let bare = rawIp.trim().toLowerCase();
  if (bare.startsWith('[') && bare.endsWith(']')) bare = bare.slice(1, -1);
  const zoneIdx = bare.indexOf('%');
  if (zoneIdx !== -1) bare = bare.slice(0, zoneIdx);

  const kind = isIP(bare);
  if (kind === 4) {
    const quad = parseIpv4Quad(bare);
    return quad === null || isDisallowedIpv4Octets(quad[0], quad[1], quad[2], quad[3]);
  }
  if (kind === 6) {
    const g = expandIpv6(bare);
    if (!g) return true;
    const allZeroExceptLast = g.slice(0, 7).every((x) => x === 0);
    if (allZeroExceptLast && (g[7] === 0 || g[7] === 1)) return true; // :: or ::1
    const isV4MappedOrTranslated =
      g[0] === 0 &&
      g[1] === 0 &&
      g[2] === 0 &&
      g[3] === 0 &&
      ((g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) || (g[4] === 0xffff && g[5] === 0));
    if (isV4MappedOrTranslated) {
      const a = (g[6]! >> 8) & 0xff;
      const b = g[6]! & 0xff;
      const c = (g[7]! >> 8) & 0xff;
      const d = g[7]! & 0xff;
      return isDisallowedIpv4Octets(a, b, c, d);
    }
    if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
    if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (g[0] === 0x2002) return true; // 2002::/16 6to4
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 0100::/64 discard
    if (g[0] === 0x0064 && g[1] === 0xff9b && (g[2] === 0 || g[2] === 1)) return true; // NAT64
    return false;
  }
  return true;
}

export function unwrapIpLiteral(hostname: string): string | null {
  let bare = hostname.trim().toLowerCase();
  if (bare.startsWith('[') && bare.endsWith(']')) bare = bare.slice(1, -1);
  return isIP(bare) !== 0 ? bare : null;
}

export function isDisallowedRemoteHost(hostname: string): boolean {
  const bare = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (bare === '' || bare === 'localhost') return true;
  if (isIP(bare) !== 0) return isPrivateOrReservedIp(bare);
  if (!bare.includes('.')) return true;
  if (bare.endsWith('.local') || bare.endsWith('.internal') || bare.endsWith('.arpa') || bare.endsWith('.localhost')) {
    return true;
  }
  return false;
}

function hasUnsafeRawPathSegments(rawPath: string): boolean {
  if (rawPath.includes('\\')) return true;
  for (const segment of rawPath.split('/')) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (segment === '.' || segment === '..' || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      return true;
    }
  }
  return false;
}

export interface FeedUrlOptions {
  ludyUrl?: string | null | undefined;
  allowedOrigin?: string | null | undefined;
}

export function parseFeedOrigin(value: string): FeedUrlCheck {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: 'không phải một địa chỉ hợp lệ' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'không được chứa tên người dùng hoặc mật khẩu' };
  if (url.search !== '' || url.hash !== '') return { ok: false, reason: 'không được chứa tham số hoặc đoạn #' };
  if (url.pathname !== '/') return { ok: false, reason: 'chỉ gồm địa chỉ gốc, không có đường dẫn' };
  if (url.protocol === 'http:') {
    if (!isLiteralLoopbackHost(url.hostname)) {
      return { ok: false, reason: 'phải dùng https (http chỉ cho localhost, 127.0.0.1 hoặc [::1])' };
    }
    return { ok: true, url: url.origin };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'phải dùng https (http chỉ cho localhost, 127.0.0.1 hoặc [::1])' };
  }
  if (isDisallowedRemoteHost(url.hostname)) {
    return { ok: false, reason: 'không được trỏ tới địa chỉ mạng nội bộ hoặc tên miền cục bộ' };
  }
  return { ok: true, url: url.origin };
}

export function resolveFeedUrl(value: string, options: FeedUrlOptions = {}): FeedUrlCheck {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('//')) {
    return { ok: false, reason: 'không phải một địa chỉ hợp lệ' };
  }

  let rawTarget = trimmed;
  if (trimmed.startsWith('/')) {
    if (!options.ludyUrl) {
      return { ok: false, reason: 'đường dẫn cập nhật tương đối cần có địa chỉ Ludy hợp lệ' };
    }
    if (trimmed.includes('?') || trimmed.includes('#') || hasUnsafeRawPathSegments(trimmed)) {
      return { ok: false, reason: 'đường dẫn cập nhật không hợp lệ' };
    }
    rawTarget = `${options.ludyUrl}${trimmed}`;
  } else {
    const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/.exec(trimmed);
    const rawPath = schemeMatch?.[1] ?? '';
    if (trimmed.includes('\\') || (rawPath !== '' && hasUnsafeRawPathSegments(rawPath))) {
      return { ok: false, reason: 'đường dẫn cập nhật không hợp lệ' };
    }
  }

  let url: URL;
  try {
    url = new URL(rawTarget);
  } catch {
    return { ok: false, reason: 'không phải một địa chỉ hợp lệ' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'không được chứa tên người dùng hoặc mật khẩu' };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'không được chứa tham số hoặc đoạn #' };
  }
  if (hasUnsafeRawPathSegments(url.pathname)) {
    return { ok: false, reason: 'đường dẫn cập nhật không hợp lệ' };
  }

  if (url.protocol === 'http:') {
    if (!isLiteralLoopbackHost(url.hostname)) {
      return { ok: false, reason: 'phải dùng https (http chỉ cho localhost, 127.0.0.1 hoặc [::1])' };
    }
  } else if (url.protocol === 'https:') {
    if (isDisallowedRemoteHost(url.hostname)) {
      return { ok: false, reason: 'không được trỏ tới địa chỉ mạng nội bộ hoặc tên miền cục bộ' };
    }
  } else {
    return { ok: false, reason: 'phải dùng https (http chỉ cho localhost, 127.0.0.1 hoặc [::1])' };
  }

  if (options.allowedOrigin && url.origin !== options.allowedOrigin) {
    return { ok: false, reason: 'không khớp địa chỉ gốc cập nhật được ghim' };
  }

  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

function parseSemverTuple(version: string): { major: number; minor: number; patch: number; pre: string | null } {
  const [core, ...preParts] = version.split('-');
  const [maj, min, pat] = (core ?? '').split('.').map((n) => Number(n));
  return {
    major: maj ?? 0,
    minor: min ?? 0,
    patch: pat ?? 0,
    pre: preParts.length > 0 ? preParts.join('-') : null,
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemverTuple(a);
  const pb = parseSemverTuple(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function resolveReleaseEntryTarget(rawTarget: string, normalizedFeedUrl: string): string {
  for (let i = 0; i < rawTarget.length; i++) {
    if (rawTarget.charCodeAt(i) < 0x20 || rawTarget.charCodeAt(i) === 0x7f) {
      throw new UpdateFeedError('INVALID_TARGET', 'RELEASES contains control characters in package target');
    }
  }
  if (rawTarget.includes('\\') || rawTarget.includes('?') || rawTarget.includes('#') || rawTarget.includes('..')) {
    throw new UpdateFeedError('INVALID_TARGET', `Refused unsafe RELEASES target: ${rawTarget}`);
  }

  const feedParsed = new URL(normalizedFeedUrl);
  const basePath = feedParsed.pathname.replace(/\/+$/, '');
  let file = rawTarget;

  if (rawTarget.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawTarget)) {
    let targetUrl: URL;
    try {
      targetUrl = new URL(rawTarget);
    } catch {
      throw new UpdateFeedError('INVALID_TARGET', `Invalid download URL in RELEASES: ${rawTarget}`);
    }
    if (targetUrl.username !== '' || targetUrl.password !== '' || targetUrl.search !== '' || targetUrl.hash !== '') {
      throw new UpdateFeedError('INVALID_TARGET', 'Download URL in RELEASES must not contain credentials, query, or hash');
    }
    if (targetUrl.protocol !== feedParsed.protocol) {
      throw new UpdateFeedError('INSECURE_DOWNLOAD_URL', `Refused download URL protocol ${targetUrl.protocol} (expected ${feedParsed.protocol})`);
    }
    if (targetUrl.origin !== feedParsed.origin) {
      throw new UpdateFeedError('ORIGIN_MISMATCH', `Refused cross-origin download URL ${targetUrl.origin} (expected ${feedParsed.origin})`);
    }
    const expectedPrefix = `${basePath}/`;
    if (!targetUrl.pathname.startsWith(expectedPrefix)) {
      throw new UpdateFeedError('PATH_MISMATCH', 'Download URL path must stay under the configured update feed');
    }
    file = targetUrl.pathname.slice(expectedPrefix.length);
  }

  if (file.includes('/') || file.includes('%') || !PACKAGE_FILE_PATTERN.test(file)) {
    throw new UpdateFeedError('INVALID_PACKAGE_NAME', `Invalid Squirrel package name in RELEASES: ${rawTarget}`);
  }
  return file;
}

export function parseReleasesManifest(text: string, feedUrl: string): ParsedReleasesManifest {
  const checkedFeed = resolveFeedUrl(feedUrl);
  if (!checkedFeed.ok) {
    throw new UpdateFeedError('INVALID_FEED_URL', checkedFeed.reason);
  }
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new UpdateFeedError('INVALID_RELEASES', 'RELEASES manifest is empty or too large');
  }
  if (/^\s*(?:<!doctype|<html\b)/i.test(text)) {
    throw new UpdateFeedError('INVALID_RELEASES', 'RELEASES endpoint returned HTML instead of a Squirrel manifest');
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new UpdateFeedError('INVALID_RELEASES', 'RELEASES manifest has no entries');
  }

  const entries: ReleaseEntry[] = [];
  for (const line of lines) {
    const match = RELEASE_LINE_PATTERN.exec(line);
    if (!match) {
      throw new UpdateFeedError('INVALID_RELEASES', 'Malformed line in RELEASES manifest');
    }
    const sha1 = match[1]!.toLowerCase();
    const rawTarget = match[2]!;
    const rawSize = match[3]!;
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PACKAGE_BYTES || String(size) !== rawSize) {
      throw new UpdateFeedError('INVALID_RELEASES', 'Invalid or oversized package size in RELEASES manifest');
    }
    const file = resolveReleaseEntryTarget(rawTarget, checkedFeed.url);
    const pkgMatch = PACKAGE_FILE_PATTERN.exec(file);
    if (!pkgMatch) {
      throw new UpdateFeedError('INVALID_PACKAGE_NAME', `Invalid package filename: ${file}`);
    }
    const version = pkgMatch[2]!;
    const kind = pkgMatch[3] === 'delta' ? 'delta' : 'full';
    entries.push({
      sha1,
      file,
      downloadUrl: `${checkedFeed.url}/${file}`,
      size,
      version,
      kind,
    });
  }

  const fullEntries = entries.filter((entry) => entry.kind === 'full');
  if (fullEntries.length === 0) {
    throw new UpdateFeedError('INVALID_RELEASES', 'RELEASES manifest has no full package');
  }
  let latestFull = fullEntries[0]!;
  for (let i = 1; i < fullEntries.length; i++) {
    const candidate = fullEntries[i]!;
    if (compareSemver(candidate.version, latestFull.version) > 0) {
      latestFull = candidate;
    }
  }
  return { feedUrl: checkedFeed.url, entries, latestFull };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseOptionalTimestampUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new UpdateFeedError('INVALID_MANIFEST', 'Invalid timestampServer in release manifest');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Invalid timestampServer URL in release manifest');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Unsafe timestampServer URL in release manifest');
  }
  return url.toString();
}

export function parseDesktopReleaseManifest(rawText: string): DesktopReleaseManifest {
  if (rawText.length === 0 || Buffer.byteLength(rawText, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest is empty or too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest is not valid JSON');
  }
  if (!isPlainRecord(parsed)) {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest must be a JSON object');
  }
  if (parsed.schemaVersion !== 1 || parsed.product !== 'ludy-desktop' || parsed.platform !== 'win32' || parsed.arch !== 'x64') {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest target or schemaVersion is unsupported');
  }
  if (typeof parsed.version !== 'string' || !SEMVER_CORE.test(parsed.version)) {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest version must be X.Y.Z');
  }
  if (typeof parsed.signed !== 'boolean') {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest missing boolean signed flag');
  }
  if (!isPlainRecord(parsed.signing) || parsed.signing.algorithm !== 'sha256') {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest signing metadata must use sha256');
  }
  const timestampServer = parseOptionalTimestampUrl(parsed.signing.timestampServer);
  const rawThumbprint = parsed.signing.publisherThumbprint;
  let publisherThumbprint: string | null = null;
  if (rawThumbprint !== null && rawThumbprint !== undefined) {
    if (typeof rawThumbprint !== 'string' || !SHA1_HEX.test(rawThumbprint)) {
      throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest publisherThumbprint must be 40 hex chars');
    }
    publisherThumbprint = rawThumbprint.toLowerCase();
  }

  if (!isPlainRecord(parsed.installer)) {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest missing installer metadata');
  }
  if (
    parsed.installer.file !== 'LudyDesktop-Setup.exe' ||
    typeof parsed.installer.sha256 !== 'string' ||
    !SHA256_HEX.test(parsed.installer.sha256) ||
    typeof parsed.installer.size !== 'number' ||
    !Number.isSafeInteger(parsed.installer.size) ||
    parsed.installer.size <= 0
  ) {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest installer metadata is invalid');
  }

  if (!Array.isArray(parsed.packages) || parsed.packages.length === 0) {
    throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest packages list must be non-empty');
  }
  const packages: DesktopReleasePackage[] = [];
  for (const item of parsed.packages) {
    if (!isPlainRecord(item)) throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest package entry is not an object');
    if (
      typeof item.file !== 'string' ||
      item.file.includes('/') ||
      item.file.includes('\\') ||
      !PACKAGE_FILE_PATTERN.test(item.file) ||
      (item.kind !== 'full' && item.kind !== 'delta') ||
      typeof item.version !== 'string' ||
      !SEMVER_CORE.test(item.version) ||
      typeof item.sha1 !== 'string' ||
      !SHA1_HEX.test(item.sha1) ||
      typeof item.sha256 !== 'string' ||
      !SHA256_HEX.test(item.sha256) ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0
    ) {
      throw new UpdateFeedError('INVALID_MANIFEST', 'Release manifest package entry is invalid');
    }
    packages.push({
      file: item.file,
      kind: item.kind,
      version: item.version,
      sha1: item.sha1.toLowerCase(),
      sha256: item.sha256.toLowerCase(),
      size: item.size,
    });
  }

  return {
    schemaVersion: 1,
    product: 'ludy-desktop',
    platform: 'win32',
    arch: 'x64',
    version: parsed.version,
    signed: parsed.signed,
    signing: {
      algorithm: 'sha256',
      timestampServer,
      publisherThumbprint,
    },
    installer: {
      file: parsed.installer.file,
      sha256: parsed.installer.sha256.toLowerCase(),
      size: parsed.installer.size,
    },
    packages,
  };
}

export function verifyReleaseManifestAgainstReleases(
  releases: ParsedReleasesManifest,
  manifest: DesktopReleaseManifest,
  options: { requireSigned: boolean; expectedPublisherThumbprint?: string | null },
): void {
  if (releases.latestFull.version !== manifest.version) {
    throw new UpdateFeedError('MANIFEST_MISMATCH', `RELEASES version (${releases.latestFull.version}) does not match release manifest (${manifest.version})`);
  }
  const byFile = new Map(manifest.packages.map((pkg) => [pkg.file, pkg]));
  for (const entry of releases.entries) {
    const matched = byFile.get(entry.file);
    if (!matched) {
      throw new UpdateFeedError('MANIFEST_MISMATCH', `Package ${entry.file} in RELEASES is missing from release manifest`);
    }
    if (matched.sha1 !== entry.sha1 || matched.size !== entry.size || matched.version !== entry.version || matched.kind !== entry.kind) {
      throw new UpdateFeedError('MANIFEST_MISMATCH', `Metadata mismatch for ${entry.file} between RELEASES and release manifest`);
    }
  }
  if (options.requireSigned) {
    if (!manifest.signed) {
      throw new UpdateFeedError('UNSIGNED_FEED', 'Refused unsigned release manifest on a production update feed');
    }
    if (manifest.signing.algorithm !== 'sha256') {
      throw new UpdateFeedError('UNSIGNED_FEED', 'Update feed signing metadata must specify sha256');
    }
  }
  if (options.expectedPublisherThumbprint) {
    const expected = options.expectedPublisherThumbprint.trim().toLowerCase();
    if (!manifest.signed || manifest.signing.publisherThumbprint !== expected) {
      throw new UpdateFeedError('PUBLISHER_MISMATCH', 'Update feed publisher certificate thumbprint does not match expected thumbprint');
    }
  }
}

export async function readBoundedResponseBytes(response: Response, maxBytes: number, rejectHtml: boolean): Promise<Buffer> {
  const contentType = response.headers.get('content-type') ?? '';
  if (rejectHtml && /\btext\/html\b/i.test(contentType)) {
    throw new UpdateFeedError('INVALID_RESPONSE', 'Update feed returned HTML instead of release metadata');
  }
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const len = Number(contentLengthHeader);
    if (Number.isFinite(len) && len > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpdateFeedError('RESPONSE_TOO_LARGE', 'Update feed response exceeded size limit');
    }
  }
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new UpdateFeedError('RESPONSE_TOO_LARGE', 'Update feed response exceeded size limit');
    }
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpdateFeedError('RESPONSE_TOO_LARGE', 'Update feed response exceeded size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function sendPinnedHttpRequest(
  url: URL,
  init: RequestInit | undefined,
  headers: Record<string, string>,
  pinnedAddress: { address: string; family: 4 | 6 } | null,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(
      url,
      {
        method: init?.method ?? 'GET',
        headers,
        ...(pinnedAddress
          ? {
              autoSelectFamily: false,
              lookup: (_hostname, opts, callback) => {
                const wantAll = typeof opts === 'object' && opts !== null && opts.all === true;
                if (wantAll) {
                  (callback as (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void)(
                    null,
                    [{ address: pinnedAddress.address, family: pinnedAddress.family }],
                  );
                } else {
                  (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
                    null,
                    pinnedAddress.address,
                    pinnedAddress.family,
                  );
                }
              },
            }
          : {}),
      },
      (res) => {
        const status = res.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          res.resume();
          finish(() => reject(new UpdateFeedError('REDIRECT_REFUSED', `Refused HTTP redirect (${status}) from update feed`)));
          return;
        }
        const resHeaders = new Headers();
        for (const [key, val] of Object.entries(res.headers)) {
          if (Array.isArray(val)) {
            for (const item of val) resHeaders.append(key, item);
          } else if (val !== undefined) {
            resHeaders.set(key, val);
          }
        }
        if (status === 204 || status === 205 || status === 304) {
          res.resume();
          finish(() => resolve(new Response(null, { status, headers: resHeaders })));
          return;
        }
        try {
          const webStream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
          finish(() => resolve(new Response(webStream, { status, headers: resHeaders })));
        } catch (err) {
          res.resume();
          finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      },
    );
    req.on('error', (err) => finish(() => reject(err)));
    if (init?.signal) {
      if (init.signal.aborted) {
        const abortErr = init.signal.reason instanceof Error ? init.signal.reason : new Error('Aborted');
        req.destroy(abortErr);
        finish(() => reject(abortErr));
        return;
      }
      const onAbort = (): void => {
        const abortErr = init.signal?.reason instanceof Error ? init.signal.reason : new Error('Aborted');
        req.destroy(abortErr);
        finish(() => reject(abortErr));
      };
      init.signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    }
    req.end();
  });
}

export function createPinnedFetch(
  lookupHost: HostLookup = (hostname) => dnsLookup(hostname, { all: true }),
  sendRequest: (
    url: URL,
    init: RequestInit | undefined,
    headers: Record<string, string>,
    pinnedAddress: { address: string; family: 4 | 6 } | null,
  ) => Promise<Response> = sendPinnedHttpRequest,
): FetchLike {
  return async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const checked = resolveFeedUrl(rawUrl);
    if (!checked.ok) {
      throw new UpdateFeedError('INVALID_FEED_URL', checked.reason);
    }
    const url = new URL(rawUrl);
    const isLoopback = isLiteralLoopbackHost(url.hostname);
    const literalIp = unwrapIpLiteral(url.hostname);
    let candidates: Array<{ address: string; family: 4 | 6 }> | null = null;
    if (!isLoopback) {
      if (literalIp !== null) {
        if (isPrivateOrReservedIp(literalIp)) {
          throw new UpdateFeedError('SSRF_BLOCKED', 'Refused update feed host resolving to a private or reserved IP address');
        }
      } else {
        const resolved = await lookupHost(url.hostname);
        if (resolved.length === 0 || resolved.some((entry) => isPrivateOrReservedIp(entry.address))) {
          throw new UpdateFeedError('SSRF_BLOCKED', 'Refused update feed host resolving to a private or reserved IP address');
        }
        candidates = resolved.map((entry) => {
          const family = isIP(entry.address);
          if (family !== 4 && family !== 6) {
            throw new UpdateFeedError('SSRF_BLOCKED', 'Invalid resolved IP family for update feed host');
          }
          return { address: entry.address, family };
        });
      }
    }

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    const attempts: Array<{ address: string; family: 4 | 6 } | null> = candidates ?? [null];
    let lastError: unknown;
    for (let i = 0; i < attempts.length; i++) {
      if (init?.signal?.aborted) {
        throw init.signal.reason instanceof Error ? init.signal.reason : new Error('Aborted');
      }
      try {
        return await sendRequest(url, init, headers, attempts[i]!);
      } catch (err) {
        lastError = err;
        if (err instanceof UpdateFeedError || init?.signal?.aborted) {
          throw err;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

export function verifyEd25519ManifestSignature(rawManifestBytes: Buffer, signatureBase64: string, publicKeyPem: string): boolean {
  const cleanSig = signatureBase64.trim();
  if (!cleanSig) return false;
  const sigBytes = Buffer.from(cleanSig, 'base64');
  if (sigBytes.length !== 64) return false;
  try {
    return cryptoVerify(null, rawManifestBytes, publicKeyPem, sigBytes);
  } catch {
    return false;
  }
}

export interface ValidateUpdateFeedOptions {
  feedUrl: string;
  fetch: FetchLike;
  allowedOrigin?: string | null | undefined;
  requireSigned?: boolean | undefined;
  allowUnsigned?: boolean | undefined;
  expectedPublisherThumbprint?: string | null | undefined;
  expectedManifestPublicKey?: string | null | undefined;
  lookupHost?: HostLookup | undefined;
}

function shouldRequireSignedFeed(
  feedHostname: string,
  options: Pick<ValidateUpdateFeedOptions, 'requireSigned' | 'allowUnsigned' | 'expectedPublisherThumbprint' | 'expectedManifestPublicKey'>,
): boolean {
  if (options.requireSigned !== undefined) return options.requireSigned;
  if (options.expectedPublisherThumbprint || options.expectedManifestPublicKey) return true;
  if (options.allowUnsigned === true && isLiteralLoopbackHost(feedHostname)) return false;
  return true;
}

export async function validateUpdateFeed(options: ValidateUpdateFeedOptions): Promise<ValidatedUpdateFeed> {
  const checkedFeed = resolveFeedUrl(options.feedUrl, options.allowedOrigin ? { allowedOrigin: options.allowedOrigin } : {});
  if (!checkedFeed.ok) {
    throw new UpdateFeedError('INVALID_FEED_URL', checkedFeed.reason);
  }
  const feedParsed = new URL(checkedFeed.url);
  const isLoopback = isLiteralLoopbackHost(feedParsed.hostname);
  const literalIp = unwrapIpLiteral(feedParsed.hostname);
  const requireSigned = shouldRequireSignedFeed(feedParsed.hostname, options);

  if (!isLoopback) {
    if (literalIp !== null) {
      if (isPrivateOrReservedIp(literalIp)) {
        throw new UpdateFeedError('SSRF_BLOCKED', 'Refused update feed host resolving to a private or reserved IP address');
      }
    } else if (options.lookupHost) {
      const addresses = await options.lookupHost(feedParsed.hostname);
      if (addresses.length === 0 || addresses.some((a) => isPrivateOrReservedIp(a.address))) {
        throw new UpdateFeedError('SSRF_BLOCKED', 'Refused update feed host resolving to a private or reserved IP address');
      }
    }
  }

  let releasesRes: Response;
  try {
    releasesRes = await options.fetch(`${checkedFeed.url}/RELEASES`, {
      method: 'GET',
      headers: { accept: 'text/plain, */*' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof UpdateFeedError) throw error;
    throw new UpdateFeedError('FETCH_FAILED', `Failed fetching RELEASES: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!releasesRes.ok) {
    throw new UpdateFeedError('RELEASES_HTTP_ERROR', `Update feed RELEASES returned HTTP ${releasesRes.status}`);
  }
  const releasesBuf = await readBoundedResponseBytes(releasesRes, MAX_MANIFEST_BYTES, true);
  const releases = parseReleasesManifest(releasesBuf.toString('utf8'), checkedFeed.url);

  let manifestRes: Response;
  try {
    manifestRes = await options.fetch(`${checkedFeed.url}/${RELEASE_MANIFEST_FILENAME}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof UpdateFeedError) throw error;
    throw new UpdateFeedError('FETCH_FAILED', `Failed fetching ${RELEASE_MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (manifestRes.status === 404) {
    if (requireSigned || options.expectedPublisherThumbprint || options.expectedManifestPublicKey) {
      throw new UpdateFeedError('MISSING_MANIFEST', `Update feed is missing ${RELEASE_MANIFEST_FILENAME}`);
    }
    return { feedUrl: checkedFeed.url, releases, manifest: null, rawManifestBytes: null };
  }
  if (!manifestRes.ok) {
    throw new UpdateFeedError('MANIFEST_HTTP_ERROR', `Update feed ${RELEASE_MANIFEST_FILENAME} returned HTTP ${manifestRes.status}`);
  }

  const manifestBuf = await readBoundedResponseBytes(manifestRes, MAX_MANIFEST_BYTES, true);
  if (options.expectedManifestPublicKey) {
    let sigRes: Response;
    try {
      sigRes = await options.fetch(`${checkedFeed.url}/${RELEASE_MANIFEST_SIG_FILENAME}`, {
        method: 'GET',
        headers: { accept: 'text/plain' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof UpdateFeedError) throw error;
      throw new UpdateFeedError('FETCH_FAILED', `Failed fetching ${RELEASE_MANIFEST_SIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!sigRes.ok) {
      throw new UpdateFeedError('MISSING_MANIFEST_SIGNATURE', `Update feed ${RELEASE_MANIFEST_SIG_FILENAME} returned HTTP ${sigRes.status}`);
    }
    const sigText = (await readBoundedResponseBytes(sigRes, 4096, true)).toString('utf8');
    if (!verifyEd25519ManifestSignature(manifestBuf, sigText, options.expectedManifestPublicKey)) {
      throw new UpdateFeedError('INVALID_MANIFEST_SIGNATURE', 'Manifest Ed25519 cryptographic signature failed verification');
    }
  }

  const manifest = parseDesktopReleaseManifest(manifestBuf.toString('utf8'));
  verifyReleaseManifestAgainstReleases(releases, manifest, {
    requireSigned,
    expectedPublisherThumbprint: options.expectedPublisherThumbprint ?? null,
  });

  return { feedUrl: checkedFeed.url, releases, manifest, rawManifestBytes: manifestBuf };
}

export type SignedPackageVerifier = (packagePath: string, expectedThumbprint: string | null) => Promise<void>;
export type SignedManifestVerifier = (
  manifestScriptPath: string,
  expectedJsonBytes: Buffer,
  expectedThumbprint: string,
) => Promise<void | { thumbprint: string }>;

export interface PrepareVerifiedUpdateOptions extends ValidateUpdateFeedOptions {
  currentVersion?: string | null | undefined;
  stagingDir: string;
  resolveTrustedThumbprint?: (() => Promise<string | null>) | undefined;
  verifySignedManifest?: SignedManifestVerifier | undefined;
  verifySignedPackage?: SignedPackageVerifier | undefined;
}

export async function prepareVerifiedUpdate(options: PrepareVerifiedUpdateOptions): Promise<PreparedUpdateResult> {
  const validated = await validateUpdateFeed(options);
  const target = validated.releases.latestFull;
  const manifestPkg = validated.manifest?.packages.find((p) => p.file === target.file) ?? null;
  const feedHost = new URL(validated.feedUrl).hostname;
  const requireSigned = shouldRequireSignedFeed(feedHost, options);

  let trustedThumbprint: string | null = options.expectedPublisherThumbprint?.trim().toLowerCase() ?? null;
  if (requireSigned && !trustedThumbprint && options.resolveTrustedThumbprint) {
    trustedThumbprint = (await options.resolveTrustedThumbprint())?.trim().toLowerCase() ?? null;
  }

  if (requireSigned) {
    if (!trustedThumbprint && !options.expectedManifestPublicKey) {
      throw new UpdateFeedError('UNTRUSTED_PUBLISHER', 'Refused update without a trusted publisher thumbprint or public key');
    }
    if (trustedThumbprint && validated.manifest?.signing.publisherThumbprint !== trustedThumbprint) {
      throw new UpdateFeedError('PUBLISHER_MISMATCH', 'Update feed publisher certificate thumbprint does not match trusted publisher');
    }
    if (!options.verifySignedPackage) {
      throw new UpdateFeedError('MISSING_VERIFIER', 'Refused signed update without a package Authenticode verifier');
    }
    if (!options.expectedManifestPublicKey) {
      if (!options.verifySignedManifest || !validated.rawManifestBytes || !trustedThumbprint) {
        throw new UpdateFeedError('MISSING_VERIFIER', 'Refused signed update without a signed manifest script verifier');
      }
      const scriptRes = await options.fetch(`${validated.feedUrl}/${RELEASE_MANIFEST_SCRIPT_FILENAME}`, {
        method: 'GET',
        headers: { accept: 'text/plain, application/octet-stream' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!scriptRes.ok) {
        throw new UpdateFeedError('MISSING_SIGNED_MANIFEST', `Update feed ${RELEASE_MANIFEST_SCRIPT_FILENAME} returned HTTP ${scriptRes.status}`);
      }
      const scriptBytes = await readBoundedResponseBytes(scriptRes, MAX_MANIFEST_BYTES, true);
      mkdirSync(options.stagingDir, { recursive: true });
      const tempScriptPath = join(options.stagingDir, `verify-${randomUUID()}.ps1`);
      writeFileSync(tempScriptPath, scriptBytes, { mode: 0o600 });
      try {
        await options.verifySignedManifest(tempScriptPath, validated.rawManifestBytes, trustedThumbprint);
      } finally {
        rmSync(tempScriptPath, { force: true });
      }
    }
  }

  if (options.currentVersion && compareSemver(target.version, options.currentVersion) <= 0) {
    return { status: 'up-to-date', version: target.version };
  }

  rmSync(options.stagingDir, { recursive: true, force: true });
  mkdirSync(options.stagingDir, { recursive: true });
  const tempPath = join(options.stagingDir, `${target.file}.part`);
  const finalPath = join(options.stagingDir, target.file);

  const downloadAc = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const totalTimer = setTimeout(() => downloadAc.abort(new Error('Update download exceeded maximum duration')), DOWNLOAD_MAX_TOTAL_MS);
  const resetIdleTimer = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => downloadAc.abort(new Error('Update download stalled without progress')), DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  resetIdleTimer();

  const sha1Hash = createHash('sha1');
  const sha256Hash = createHash('sha256');
  let received = 0;

  try {
    try {
      const res = await options.fetch(target.downloadUrl, {
        method: 'GET',
        headers: { accept: 'application/octet-stream' },
        redirect: 'error',
        signal: downloadAc.signal,
      });
      resetIdleTimer();
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new UpdateFeedError('DOWNLOAD_HTTP_ERROR', `Failed downloading update package: HTTP ${res.status}`);
      }
      const contentLengthHeader = res.headers.get('content-length');
      if (contentLengthHeader !== null) {
        const declared = Number(contentLengthHeader);
        if (Number.isFinite(declared) && (declared > MAX_PACKAGE_BYTES || declared !== target.size)) {
          await res.body?.cancel().catch(() => undefined);
          throw new UpdateFeedError('CHECKSUM_FAILED', 'Downloaded update package failed checksum verification (size mismatch)');
        }
      }

      if (!res.body) {
        const buf = Buffer.from(await res.arrayBuffer());
        resetIdleTimer();
        received = buf.byteLength;
        if (received > MAX_PACKAGE_BYTES || received !== target.size) {
          throw new UpdateFeedError('CHECKSUM_FAILED', 'Downloaded update package failed checksum verification (size mismatch)');
        }
        sha1Hash.update(buf);
        sha256Hash.update(buf);
        writeFileSync(tempPath, buf);
      } else {
        const reader = res.body.getReader();
        const ws = createWriteStream(tempPath, { mode: 0o600 });
        let streamErr: Error | null = null;
        const getStreamErr = (): Error | null => streamErr;
        let pendingErrReject: ((err: Error) => void) | null = null;
        const onStreamError = (err: Error): void => {
          streamErr = err;
          if (pendingErrReject) {
            const r = pendingErrReject;
            pendingErrReject = null;
            r(err);
          }
        };
        ws.on('error', onStreamError);
        try {
          for (;;) {
            const errNow = getStreamErr();
            if (errNow) throw errNow;
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            resetIdleTimer();
            received += value.byteLength;
            if (received > MAX_PACKAGE_BYTES || received > target.size) {
              await reader.cancel().catch(() => undefined);
              throw new UpdateFeedError('CHECKSUM_FAILED', 'Downloaded update package failed checksum verification (size exceeded)');
            }
            sha1Hash.update(value);
            sha256Hash.update(value);
            const writeErrNow = getStreamErr();
            if (writeErrNow) throw writeErrNow;
            if (!ws.write(value)) {
              await new Promise<void>((resolve, reject) => {
                const immediateErr = getStreamErr();
                if (immediateErr) {
                  reject(immediateErr);
                  return;
                }
                const onDrain = (): void => {
                  pendingErrReject = null;
                  resolve();
                };
                pendingErrReject = (err) => {
                  ws.removeListener('drain', onDrain);
                  reject(err);
                };
                ws.once('drain', onDrain);
              });
            }
          }
          const finishErrNow = getStreamErr();
          if (finishErrNow) throw finishErrNow;
          await new Promise<void>((resolve, reject) => {
            const onFinish = (): void => {
              pendingErrReject = null;
              resolve();
            };
            pendingErrReject = (err) => {
              ws.removeListener('finish', onFinish);
              reject(err);
            };
            ws.once('finish', onFinish);
            ws.end();
          });
        } catch (err) {
          ws.destroy();
          throw err;
        } finally {
          ws.removeListener('error', onStreamError);
          reader.releaseLock();
        }
      }
    } catch (err) {
      downloadAc.abort(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
    }

    const actualSha1 = sha1Hash.digest('hex').toLowerCase();
    const actualSha256 = sha256Hash.digest('hex').toLowerCase();
    if (received !== target.size || actualSha1 !== target.sha1) {
      throw new UpdateFeedError('CHECKSUM_FAILED', 'Downloaded update package failed checksum verification (SHA-1 or size mismatch)');
    }
    if (manifestPkg && actualSha256 !== manifestPkg.sha256) {
      throw new UpdateFeedError('CHECKSUM_FAILED', 'Downloaded update package failed checksum verification (SHA-256 mismatch)');
    }

    if (requireSigned && options.verifySignedPackage) {
      await options.verifySignedPackage(tempPath, trustedThumbprint);
    }

    rmSync(finalPath, { force: true });
    renameSync(tempPath, finalPath);
    writeFileSync(join(options.stagingDir, 'RELEASES'), `${actualSha1.toUpperCase()} ${target.file} ${received}\n`, 'utf8');

    return {
      status: 'staged',
      version: target.version,
      stagingDir: options.stagingDir,
      packageFile: target.file,
      sha1: actualSha1,
      sha256: actualSha256,
      size: received,
    };
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
