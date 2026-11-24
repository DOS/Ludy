// SPDX-License-Identifier: AGPL-3.0-only
// The fake Ludy of the Windows smoke run, driven by the shell's own sign-in code: the real PKCE, loopback listener, connect URL,
// token exchange and /api/extension/me check, with a stand-in "browser" that follows the redirects. If this passes, the CI job's
// sign-in leg differs from it only in the real browser and the real DPAPI key store.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopConfig } from '../src/config.ts';
import { createShell } from '../src/shell.ts';
import { createSessionStore, type FileIO, type SecretBox } from '../src/token-store.ts';
import { createUpdater } from '../src/updater.ts';
import { startFakeLudy, type FakeLudy } from './support/fake-ludy.ts';

let fake: FakeLudy | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await fake?.close();
  fake = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(ludyUrl: string) {
  const files = new Map<string, Uint8Array>();
  const io: FileIO = { read: async (p) => files.get(p) ?? null, write: async (p, d) => void files.set(p, d), remove: async (p) => void files.delete(p) };
  const box: SecretBox = { isAvailable: () => true, encrypt: (plain) => Buffer.from(plain).reverse(), decrypt: (blob) => Buffer.from(blob).reverse().toString('utf8') };
  const config: DesktopConfig = { ludyUrl, updateUrl: null, problems: [] };
  const make = () =>
    createShell({
      config,
      store: createSessionStore({ file: 's.bin', box, io }),
      updater: createUpdater({ updater: { setFeedURL: () => undefined, checkForUpdates: () => undefined, quitAndInstall: () => undefined, subscribe: () => undefined }, feedUrl: null, supported: false }),
      fetch: globalThis.fetch,
      // The stand-in browser: opens the sign-in page and follows the fake's redirect back to the loopback listener.
      openExternal: async (url) => {
        const res = await globalThis.fetch(url);
        await res.text();
      },
      deviceName: 'Ludy Desktop, Windows, TEST',
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
  return { make, files };
}

describe('fake Ludy with the real desktop sign-in code', () => {
  it('signs in with PKCE, stores the token, and a restarted shell reads it back and passes the /me check', async () => {
    fake = await startFakeLudy();
    const { make, files } = build(fake.url);
    const first = make();
    await first.start();
    await first.signIn();
    expect(first.model().auth).toMatchObject({ kind: 'signed-in', orgSlug: 'smoke-org', online: true, persisted: true });
    expect(fake.connects).toHaveLength(1);
    expect(fake.connects[0]?.method).toBe('S256');
    expect(fake.exchanges).toBe(1);
    expect(fake.refusedExchanges).toBe(0);
    const [token] = fake.issuedTokens();
    expect(token).toMatch(/^crx_[A-Za-z0-9_-]{43}$/);
    // At rest it is the key store's blob, never the token.
    expect(Buffer.from(files.get('s.bin') ?? []).includes(Buffer.from(token ?? ''))).toBe(false);
    first.stop();

    fake.meCalls.length = 0;
    const second = make();
    await second.start();
    expect(second.model().auth).toMatchObject({ kind: 'signed-in', online: true });
    expect(fake.connects).toHaveLength(1);
    expect(fake.meCalls).toEqual([{ accepted: true }]);
    second.stop();
  });

  it('signs a restarted shell out when the server revokes the token', async () => {
    fake = await startFakeLudy();
    const { make } = build(fake.url);
    const first = make();
    await first.start();
    await first.signIn();
    first.stop();
    fake.revokeAll();
    const second = make();
    await second.start();
    expect(second.model().auth.kind).toBe('signed-out');
    second.stop();
  });

  it('refuses a wrong verifier and a reused code', async () => {
    fake = await startFakeLudy();
    const challenge = 'A'.repeat(43);
    const redirect = 'http://127.0.0.1:1/ludy-desktop/callback';
    const res = await fetch(`${fake.url}/-/extension/connect?client=desktop&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirect)}&state=s&device=d`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code');
    const post = (body: unknown) => fetch(`${fake?.url}/api/extension/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ code, codeVerifier: 'wrong', client: 'desktop' })).status).toBe(400);
    expect((await post({ code, codeVerifier: 'wrong', client: 'desktop' })).status).toBe(400);
    expect(fake.exchanges).toBe(0);
    expect(fake.refusedExchanges).toBe(2);
  });

  it('refuses a sign-in page request whose redirect is not the desktop loopback callback', async () => {
    fake = await startFakeLudy();
    for (const redirect of ['https://evil.example/ludy-desktop/callback', 'http://127.0.0.1:1/other', 'http://localhost:1/ludy-desktop/callback']) {
      const res = await fetch(`${fake.url}/-/extension/connect?client=desktop&code_challenge=${'A'.repeat(43)}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirect)}&state=s`, { redirect: 'manual' });
      expect(res.status).toBe(400);
    }
  });

  it('serves only the files of the feed folder, by name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-ludy-feed-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'RELEASES'), 'abc');
    fake = await startFakeLudy({ feedDir: () => dir });
    expect(await (await fetch(`${fake.url}/feed/RELEASES`)).text()).toBe('abc');
    expect((await fetch(`${fake.url}/feed/missing.nupkg`)).status).toBe(404);
    expect((await fetch(`${fake.url}/feed/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    expect(fake.feedRequests.map((r) => r.status)).toEqual([200, 404, 404]);
    expect(fake.requestLog.every((line) => !line.includes('?'))).toBe(true);
  });
});
