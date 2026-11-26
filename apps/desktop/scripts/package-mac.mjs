// SPDX-License-Identifier: AGPL-3.0-only
// The macOS build (issue #4885): packs Ludy Desktop for darwin-arm64 and darwin-x64 with @electron/packager,
// optionally signs with Developer ID Application + Hardened Runtime + minimal entitlements + Apple timestamp,
// notarizes and staples both the .app (inside .zip for Squirrel.Mac) and .dmg, verifies Gatekeeper acceptance,
// and emits release-manifest.json and SHA256SUMS.txt. Runs on macOS only.
//   node scripts/package-mac.mjs [--version X.Y.Z] [--arch arm64|x64|all] [--sign]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import {
  APPLE_BUNDLE_ID,
  MAC_APP_BUNDLE_NAME,
  normalizeAppleTeamId,
  parseSpctlAssessOutput,
  verifyMacAppBundle,
  verifyMacSignedPackage,
} from '../src/codesign.ts';
import { build } from './build.mjs';
import { isMainEntry } from './build-native.mjs';
import {
  APPLE_HELPER_BUNDLE_ID,
  buildMacExtendInfo,
  buildMacPackagerOsxSign,
  buildNotaryLogArgs,
  buildNotarySubmitArgs,
  createMacReleaseArtifacts,
  parseNotaryToolSubmitResult,
  resolveMacSigningConfig,
  SUPPORTED_MAC_ARCHES,
  withEphemeralMacKeychain,
} from './macos-signing.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export function parseMacPackageArgs(argv = process.argv.slice(2)) {
  let version;
  let archArg;
  let sign = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sign') {
      sign = true;
    } else if (arg === '--version') {
      if (version !== undefined) throw new Error('--version specified multiple times');
      const next = argv[++i];
      if (next === undefined || !/^\d+\.\d+\.\d+$/.test(next)) {
        throw new Error('--version must be X.Y.Z');
      }
      version = next;
    } else if (arg === '--arch') {
      if (archArg !== undefined) throw new Error('--arch specified multiple times');
      const next = argv[++i];
      if (next !== 'arm64' && next !== 'x64' && next !== 'all') {
        throw new Error('--arch must be arm64, x64, or all');
      }
      archArg = next;
    } else {
      throw new Error(`Unknown argument for package-mac.mjs: ${arg}`);
    }
  }
  const arches = archArg === undefined || archArg === 'all' ? [...SUPPORTED_MAC_ARCHES] : [archArg];
  return { version, arches, sign };
}

function runCommand(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function createZipFromApp(appPath, zipPath) {
  rmSync(zipPath, { force: true });
  runCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', MAC_APP_BUNDLE_NAME, zipPath], {
    cwd: dirname(appPath),
  });
}

function createDmgFromApp(appPath, dmgPath, stagingParent) {
  const stageDir = mkdtempSync(join(stagingParent, 'dmg-stage-'));
  try {
    const stagedApp = join(stageDir, MAC_APP_BUNDLE_NAME);
    runCommand('ditto', [appPath, stagedApp]);
    symlinkSync('/Applications', join(stageDir, 'Applications'));
    rmSync(dmgPath, { force: true });
    runCommand('hdiutil', ['create', '-volname', 'Ludy Desktop', '-srcfolder', stageDir, '-ov', '-format', 'UDZO', dmgPath]);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

function notarizeAndWait({ targetPath, signing, notaryKeychainPath, notaryProfile }) {
  const submitArgs = buildNotarySubmitArgs({ targetPath, signing, notaryKeychainPath, notaryProfile });
  const res = spawnSync('xcrun', submitArgs, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const rawOut = (res.stdout || '').trim();
  const rawErr = (res.stderr || '').trim();
  let parsed = null;
  if (rawOut) {
    try {
      parsed = parseNotaryToolSubmitResult(rawOut);
    } catch {
      parsed = null;
    }
  }

  if (res.status === 0 && parsed?.status === 'Accepted') {
    return parsed;
  }

  let logDetail = '';
  if (parsed?.id) {
    const logRes = spawnSync('xcrun', buildNotaryLogArgs({ submissionId: parsed.id, signing, notaryKeychainPath, notaryProfile }), {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const combinedLog = (logRes.stdout || logRes.stderr || '').trim();
    if (combinedLog) logDetail = `\nNotary log (${parsed.id}): ${combinedLog.slice(0, 4000)}`;
  }
  const detail = rawErr || rawOut || `exit ${String(res.status)}`;
  throw new Error(`Apple notarization failed for ${targetPath}: ${detail}${logDetail}`);
}

function stapleAndValidate(targetPath) {
  runCommand('xcrun', ['stapler', 'staple', targetPath]);
  runCommand('xcrun', ['stapler', 'validate', targetPath]);
}

function verifySignedDmg(dmgPath, expectedTeamId) {
  runCommand('codesign', ['--verify', '--verbose=2', dmgPath]);
  const displayRes = spawnSync('codesign', ['--display', '--verbose=4', dmgPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (displayRes.status !== 0) {
    throw new Error(`codesign --display failed for ${dmgPath}: ${(displayRes.stderr || displayRes.stdout || '').trim()}`);
  }
  const displayText = `${displayRes.stdout || ''}\n${displayRes.stderr || ''}`;
  const lines = displayText.replace(/\r?\n/g, '\n').split('\n').map((l) => l.trim());
  const teamLine = lines.find((l) => l.startsWith('TeamIdentifier='));
  const foundTeam = teamLine ? normalizeAppleTeamId(teamLine.slice('TeamIdentifier='.length)) : null;
  const expected = normalizeAppleTeamId(expectedTeamId);
  if (!foundTeam || !expected || foundTeam !== expected) {
    throw new Error(`.dmg TeamIdentifier ${foundTeam ?? 'missing'} does not match expected ${expectedTeamId}`);
  }
  if (!lines.some((l) => l.startsWith('Authority=Developer ID Application:'))) {
    throw new Error(`.dmg signature is missing Developer ID Application authority: ${dmgPath}`);
  }
  if (!lines.some((l) => l.startsWith('Timestamp=') && l.slice('Timestamp='.length).trim().length > 0)) {
    throw new Error(`.dmg signature is missing secure Apple timestamp: ${dmgPath}`);
  }

  runCommand('xcrun', ['stapler', 'validate', dmgPath]);
  const spctlRes = spawnSync('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmgPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (spctlRes.status !== 0) {
    throw new Error(`spctl Gatekeeper check failed for ${dmgPath}: ${(spctlRes.stderr || spctlRes.stdout || '').trim()}`);
  }
  parseSpctlAssessOutput(`${spctlRes.stdout || ''}\n${spctlRes.stderr || ''}`, {
    expectedTeamId,
    requireOrigin: false,
  });
}

if (isMainEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  const { version, arches, sign } = parseMacPackageArgs();
  if (process.platform !== 'darwin') {
    console.error('package-mac.mjs builds macOS .dmg and .zip artifacts and runs on macOS only.');
    process.exit(1);
  }

  // Fail closed immediately when --sign is requested without complete Apple credentials.
  const signing = resolveMacSigningConfig({ sign });
  const built = await build(version);
  const req = createRequire(import.meta.url);
  const electronVersion = req('electron/package.json').version;

  const outRoot = join(root, 'out');
  const packedRoot = join(outRoot, 'pkg-mac');
  const macOutRoot = join(outRoot, 'mac');
  await rm(packedRoot, { recursive: true, force: true });
  await rm(macOutRoot, { recursive: true, force: true });
  await mkdir(macOutRoot, { recursive: true });

  const packageAll = async (ctx) => {
    // Strip raw credential passwords from process.env before spawning Electron Packager / codesign / hdiutil.
    delete process.env.APPLE_CERT_P12_PASSWORD;
    delete process.env.APPLE_APP_SPECIFIC_PASSWORD;

    const osxSign = signing.enabled
      ? buildMacPackagerOsxSign({ identity: ctx.identity, keychainPath: ctx.keychainPath })
      : undefined;

    for (const arch of arches) {
      const [appDirectory] = await packager({
        dir: built.stage,
        out: join(packedRoot, arch),
        name: 'Ludy Desktop',
        executableName: 'Ludy Desktop',
        platform: 'darwin',
        arch,
        electronVersion,
        asar: true,
        overwrite: true,
        appBundleId: APPLE_BUNDLE_ID,
        helperBundleId: APPLE_HELPER_BUNDLE_ID,
        appCategoryType: 'public.app-category.productivity',
        appVersion: built.version,
        buildVersion: built.version,
        appCopyright: 'AGPL-3.0-only',
        darwinDarkModeSupport: true,
        extendInfo: buildMacExtendInfo(),
        ...(osxSign ? { osxSign } : {}),
      });

      const appPath = join(appDirectory, MAC_APP_BUNDLE_NAME);
      if (!existsSync(appPath)) {
        throw new Error(`Expected packed macOS app at ${appPath}`);
      }

      const archDir = join(macOutRoot, `darwin-${arch}`);
      mkdirSync(archDir, { recursive: true });
      const dmgPath = join(archDir, `LudyDesktop-${built.version}-darwin-${arch}.dmg`);
      const zipPath = join(archDir, `LudyDesktop-${built.version}-darwin-${arch}.zip`);

      if (signing.enabled) {
        await verifyMacAppBundle(appPath, {
          expectedTeamId: signing.teamId,
          requireGatekeeper: false,
        });

        const tempAppZip = join(archDir, `.notarize-${arch}.zip`);
        try {
          createZipFromApp(appPath, tempAppZip);
          notarizeAndWait({
            targetPath: tempAppZip,
            signing,
            notaryKeychainPath: ctx.notaryKeychainPath ?? null,
            notaryProfile: ctx.notaryProfile,
          });
        } finally {
          rmSync(tempAppZip, { force: true });
        }

        stapleAndValidate(appPath);
        createZipFromApp(appPath, zipPath);

        createDmgFromApp(appPath, dmgPath, outRoot);
        const dmgSignArgs = ['--force', '--sign', ctx.identity, '--timestamp'];
        if (ctx.keychainPath) dmgSignArgs.push('--keychain', ctx.keychainPath);
        dmgSignArgs.push(dmgPath);
        runCommand('codesign', dmgSignArgs);

        notarizeAndWait({
          targetPath: dmgPath,
          signing,
          notaryKeychainPath: ctx.notaryKeychainPath ?? null,
          notaryProfile: ctx.notaryProfile,
        });
        stapleAndValidate(dmgPath);

        await verifyMacAppBundle(appPath, {
          expectedTeamId: signing.teamId,
          requireGatekeeper: true,
        });
        verifySignedDmg(dmgPath, signing.teamId);
        await verifyMacSignedPackage(zipPath, signing.teamId);
      } else {
        createZipFromApp(appPath, zipPath);
        createDmgFromApp(appPath, dmgPath, outRoot);
      }

      createMacReleaseArtifacts({
        archDir,
        arch,
        version: built.version,
        signed: signing.enabled,
        teamId: signing.enabled ? signing.teamId : null,
        bundleId: APPLE_BUNDLE_ID,
        hardenedRuntime: signing.enabled,
        notarized: signing.enabled,
      });
      console.log(`${signing.enabled ? 'signed+notarized' : 'unsigned'} macOS (${arch}) build ${built.version}: ${archDir}`);
    }
  };

  if (signing.enabled) {
    await withEphemeralMacKeychain({ signing, run: packageAll });
  } else {
    await packageAll({ identity: null, keychainPath: null, notaryKeychainPath: null, notaryProfile: null });
  }
}
