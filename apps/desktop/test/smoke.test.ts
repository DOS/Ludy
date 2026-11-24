// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createSmoke, parseSmokeCommand, SMOKE_DIR_ENV, smokeDirFor, type SmokeSnapshot } from '../src/smoke.ts';

const DIR = process.platform === 'win32' ? 'C:\\smoke' : '/smoke';

describe('smokeDirFor', () => {
  it('is on only with an absolute folder and a loopback Ludy address', () => {
    expect(smokeDirFor({ [SMOKE_DIR_ENV]: DIR }, 'http://127.0.0.1:5000')).toBe(DIR);
    expect(smokeDirFor({ [SMOKE_DIR_ENV]: DIR }, 'http://localhost:8080')).toBe(DIR);
  });
  it('stays off for a real deployment, no address, no folder or a relative folder', () => {
    expect(smokeDirFor({ [SMOKE_DIR_ENV]: DIR }, 'https://ludy.example.vn')).toBeNull();
    expect(smokeDirFor({ [SMOKE_DIR_ENV]: DIR }, null)).toBeNull();
    expect(smokeDirFor({}, 'http://127.0.0.1:5000')).toBeNull();
    expect(smokeDirFor({ [SMOKE_DIR_ENV]: '  ' }, 'http://127.0.0.1:5000')).toBeNull();
    expect(smokeDirFor({ [SMOKE_DIR_ENV]: 'relative/dir' }, 'http://127.0.0.1:5000')).toBeNull();
  });
});

describe('parseSmokeCommand', () => {
  it('accepts only the known commands', () => {
    for (const command of ['sign-in', 'sign-out', 'check-update', 'restart', 'quit']) expect(parseSmokeCommand(JSON.stringify({ command }))).toBe(command);
    expect(parseSmokeCommand('{"command":"rm -rf"}')).toBeNull();
    expect(parseSmokeCommand('{"command":"toString"}')).toBeNull();
    expect(parseSmokeCommand('not json')).toBeNull();
    expect(parseSmokeCommand('{}')).toBeNull();
  });
});

describe('createSmoke', () => {
  const snapshot = (): SmokeSnapshot => ({
    pid: 1,
    version: '0.1.0',
    execPath: 'x',
    packaged: true,
    squirrelInstalled: true,
    tray: { created: true, icon: 'signed-out', tooltip: 't', items: [] },
    auth: { kind: 'signed-out' },
    update: { kind: 'idle' },
    secondInstances: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('writes the state on start and on report, runs a command once and ignores an unknown one', async () => {
    const written: string[] = [];
    const commands: Array<string | null> = ['{"command":"sign-in"}', '{"command":"nope"}', null];
    const ran: string[] = [];
    const logs: string[] = [];
    let tick: () => void = () => undefined;
    const smoke = createSmoke({
      io: { writeState: async (json) => void written.push(json), takeCommand: async () => commands.shift() ?? null },
      snapshot,
      run: (command) => void ran.push(command),
      log: (line) => void logs.push(line),
      setInterval: (cb) => {
        tick = cb;
        return 1;
      },
      clearInterval: () => undefined,
    });
    smoke.start();
    smoke.report();
    tick();
    await new Promise((r) => setTimeout(r, 0));
    tick();
    await new Promise((r) => setTimeout(r, 0));
    smoke.stop();
    expect(written.length).toBe(2);
    expect(JSON.parse(written[0] ?? '{}')).toMatchObject({ version: '0.1.0', secondInstances: 0 });
    expect(ran).toEqual(['sign-in']);
    expect(logs).toContain('smoke: ignored an unknown command');
  });
});
