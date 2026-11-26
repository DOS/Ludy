// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELEASE_MANIFEST_SCRIPT_FILENAME } from '../src/authenticode.ts';
import type { FetchLike } from '../src/exchange.ts';
import { CHECK_INTERVAL_MS, createUpdater, type AutoUpdaterLike, type UpdaterEvents } from '../src/updater.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function make(
  options: {
    feedUrl?: string | null;
    supported?: boolean;
    fetch?: FetchLike;
    allowedOrigin?: string | null;
    expectedPublisherThumbprint?: string | null;
    requireSigned?: boolean;
  } = {},
) {
  const f = fake();
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const logs: string[] = [];
  const controller = createUpdater({
    updater: f.updater,
    feedUrl: options.feedUrl === undefined ? 'https://updates.example.vn/feed' : options.feedUrl,
    supported: options.supported ?? true,
    fetch: options.fetch,
    allowedOrigin: options.allowedOrigin,
    expectedPublisherThumbprint: options.expectedPublisherThumbprint,
    requireSigned: options.requireSigned,
    setInterval: (cb, ms) => timers.push({ cb, ms }),
    clearInterval: () => undefined,
    log: (m) => logs.push(m),
  });
  return { ...f, controller, timers, logs };
}

const waitUntil = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
};

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

  it('fails closed during preflight on HTTP download URLs or unsigned HTTPS feeds without calling Squirrel', async () => {
    const sha1 = '1'.repeat(40);
    const badFetch: FetchLike = async (url) => {
      if (String(url).endsWith('/RELEASES')) {
        return new Response(`${sha1} http://updates.example.vn/feed/LudyDesktop-0.1.1-full.nupkg 1024\n`, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };
    const bad = make({ fetch: badFetch });
    bad.controller.start();
    expect(bad.controller.state()).toEqual({ kind: 'checking' });
    await waitUntil(() => bad.controller.state().kind === 'failed');
    expect(bad.calls).toEqual([]);

    const thumb = 'a'.repeat(40);
    const validFetch: FetchLike = async (url) => {
      if (String(url).endsWith('/RELEASES')) {
        return new Response(`${sha1} LudyDesktop-0.1.1-full.nupkg 1024\n`, { status: 200 });
      }
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          product: 'ludy-desktop',
          platform: 'win32',
          arch: 'x64',
          version: '0.1.1',
          signed: true,
          signing: { algorithm: 'sha256', timestampServer: 'http://timestamp.digicert.com', publisherThumbprint: thumb },
          installer: { file: 'LudyDesktop-Setup.exe', sha256: 'b'.repeat(64), size: 2048 },
          packages: [{ file: 'LudyDesktop-0.1.1-full.nupkg', kind: 'full', version: '0.1.1', sha1, sha256: 'c'.repeat(64), size: 1024 }],
        }),
        { status: 200 },
      );
    };
    const good = make({
      fetch: validFetch,
      allowedOrigin: 'https://updates.example.vn',
      expectedPublisherThumbprint: thumb,
    });
    good.controller.start();
    // Overlapping checkNow while preflight is in flight is ignored.
    good.controller.checkNow();
    await waitUntil(() => good.calls.length === 2);
    expect(good.calls).toEqual(['feed:https://updates.example.vn/feed', 'check']);
    good.events().available();
    good.events().downloaded('0.1.1');
    expect(good.controller.state()).toEqual({ kind: 'ready', version: '0.1.1' });
    expect(good.controller.restart()).toBe(true);
    expect(good.calls.at(-1)).toBe('quitAndInstall');
  });

  it('stages verified update once and serves Squirrel strictly over an ephemeral 127.0.0.1 local feed', async () => {
    const payload = Buffer.from('verified-nupkg-binary');
    const sha1 = createHash('sha1').update(payload).digest('hex');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const thumb = 'a'.repeat(40);
    const feed = 'https://updates.example.vn/feed';
    const stagingDir = mkdtempSync(join(tmpdir(), 'ludy-updater-stage-'));
    tempDirs.push(stagingDir);

    let packageFetches = 0;
    const fetchFeed: FetchLike = async (url) => {
      const s = String(url);
      if (s.endsWith('/RELEASES')) {
        return new Response(`${sha1.toUpperCase()} LudyDesktop-0.1.2-full.nupkg ${payload.length}\n`, { status: 200 });
      }
      if (s.endsWith('/release-manifest.json')) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            product: 'ludy-desktop',
            platform: 'win32',
            arch: 'x64',
            version: '0.1.2',
            signed: true,
            signing: { algorithm: 'sha256', timestampServer: 'http://timestamp.digicert.com', publisherThumbprint: thumb },
            installer: { file: 'LudyDesktop-Setup.exe', sha256: 'b'.repeat(64), size: 2048 },
            packages: [{ file: 'LudyDesktop-0.1.2-full.nupkg', kind: 'full', version: '0.1.2', sha1, sha256, size: payload.length }],
          }),
          { status: 200 },
        );
      }
      if (s.endsWith(`/${RELEASE_MANIFEST_SCRIPT_FILENAME}`)) {
        return new Response('# signed manifest script', { status: 200 });
      }
      if (s.endsWith('/LudyDesktop-0.1.2-full.nupkg')) {
        packageFetches += 1;
        return new Response(payload, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const f = fake();
    const controller = createUpdater({
      updater: f.updater,
      feedUrl: feed,
      supported: true,
      fetch: fetchFeed,
      allowedOrigin: 'https://updates.example.vn',
      expectedPublisherThumbprint: thumb,
      currentVersion: '0.1.1',
      stagingDir,
      verifySignedManifest: async () => undefined,
      verifySignedPackage: async () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
    });

    controller.start();
    await waitUntil(() => f.calls.includes('check'));
    expect(packageFetches).toBe(1);
    const setFeedCall = f.calls.find((c) => c.startsWith('feed:'));
    expect(setFeedCall).toMatch(/^feed:http:\/\/127\.0\.0\.1:\d+$/);
    const localBaseUrl = setFeedCall!.slice('feed:'.length);

    // Local feed serves RELEASES and the staged nupkg, and rejects unknown paths.
    const releasesRes = await fetch(`${localBaseUrl}/RELEASES?id=LudyDesktop`);
    expect(releasesRes.status).toBe(200);
    expect(await releasesRes.text()).toContain('LudyDesktop-0.1.2-full.nupkg');
    const pkgRes = await fetch(`${localBaseUrl}/LudyDesktop-0.1.2-full.nupkg`);
    expect(pkgRes.status).toBe(200);
    expect(Buffer.from(await pkgRes.arrayBuffer()).equals(payload)).toBe(true);
    expect((await fetch(`${localBaseUrl}/other`)).status).toBe(404);

    f.events().downloaded('0.1.2');
    expect(controller.state()).toEqual({ kind: 'ready', version: '0.1.2' });
    // After downloaded closes the local server and removes stagingDir; restart works cleanly.
    await expect(fetch(`${localBaseUrl}/RELEASES`)).rejects.toThrow();
    await waitUntil(() => !existsSync(stagingDir));
    expect(controller.restart()).toBe(true);
    controller.stop();

    // When currentVersion already matches feed version, idle cleanly without invoking Squirrel.
    const sameVer = fake();
    const sameCtrl = createUpdater({
      updater: sameVer.updater,
      feedUrl: feed,
      supported: true,
      fetch: fetchFeed,
      expectedPublisherThumbprint: thumb,
      currentVersion: '0.1.2',
      stagingDir,
      verifySignedManifest: async () => undefined,
      verifySignedPackage: async () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
    sameCtrl.start();
    await waitUntil(() => sameCtrl.state().kind === 'idle');
    expect(sameVer.calls).toEqual([]);
  });
});
