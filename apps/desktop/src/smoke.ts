// SPDX-License-Identifier: AGPL-3.0-only
// The Windows smoke channel (#4566): lets the CI job drive and observe the INSTALLED app without a screen. It is off unless the
// process was started with LUDY_DESKTOP_SMOKE_DIR, and it refuses to turn on unless the configured Ludy address is a loopback one
// (the fake test server), so it can never steer or leak a real deployment's sign-in. Two files in that folder, nothing else:
//   - state.json: written by the app after every change: version, pid, tray, auth and update state. NEVER the token or any secret.
//   - command.json: written by the CI harness: {"command": "sign-in" | "sign-out" | "check-update" | "restart" | "quit"}, run through the
//     same functions as the tray menu items, then deleted.
// No Electron import here, so it runs in unit tests.
import { isAbsolute } from 'node:path';
// Only the literal loopback forms: a name such as x.localhost depends on the resolver and is not accepted here.
const LOOPBACK_LITERALS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const MAX_COMMAND_BYTES = 1024;

export const SMOKE_DIR_ENV = 'LUDY_DESKTOP_SMOKE_DIR';
export const SMOKE_POLL_MS = 500;
export const SMOKE_COMMANDS = ['sign-in', 'sign-out', 'check-update', 'restart', 'quit'] as const;
export type SmokeCommand = (typeof SMOKE_COMMANDS)[number];

// The folder to use, or null (the normal case). Only an absolute folder, and only with a loopback Ludy address.
export function smokeDirFor(env: Readonly<Record<string, string | undefined>>, ludyUrl: string | null): string | null {
  const dir = env[SMOKE_DIR_ENV]?.trim();
  if (!dir || !isAbsolute(dir) || ludyUrl === null) return null;
  try {
    return LOOPBACK_LITERALS.has(new URL(ludyUrl).hostname.toLowerCase()) ? dir : null;
  } catch {
    return null;
  }
}

export function parseSmokeCommand(text: string): SmokeCommand | null {
  if (text.length > MAX_COMMAND_BYTES) return null;
  try {
    const parsed = JSON.parse(text) as { command?: unknown };
    return SMOKE_COMMANDS.find((c) => c === parsed.command) ?? null;
  } catch {
    return null;
  }
}

export interface SmokeSnapshot {
  pid: number;
  version: string;
  execPath: string;
  packaged: boolean;
  squirrelInstalled: boolean;
  tray: { created: boolean; icon: string; tooltip: string; items: string[] };
  auth: unknown;
  update: unknown;
  // How many times another launch of the app reached this one: the proof of the single-instance lock.
  secondInstances: number;
  updatedAt: string;
}

export interface SmokeIO {
  writeState(json: string): Promise<void>;
  // The command text, removing the file; null when there is none.
  takeCommand(): Promise<string | null>;
}

export interface Smoke {
  report(): void;
  start(): void;
  stop(): void;
}

export function createSmoke(options: {
  io: SmokeIO;
  snapshot: () => SmokeSnapshot;
  run: (command: SmokeCommand) => void;
  log: (message: string) => void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}): Smoke {
  const setTimer = options.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearTimer = options.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let timer: unknown;
  let writing: Promise<void> = Promise.resolve();
  const report = (): void => {
    const json = JSON.stringify(options.snapshot());
    writing = writing.then(() => options.io.writeState(json)).catch((error: unknown) => options.log(`smoke: state not written: ${error instanceof Error ? error.message : String(error)}`));
  };
  const poll = async (): Promise<void> => {
    const text = await options.io.takeCommand().catch(() => null);
    if (text === null) return;
    const command = parseSmokeCommand(text);
    if (command === null) return options.log('smoke: ignored an unknown command');
    options.log(`smoke: command ${command}`);
    options.run(command);
  };
  return {
    report,
    start() {
      if (timer !== undefined) return;
      report();
      timer = setTimer(() => void poll(), SMOKE_POLL_MS);
    },
    stop() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
