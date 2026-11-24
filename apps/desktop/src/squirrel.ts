// SPDX-License-Identifier: AGPL-3.0-only
// Squirrel.Windows starts the app with a flag at install, update and uninstall. The app must make or remove its shortcuts through Update.exe
// and exit at once; any other start is a normal run (`--squirrel-firstrun` is the first normal run after an install). This replaces the
// electron-squirrel-startup package, which does the same in a dependency.
// Windows paths on purpose: this runs only on win32, and the tests give it Windows paths on any system.
import { win32 } from 'node:path';

export type SquirrelCommand = 'install' | 'updated' | 'uninstall' | 'obsolete' | 'firstrun';

const FLAGS: Readonly<Record<string, SquirrelCommand>> = {
  '--squirrel-install': 'install',
  '--squirrel-updated': 'updated',
  '--squirrel-uninstall': 'uninstall',
  '--squirrel-obsolete': 'obsolete',
  '--squirrel-firstrun': 'firstrun',
};

export function squirrelCommand(argv: readonly string[]): SquirrelCommand | null {
  const flag = argv[1];
  return flag !== undefined && Object.hasOwn(FLAGS, flag) ? (FLAGS[flag] ?? null) : null;
}

export interface SquirrelDeps {
  platform: string;
  // process.execPath of the running app: <install>\app-<version>\<name>.exe, with Update.exe one folder up.
  execPath: string;
  runUpdate(updateExe: string, args: string[]): Promise<void>;
}

// true: this process only ran an installer hook and must quit now; false: a normal run.
export async function handleSquirrelStartup(argv: readonly string[], deps: SquirrelDeps): Promise<boolean> {
  if (deps.platform !== 'win32') return false;
  const command = squirrelCommand(argv);
  if (command === null || command === 'firstrun') return false;
  const updateExe = win32.resolve(win32.dirname(deps.execPath), '..', 'Update.exe');
  const exeName = win32.basename(deps.execPath);
  if (command === 'install' || command === 'updated') await deps.runUpdate(updateExe, ['--createShortcut', exeName]);
  else if (command === 'uninstall') await deps.runUpdate(updateExe, ['--removeShortcut', exeName]);
  // 'obsolete' (the old version's last call) needs nothing but to quit.
  return true;
}
