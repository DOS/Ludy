// SPDX-License-Identifier: AGPL-3.0-only
// The Windows build (issues #4515 and #4884): packs the app with @electron/packager, then builds the Squirrel.Windows
// installer, full nupkg, RELEASES, release-manifest.json and SHA256SUMS.txt. Runs on Windows (in CI) only.
//   node scripts/package.mjs [--version X.Y.Z] [--skip-native] [--sign]
// Without --sign, produces an unsigned build (for CI PR checks and smoke runs). With --sign, requires operator-supplied
// Windows signing credentials in env, signs the app, native helper, Update.exe and Setup.exe, and verifies Authenticode
// signatures + RFC 3161 timestamps before finishing (failing closed on missing credentials or invalid signatures).
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packager } from '@electron/packager';
import { createWindowsInstaller } from 'electron-winstaller';
import {
  formatSignedReleaseManifestScript,
  RELEASE_MANIFEST_SCRIPT_FILENAME,
  verifyWindowsAuthenticodeFiles,
  verifyWindowsSignedManifest,
  verifyWindowsSignedPackage,
} from '../src/authenticode.ts';
import { build } from './build.mjs';
import { buildNative, isMainEntry } from './build-native.mjs';
import {
  buildPackagerWindowsSign,
  buildWinstallerSignOptions,
  createReleaseArtifacts,
  extractSigntoolDigestAlgorithm,
  resolveSigningConfig,
  writeReleaseChecksums,
} from './signing.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export function parsePackageArgs(argv = process.argv.slice(2)) {
  let version;
  let skipNative = false;
  let sign = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--skip-native') {
      skipNative = true;
    } else if (arg === '--sign') {
      sign = true;
    } else if (arg === '--version') {
      if (version !== undefined) throw new Error('--version specified multiple times');
      const next = argv[++i];
      if (next === undefined || !/^\d+\.\d+\.\d+$/.test(next)) {
        throw new Error('--version must be X.Y.Z');
      }
      version = next;
    } else {
      throw new Error(`Unknown argument for package.mjs: ${arg}`);
    }
  }
  return { version, skipNative, sign };
}

export function verifyPrebuiltNative(prebuilt) {
  if (!existsSync(prebuilt)) {
    throw new Error(`--skip-native passed, but expected prebuilt native helper at ${prebuilt}`);
  }
  const stat = statSync(prebuilt);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`--skip-native passed, but prebuilt native helper is not a non-empty file: ${prebuilt}`);
  }
  const header = Buffer.alloc(2);
  const fd = openSync(prebuilt, 'r');
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, header, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  if (bytesRead < 2 || header[0] !== 0x4d || header[1] !== 0x5a) {
    throw new Error(`--skip-native passed, but prebuilt native helper lacks PE MZ header: ${prebuilt}`);
  }
}

const SHA1_HEX = /^[0-9a-fA-F]{40}$/;

export function resolveBundledModernSigntool(req = createRequire(import.meta.url)) {
  const packagerEntry = req.resolve('@electron/packager');
  const packagerReq = createRequire(packagerEntry);
  const windowsSignEntry = packagerReq.resolve('@electron/windows-sign');
  return join(dirname(dirname(windowsSignEntry)), 'vendor', 'signtool.exe');
}

function importEphemeralPfx(pfxFile) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$secure = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force',
    '$pfxCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:LUDY_PFX_FILE, $secure)',
    'if (-not $pfxCert.Thumbprint) { throw "PFX certificate has no thumbprint" }',
    '$existingStorePath = "Cert:\\CurrentUser\\My\\$($pfxCert.Thumbprint)"',
    'if (Test-Path -LiteralPath $existingStorePath) {',
    '  throw "Certificate $($pfxCert.Thumbprint) already exists in Cert:\\CurrentUser\\My; refusing to overwrite or delete pre-existing store entry. Pass WINDOWS_CERT_SHA1 instead."',
    '}',
    "$cert = Import-PfxCertificate -FilePath $env:LUDY_PFX_FILE -CertStoreLocation 'Cert:\\CurrentUser\\My' -Password $secure",
    'if (-not $cert.Thumbprint) { throw "Imported PFX certificate has no thumbprint" }',
    'Write-Output $cert.Thumbprint',
  ].join('\n');
  const thumb = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LUDY_PFX_FILE: pfxFile },
  }).trim();
  if (!SHA1_HEX.test(thumb)) {
    throw new Error('Imported PFX certificate returned an invalid thumbprint');
  }
  return thumb.toUpperCase();
}

function removeEphemeralCert(thumbprint) {
  if (!thumbprint || !SHA1_HEX.test(thumbprint)) return;
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'if ($env:LUDY_CERT_THUMBPRINT -match "^[0-9a-fA-F]{40}$") {',
    '  $storePath = "Cert:\\CurrentUser\\My\\$($env:LUDY_CERT_THUMBPRINT)"',
    '  if (Test-Path -LiteralPath $storePath) { Remove-Item -LiteralPath $storePath -DeleteKey }',
    '}',
  ].join('\n');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LUDY_CERT_THUMBPRINT: thumbprint },
  });
}

async function prepareSquirrelVendor(req, stagingParent, signing) {
  const winstallerVendor = join(dirname(req.resolve('electron-winstaller/package.json')), 'vendor');
  const vendorDir = join(stagingParent, 'squirrel-vendor');
  await rm(vendorDir, { recursive: true, force: true });
  await mkdir(vendorDir, { recursive: true });
  await cp(winstallerVendor, vendorDir, { recursive: true });

  const sevenZipExe = join(vendorDir, '7z.exe');
  const sevenZipDll = join(vendorDir, '7z.dll');
  if (!existsSync(sevenZipExe)) copyFileSync(join(vendorDir, '7z-x64.exe'), sevenZipExe);
  if (!existsSync(sevenZipDll)) copyFileSync(join(vendorDir, '7z-x64.dll'), sevenZipDll);

  let signtoolPath = null;
  if (signing.enabled) {
    const signtoolSrc = signing.signtoolPath ?? resolveBundledModernSigntool(req);
    signtoolPath = join(vendorDir, 'signtool.exe');
    copyFileSync(signtoolSrc, signtoolPath);
  }
  return { vendorDir, signtoolPath };
}

async function verifySignedInstallerOutputs(installerDir, appDirectory, signtoolExePath) {
  const setupExe = join(installerDir, 'LudyDesktop-Setup.exe');
  const packedAppExe = join(appDirectory, 'ludy-desktop.exe');
  const packedNativeExe = join(appDirectory, 'resources', 'app.asar.unpacked', 'bin', 'ludy-wasapi-loopback.exe');
  const fullNupkgName = readdirSync(installerDir).find((name) => name.endsWith('-full.nupkg'));
  if (!fullNupkgName) throw new Error(`Missing *-full.nupkg in ${installerDir}`);
  const fullNupkgPath = join(installerDir, fullNupkgName);

  const peTargets = [setupExe, packedAppExe, packedNativeExe];
  const verified = await verifyWindowsAuthenticodeFiles(peTargets);
  for (const target of peTargets) {
    const signtoolOut = execFileSync(signtoolExePath, ['verify', '/pa', '/v', target], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    extractSigntoolDigestAlgorithm(signtoolOut);
  }
  await verifyWindowsSignedPackage(fullNupkgPath, verified.thumbprint);
  return verified;
}

if (isMainEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  const { version, skipNative, sign } = parsePackageArgs();
  if (process.platform !== 'win32') {
    console.error('package.mjs builds the Squirrel.Windows installer and runs on Windows (in CI) only.');
    process.exit(1);
  }

  // Fail closed immediately when --sign is passed without valid signing credentials.
  const signing = resolveSigningConfig({ sign });

  if (skipNative) {
    verifyPrebuiltNative(join(root, 'out', 'native', 'ludy-wasapi-loopback.exe'));
  } else {
    await buildNative({ requireWin32: true });
  }
  const built = await build(version);
  const req = createRequire(import.meta.url);
  const electronVersion = req('electron/package.json').version;

  const outRoot = join(root, 'out');
  const packed = join(outRoot, 'pkg');
  const installer = join(outRoot, 'installer');
  await rm(packed, { recursive: true, force: true });
  await rm(installer, { recursive: true, force: true });

  let ephemeralThumbprint = null;
  let effectiveSigning = signing;
  try {
    if (signing.enabled && signing.mode === 'pfx') {
      ephemeralThumbprint = importEphemeralPfx(signing.certificateFile);
      // Remove PFX path/password from process.env immediately so @electron/windows-sign uses only the store thumbprint.
      delete process.env.WINDOWS_CERTIFICATE_FILE;
      delete process.env.WINDOWS_CERTIFICATE_PASSWORD;
      effectiveSigning = {
        enabled: true,
        mode: 'thumbprint',
        thumbprint: ephemeralThumbprint,
        timestampServer: signing.timestampServer,
        signtoolPath: signing.signtoolPath,
        signWithParams: ['/fd', 'sha256', '/tr', signing.timestampServer, '/td', 'sha256', '/sha1', ephemeralThumbprint],
      };
    }

    const { vendorDir, signtoolPath } = await prepareSquirrelVendor(req, outRoot, effectiveSigning);
    try {
      const windowsSign = buildPackagerWindowsSign(effectiveSigning);
      const [appDirectory] = await packager({
        dir: built.stage,
        out: packed,
        name: 'ludy-desktop',
        executableName: 'ludy-desktop',
        platform: 'win32',
        arch: 'x64',
        electronVersion,
        asar: { unpackDir: 'bin' },
        overwrite: true,
        appVersion: built.version,
        appCopyright: 'AGPL-3.0-only',
        win32metadata: {
          CompanyName: 'Ludy',
          FileDescription: 'Ludy Desktop',
          InternalName: 'ludy-desktop',
          OriginalFilename: 'ludy-desktop.exe',
          ProductName: 'Ludy Desktop',
        },
        ...(windowsSign ? { windowsSign } : {}),
      });

      const winstallerSignOptions = buildWinstallerSignOptions(effectiveSigning);
      await createWindowsInstaller({
        appDirectory,
        outputDirectory: installer,
        vendorDirectory: vendorDir,
        name: 'LudyDesktop',
        title: 'Ludy Desktop',
        authors: 'Ludy',
        exe: 'ludy-desktop.exe',
        description: 'Ludy Desktop',
        setupExe: 'LudyDesktop-Setup.exe',
        noMsi: true,
        ...winstallerSignOptions,
      });

      let publisherThumbprint = null;
      if (effectiveSigning.enabled) {
        if (!signtoolPath) throw new Error('Expected signtool.exe in Squirrel vendor directory for signature verification');
        const verified = await verifySignedInstallerOutputs(installer, appDirectory, signtoolPath);
        publisherThumbprint = verified.thumbprint;
      }

      const artifacts = createReleaseArtifacts({
        installerDir: installer,
        version: built.version,
        signed: effectiveSigning.enabled,
        timestampServer: effectiveSigning.enabled ? effectiveSigning.timestampServer : null,
        publisherThumbprint,
      });
      if (effectiveSigning.enabled && publisherThumbprint && windowsSign) {
        const manifestPs1Path = join(installer, RELEASE_MANIFEST_SCRIPT_FILENAME);
        const manifestRaw = readFileSync(artifacts.manifestPath, 'utf8');
        writeFileSync(manifestPs1Path, `\uFEFF${formatSignedReleaseManifestScript(manifestRaw)}`, 'utf8');
        const packagerReq = createRequire(req.resolve('@electron/packager'));
        const { sign: signWindowsFiles } = await import(pathToFileURL(packagerReq.resolve('@electron/windows-sign')).href);
        await signWindowsFiles({ ...windowsSign, files: [manifestPs1Path] });
        await verifyWindowsSignedManifest(manifestPs1Path, Buffer.from(manifestRaw, 'utf8'), publisherThumbprint);
        writeReleaseChecksums(installer);
      }
      console.log(`${effectiveSigning.enabled ? 'signed' : 'unsigned'} Squirrel.Windows build ${built.version}: ${installer}`);
    } finally {
      await rm(vendorDir, { recursive: true, force: true });
    }
  } finally {
    if (ephemeralThumbprint) {
      try {
        removeEphemeralCert(ephemeralThumbprint);
      } catch (cleanupError) {
        console.error(`warning: failed removing ephemeral certificate from store: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
  }
}
