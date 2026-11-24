// SPDX-License-Identifier: AGPL-3.0-only
// Compiles the small Win32 WASAPI per-app loopback helper (native/ludy-wasapi-loopback.cpp -> out/native/ludy-wasapi-loopback.exe)
// using MSVC (cl.exe) and the Windows SDK on win32 runners. Skips cleanly on non-Windows developer hosts unless --require-win32 is set.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'native', 'ludy-wasapi-loopback.cpp');
const outDir = join(root, 'out', 'native');
const output = join(outDir, 'ludy-wasapi-loopback.exe');

export function findVsDevCmd(env = process.env, exists = existsSync) {
  if (env.VCToolsInstallDir) return null;
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!exists(vswhere)) return null;
  const probe = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) return null;
  const vsPath = probe.stdout.trim().split(/\r?\n/)[0]?.trim();
  if (!vsPath) return null;
  const vcvars = join(vsPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return exists(vcvars) ? vcvars : null;
}

export function formatClArgs(srcPath = source, outExe = output, objDir = outDir) {
  const objFile = join(objDir, 'ludy-wasapi-loopback.obj');
  return `/nologo /EHsc /O2 /std:c++17 /W3 /DUNICODE /D_UNICODE "${srcPath}" /Fe:"${outExe}" /Fo:"${objFile}" /link ole32.lib mmdevapi.lib user32.lib`;
}

export async function buildNative({ requireWin32 = false } = {}) {
  if (process.platform !== 'win32') {
    if (requireWin32) {
      throw new Error('build-native.mjs requires win32 to compile ludy-wasapi-loopback.exe');
    }
    return { compiled: false, skipped: true, output: null };
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const clArgs = formatClArgs();
  const vcvars = findVsDevCmd();
  const cmdLine = vcvars ? `call "${vcvars}" >nul && cl.exe ${clArgs}` : `cl.exe ${clArgs}`;
  const res = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], { windowsVerbatimArguments: true, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`cl.exe failed compiling ${source} (exit ${String(res.status)})`);
  }
  if (!existsSync(output)) {
    throw new Error(`expected native helper at ${output}`);
  }
  return { compiled: true, skipped: false, output };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--print-cl-args')) {
    console.log(formatClArgs());
    process.exit(0);
  }
  const requireWin32 = process.argv.includes('--require-win32');
  const result = await buildNative({ requireWin32 });
  if (result.skipped) {
    console.log(`skipped native helper build on ${process.platform} (win32 only)`);
  } else {
    console.log(`built native helper: ${result.output}`);
  }
}
