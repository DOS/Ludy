// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests for desktop capture scoping, server-toggle reconnect prompts, session checks, and recording tray states.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { buildConnectUrl } from '../src/connect-url.ts';
import { exchangeCode, type FetchLike } from '../src/exchange.ts';
import { trayIconPng } from '../src/icons.ts';
import type { CallbackResult, LoopbackListener } from '../src/loopback.ts';
import { inspectSession } from '../src/session-check.ts';
import { createShell } from '../src/shell.ts';
import type { SessionStore, StoredSession } from '../src/token-store.ts';
import { describeTray, formatDurationClock, type ShellModel } from '../src/tray-model.ts';
import { createUpdater, type AutoUpdaterLike } from '../src/updater.ts';

const TOKEN = `crx_${'s'.repeat(43)}`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function memoryStore(initial: StoredSession | null = null): SessionStore {
  let held = initial;
  return {
    load: async () => held,
    save: async (s) => {
      held = s;
      return 'persisted';
    },
    clear: async () => {
      held = null;
    },
  };
}

function noUpdater() {
  const adapter: AutoUpdaterLike = {
    setFeedURL() {},
    checkForUpdates() {},
    quitAndInstall() {},
    subscribe() {},
  };
  return createUpdater({ updater: adapter, feedUrl: null, supported: false });
}

describe('connect-url, exchange & inspectSession scopes', () => {
  it('omits scope by default and includes requested scopes only when passed', () => {
    const plain = new URL(
      buildConnectUrl('https://ludy.example.vn', {
        challenge: 'ch',
        state: 'st',
        redirectUri: 'http://127.0.0.1:42/cb',
        deviceName: 'WinBox',
      }),
    );
    expect(plain.searchParams.has('scope')).toBe(false);

    const scoped = new URL(
      buildConnectUrl('https://ludy.example.vn', {
        challenge: 'ch',
        state: 'st',
        redirectUri: 'http://127.0.0.1:42/cb',
        deviceName: 'WinBox',
        scopes: ['meetings', 'agenda'],
      }),
    );
    expect(scoped.searchParams.get('scope')).toBe('meetings agenda');
  });

  it('preserves granted scopes in exchangeCode and reads features in inspectSession', async () => {
    const done = await exchangeCode(
      async () => json(200, { token: TOKEN, tokenId: 'tid', orgId: 'oid', scopes: ['meetings', 'agenda'], expiresAt: '2027-02-01T00:00:00.000Z' }),
      'https://ludy.example.vn',
      'crc_1',
      'verifier',
    );
    expect(done.scopes).toEqual(['meetings', 'agenda']);

    const checked = await inspectSession(
      async () =>
        json(200, {
          tokenId: 'tid',
          orgId: 'oid',
          client: 'desktop',
          scopes: ['meetings'],
          expiresAt: '2027-02-01T00:00:00.000Z',
          features: { meetings: true, agenda: false, notes: true },
        }),
      'https://ludy.example.vn',
      TOKEN,
    );
    expect(checked).toEqual({
      status: 'valid',
      me: {
        tokenId: 'tid',
        orgId: 'oid',
        client: 'desktop',
        scopes: ['meetings'],
        expiresAt: '2027-02-01T00:00:00.000Z',
        features: { meetings: true, agenda: false, notes: true },
      },
    });
  });
});

describe('shell capture gate & reconnect', () => {
  function fakeLoopback(result: CallbackResult): () => Promise<LoopbackListener> {
    return async () => ({
      redirectUri: 'http://127.0.0.1:4444/callback',
      result: Promise.resolve(result),
      close() {},
    });
  }

  it('requests zero scopes and stays inert when meetingsDesktopCapture is false', async () => {
    const openedUrls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).endsWith('/api/config')) return json(200, { meetingsDesktopCapture: false, uploads: 'direct', modules: [] });
      if (String(url).endsWith('/api/extension/token')) return json(200, { token: TOKEN, tokenId: 'tid', orgId: 'oid', scopes: [], expiresAt: '2027-02-01T00:00:00.000Z' });
      return json(200, { client: 'desktop', scopes: [], features: { meetings: true, agenda: true, notes: false } });
    };

    const s = createShell({
      config: loadConfig({ env: { LUDY_URL: 'https://ludy.example.vn' }, configFile: null }),
      store: memoryStore(),
      updater: noUpdater(),
      fetch: fetchImpl,
      openExternal: async (url) => {
        openedUrls.push(url);
      },
      deviceName: 'WinBox',
      startLoopback: fakeLoopback({ code: 'crc_ok', org: 'acme' }),
      newPkce: () => ({ verifier: 'v', challenge: 'c', state: 'st' }),
      setInterval: () => 0,
      clearInterval: () => {},
    });

    await s.signIn();
    expect(new URL(openedUrls[0]!).searchParams.has('scope')).toBe(false);
    expect(s.model().capture).toMatchObject({ enabled: false, agendaEnabled: false, reconnectNeeded: false });
  });

  it('requests meetings+agenda scopes when enabled and reconnects cleanly if server enabled later', async () => {
    let serverEnabled = true;
    const openedUrls: string[] = [];
    let returnedScopes: string[] = [];

    const fetchImpl: FetchLike = async (url) => {
      const u = String(url);
      if (u.endsWith('/api/config')) return json(200, { meetingsDesktopCapture: serverEnabled, uploads: 'presigned', modules: ['meetings'] });
      if (u.endsWith('/api/extension/token')) return json(200, { token: TOKEN, tokenId: 'tid', orgId: 'oid', scopes: returnedScopes, expiresAt: '2027-02-01T00:00:00.000Z' });
      if (u.endsWith('/api/extension/me')) {
        return json(200, {
          tokenId: 'tid',
          orgId: 'oid',
          client: 'desktop',
          scopes: returnedScopes,
          expiresAt: '2027-02-01T00:00:00.000Z',
          features: { meetings: true, agenda: true, notes: true },
        });
      }
      return json(404, {});
    };

    const s = createShell({
      config: loadConfig({ env: { LUDY_URL: 'https://ludy.example.vn' }, configFile: null }),
      store: memoryStore({
        ludyUrl: 'https://ludy.example.vn',
        token: TOKEN,
        tokenId: 'tid',
        orgId: 'oid',
        orgSlug: 'acme',
        scopes: [],
        expiresAt: '2027-02-01T00:00:00.000Z',
      }),
      updater: noUpdater(),
      fetch: fetchImpl,
      openExternal: async (url) => {
        openedUrls.push(url);
      },
      deviceName: 'WinBox',
      startLoopback: fakeLoopback({ code: 'crc_ok', org: 'acme' }),
      newPkce: () => ({ verifier: 'v', challenge: 'c', state: 'st' }),
      setInterval: () => 0,
      clearInterval: () => {},
    });

    await s.start();
    expect(s.model().capture).toMatchObject({ enabled: false, reconnectNeeded: true });

    returnedScopes = ['meetings', 'agenda'];
    await s.reconnectForCapture();
    expect(new URL(openedUrls[0]!).searchParams.get('scope')).toBe('meetings agenda');
    expect(s.model().capture).toMatchObject({ enabled: true, agendaEnabled: true, reconnectNeeded: false });
    expect(s.currentSession()).toMatchObject({ uploads: 'presigned', meetingsEnabled: true, agendaEnabled: true });

    // Org disables Meetings in features -> capture disabled safely.
    serverEnabled = true;
    const sDisabled = createShell({
      config: loadConfig({ env: { LUDY_URL: 'https://ludy.example.vn' }, configFile: null }),
      store: memoryStore({
        ludyUrl: 'https://ludy.example.vn',
        token: TOKEN,
        tokenId: 'tid',
        orgId: 'oid',
        orgSlug: 'acme',
        scopes: ['meetings', 'agenda'],
        expiresAt: '2027-02-01T00:00:00.000Z',
      }),
      updater: noUpdater(),
      fetch: async (url) => {
        if (String(url).endsWith('/api/config')) return json(200, { meetingsDesktopCapture: true, uploads: 'direct', modules: [] });
        return json(200, {
          client: 'desktop',
          scopes: ['meetings', 'agenda'],
          features: { meetings: false, agenda: false, notes: false },
        });
      },
      openExternal: async () => undefined,
      deviceName: 'WinBox',
      setInterval: () => 0,
      clearInterval: () => {},
    });
    await sDisabled.start();
    expect(sDisabled.model().capture?.enabled).toBe(false);
  });
});

describe('recording tray icon & menu state', () => {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  it('produces a valid recording tray icon and displays elapsed time, warnings, and reconnect items', () => {
    const recIcon = trayIconPng('recording', 16);
    expect(Array.from(recIcon.subarray(0, 8))).toEqual(PNG_SIGNATURE);
    expect(recIcon.equals(trayIconPng('signed-in', 16))).toBe(false);
    expect(formatDurationClock(125_000)).toBe('02:05');
    expect(formatDurationClock(3_665_000)).toBe('1:01:05');

    const recordingModel: ShellModel = {
      auth: { kind: 'signed-in', orgSlug: 'acme', online: true, persisted: true },
      update: { kind: 'idle' },
      configProblems: [],
      configured: true,
      notice: null,
      capture: {
        enabled: true,
        reconnectNeeded: false,
        agendaEnabled: true,
        phase: 'recording',
        meetingTitle: 'Design Review',
        elapsedMs: 65_000,
        detectedApp: 'Zoom',
        warning: 'Micro đang im lặng',
      },
    };
    const spec = describeTray(recordingModel);
    expect(spec.icon).toBe('recording');
    expect(spec.tooltip).toContain('Đang ghi âm Design Review (01:05)');
    expect(spec.items.some((i) => i.kind === 'action' && i.id === 'stop-record' && i.enabled)).toBe(true);
    expect(spec.items.some((i) => i.kind === 'action' && i.id === 'sign-out' && !i.enabled)).toBe(true);

    const reconnectSpec = describeTray({
      ...recordingModel,
      capture: {
        enabled: false,
        reconnectNeeded: true,
        agendaEnabled: false,
        phase: 'idle',
        meetingTitle: null,
        elapsedMs: 0,
        detectedApp: null,
        warning: null,
      },
    });
    expect(reconnectSpec.items.some((i) => i.kind === 'action' && i.id === 'reconnect-capture' && i.enabled)).toBe(true);
  });
});
