// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { handleSquirrelStartup, squirrelCommand } from '../src/squirrel.ts';

const EXEC = 'C:\\Users\\a\\AppData\\Local\\LudyDesktop\\app-0.1.0\\ludy-desktop.exe';

async function run(flag: string | undefined, platform = 'win32') {
  const calls: Array<[string, string[]]> = [];
  const quit = await handleSquirrelStartup(['x', ...(flag ? [flag] : [])], { platform, execPath: EXEC, runUpdate: async (exe, args) => void calls.push([exe, args]) });
  return { quit, calls };
}

describe('squirrel startup events', () => {
  it('recognizes the five flags', () => {
    expect(squirrelCommand(['x', '--squirrel-install', '0.1.0'])).toBe('install');
    expect(squirrelCommand(['x', '--squirrel-firstrun'])).toBe('firstrun');
    expect(squirrelCommand(['x', '--other'])).toBeNull();
    expect(squirrelCommand(['x'])).toBeNull();
    expect(squirrelCommand(['x', 'constructor'])).toBeNull();
  });
  it('creates the shortcut at install and update, then quits', async () => {
    for (const flag of ['--squirrel-install', '--squirrel-updated']) {
      const { quit, calls } = await run(flag);
      expect(quit).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toEqual(['--createShortcut', 'ludy-desktop.exe']);
      expect(calls[0]![0]).toMatch(/Update\.exe$/);
    }
  });
  it('removes the shortcut at uninstall, only quits when obsolete, and runs normally at first run', async () => {
    expect((await run('--squirrel-uninstall')).calls[0]![1]).toEqual(['--removeShortcut', 'ludy-desktop.exe']);
    expect(await run('--squirrel-obsolete')).toEqual({ quit: true, calls: [] });
    expect(await run('--squirrel-firstrun')).toEqual({ quit: false, calls: [] });
    expect(await run(undefined)).toEqual({ quit: false, calls: [] });
  });
  it('does nothing off Windows', async () => {
    expect(await run('--squirrel-install', 'darwin')).toEqual({ quit: false, calls: [] });
  });
});
