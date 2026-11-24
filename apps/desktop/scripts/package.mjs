// SPDX-License-Identifier: AGPL-3.0-only
// The UNSIGNED Windows build (issue #4515): packs the app with @electron/packager, then makes the Squirrel.Windows installer, the
// full nupkg and the RELEASES file with electron-winstaller. It runs in CI on a Windows runner (.github/workflows/desktop-build.yml)
// and refuses anywhere else: Squirrel needs Windows, and a build is never made on a shared developer machine.
// No certificate, no signing step, no publishing: the output is a development build, and Windows will warn about it.
//   node scripts/package.mjs [--version X.Y.Z] [--skip-native]
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { createWindowsInstaller } from 'electron-winstaller';
import { build } from './build.mjs';
import { buildNative, isMainEntry } from './build-native.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export function parsePackageArgs(argv = process.argv.slice(2)) {
  let version;
  let skipNative = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--skip-native') {
      skipNative = true;
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
  return { version, skipNative };
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

if (isMainEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  const { version, skipNative } = parsePackageArgs();
  if (process.platform !== 'win32') {
    console.error('package.mjs builds the Squirrel.Windows installer and runs on Windows (in CI) only.');
    process.exit(1);
  }

  if (skipNative) {
    verifyPrebuiltNative(join(root, 'out', 'native', 'ludy-wasapi-loopback.exe'));
  } else {
    await buildNative({ requireWin32: true });
  }
  const built = await build(version);
  const electronVersion = createRequire(import.meta.url)('electron/package.json').version;

  const packed = join(root, 'out', 'pkg');
  const installer = join(root, 'out', 'installer');
  await rm(packed, { recursive: true, force: true });
  await rm(installer, { recursive: true, force: true });

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
  });

  await createWindowsInstaller({
    appDirectory,
    outputDirectory: installer,
    name: 'LudyDesktop',
    title: 'Ludy Desktop',
    authors: 'Ludy',
    exe: 'ludy-desktop.exe',
    description: 'Ludy Desktop',
    setupExe: 'LudyDesktop-Setup.exe',
    noMsi: true,
  });
  console.log(`unsigned Squirrel.Windows build ${built.version}: ${installer}`);
}
