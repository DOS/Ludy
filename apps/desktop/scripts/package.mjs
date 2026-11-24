// SPDX-License-Identifier: AGPL-3.0-only
// The UNSIGNED Windows build (issue #4515): packs the app with @electron/packager, then makes the Squirrel.Windows installer, the
// full nupkg and the RELEASES file with electron-winstaller. It runs in CI on a Windows runner (.github/workflows/desktop-build.yml)
// and refuses anywhere else: Squirrel needs Windows, and a build is never made on a shared developer machine.
// No certificate, no signing step, no publishing: the output is a development build, and Windows will warn about it.
//   node scripts/package.mjs [--version X.Y.Z]
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { createWindowsInstaller } from 'electron-winstaller';
import { build } from './build.mjs';
import { buildNative } from './build-native.mjs';

if (process.platform !== 'win32') {
  console.error('package.mjs builds the Squirrel.Windows installer and runs on Windows (in CI) only.');
  process.exit(1);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const at = process.argv.indexOf('--version');
const version = at === -1 ? undefined : process.argv[at + 1];
if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('--version must be X.Y.Z');
if (process.argv.includes('--skip-native')) {
  const prebuilt = join(root, 'out', 'native', 'ludy-wasapi-loopback.exe');
  if (!existsSync(prebuilt)) {
    throw new Error(`--skip-native passed, but expected prebuilt native helper at ${prebuilt}`);
  }
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
