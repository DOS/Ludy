// SPDX-License-Identifier: AGPL-3.0-only
// Windows code-signing configuration guardrails, Authenticode verification parsing, and release-manifest/checksum generation
// for Ludy Desktop (#4884). Never holds or logs certificates, passwords, tokens, or private keys.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export const DEFAULT_TIMESTAMP_SERVER = 'http://timestamp.digicert.com';
export const RELEASE_MANIFEST_FILENAME = 'release-manifest.json';
export const CHECKSUMS_FILENAME = 'SHA256SUMS.txt';

const SHA1_HEX = /^[0-9a-f]{40}$/i;
const SEMVER_CORE = /^\d+\.\d+\.\d+$/;
const PACKAGE_FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)-(\d+\.\d+\.\d+)-(full|delta)\.nupkg$/;
const RELEASE_LINE_PATTERN = /^([0-9a-fA-F]{40})\s+(\S+)\s+(\d+)$/;
const UNSAFE_PATH_CHARS = /["%^&|<>!]/;
const UNSAFE_SHELL_CHARS = /[&|;<>`$]/;

function assertSafeToken(label, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${label}: expected non-empty string`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`Refused ${label}: contains control characters`);
    }
  }
  if (UNSAFE_PATH_CHARS.test(value)) {
    throw new Error(`Refused ${label}: contains unsafe characters`);
  }
  return value;
}

function parseIpv6Groups(address) {
  let clean = address.toLowerCase();
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx !== -1) clean = clean.slice(0, zoneIdx);
  if (clean.includes('.')) {
    const lastColon = clean.lastIndexOf(':');
    if (lastColon === -1) return null;
    const octets = clean.slice(lastColon + 1).split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    clean = `${clean.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  if (halves.length === 2 ? missing < 1 : left.length !== 8) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  const groups = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function isDisallowedTimestampHost(hostname) {
  let bare = hostname.trim().toLowerCase();
  if (bare.startsWith('[') && bare.endsWith(']')) bare = bare.slice(1, -1);
  if (bare.includes('%')) return true;
  bare = bare.replace(/\.+$/, '');
  if (!bare) return true;
  if (
    bare === 'localhost' ||
    bare.endsWith('.local') ||
    bare.endsWith('.internal') ||
    bare.endsWith('.localhost') ||
    bare.endsWith('.arpa')
  ) {
    return true;
  }
  const ipKind = isIP(bare);
  if (ipKind === 4) {
    const [a, b, c] = bare.split('.').map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    ) {
      return true;
    }
  } else if (ipKind === 6) {
    const g = parseIpv6Groups(bare);
    if (!g) return true;
    // IPv4-compatible ::/96 (includes :: and ::1), IPv4-mapped ::ffff:0:0/96, IPv4-translated ::ffff:0:0:0/96
    const allZeroTop6 = g.slice(0, 6).every((w) => w === 0);
    const ipv4Mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
    const ipv4Translated = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0;
    if (allZeroTop6 || ipv4Mapped || ipv4Translated) {
      return true;
    }
    // ULA fc00::/7, link-local fe80::/10 (fe80..febf), deprecated site-local fec0::/10, multicast ff00::/8
    if (
      (g[0] & 0xfe00) === 0xfc00 ||
      (g[0] & 0xffc0) === 0xfe80 ||
      (g[0] & 0xffc0) === 0xfec0 ||
      (g[0] & 0xff00) === 0xff00
    ) {
      return true;
    }
    // 6to4 2002::/16, documentation 2001:db8::/32, discard 100::/64, NAT64 64:ff9b::/96 & 64:ff9b:1::/48
    if (
      g[0] === 0x2002 ||
      (g[0] === 0x2001 && g[1] === 0x0db8) ||
      (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) ||
      (g[0] === 0x0064 && g[1] === 0xff9b && ((g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) || g[2] === 1))
    ) {
      return true;
    }
  } else if (!bare.includes('.')) {
    return true;
  }
  return false;
}

export function validateTimestampServer(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('WINDOWS_TIMESTAMP_SERVER must not be empty');
  assertSafeToken('WINDOWS_TIMESTAMP_SERVER', raw);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid WINDOWS_TIMESTAMP_SERVER URL: ${raw}`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('WINDOWS_TIMESTAMP_SERVER must be a plain http or https URL with no credentials, query, or fragment');
  }
  if (isDisallowedTimestampHost(url.hostname)) {
    throw new Error('Refused WINDOWS_TIMESTAMP_SERVER pointing to loopback or private network host');
  }
  return url.toString().replace(/\/+$/, '');
}

export function parseSignWithParamsTokens(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('WINDOWS_SIGN_WITH_PARAMS must be a non-empty string');
  }
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error('Refused WINDOWS_SIGN_WITH_PARAMS: contains control characters');
    }
  }
  if (UNSAFE_SHELL_CHARS.test(input)) {
    throw new Error('Refused WINDOWS_SIGN_WITH_PARAMS: contains shell metacharacters');
  }
  const tokens = [];
  let current = '';
  let inToken = false;
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      inToken = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inQuotes) {
    throw new Error('Refused WINDOWS_SIGN_WITH_PARAMS: unclosed double quote');
  }
  if (inToken) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    throw new Error('WINDOWS_SIGN_WITH_PARAMS produced no arguments');
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();
    if (lower === '/p' || lower === '-p' || lower === '/password' || lower.startsWith('/p:') || lower.startsWith('-p:')) {
      throw new Error('Refused password flag inside WINDOWS_SIGN_WITH_PARAMS; use WINDOWS_CERTIFICATE_PASSWORD or store thumbprint');
    }
    if (lower === '/t' || lower === '-t' || lower.startsWith('/t:') || lower.startsWith('-t:')) {
      throw new Error('Refused legacy /t timestamp flag in WINDOWS_SIGN_WITH_PARAMS; use RFC 3161 /tr');
    }
    if (lower === '/fd' || lower === '-fd') {
      const alg = tokens[i + 1]?.toLowerCase() ?? '';
      if (alg !== 'sha256') {
        throw new Error('Refused WINDOWS_SIGN_WITH_PARAMS: /fd file digest algorithm must be sha256');
      }
      i += 1;
      continue;
    }
    if (lower.startsWith('/fd:') || lower.startsWith('-fd:')) {
      const alg = lower.slice(4);
      if (alg !== 'sha256') {
        throw new Error('Refused WINDOWS_SIGN_WITH_PARAMS: /fd file digest algorithm must be sha256');
      }
      continue;
    }
    if (lower === '/td' || lower === '-td') {
      const alg = tokens[i + 1]?.toLowerCase() ?? '';
      if (alg !== 'sha256') {
        throw new Error('Refused WINDOWS_SIGN_WITH_PARAMS: /td timestamp digest algorithm must be sha256');
      }
      i += 1;
      continue;
    }
    if (lower.startsWith('/td:') || lower.startsWith('-td:')) {
      const alg = lower.slice(4);
      if (alg !== 'sha256') {
        throw new Error('Refused WINDOWS_SIGN_WITH_PARAMS: /td timestamp digest algorithm must be sha256');
      }
      continue;
    }
    if (lower === '/tr' || lower === '-tr') {
      const serverUrl = tokens[i + 1] ?? '';
      validateTimestampServer(serverUrl);
      i += 1;
      continue;
    }
    if (lower.startsWith('/tr:') || lower.startsWith('-tr:')) {
      validateTimestampServer(tok.slice(4));
    }
  }
  // Canonicalize digest/timestamp flag casing and split colon forms so @electron/windows-sign recognizes them accurately.
  const normalized = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();
    if (lower === '/fd' || lower === '-fd') {
      normalized.push('/fd', 'sha256');
      i += 1;
    } else if (lower.startsWith('/fd:') || lower.startsWith('-fd:')) {
      normalized.push('/fd', 'sha256');
    } else if (lower === '/td' || lower === '-td') {
      normalized.push('/td', 'sha256');
      i += 1;
    } else if (lower.startsWith('/td:') || lower.startsWith('-td:')) {
      normalized.push('/td', 'sha256');
    } else if (lower === '/tr' || lower === '-tr') {
      normalized.push('/tr', validateTimestampServer(tokens[i + 1]));
      i += 1;
    } else if (lower.startsWith('/tr:') || lower.startsWith('-tr:')) {
      normalized.push('/tr', validateTimestampServer(tok.slice(4)));
    } else {
      normalized.push(tok);
    }
  }
  return normalized;
}

export function formatSignWithParamsString(tokens) {
  return tokens
    .map((tok) => {
      if (typeof tok !== 'string') throw new Error('Expected string token in signWithParams');
      for (let i = 0; i < tok.length; i++) {
        const code = tok.charCodeAt(i);
        if (code < 0x20 || code === 0x7f || tok[i] === '"') {
          throw new Error('Refused unsafe character in signWithParams token');
        }
      }
      return /\s/.test(tok) ? `"${tok}"` : tok;
    })
    .join(' ');
}

function validateFilePathOption(label, value, exists) {
  assertSafeToken(label, value);
  if (value.endsWith('\\')) {
    throw new Error(`Refused ${label}: trailing backslash is unsafe`);
  }
  if (!exists(value)) {
    throw new Error(`${label} does not exist: ${value}`);
  }
  return value;
}

export function resolveSigningConfig({ sign = false, env = process.env, exists = existsSync } = {}) {
  if (!sign) {
    return { enabled: false };
  }

  const sha1 = env.WINDOWS_CERT_SHA1?.trim() ?? '';
  const certFile = env.WINDOWS_CERTIFICATE_FILE?.trim() ?? '';
  const certPassword = env.WINDOWS_CERTIFICATE_PASSWORD ?? '';
  const rawParams = env.WINDOWS_SIGN_WITH_PARAMS?.trim() ?? '';
  const hookModulePath = env.WINDOWS_SIGN_HOOK_MODULE_PATH?.trim() ?? '';
  const rawSigntoolPath = env.WINDOWS_SIGNTOOL_PATH?.trim() ?? '';
  const timestampServer = validateTimestampServer(env.WINDOWS_TIMESTAMP_SERVER?.trim() || DEFAULT_TIMESTAMP_SERVER);

  if ((certFile !== '' && certPassword === '') || (certFile === '' && certPassword !== '')) {
    throw new Error('WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD must both be set when signing with a PFX file');
  }

  const hasThumbprint = sha1 !== '';
  const hasPfx = certFile !== '' && certPassword !== '';
  const hasParams = rawParams !== '';
  const hasHook = hookModulePath !== '';
  const activeCount = [hasThumbprint, hasPfx, hasParams, hasHook].filter(Boolean).length;

  if (activeCount === 0) {
    throw new Error(
      'Windows signing requested (--sign), but no signing credentials were supplied. Set WINDOWS_CERT_SHA1, WINDOWS_CERTIFICATE_FILE + WINDOWS_CERTIFICATE_PASSWORD, WINDOWS_SIGN_WITH_PARAMS, or WINDOWS_SIGN_HOOK_MODULE_PATH.',
    );
  }
  if (activeCount > 1) {
    throw new Error('Ambiguous Windows signing configuration: configure exactly one signing credential mode');
  }

  const signtoolPath = rawSigntoolPath ? validateFilePathOption('WINDOWS_SIGNTOOL_PATH', rawSigntoolPath, exists) : null;

  if (hasThumbprint) {
    if (!SHA1_HEX.test(sha1)) {
      throw new Error('WINDOWS_CERT_SHA1 must be a 40-character hexadecimal certificate thumbprint');
    }
    const thumbprint = sha1.toUpperCase();
    return {
      enabled: true,
      mode: 'thumbprint',
      thumbprint,
      timestampServer,
      signtoolPath,
      signWithParams: ['/fd', 'sha256', '/tr', timestampServer, '/td', 'sha256', '/sha1', thumbprint],
    };
  }

  if (hasParams) {
    const tokens = parseSignWithParamsTokens(rawParams);
    const hasFlag = (name) => tokens.includes(`/${name}`);
    const finalTokens = [...tokens];
    if (!hasFlag('fd')) finalTokens.push('/fd', 'sha256');
    if (!hasFlag('tr')) finalTokens.push('/tr', timestampServer);
    if (!hasFlag('td')) finalTokens.push('/td', 'sha256');
    return {
      enabled: true,
      mode: 'params',
      timestampServer,
      signtoolPath,
      signWithParams: finalTokens,
    };
  }

  if (hasPfx) {
    const validatedCertFile = validateFilePathOption('WINDOWS_CERTIFICATE_FILE', certFile, exists);
    return {
      enabled: true,
      mode: 'pfx',
      certificateFile: validatedCertFile,
      timestampServer,
      signtoolPath,
    };
  }

  const validatedHook = validateFilePathOption('WINDOWS_SIGN_HOOK_MODULE_PATH', hookModulePath, exists);
  if (!/\.(?:js|mjs|cjs)$/i.test(validatedHook)) {
    throw new Error('WINDOWS_SIGN_HOOK_MODULE_PATH must point to a .js, .mjs, or .cjs module');
  }
  return {
    enabled: true,
    mode: 'hook',
    hookModulePath: validatedHook,
    timestampServer,
    signtoolPath,
  };
}

export function buildPackagerWindowsSign(signing) {
  if (!signing.enabled) return undefined;
  const base = {
    hashes: ['sha256'],
    description: 'Ludy Desktop',
    timestampServer: signing.timestampServer,
    ...(signing.signtoolPath ? { signToolPath: signing.signtoolPath } : {}),
  };
  if (signing.mode === 'thumbprint' || signing.mode === 'params') {
    return { ...base, signWithParams: signing.signWithParams };
  }
  if (signing.mode === 'pfx') {
    // Password is read directly from process.env.WINDOWS_CERTIFICATE_PASSWORD by @electron/windows-sign.
    return { ...base, certificateFile: signing.certificateFile };
  }
  return {
    description: 'Ludy Desktop',
    hookModulePath: signing.hookModulePath,
  };
}

export function buildWinstallerSignOptions(signing, env = process.env) {
  if (!signing.enabled) return {};
  if (signing.mode === 'thumbprint' || signing.mode === 'params') {
    return { signWithParams: formatSignWithParamsString(signing.signWithParams) };
  }
  if (signing.mode === 'pfx') {
    const password = env.WINDOWS_CERTIFICATE_PASSWORD ?? '';
    if (!password) {
      throw new Error('WINDOWS_CERTIFICATE_PASSWORD is missing for PFX signing');
    }
    // Use @electron/windows-sign via windowsSign (never legacy certificateFile + /fd signWithParams, which triggers a substring '/f' bug and leaks /p on CLI).
    return {
      windowsSign: {
        hashes: ['sha256'],
        certificateFile: signing.certificateFile,
        timestampServer: signing.timestampServer,
        description: 'Ludy Desktop',
        ...(signing.signtoolPath ? { signToolPath: signing.signtoolPath } : {}),
      },
    };
  }
  return {
    windowsSign: {
      hookModulePath: signing.hookModulePath,
      description: 'Ludy Desktop',
    },
  };
}

export function extractSigntoolDigestAlgorithm(signtoolOutput) {
  if (typeof signtoolOutput !== 'string' || signtoolOutput.trim() === '') {
    throw new Error('signtool verify produced empty output');
  }
  const matches = [...signtoolOutput.matchAll(/Hash of file \(([a-z0-9-]+)\):/gi)];
  if (matches.length === 0) {
    throw new Error('signtool verify output did not report a file digest algorithm');
  }
  const algs = matches.map((m) => m[1].toLowerCase());
  const nonSha256 = algs.find((alg) => alg !== 'sha256');
  if (nonSha256) {
    throw new Error(`signtool verify found non-sha256 file digest algorithm: ${nonSha256}`);
  }
  return 'sha256';
}

export function parseReleasesEntries(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error('RELEASES file is empty');
  }
  return lines.map((line) => {
    const match = RELEASE_LINE_PATTERN.exec(line);
    if (!match) throw new Error(`Malformed RELEASES line: ${line}`);
    const file = match[2];
    if (file.includes('/') || file.includes('\\')) {
      throw new Error(`Expected flat filename in RELEASES, got ${file}`);
    }
    const pkg = PACKAGE_FILE_PATTERN.exec(file);
    if (!pkg) {
      throw new Error(`Unexpected package name in RELEASES: ${file}`);
    }
    return {
      sha1: match[1].toLowerCase(),
      file,
      size: Number(match[3]),
      version: pkg[2],
      kind: pkg[3] === 'delta' ? 'delta' : 'full',
    };
  });
}

function digestFile(filePath, algorithm) {
  const buf = readFileSync(filePath);
  return {
    hash: createHash(algorithm).update(buf).digest('hex'),
    size: statSync(filePath).size,
  };
}

export function createReleaseArtifacts({ installerDir, version, signed, timestampServer = null, publisherThumbprint = null }) {
  if (!SEMVER_CORE.test(version)) {
    throw new Error(`Invalid version for release artifacts: ${version}`);
  }
  if (signed && (!publisherThumbprint || !SHA1_HEX.test(publisherThumbprint))) {
    throw new Error('Signed release artifacts require a valid 40-hex publisherThumbprint');
  }
  const releasesPath = join(installerDir, 'RELEASES');
  const setupFile = 'LudyDesktop-Setup.exe';
  const setupPath = join(installerDir, setupFile);
  if (!existsSync(releasesPath)) throw new Error(`Missing RELEASES in ${installerDir}`);
  if (!existsSync(setupPath)) throw new Error(`Missing ${setupFile} in ${installerDir}`);

  const entries = parseReleasesEntries(readFileSync(releasesPath, 'utf8'));
  const packages = entries.map((entry) => {
    const pkgPath = join(installerDir, entry.file);
    if (!existsSync(pkgPath)) {
      throw new Error(`Package ${entry.file} listed in RELEASES is missing in ${installerDir}`);
    }
    const sha1Check = digestFile(pkgPath, 'sha1');
    if (sha1Check.size !== entry.size || sha1Check.hash !== entry.sha1) {
      throw new Error(`Package ${entry.file} does not match RELEASES SHA-1 or byte size`);
    }
    const sha256Check = digestFile(pkgPath, 'sha256');
    return {
      file: entry.file,
      kind: entry.kind,
      version: entry.version,
      sha1: entry.sha1,
      sha256: sha256Check.hash,
      size: entry.size,
    };
  });

  if (!packages.some((p) => p.kind === 'full' && p.version === version)) {
    throw new Error(`No full nupkg for version ${version} found in RELEASES`);
  }

  const setupDigest = digestFile(setupPath, 'sha256');
  const manifest = {
    schemaVersion: 1,
    product: 'ludy-desktop',
    platform: 'win32',
    arch: 'x64',
    version,
    signed,
    signing: {
      algorithm: 'sha256',
      timestampServer: signed ? timestampServer : null,
      publisherThumbprint: signed ? publisherThumbprint.toLowerCase() : null,
    },
    installer: {
      file: setupFile,
      sha256: setupDigest.hash,
      size: setupDigest.size,
    },
    packages,
  };

  const manifestPath = join(installerDir, RELEASE_MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const checksumsPath = writeReleaseChecksums(installerDir);
  return { manifest, manifestPath, checksumsPath };
}

export function writeReleaseChecksums(installerDir) {
  const releasesPath = join(installerDir, 'RELEASES');
  const entries = parseReleasesEntries(readFileSync(releasesPath, 'utf8'));
  const checksumFiles = ['LudyDesktop-Setup.exe', 'RELEASES', RELEASE_MANIFEST_FILENAME];
  if (existsSync(join(installerDir, 'release-manifest.ps1'))) {
    checksumFiles.push('release-manifest.ps1');
  }
  checksumFiles.push(...entries.map((p) => p.file));
  const checksumLines = checksumFiles.map((file) => `${digestFile(join(installerDir, file), 'sha256').hash}  ${file}`);
  const checksumsPath = join(installerDir, CHECKSUMS_FILENAME);
  writeFileSync(checksumsPath, `${checksumLines.join('\n')}\n`, 'utf8');
  return checksumsPath;
}
