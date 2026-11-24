// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for #4640 & #4691: MSVC hardening flags, cmd.exe metacharacter/control/backslash rejection,
// strict CLI flag parsing, prebuilt PE binary verification, spawn diagnostics, and CI workflow guards.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  assertSafeCmdPath,
  buildCmdLine,
  buildNative,
  findVsDevCmd,
  formatClArgs,
  isMainEntry,
  parseBuildNativeArgs,
} from '../scripts/build-native.mjs';
import { parsePackageArgs, verifyPrebuiltNative } from '../scripts/package.mjs';

const runExecFile = promisify(execFile);

describe('MSVC hardening flags and shell boundary', () => {
  it('includes static CRT /MT, /GS, /sdl, /guard:cf, ASLR/DEP/CFG linker mitigations, and clean .obj /Fo quoting', () => {
    const args = formatClArgs(
      'C:\\Program Files (x86)\\Ludy\\native\\ludy-wasapi-loopback.cpp',
      'C:\\Program Files (x86)\\Ludy\\out\\native\\ludy-wasapi-loopback.exe',
      'C:\\Program Files (x86)\\Ludy\\out\\native',
    );
    expect(args).toContain(' /MT ');
    expect(args).toContain(' /GS ');
    expect(args).toContain(' /sdl ');
    expect(args).toContain(' /guard:cf ');
    expect(args).toContain(' /link /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /GUARD:CF ole32.lib mmdevapi.lib user32.lib');
    expect(args).toMatch(/\/Fo:"[^"]+ludy-wasapi-loopback\.obj"/);
    expect(args).not.toMatch(/\\"/);
  });

  it.each(['"', '%TEMP%', '\0', '\x01', '\t', '\n', '\r', '\x1b', '\x1f', '\x7f', '^', '&', '|', '<', '>', '!'])(
    'rejects cmd.exe metacharacter or control character %j in paths',
    (bad) => {
      const poisoned = `C:\\repo\\path${bad}evil`;
      expect(() => assertSafeCmdPath('test path', poisoned)).toThrow(/unsafe cmd\.exe metacharacters/);
      expect(() => formatClArgs(poisoned, 'C:\\out\\a.exe', 'C:\\out')).toThrow(/unsafe cmd\.exe metacharacters/);
      expect(() => formatClArgs('C:\\in\\a.cpp', poisoned, 'C:\\out')).toThrow(/unsafe cmd\.exe metacharacters/);
      expect(() => formatClArgs('C:\\in\\a.cpp', 'C:\\out\\a.exe', poisoned)).toThrow(/unsafe cmd\.exe metacharacters/);
      expect(() => buildCmdLine('/nologo', poisoned)).toThrow(/unsafe cmd\.exe metacharacters/);
    },
  );

  it('rejects trailing backslashes so CRT quote-escaping cannot occur', () => {
    for (const trailing of ['C:\\repo\\path\\', '\\']) {
      expect(() => assertSafeCmdPath('test path', trailing)).toThrow(/trailing backslash/);
      expect(() => formatClArgs(trailing, 'C:\\out\\a.exe', 'C:\\out')).toThrow(/trailing backslash/);
      expect(() => formatClArgs('C:\\in\\a.cpp', trailing, 'C:\\out')).toThrow(/trailing backslash/);
      expect(() => formatClArgs('C:\\in\\a.cpp', 'C:\\out\\a.exe', trailing)).toThrow(/trailing backslash/);
      expect(() => buildCmdLine('/nologo', trailing)).toThrow(/trailing backslash/);
    }
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

describe('CI desktop-build deduplication, CLI flag validation, and binary verification', () => {
  it('rejects unknown CLI flags in build-native.mjs and accepts --require-win32 / --print-cl-args', async () => {
    expect(parseBuildNativeArgs([])).toEqual({ requireWin32: false, printClArgs: false });
    expect(parseBuildNativeArgs(['--require-win32'])).toEqual({ requireWin32: true, printClArgs: false });
    expect(parseBuildNativeArgs(['--print-cl-args'])).toEqual({ requireWin32: false, printClArgs: true });
    for (const badArgs of [['--require-win32x'], ['--unknown'], ['positional'], ['--print-cl-args', '--bogus']]) {
      expect(() => parseBuildNativeArgs(badArgs)).toThrow(/Unknown argument for build-native\.mjs/);
    }

    const script = fileURLToPath(new URL('../scripts/build-native.mjs', import.meta.url));
    await expect(runExecFile(process.execPath, [script, '--require-win32x'])).rejects.toThrow(/Unknown argument for build-native\.mjs/);
  });

  it('rejects unknown CLI flags and invalid --version in package.mjs', async () => {
    expect(parsePackageArgs([])).toEqual({ version: undefined, skipNative: false });
    expect(parsePackageArgs(['--skip-native'])).toEqual({ version: undefined, skipNative: true });
    expect(parsePackageArgs(['--version', '0.1.0'])).toEqual({ version: '0.1.0', skipNative: false });
    expect(parsePackageArgs(['--skip-native', '--version', '1.2.3'])).toEqual({ version: '1.2.3', skipNative: true });

    for (const badArgs of [['--skip-nativex'], ['--unknown'], ['positional'], ['--skip-native', '--bogus']]) {
      expect(() => parsePackageArgs(badArgs)).toThrow(/Unknown argument for package\.mjs/);
    }
    for (const badVersion of [['--version'], ['--version', '--skip-native'], ['--version', '0.1']]) {
      expect(() => parsePackageArgs(badVersion)).toThrow(/--version must be X\.Y\.Z/);
    }
    expect(() => parsePackageArgs(['--version', '0.1.0', '--version', '0.1.1'])).toThrow(/multiple times/);

    const script = fileURLToPath(new URL('../scripts/package.mjs', import.meta.url));
    await expect(runExecFile(process.execPath, [script, '--skip-nativex'])).rejects.toThrow(/Unknown argument for package\.mjs/);
  });

  it('verifies prebuilt native helper is a non-empty file starting with PE MZ magic bytes under --skip-native', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ludy-prebuilt-check-'));
    try {
      expect(() => verifyPrebuiltNative(join(dir, 'missing.exe'))).toThrow(/expected prebuilt native helper/);

      const subdir = join(dir, 'subdir');
      mkdirSync(subdir);
      expect(() => verifyPrebuiltNative(subdir)).toThrow(/not a non-empty file/);

      const emptyFile = join(dir, 'empty.exe');
      writeFileSync(emptyFile, Buffer.alloc(0));
      expect(() => verifyPrebuiltNative(emptyFile)).toThrow(/not a non-empty file/);

      const oneByte = join(dir, 'one-byte.exe');
      writeFileSync(oneByte, Buffer.from([0x4d]));
      expect(() => verifyPrebuiltNative(oneByte)).toThrow(/lacks PE MZ header/);

      const badMagic = join(dir, 'not-pe.exe');
      writeFileSync(badMagic, Buffer.from('\x7fELF'));
      expect(() => verifyPrebuiltNative(badMagic)).toThrow(/lacks PE MZ header/);

      const validPe = join(dir, 'ludy-wasapi-loopback.exe');
      writeFileSync(validPe, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
      expect(() => verifyPrebuiltNative(validPe)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compiles native helper once in workflow, passes --skip-native to package.mjs, and verifies non-empty unpacked bin exe', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../../../.github/workflows/desktop-build.yml', import.meta.url)), 'utf8');
    const pkgScript = readFileSync(fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), 'utf8');

    expect(workflow).toContain('node apps/desktop/scripts/build-native.mjs --require-win32');
    expect(workflow).toContain('node apps/desktop/scripts/package.mjs --skip-native');
    expect(workflow).toContain('$exe = "$out/pkg/ludy-desktop-win32-x64/resources/app.asar.unpacked/bin/ludy-wasapi-loopback.exe"');
    expect(workflow).toContain('Test-Path -PathType Leaf "$exe"');
    expect(workflow).toContain('(Get-Item "$exe").Length -gt 0');
    expect(pkgScript).toContain('parsePackageArgs');
    expect(pkgScript).toContain('verifyPrebuiltNative');
  });
});
