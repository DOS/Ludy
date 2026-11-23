// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CHECK_INTERVAL_MS, createUpdater, type AutoUpdaterLike, type UpdaterEvents } from '../src/updater.ts';

// A fake Electron autoUpdater: tests drive its events like Squirrel.Windows does.
function fake() {
  const calls: string[] = [];
  let events: UpdaterEvents | null = null;
  let failCheck: Error | null = null;
  const updater: AutoUpdaterLike = {
    setFeedURL: (url) => void calls.push(`feed:${url}`),
    checkForUpdates: () => {
      calls.push('check');
      if (failCheck) throw failCheck;
    },
    quitAndInstall: () => void calls.push('quitAndInstall'),
    subscribe: (e) => {
      events = e;
    },
  };
  return { calls, updater, events: () => events!, failNextCheck: (e: Error) => { failCheck = e; } };
}

function make(options: { feedUrl?: string | null; supported?: boolean } = {}) {
  const f = fake();
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const logs: string[] = [];
  const controller = createUpdater({
    updater: f.updater,
    feedUrl: options.feedUrl === undefined ? 'https://updates.example.vn/feed' : options.feedUrl,
    supported: options.supported ?? true,
    setInterval: (cb, ms) => timers.push({ cb, ms }),
    clearInterval: () => undefined,
    log: (m) => logs.push(m),
  });
  return { ...f, controller, timers, logs };
}

describe('updater', () => {
  it('is off, and never touches the autoUpdater, without a feed or off a Squirrel install', () => {
    for (const options of [{ feedUrl: null }, { supported: false }]) {
      const t = make(options);
      t.controller.start();
      t.controller.checkNow();
      expect(t.controller.state().kind).toBe('off');
      expect(t.calls).toEqual([]);
      expect(t.controller.restart()).toBe(false);
    }
    expect(make({ feedUrl: null }).controller.state()).toEqual({ kind: 'off', reason: 'no-feed' });
    expect(make({ supported: false }).controller.state()).toEqual({ kind: 'off', reason: 'unsupported' });
  });

  it('checks at start and every 6 hours against the deployment feed', () => {
    const t = make();
    t.controller.start();
    expect(t.calls).toEqual(['feed:https://updates.example.vn/feed', 'check']);
    expect(t.timers.map((x) => x.ms)).toEqual([CHECK_INTERVAL_MS]);
    expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    t.events().notAvailable();
    expect(t.controller.state()).toEqual({ kind: 'idle' });
    t.timers[0]!.cb();
    expect(t.calls.filter((c) => c === 'check')).toHaveLength(2);
  });

  it('picks up a newer build: checking, downloading, then ready, and only restarts when asked', () => {
    const t = make();
    const seen: string[] = [];
    t.controller.subscribe((s) => seen.push(s.kind));
    t.controller.start();
    t.events().checking();
    t.events().available();
    expect(t.controller.restart()).toBe(false);
    expect(t.calls).not.toContain('quitAndInstall');
    t.events().downloaded('0.0.2');
    expect(t.controller.state()).toEqual({ kind: 'ready', version: '0.0.2' });
    expect(seen).toEqual(['checking', 'downloading', 'ready']);
    // Not restarted by itself, and a later check does not run over a ready update.
    expect(t.calls).not.toContain('quitAndInstall');
    t.controller.checkNow();
    expect(t.calls.filter((c) => c === 'check')).toHaveLength(1);
    expect(t.controller.restart()).toBe(true);
    expect(t.calls.at(-1)).toBe('quitAndInstall');
  });

  it('a failed update only reports: the old version keeps running, never restarts, and the next check tries again', () => {
    const t = make();
    t.controller.start();
    t.events().available();
    t.events().error('download interrupted');
    expect(t.controller.state()).toEqual({ kind: 'failed', message: 'download interrupted' });
    expect(t.controller.restart()).toBe(false);
    expect(t.calls).not.toContain('quitAndInstall');
    expect(t.logs).toEqual(['update failed: download interrupted']);
    t.timers[0]!.cb();
    expect(t.calls.filter((c) => c === 'check')).toHaveLength(2);
  });

  it('keeps a downloaded update ready when a later error arrives, and reports a check that throws', () => {
    const t = make();
    t.controller.start();
    t.events().downloaded(null);
    t.events().error('late');
    expect(t.controller.state().kind).toBe('ready');
    const u = make();
    u.failNextCheck(new Error('No Update.exe'));
    u.controller.start();
    expect(u.controller.state()).toEqual({ kind: 'failed', message: 'No Update.exe' });
  });
});
