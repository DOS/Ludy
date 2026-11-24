// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for #4640: MSVC hardening flags, cmd.exe metacharacter rejection, spawn error diagnostics,
// case-insensitive win32 CLI entrypoint detection, and CI native compile deduplication checks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertSafeCmdPath,
  buildCmdLine,
  buildNative,
  findVsDevCmd,
  formatClArgs,
  isMainEntry,
} from '../scripts/build-native.mjs';

describe('MSVC hardening flags and shell boundary', () => {
  it('includes static CRT /MT, /GS, ASLR/DEP linker mitigations, and clean .obj /Fo quoting', () => {
    const args = formatClArgs(
      'C:\\Program Files (x86)\\Ludy\\native\\ludy-wasapi-loopback.cpp',
      'C:\\Program Files (x86)\\Ludy\\out\\native\\ludy-wasapi-loopback.exe',
      'C:\\Program Files (x86)\\Ludy\\out\\native',
    );
    expect(args).toContain(' /MT ');
    expect(args).toContain(' /GS ');
    expect(args).toContain(' /link /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT ole32.lib mmdevapi.lib user32.lib');
    expect(args).toMatch(/\/Fo:"[^"]+ludy-wasapi-loopback\.obj"/);
    expect(args).not.toMatch(/\\"/);
  });

  it.each(['"', '%TEMP%', '\r', '\n', '\0', '^', '&', '|', '<', '>', '!'])('rejects cmd.exe metacharacter %j in paths', (bad) => {
    const poisoned = `C:\\repo\\path${bad}evil`;
    expect(() => assertSafeCmdPath('test path', poisoned)).toThrow(/unsafe cmd\.exe metacharacters/);
    expect(() => formatClArgs(poisoned, 'C:\\out\\a.exe', 'C:\\out')).toThrow(/unsafe cmd\.exe metacharacters/);
    expect(() => formatClArgs('C:\\in\\a.cpp', poisoned, 'C:\\out')).toThrow(/unsafe cmd\.exe metacharacters/);
    expect(() => formatClArgs('C:\\in\\a.cpp', 'C:\\out\\a.exe', poisoned)).toThrow(/unsafe cmd\.exe metacharacters/);
    expect(() => buildCmdLine('/nologo', poisoned)).toThrow(/unsafe cmd\.exe metacharacters/);
  });

  it('rejects empty or non-string paths cleanly', () => {
    expect(() => assertSafeCmdPath('empty path', '')).toThrow(/expected non-empty path/);
    expect(() => assertSafeCmdPath('bad type', null as unknown as string)).toThrow(/expected non-empty path/);
  });

  it('builds safe command lines with and without vcvars64.bat', () => {
    const args = formatClArgs('C:\\src\\a.cpp', 'C:\\out\\a.exe', 'C:\\out');
    expect(buildCmdLine(args, null)).toBe(`cl.exe ${args}`);
    expect(buildCmdLine(args, 'C:\\VS\\vcvars64.bat')).toBe(`call "C:\\VS\\vcvars64.bat" >nul && cl.exe ${args}`);
  });
});

describe('buildNative diagnostics and Windows entrypoint handling', () => {
  it('blocks cmd.exe invocation if vswhere returns a vcvars path with metacharacters', async () => {
    let spawnedCmd = false;
    let wipedOutDir = false;
    const vswhere = join('C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    await expect(
      buildNative({
        platform: 'win32',
        env: {},
        exists: (p) => p === vswhere || p.includes('vcvars64.bat'),
        runSpawn: (cmd) => {
          if (cmd === vswhere) {
            return { status: 0, stdout: 'C:\\VS&calc.exe\r\n', stderr: '' };
          }
          spawnedCmd = true;
          return { status: 0, stdout: '', stderr: '' };
        },
        rmImpl: async () => {
          wipedOutDir = true;
        },
        mkdirImpl: async () => undefined,
      }),
    ).rejects.toThrow(/unsafe cmd\.exe metacharacters/);
    expect(spawnedCmd).toBe(false);
    expect(wipedOutDir).toBe(false);
  });

  it('surfaces res.error.message when spawnSync exits with status null and reports exit codes otherwise', async () => {
    await expect(
      buildNative({
        platform: 'win32',
        env: { VCToolsInstallDir: 'C:\\VS\\Tools\\' },
        exists: () => true,
        runSpawn: () => ({
          status: null,
          error: new Error('spawn cmd.exe ENOENT'),
        }),
        rmImpl: async () => undefined,
        mkdirImpl: async () => undefined,
      }),
    ).rejects.toThrow(/spawn cmd\.exe ENOENT/);

    await expect(
      buildNative({
        platform: 'win32',
        env: { VCToolsInstallDir: 'C:\\VS\\Tools\\' },
        exists: () => true,
        runSpawn: () => ({ status: 2 }),
        rmImpl: async () => undefined,
        mkdirImpl: async () => undefined,
      }),
    ).rejects.toThrow(/exit 2/);
  });

  it('succeeds cleanly on mocked win32 compile when output binary exists', async () => {
    const outExe = 'C:\\Ludy\\apps\\desktop\\out\\native\\ludy-wasapi-loopback.exe';
    const done = await buildNative({
      platform: 'win32',
      env: { VCToolsInstallDir: 'C:\\VS\\Tools\\' },
      srcPath: 'C:\\Ludy\\apps\\desktop\\native\\ludy-wasapi-loopback.cpp',
      outExe,
      objDir: 'C:\\Ludy\\apps\\desktop\\out\\native',
      exists: (p) => p === outExe,
      runSpawn: () => ({ status: 0 }),
      rmImpl: async () => undefined,
      mkdirImpl: async () => undefined,
    });
    expect(done).toEqual({ compiled: true, skipped: false, output: outExe });
  });

  it('detects findVsDevCmd cleanly when VCToolsInstallDir is unset', () => {
    const vswhere = join('C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const vcvars = join('C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise', 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    const found = findVsDevCmd(
      { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      (p) => p === vswhere || p === vcvars,
      () => ({
        status: 0,
        stdout: 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\r\n',
      }),
    );
    expect(found).toBe(vcvars);
  });

  it('compares Windows CLI entrypoint paths case-insensitively on win32 and strictly elsewhere', () => {
    const selfWin = 'C:\\Users\\Runner\\Ludy\\apps\\desktop\\scripts\\build-native.mjs';
    expect(isMainEntry('c:\\users\\runner\\ludy\\apps\\desktop\\scripts\\build-native.mjs', selfWin, 'win32')).toBe(true);
    expect(isMainEntry('c:/Users/Runner/Ludy/apps/desktop/scripts/build-native.mjs', selfWin, 'win32')).toBe(true);
    expect(isMainEntry('c:\\users\\runner\\ludy\\apps\\desktop\\scripts\\other.mjs', selfWin, 'win32')).toBe(false);
    expect(isMainEntry(undefined, selfWin, 'win32')).toBe(false);

    const selfPosix = '/repo/apps/desktop/scripts/build-native.mjs';
    expect(isMainEntry('/repo/apps/desktop/scripts/build-native.mjs', selfPosix, 'linux')).toBe(true);
    expect(isMainEntry('/Repo/apps/desktop/scripts/build-native.mjs', selfPosix, 'linux')).toBe(false);
  });
});

describe('CI desktop-build deduplication and unpacked binary verification', () => {
  it('compiles native helper once in workflow, passes --skip-native to package.mjs, and verifies app.asar.unpacked/bin exe', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../../../.github/workflows/desktop-build.yml', import.meta.url)), 'utf8');
    const pkgScript = readFileSync(fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), 'utf8');

    expect(workflow).toContain('node apps/desktop/scripts/build-native.mjs --require-win32');
    expect(workflow).toContain('node apps/desktop/scripts/package.mjs --skip-native');
    expect(workflow).toContain('Test-Path "$out/pkg/ludy-desktop-win32-x64/resources/app.asar.unpacked/bin/ludy-wasapi-loopback.exe"');
    expect(pkgScript).toContain("process.argv.includes('--skip-native')");
  });
});
