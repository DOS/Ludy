// SPDX-License-Identifier: AGPL-3.0-only
// macOS Developer ID signing, Apple notarization credential validation, ephemeral Keychain lifecycle,
// minimal Hardened Runtime entitlements selection, and release-manifest/checksum generation (#4885).
// Never stores, logs, or passes certificates, passwords, or private keys in process argv or configs.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLE_BUNDLE_ID, APPLE_TEAM_ID_PATTERN, normalizeAppleTeamId } from '../src/codesign.ts';

export const APPLE_HELPER_BUNDLE_ID = 'vn.ludy.desktop.helper';
export const SUPPORTED_MAC_ARCHES = ['arm64', 'x64'];
export const MAC_RELEASE_MANIFEST_FILENAME = 'release-manifest.json';
export const MAC_CHECKSUMS_FILENAME = 'SHA256SUMS.txt';

const SEMVER_CORE = /^\d+\.\d+\.\d+$/;
const KEY_ID_PATTERN = /^[A-Z0-9]{8,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPLE_ID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNSAFE_ARG_CHARS = /["%^&|<>!`$;\r\n\0]/;

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
export const MAC_DARWIN_ENTITLEMENTS_PATH = join(desktopRoot, 'entitlements', 'darwin.plist');
export const MAC_HELPER_ENTITLEMENTS_PATH = join(desktopRoot, 'entitlements', 'darwin-helper.plist');

function assertSafeValue(label, value, { allowQuotes = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${label}: expected non-empty string`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`Refused ${label}: contains control characters`);
    }
  }
  if (!allowQuotes && UNSAFE_ARG_CHARS.test(value)) {
    throw new Error(`Refused ${label}: contains unsafe characters`);
  }
  return value;
}

function assertSafeSecret(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${label}: must not be empty`);
  }
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new Error(`Refused ${label}: contains NUL or newline characters`);
  }
  return value;
}

function validateFileExists(label, value, exists) {
  assertSafeValue(label, value);
  if (!exists(value)) {
    throw new Error(`${label} does not exist: ${value}`);
  }
  return value;
}

export function selectMacEntitlementsForFile(filePath) {
  if (
    filePath.includes('(GPU).app') ||
    filePath.includes('(Plugin).app') ||
    filePath.includes('(Alerts).app')
  ) {
    return MAC_HELPER_ENTITLEMENTS_PATH;
  }
  return MAC_DARWIN_ENTITLEMENTS_PATH;
}

export function buildMacExtendInfo() {
  return {
    LSApplicationCategoryType: 'public.app-category.productivity',
    NSMicrophoneUsageDescription:
      'Ludy Desktop sử dụng micro khi bạn bắt đầu ghi âm cuộc họp sau khi đã xác nhận thông báo với người tham gia.',
    NSAudioCaptureUsageDescription:
      'Ludy Desktop sử dụng âm thanh hệ thống Core Audio để ghi âm cuộc họp trực tuyến khi bạn xác nhận bắt đầu ghi.',
    NSScreenCaptureUsageDescription:
      'Ludy Desktop chỉ yêu cầu quyền ghi âm thanh hệ thống khi bạn chọn ghi âm thanh cuộc họp trên macOS (không quay hình màn hình).',
    // Keep App Transport Security strictly enabled; permit plain HTTP only for the local verified staging server on 127.0.0.1.
    NSAppTransportSecurity: {
      NSAllowsArbitraryLoads: false,
      NSExceptionDomains: {
        '127.0.0.1': {
          NSExceptionAllowsInsecureHTTPLoads: true,
          NSIncludesSubdomains: false,
        },
      },
    },
  };
}

export function resolveMacSigningConfig({ sign = false, env = process.env, exists = existsSync } = {}) {
  if (!sign) {
    return { enabled: false };
  }

  const rawTeamId = env.APPLE_TEAM_ID?.trim() ?? '';
  if (!rawTeamId) {
    throw new Error('APPLE_TEAM_ID is required when --sign is enabled for macOS');
  }
  const teamId = normalizeAppleTeamId(rawTeamId);
  if (!teamId || !APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new Error('APPLE_TEAM_ID must be a 10-character alphanumeric Apple Developer Team ID');
  }

  const p12File = env.APPLE_CERT_P12_FILE?.trim() ?? '';
  const p12Password = env.APPLE_CERT_P12_PASSWORD ?? '';
  const identity = env.APPLE_CODESIGN_IDENTITY?.trim() ?? '';
  const keychainPath = env.APPLE_KEYCHAIN_PATH?.trim() ?? '';

  if ((p12File !== '' && p12Password === '') || (p12File === '' && p12Password !== '')) {
    throw new Error('APPLE_CERT_P12_FILE and APPLE_CERT_P12_PASSWORD must both be set when signing with a .p12 certificate');
  }
  const hasP12 = p12File !== '' && p12Password !== '';
  const hasIdentity = identity !== '';
  if (!hasP12 && !hasIdentity) {
    throw new Error(
      'macOS signing requested (--sign), but no signing credentials were supplied. Set APPLE_CERT_P12_FILE + APPLE_CERT_P12_PASSWORD or APPLE_CODESIGN_IDENTITY.',
    );
  }
  if (hasP12 && hasIdentity) {
    throw new Error('Ambiguous macOS signing configuration: set either APPLE_CERT_P12_FILE + APPLE_CERT_P12_PASSWORD or APPLE_CODESIGN_IDENTITY, not both');
  }
  if (hasP12 && keychainPath !== '') {
    throw new Error('Ambiguous macOS signing configuration: APPLE_KEYCHAIN_PATH cannot be combined with ephemeral .p12 staging');
  }

  let certConfig;
  if (hasP12) {
    const validatedP12 = validateFileExists('APPLE_CERT_P12_FILE', p12File, exists);
    assertSafeSecret('APPLE_CERT_P12_PASSWORD', p12Password);
    certConfig = { certMode: 'p12', p12File: validatedP12 };
  } else {
    assertSafeValue('APPLE_CODESIGN_IDENTITY', identity);
    const idTeamMatch = /\(([A-Z0-9]{10})\)\s*$/i.exec(identity);
    if (idTeamMatch?.[1] && idTeamMatch[1].toUpperCase() !== teamId) {
      throw new Error(`APPLE_CODESIGN_IDENTITY Team ID (${idTeamMatch[1].toUpperCase()}) does not match APPLE_TEAM_ID (${teamId})`);
    }
    const validatedKeychain = keychainPath ? validateFileExists('APPLE_KEYCHAIN_PATH', keychainPath, exists) : null;
    certConfig = { certMode: 'identity', identity, keychainPath: validatedKeychain };
  }

  const apiKeyFile = env.APPLE_API_KEY_FILE?.trim() ?? '';
  const apiKeyId = env.APPLE_API_KEY_ID?.trim().toUpperCase() ?? '';
  const apiIssuerId = env.APPLE_API_ISSUER_ID?.trim().toLowerCase() ?? '';
  const appleId = env.APPLE_ID?.trim() ?? '';
  const appleAppPassword = env.APPLE_APP_SPECIFIC_PASSWORD ?? '';

  const hasAnyApi = apiKeyFile !== '' || apiKeyId !== '' || apiIssuerId !== '';
  const hasAnyAppleId = appleId !== '' || appleAppPassword !== '';

  if (!hasAnyApi && !hasAnyAppleId) {
    throw new Error(
      'Apple notarization credentials are required when --sign is enabled. Set APPLE_API_KEY_FILE + APPLE_API_KEY_ID + APPLE_API_ISSUER_ID, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD.',
    );
  }
  if (hasAnyApi && hasAnyAppleId) {
    throw new Error(
      'Ambiguous Apple notarization configuration: set either App Store Connect API key variables or Apple ID credentials, not both',
    );
  }

  let notary;
  if (hasAnyApi) {
    if (!apiKeyFile || !apiKeyId || !apiIssuerId) {
      throw new Error('APPLE_API_KEY_FILE, APPLE_API_KEY_ID, and APPLE_API_ISSUER_ID must all be set together');
    }
    const validatedKeyFile = validateFileExists('APPLE_API_KEY_FILE', apiKeyFile, exists);
    if (!KEY_ID_PATTERN.test(apiKeyId)) {
      throw new Error('APPLE_API_KEY_ID must be 8-20 uppercase alphanumeric characters');
    }
    if (!UUID_PATTERN.test(apiIssuerId)) {
      throw new Error('APPLE_API_ISSUER_ID must be a valid UUID');
    }
    notary = {
      notaryMode: 'api-key',
      apiKeyFile: validatedKeyFile,
      apiKeyId,
      apiIssuerId,
    };
  } else {
    if (!appleId || !appleAppPassword) {
      throw new Error('APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD must both be set together');
    }
    assertSafeValue('APPLE_ID', appleId);
    if (!APPLE_ID_EMAIL.test(appleId)) {
      throw new Error('APPLE_ID must be a valid Apple ID email address');
    }
    assertSafeSecret('APPLE_APP_SPECIFIC_PASSWORD', appleAppPassword);
    notary = {
      notaryMode: 'apple-id',
      appleId,
    };
  }

  return {
    enabled: true,
    teamId,
    bundleId: APPLE_BUNDLE_ID,
    ...certConfig,
    notary,
  };
}

export function escapeSecurityInteractiveArg(value) {
  assertSafeSecret('security interactive argument', value);
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatSecurityImportCommands({ keychainPath, keychainPassword, p12Path, p12Password }) {
  return [
    `create-keychain -p ${escapeSecurityInteractiveArg(keychainPassword)} ${escapeSecurityInteractiveArg(keychainPath)}`,
    `set-keychain-settings -lut 21600 ${escapeSecurityInteractiveArg(keychainPath)}`,
    `unlock-keychain -p ${escapeSecurityInteractiveArg(keychainPassword)} ${escapeSecurityInteractiveArg(keychainPath)}`,
    `import ${escapeSecurityInteractiveArg(p12Path)} -k ${escapeSecurityInteractiveArg(keychainPath)} -f pkcs12 -P ${escapeSecurityInteractiveArg(p12Password)} -T /usr/bin/codesign -T /usr/bin/productsign -T /usr/bin/security`,
    `set-key-partition-list -S apple-tool:,apple:,codesign: -s -k ${escapeSecurityInteractiveArg(keychainPassword)} ${escapeSecurityInteractiveArg(keychainPath)}`,
    '',
  ].join('\n');
}

export function parseCodesignIdentities(findIdentityOutput, expectedTeamId = null) {
  const normalized = findIdentityOutput.replace(/\r?\n/g, '\n');
  const matches = [];
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    const m = /^\d+\)\s+([0-9A-Fa-f]{40})\s+"(Developer ID Application:[^"]+)"/.exec(line);
    if (!m) continue;
    const hash = m[1].toUpperCase();
    const name = m[2];
    const teamMatch = /\(([A-Z0-9]{10})\)\s*$/.exec(name);
    const certTeamId = teamMatch?.[1] ?? null;
    matches.push({ hash, name, teamId: certTeamId });
  }
  if (matches.length === 0) {
    throw new Error('No valid Developer ID Application signing identity found in Keychain');
  }
  if (matches.length > 1) {
    throw new Error(`Expected exactly 1 Developer ID Application identity in ephemeral Keychain, found ${matches.length}`);
  }
  const chosen = matches[0];
  if (!chosen.teamId) {
    throw new Error(`Developer ID Application identity is missing a 10-character Team ID: ${chosen.name}`);
  }
  if (expectedTeamId) {
    const cleanExpected = normalizeAppleTeamId(expectedTeamId);
    if (!cleanExpected || chosen.teamId !== cleanExpected) {
      throw new Error(`Signing certificate Team ID ${chosen.teamId} does not match expected APPLE_TEAM_ID ${expectedTeamId}`);
    }
  }
  return chosen;
}

export function parseKeychainSearchList(output) {
  const out = [];
  for (const rawLine of output.replace(/\r?\n/g, '\n').split('\n')) {
    const m = /^\s*"([^"]+)"\s*$/.exec(rawLine);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

export function buildMacPackagerOsxSign({ identity, keychainPath }) {
  return {
    identity,
    identityValidation: true,
    ...(keychainPath ? { keychain: keychainPath } : {}),
    platform: 'darwin',
    hardenedRuntime: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    continueOnError: false,
    optionsForFile: (filePath) => ({
      entitlements: selectMacEntitlementsForFile(filePath),
      hardenedRuntime: true,
    }),
  };
}

export function parseNotaryToolSubmitResult(rawOutput) {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    throw new Error('xcrun notarytool submit produced empty output');
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`xcrun notarytool submit returned malformed JSON output: ${trimmed.slice(0, 300)}`);
  }
  const id = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
  const status = typeof parsed?.status === 'string' ? parsed.status.trim() : '';
  if (!id) {
    throw new Error('xcrun notarytool submit response is missing submission id');
  }
  return { id, status, message: typeof parsed?.message === 'string' ? parsed.message : '' };
}

function defaultExec(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function defaultRunSecurityInteractive(commands) {
  const res = spawnSync('security', ['-i'], {
    input: commands,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim() || `exit ${String(res.status)}`;
    throw new Error(`security interactive command failed: ${detail}`);
  }
}

function defaultStoreNotaryProfileViaPty({ profileName, appleId, teamId, keychainPath, appSpecificPassword }) {
  const pyScript = [
    'import fcntl, os, pty, select, subprocess, termios, time',
    'master, slave = pty.openpty()',
    'def setup():',
    '  os.setsid()',
    '  fcntl.ioctl(slave, termios.TIOCSCTTY, 0)',
    'cmd = ["xcrun", "notarytool", "store-credentials", os.environ["LUDY_NT_PROFILE"], "--apple-id", os.environ["LUDY_NT_APPLE_ID"], "--team-id", os.environ["LUDY_NT_TEAM_ID"], "--keychain", os.environ["LUDY_NT_KEYCHAIN"], "--no-validate"]',
    'p = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup, close_fds=True)',
    'os.close(slave)',
    'buf = b""',
    'sent = False',
    'deadline = time.time() + 30',
    'while time.time() < deadline:',
    '  r, _, _ = select.select([master], [], [], 0.5)',
    '  if master in r:',
    '    try:',
    '      chunk = os.read(master, 4096)',
    '    except OSError:',
    '      break',
    '    if not chunk:',
    '      break',
    '    buf += chunk',
    '    if not sent and b"password" in buf.lower():',
    '      os.write(master, (os.environ["LUDY_NT_PW"] + "\\n").encode())',
    '      sent = True',
    '  elif p.poll() is not None:',
    '    break',
    'os.close(master)',
    'if p.poll() is None:',
    '  p.kill()',
    '  p.wait()',
    '  raise SystemExit("Timed out storing notarytool credentials in ephemeral Keychain")',
    'rc = p.wait()',
    'if rc != 0:',
    '  raise SystemExit(f"notarytool store-credentials failed with exit {rc}")',
  ].join('\n');

  const res = spawnSync('python3', ['-'], {
    input: pyScript,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      LUDY_NT_PROFILE: profileName,
      LUDY_NT_APPLE_ID: appleId,
      LUDY_NT_TEAM_ID: teamId,
      LUDY_NT_KEYCHAIN: keychainPath,
      LUDY_NT_PW: appSpecificPassword,
    },
  });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim() || `exit ${String(res.status)}`;
    throw new Error(`Failed storing notarization profile into ephemeral Keychain: ${detail}`);
  }
}

export async function withEphemeralMacKeychain(options) {
  const {
    signing,
    env = process.env,
    exists = existsSync,
    exec = defaultExec,
    runSecurityInteractive = defaultRunSecurityInteractive,
    storeNotaryProfile = defaultStoreNotaryProfileViaPty,
    run,
  } = options;

  const needEphemeralKeychain = signing.certMode === 'p12' || signing.notary.notaryMode === 'apple-id';
  if (!needEphemeralKeychain) {
    return await run({
      identity: signing.identity,
      keychainPath: signing.keychainPath,
      notaryProfile: null,
    });
  }

  let tempDir = null;
  const requestedPath = env.LUDY_MAC_EPHEMERAL_KEYCHAIN?.trim() ?? '';
  let keychainPath;
  if (requestedPath) {
    assertSafeValue('LUDY_MAC_EPHEMERAL_KEYCHAIN', requestedPath);
    if (!requestedPath.endsWith('.keychain-db')) {
      throw new Error('LUDY_MAC_EPHEMERAL_KEYCHAIN must end with .keychain-db');
    }
    if (exists(requestedPath)) {
      throw new Error(`Refused to clobber pre-existing Keychain: ${requestedPath}`);
    }
    mkdirSync(dirname(requestedPath), { recursive: true, mode: 0o700 });
    keychainPath = requestedPath;
  } else {
    tempDir = mkdtempSync(join(tmpdir(), 'ludy-mac-kc-'));
    keychainPath = join(tempDir, 'ephemeral.keychain-db');
    if (exists(keychainPath)) {
      throw new Error(`Refused to clobber pre-existing Keychain: ${keychainPath}`);
    }
  }

  const priorSearchList = parseKeychainSearchList(exec('security', ['list-keychains', '-d', 'user']));
  if (priorSearchList.includes(keychainPath)) {
    throw new Error(`Refused to reuse Keychain already present in search list: ${keychainPath}`);
  }

  const ephemeralPassword = randomBytes(24).toString('hex');
  const notaryProfile = signing.notary.notaryMode === 'apple-id' ? `ludy-notary-${randomBytes(8).toString('hex')}` : null;
  let primaryError = null;
  let cleanupError = null;
  let result;

  try {
    if (signing.certMode === 'p12') {
      const p12Password = env.APPLE_CERT_P12_PASSWORD ?? '';
      if (!p12Password) {
        throw new Error('APPLE_CERT_P12_PASSWORD is missing for .p12 import');
      }
      runSecurityInteractive(
        formatSecurityImportCommands({
          keychainPath,
          keychainPassword: ephemeralPassword,
          p12Path: signing.p12File,
          p12Password,
        }),
      );
    } else {
      runSecurityInteractive(
        [
          `create-keychain -p ${escapeSecurityInteractiveArg(ephemeralPassword)} ${escapeSecurityInteractiveArg(keychainPath)}`,
          `set-keychain-settings -lut 21600 ${escapeSecurityInteractiveArg(keychainPath)}`,
          `unlock-keychain -p ${escapeSecurityInteractiveArg(ephemeralPassword)} ${escapeSecurityInteractiveArg(keychainPath)}`,
          '',
        ].join('\n'),
      );
    }

    exec('security', ['list-keychains', '-d', 'user', '-s', keychainPath, ...priorSearchList]);

    let chosenIdentity;
    if (signing.certMode === 'p12') {
      const idOut = exec('security', ['find-identity', '-v', '-p', 'codesigning', keychainPath]);
      const parsed = parseCodesignIdentities(idOut, signing.teamId);
      chosenIdentity = parsed.hash;
    } else {
      chosenIdentity = signing.identity;
    }

    if (signing.notary.notaryMode === 'apple-id' && notaryProfile) {
      const appPw = env.APPLE_APP_SPECIFIC_PASSWORD ?? '';
      if (!appPw) {
        throw new Error('APPLE_APP_SPECIFIC_PASSWORD is missing for Apple ID notarization');
      }
      storeNotaryProfile({
        profileName: notaryProfile,
        appleId: signing.notary.appleId,
        teamId: signing.teamId,
        keychainPath,
        appSpecificPassword: appPw,
      });
    }

    result = await run({
      identity: chosenIdentity,
      keychainPath,
      notaryKeychainPath: signing.notary.notaryMode === 'apple-id' ? keychainPath : null,
      notaryProfile,
    });
  } catch (err) {
    primaryError = err;
  } finally {
    const errors = [];
    try {
      if (priorSearchList.length > 0) {
        exec('security', ['list-keychains', '-d', 'user', '-s', ...priorSearchList]);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (exists(keychainPath)) {
      try {
        exec('security', ['delete-keychain', keychainPath]);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (exists(keychainPath)) {
      try {
        rmSync(keychainPath, { force: true });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    try {
      const afterList = parseKeychainSearchList(exec('security', ['list-keychains', '-d', 'user']));
      if (afterList.includes(keychainPath)) {
        errors.push(`Ephemeral Keychain remained in search list: ${keychainPath}`);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (exists(keychainPath)) {
      errors.push(`Ephemeral Keychain file still exists after cleanup: ${keychainPath}`);
    }

    if (errors.length > 0) {
      cleanupError = new Error(`Failed cleaning up ephemeral macOS Keychain: ${errors.join('; ')}`);
      if (primaryError) {
        console.error(`warning: ${cleanupError.message}`);
      }
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  return result;
}

export function buildNotarySubmitArgs({ targetPath, signing, notaryKeychainPath = null, notaryProfile = null }) {
  if (signing.notary.notaryMode === 'api-key') {
    return [
      'notarytool',
      'submit',
      targetPath,
      '--key',
      signing.notary.apiKeyFile,
      '--key-id',
      signing.notary.apiKeyId,
      '--issuer',
      signing.notary.apiIssuerId,
      '--wait',
      '--output-format',
      'json',
    ];
  }
  if (!notaryProfile || !notaryKeychainPath) {
    throw new Error('Missing ephemeral Keychain profile for Apple ID notarization');
  }
  return [
    'notarytool',
    'submit',
    targetPath,
    '--keychain',
    notaryKeychainPath,
    '--keychain-profile',
    notaryProfile,
    '--wait',
    '--output-format',
    'json',
  ];
}

export function buildNotaryLogArgs({ submissionId, signing, notaryKeychainPath = null, notaryProfile = null }) {
  if (signing.notary.notaryMode === 'api-key') {
    return [
      'notarytool',
      'log',
      submissionId,
      '--key',
      signing.notary.apiKeyFile,
      '--key-id',
      signing.notary.apiKeyId,
      '--issuer',
      signing.notary.apiIssuerId,
    ];
  }
  if (!notaryProfile || !notaryKeychainPath) {
    throw new Error('Missing ephemeral Keychain profile for notarization log retrieval');
  }
  return [
    'notarytool',
    'log',
    submissionId,
    '--keychain',
    notaryKeychainPath,
    '--keychain-profile',
    notaryProfile,
  ];
}

function digestSha256(filePath) {
  const buf = readFileSync(filePath);
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    size: statSync(filePath).size,
  };
}

export function createMacReleaseArtifacts({
  archDir,
  arch,
  version,
  signed,
  teamId = null,
  bundleId = APPLE_BUNDLE_ID,
  hardenedRuntime = signed,
  notarized = signed,
}) {
  if (!SUPPORTED_MAC_ARCHES.includes(arch)) {
    throw new Error(`Unsupported macOS architecture: ${String(arch)}`);
  }
  if (!SEMVER_CORE.test(version)) {
    throw new Error(`Invalid version for macOS release artifacts: ${version}`);
  }
  let cleanTeamId = null;
  if (signed) {
    cleanTeamId = teamId ? normalizeAppleTeamId(teamId) : null;
    if (!cleanTeamId) {
      throw new Error('Signed macOS release artifacts require a valid 10-character Apple Team ID');
    }
    if (!hardenedRuntime || !notarized) {
      throw new Error('Signed macOS release artifacts must be both Hardened Runtime signed and notarized');
    }
  }

  const dmgFile = `LudyDesktop-${version}-darwin-${arch}.dmg`;
  const zipFile = `LudyDesktop-${version}-darwin-${arch}.zip`;
  const dmgPath = join(archDir, dmgFile);
  const zipPath = join(archDir, zipFile);
  if (!existsSync(dmgPath) || statSync(dmgPath).size <= 0) {
    throw new Error(`Missing macOS .dmg installer at ${dmgPath}`);
  }
  if (!existsSync(zipPath) || statSync(zipPath).size <= 0) {
    throw new Error(`Missing macOS .zip update archive at ${zipPath}`);
  }

  const dmgDigest = digestSha256(dmgPath);
  const zipDigest = digestSha256(zipPath);

  const manifest = {
    schemaVersion: 1,
    product: 'ludy-desktop',
    platform: 'darwin',
    arch,
    version,
    signed,
    signing: {
      algorithm: 'sha256',
      teamId: signed ? cleanTeamId : null,
      bundleId,
      hardenedRuntime: signed ? true : false,
      notarized: signed ? true : false,
    },
    installer: {
      file: dmgFile,
      sha256: dmgDigest.sha256,
      size: dmgDigest.size,
    },
    packages: [
      {
        file: zipFile,
        kind: 'full',
        version,
        sha256: zipDigest.sha256,
        size: zipDigest.size,
      },
    ],
  };

  const manifestPath = join(archDir, MAC_RELEASE_MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const checksumsPath = writeMacReleaseChecksums(archDir, [dmgFile, zipFile, MAC_RELEASE_MANIFEST_FILENAME]);
  return { manifest, manifestPath, checksumsPath };
}

export function writeMacReleaseChecksums(archDir, files) {
  const checksumLines = files.map((file) => `${digestSha256(join(archDir, file)).sha256}  ${file}`);
  const checksumsPath = join(archDir, MAC_CHECKSUMS_FILENAME);
  writeFileSync(checksumsPath, `${checksumLines.join('\n')}\n`, 'utf8');
  return checksumsPath;
}
