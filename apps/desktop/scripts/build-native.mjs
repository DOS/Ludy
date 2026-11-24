// SPDX-License-Identifier: AGPL-3.0-only
// Compiles the small Win32 WASAPI per-app loopback helper (native/ludy-wasapi-loopback.cpp -> out/native/ludy-wasapi-loopback.exe)
// using MSVC (cl.exe) and the Windows SDK on win32 runners. Skips cleanly on non-Windows developer hosts unless --require-win32 is set.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'native', 'ludy-wasapi-loopback.cpp');
const outDir = join(root, 'out', 'native');
const output = join(outDir, 'ludy-wasapi-loopback.exe');
const UNSAFE_CMD_CHARS = /["%\r\n\0^&|<>!]/;

export function assertSafeCmdPath(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${label}: expected non-empty path`);
  }
  if (UNSAFE_CMD_CHARS.test(value)) {
    throw new Error(`Refused ${label}: contains unsafe cmd.exe metacharacters`);
  }
  return value;
}

export function findVsDevCmd(env = process.env, exists = existsSync, runSpawn = spawnSync) {
  if (env.VCToolsInstallDir) return null;
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!exists(vswhere)) return null;
  const probe = runSpawn(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) return null;
  const vsPath = probe.stdout.trim().split(/\r?\n/)[0]?.trim();
  if (!vsPath) return null;
  const vcvars = join(vsPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return exists(vcvars) ? vcvars : null;
}

export function formatClArgs(srcPath = source, outExe = output, objDir = outDir) {
  assertSafeCmdPath('MSVC source path', srcPath);
  assertSafeCmdPath('MSVC output path', outExe);
  assertSafeCmdPath('MSVC object directory', objDir);
  const objFile = join(objDir, 'ludy-wasapi-loopback.obj');
  assertSafeCmdPath('MSVC object path', objFile);
  return `/nologo /EHsc /O2 /MT /GS /std:c++17 /W3 /DUNICODE /D_UNICODE "${srcPath}" /Fe:"${outExe}" /Fo:"${objFile}" /link /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT ole32.lib mmdevapi.lib user32.lib`;
}

export function buildCmdLine(clArgs, vcvars = null) {
  if (vcvars !== null && vcvars !== undefined) {
    assertSafeCmdPath('vcvars64.bat path', vcvars);
    return `call "${vcvars}" >nul && cl.exe ${clArgs}`;
  }
  return `cl.exe ${clArgs}`;
}

export function isMainEntry(argv1, selfPath = fileURLToPath(import.meta.url), platform = process.platform) {
  if (!argv1) return false;
  if (platform === 'win32') {
    return win32Path.normalize(argv1).toLowerCase() === win32Path.normalize(selfPath).toLowerCase();
  }
  return argv1 === selfPath;
}

export async function buildNative({
  requireWin32 = false,
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  runSpawn = spawnSync,
  mkdirImpl = mkdir,
  rmImpl = rm,
  srcPath = source,
  outExe = output,
  objDir = outDir,
} = {}) {
  if (platform !== 'win32') {
    if (requireWin32) {
      throw new Error('build-native.mjs requires win32 to compile ludy-wasapi-loopback.exe');
    }
    return { compiled: false, skipped: true, output: null };
  }
  const clArgs = formatClArgs(srcPath, outExe, objDir);
  const vcvars = findVsDevCmd(env, exists, runSpawn);
  const cmdLine = buildCmdLine(clArgs, vcvars);
  await rmImpl(objDir, { recursive: true, force: true });
  await mkdirImpl(objDir, { recursive: true });
  const res = runSpawn('cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], { windowsVerbatimArguments: true, stdio: 'inherit' });
  if (res.status !== 0) {
    const detail = res.status === null && res.error ? res.error.message : `exit ${String(res.status)}`;
    throw new Error(`cl.exe failed compiling ${srcPath} (${detail})`);
  }
  if (!exists(outExe)) {
    throw new Error(`expected native helper at ${outExe}`);
  }
  return { compiled: true, skipped: false, output: outExe };
}

if (isMainEntry(process.argv[1])) {
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
