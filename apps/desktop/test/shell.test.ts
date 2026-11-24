// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { DesktopConfig } from '../src/config.ts';
import type { FetchLike } from '../src/exchange.ts';
import type { LoopbackListener } from '../src/loopback.ts';
import { createShell, SESSION_CHECK_INTERVAL_MS, type Shell } from '../src/shell.ts';
import { createSessionStore, type FileIO, type SecretBox } from '../src/token-store.ts';
import { createUpdater } from '../src/updater.ts';

const LUDY = 'https://ludy.example.vn';
const TOKEN = `crx_${'t'.repeat(43)}`;
const CODE = `crc_${'c'.repeat(43)}`;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(options: { config?: Partial<DesktopConfig>; boxAvailable?: boolean; fetchImpl?: FetchLike } = {}) {
  const files = new Map<string, Uint8Array>();
  const io: FileIO = { read: async (p) => files.get(p) ?? null, write: async (p, d) => void files.set(p, d), remove: async (p) => void files.delete(p) };
  const box: SecretBox = {
    isAvailable: () => options.boxAvailable ?? true,
    encrypt: (plain) => Buffer.from(plain).reverse(),
    decrypt: (blob) => Buffer.from(blob).reverse().toString('utf8'),
  };
  const store = createSessionStore({ file: 's.bin', box, io });
  const opened: string[] = [];
  const requests: Array<{ url: string; method: string }> = [];
  let meStatus = 200;
  let exchangeStatus = 200;
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    (async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET' });
      if (String(url).endsWith('/api/extension/token')) return exchangeStatus === 200 ? json(200, { token: TOKEN, tokenId: 'tid', orgId: 'oid', scopes: [], expiresAt: '2027-02-01T00:00:00.000Z' }) : json(exchangeStatus, { code: 'EXTENSION_CODE_INVALID' });
      return meStatus === 200 ? json(200, { client: 'desktop' }) : json(meStatus, {});
    });
  // The sign-in listener is a fake the test answers like the browser would.
  let answer: (value: Awaited<LoopbackListener['result']>) => void = () => {};
  let closed = false;
  const listener: LoopbackListener = {
    redirectUri: 'http://127.0.0.1:5555/ludy-desktop/callback',
    result: new Promise((resolve) => (answer = resolve)),
    close: () => {
      closed = true;
      answer({ error: 'closed' });
    },
  };
  const timers: Array<() => void> = [];
  const updater = createUpdater({ updater: { setFeedURL: () => undefined, checkForUpdates: () => undefined, quitAndInstall: () => undefined, subscribe: () => undefined }, feedUrl: null, supported: false });
  const shell: Shell = createShell({
    config: { ludyUrl: LUDY, updateUrl: null, problems: [], ...options.config },
    store,
    updater,
    fetch: fetchImpl,
    openExternal: async (url) => void opened.push(url),
    deviceName: 'Ludy Desktop, Windows, PC',
    startLoopback: async () => listener,
    newPkce: () => ({ verifier: 'v'.repeat(43), challenge: 'c'.repeat(43), state: 'state-x' }),
    setInterval: (cb) => timers.push(cb),
    clearInterval: () => undefined,
  });
  return { shell, files, store, opened, requests, answer: (v: Awaited<LoopbackListener['result']>) => answer(v), timers, closed: () => closed, setMe: (s: number) => (meStatus = s), setExchange: (s: number) => (exchangeStatus = s) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('shell sign-in', () => {
  it('opens the system browser at the Ludy sign-in, exchanges the code and keeps the token in the key store only', async () => {
    const t = setup();
    await t.shell.start();
    const pending = t.shell.signIn();
    await flush();
    expect(t.shell.model().auth.kind).toBe('signing-in');
    const url = new URL(t.opened[0]!);
    expect(url.origin).toBe(LUDY);
    expect(url.searchParams.get('client')).toBe('desktop');
    expect(url.searchParams.get('state')).toBe('state-x');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555/ludy-desktop/callback');
    t.answer({ code: CODE, org: 'acme' });
    await pending;
    expect(t.shell.model().auth).toEqual({ kind: 'signed-in', orgSlug: 'acme', online: true, persisted: true });
    expect(t.requests.find((r) => r.url.endsWith('/token'))?.method).toBe('POST');
    // The token is in an encrypted blob and nowhere else.
    expect(Buffer.from(t.files.get('s.bin')!).toString('utf8')).not.toContain(TOKEN);
    expect(JSON.stringify(t.shell.model())).not.toContain(TOKEN);
  });

  it('reports a refusal, a timeout and a bad code, and ends signed out each time', async () => {
    for (const [result, text] of [[{ error: 'access_denied' }, 'từ chối'], [{ error: 'timeout' }, 'Hết thời gian']] as const) {
      const t = setup();
      const pending = t.shell.signIn();
      await flush();
      t.answer(result);
      await pending;
      expect(t.shell.model().auth.kind).toBe('signed-out');
      expect(t.shell.model().notice).toContain(text);
    }
    const t = setup();
    t.setExchange(400);
    const pending = t.shell.signIn();
    await flush();
    t.answer({ code: CODE, org: 'acme' });
    await pending;
    expect(t.shell.model().auth.kind).toBe('signed-out');
    expect(t.shell.model().notice).toContain('Mã đăng nhập không hợp lệ');
    expect(t.files.size).toBe(0);
  });

  it('cancelling closes the listener with no message', async () => {
    const t = setup();
    const pending = t.shell.signIn();
    await flush();
    t.shell.cancelSignIn();
    await pending;
    expect(t.closed()).toBe(true);
    expect(t.shell.model()).toMatchObject({ auth: { kind: 'signed-out' }, notice: null });
  });

  it('stays in memory only when the OS cannot encrypt', async () => {
    const t = setup({ boxAvailable: false });
    const pending = t.shell.signIn();
    await flush();
    t.answer({ code: CODE, org: 'acme' });
    await pending;
    expect(t.shell.model().auth).toMatchObject({ kind: 'signed-in', persisted: false });
    expect(t.files.size).toBe(0);
  });

  it('does nothing without a configured Ludy address', async () => {
    const t = setup({ config: { ludyUrl: null } });
    await t.shell.signIn();
    await t.shell.openLudy();
    expect(t.opened).toEqual([]);
    expect(t.shell.model().configured).toBe(false);
  });

  it('opens only the configured Ludy address for "Mở Ludy"', async () => {
    const t = setup();
    await t.shell.openLudy();
    expect(t.opened).toEqual([LUDY]);
  });
});

describe('shell token check', () => {
  async function signedIn() {
    const t = setup();
    const pending = t.shell.signIn();
    await flush();
    t.answer({ code: CODE, org: 'acme' });
    await pending;
    return t;
  }

  it('a revoked token signs the shell out at its next check and removes the stored token', async () => {
    const t = await signedIn();
    t.setMe(401);
    await t.shell.checkSessionNow();
    expect(t.shell.model().auth.kind).toBe('signed-out');
    expect(t.shell.model().notice).toContain('ngắt kết nối');
    expect(t.files.size).toBe(0);
  });

  it('ignores the answer of a check that was in flight when the member signed out', async () => {
    let release: (r: Response) => void = () => {};
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).endsWith('/api/config')) return json(200, {});
      if (String(url).endsWith('/api/extension/token')) return json(200, { token: TOKEN, tokenId: 'tid', orgId: 'oid', scopes: [], expiresAt: '2027-02-01T00:00:00.000Z' });
      return new Promise<Response>((resolve) => (release = resolve));
    };
    const t = setup({ fetchImpl });
    const pending = t.shell.signIn();
    await flush();
    t.answer({ code: CODE, org: 'acme' });
    await pending;
    const check = t.shell.checkSessionNow();
    await flush();
    await t.shell.signOut();
    release(json(401, {}));
    await check;
    expect(t.shell.model()).toMatchObject({ auth: { kind: 'signed-out' }, notice: null });
  });

  it('a server error does not sign out, it only marks the server unreachable', async () => {
    const t = await signedIn();
    t.setMe(503);
    await t.shell.checkSessionNow();
    expect(t.shell.model().auth).toMatchObject({ kind: 'signed-in', online: false });
    t.setMe(200);
    await t.shell.checkSessionNow();
    expect(t.shell.model().auth).toMatchObject({ kind: 'signed-in', online: true });
  });

  it('a new process picks the stored session up and signs out at start when the token was revoked meanwhile', async () => {
    const first = await signedIn();
    const second = setup();
    for (const [k, v] of first.files) second.files.set(k, v);
    second.setMe(401);
    await second.shell.start();
    expect(second.shell.model().auth.kind).toBe('signed-out');
    expect(second.files.size).toBe(0);
    const third = setup();
    for (const [k, v] of first.files) third.files.set(k, v);
    await third.shell.start();
    expect(third.shell.model().auth).toMatchObject({ kind: 'signed-in', orgSlug: 'acme' });
    expect(third.timers).toHaveLength(1);
    expect(SESSION_CHECK_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it('signing out clears the token locally', async () => {
    const t = await signedIn();
    await t.shell.signOut();
    expect(t.shell.model().auth.kind).toBe('signed-out');
    expect(t.files.size).toBe(0);
  });
});
