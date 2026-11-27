// SPDX-License-Identifier: AGPL-3.0-only
// Sign-in in a normal tab (#4662): which App origin the manifest lets reach the landing page, what the pending sign-in
// holds (appAddress + apiAddress), and what the landing page exchanges against apiAddress.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newPkce, parseConnectResult } from '../src/auth.ts';
import { CONNECTED_PAGE, PENDING_KEY, PENDING_TTL_MS, completeTabSignIn, isExtensionPageAddress, loadNotesExcluded, readPending, rememberNotesExcluded, tabSignInCovers, type PendingSignIn } from '../src/signin.ts';
import { emptyState, loadState, saveState, type StorageArea } from '../src/state.ts';
import { DEFAULT_APP_MATCHES, manifestViolations, WEB_ACCESSIBLE_PAGE } from '../src/manifest-policy.ts';

const memory = (): StorageArea & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (keys) => Object.fromEntries((typeof keys === 'string' ? [keys] : (keys ?? [...data.keys()])).filter((k) => data.has(k)).map((k) => [k, data.get(k)])),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, v)),
    remove: async (keys) => void (typeof keys === 'string' ? [keys] : keys).forEach((k) => data.delete(k)),
  };
};

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const REDIRECT = `chrome-extension://${ID}/connected.html`;
const NOW = 1_800_000_000_000;
const CODE = `crc_${'A'.repeat(43)}`;
const pending = (change: Partial<PendingSignIn> = {}): PendingSignIn => ({
  verifier: 'v'.repeat(43),
  state: 'st1',
  appAddress: 'https://app.ludy.vn',
  apiAddress: 'https://api.ludy.vn',
  redirect: REDIRECT,
  notesAsked: true,
  startedAt: NOW - 1000,
  ...change,
});
const answer = (query: string) => `${REDIRECT}?${query}`;

describe('which addresses sign in through a tab', () => {
  const manifest = { web_accessible_resources: [{ resources: [WEB_ACCESSIBLE_PAGE], matches: [...DEFAULT_APP_MATCHES] }] };

  it('only the pinned Ludy Cloud App origin is covered in the store manifest; other origins keep the window', () => {
    expect(tabSignInCovers(manifest, 'https://app.ludy.vn')).toBe(true);
    for (const other of ['https://api.ludy.vn', 'http://localhost:8080', 'https://ludy.congty.vn', 'http://app.ludy.vn', 'https://app.ludy.vn.evil.example', 'https://evil.example', 'http://127.0.0.1:8080', 'not an address', '']) {
      expect(tabSignInCovers(manifest, other), other).toBe(false);
    }
  });

  it('a manifest without the entry, or with another page listed, covers nothing', () => {
    expect(tabSignInCovers({}, 'https://app.ludy.vn')).toBe(false);
    expect(tabSignInCovers({ web_accessible_resources: [{ resources: ['popup.html'], matches: ['https://app.ludy.vn/*'] }] }, 'https://app.ludy.vn')).toBe(false);
  });

  it('the shipped manifest lists the landing page for app.ludy.vn only, matching the policy', () => {
    const shipped = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(CONNECTED_PAGE).toBe(WEB_ACCESSIBLE_PAGE);
    expect(manifestViolations(shipped)).toEqual([]);
    expect(tabSignInCovers(shipped as Parameters<typeof tabSignInCovers>[0], 'https://app.ludy.vn')).toBe(true);
    expect(tabSignInCovers(shipped as Parameters<typeof tabSignInCovers>[0], 'http://localhost:8080')).toBe(false);
    expect(tabSignInCovers(shipped as Parameters<typeof tabSignInCovers>[0], 'https://ludy.congty.vn')).toBe(false);
  });
});

describe('the address the tab redirect must have', () => {
  it('is this extension\'s landing page in the chrome-extension form, and nothing else', () => {
    expect(isExtensionPageAddress(REDIRECT)).toBe(true);
    for (const other of [`extension://${ID}/connected.html`, `moz-extension://${ID}/connected.html`, `chrome-extension://${ID}/popup.html`, `chrome-extension://${ID}/connected.html?x=1`, `chrome-extension://${'q'.repeat(32)}/connected.html`, 'https://app.ludy.vn/connected.html', '']) {
      expect(isExtensionPageAddress(other), other).toBe(false);
    }
  });
});

describe('the pending sign-in', () => {
  it('is read only whole and while it is young', () => {
    expect(readPending(pending(), NOW)).toEqual(pending());
    expect(readPending(pending({ startedAt: NOW - PENDING_TTL_MS }), NOW)).toBeNull();
    expect(readPending(pending({ startedAt: NOW + 1 }), NOW)).toBeNull();
    expect(readPending({ ...pending(), state: 1 }, NOW)).toBeNull();
    expect(readPending({ ...pending(), appAddress: '' }, NOW)).toBeNull();
    expect(readPending({ ...pending(), apiAddress: '' }, NOW)).toBeNull();
    expect(readPending({ ...pending(), notesAsked: 'yes' }, NOW)).toBeNull();
    expect(readPending(null, NOW)).toBeNull();
    expect(readPending('x', NOW)).toBeNull();
  });
});

describe('the landing page', () => {
  const setup = async (record: PendingSignIn | null = pending()) => {
    const session = memory();
    const local = memory();
    if (record) await session.set({ [PENDING_KEY]: record });
    await saveState(local, emptyState());
    const calls: Array<[string, string, string]> = [];
    const exchange = async (apiAddress: string, code: string, verifier: string) => {
      calls.push([apiAddress, code, verifier]);
      return { token: 'crx_new', tokenId: 'tok_new', orgId: 'org1', scopes: ['meetings'], expiresAt: '2027-01-01T00:00:00.000Z' };
    };
    return { session, local, calls, exchange };
  };
  const run = (s: Awaited<ReturnType<typeof setup>>, url: string) => completeTabSignIn(url, { session: s.session, local: s.local, now: NOW, exchange: s.exchange });

  it('trades the code once against apiAddress (never appAddress), saves the account and uses the pending sign-in up', async () => {
    const s = await setup();
    expect(await run(s, answer(`code=${CODE}&org=cong-ty&state=st1`))).toBe('connected');
    expect(s.calls).toEqual([['https://api.ludy.vn', CODE, 'v'.repeat(43)]]);
    const state = await loadState(s.local);
    expect(state.accounts.org1).toMatchObject({ orgSlug: 'cong-ty', token: 'crx_new', tokenId: 'tok_new' });
    expect(state.activeOrg).toBe('org1');
    expect(s.session.data.has(PENDING_KEY)).toBe(false);
    // The same address again (a reload, a second tab) finds nothing and trades nothing.
    expect(await run(s, answer(`code=${CODE}&org=cong-ty&state=st1`))).toBe('nothing');
    expect(s.calls).toHaveLength(1);
  });

  it('an answer with another state is no answer to this sign-in and leaves it waiting', async () => {
    const s = await setup();
    expect(await run(s, answer(`code=${CODE}&org=cong-ty&state=other`))).toBe('nothing');
    expect(await run(s, answer(`code=${CODE}&org=cong-ty`))).toBe('nothing');
    expect(s.calls).toHaveLength(0);
    expect(s.session.data.has(PENDING_KEY)).toBe(true);
    expect(await run(s, answer(`code=${CODE}&org=cong-ty&state=st1`))).toBe('connected');
  });

  it('with no pending sign-in, or an old one, nothing is traded', async () => {
    const none = await setup(null);
    expect(await run(none, answer(`code=${CODE}&org=cong-ty&state=st1`))).toBe('nothing');
    const old = await setup(pending({ startedAt: NOW - PENDING_TTL_MS - 1 }));
    expect(await run(old, answer(`code=${CODE}&org=cong-ty&state=st1`))).toBe('nothing');
    expect(none.calls.length + old.calls.length).toBe(0);
    expect(await run(none, 'not a url')).toBe('nothing');
  });

  it('the member saying no, or an answer without a code, is told so and trades nothing', async () => {
    const denied = await setup();
    expect(await run(denied, answer('error=access_denied&state=st1'))).toBe('denied');
    expect(denied.session.data.has(PENDING_KEY)).toBe(false);
    const other = await setup();
    expect(await run(other, answer('error=server_error&state=st1'))).toBe('failed');
    const bare = await setup();
    expect(await run(bare, answer('state=st1'))).toBe('failed');
    expect(denied.calls.length + other.calls.length + bare.calls.length).toBe(0);
  });

  it('a changed app or api origin gives no account, and a failed trade says so', async () => {
    const movedApp = await setup(pending({ appAddress: 'https://ludy.congty.vn' }));
    expect(await run(movedApp, answer(`code=${CODE}&org=cong-ty&state=st1`))).toBe('failed');
    expect(movedApp.calls).toHaveLength(0);
    expect(Object.keys((await loadState(movedApp.local)).accounts)).toEqual([]);

    const movedApi = await setup(pending({ apiAddress: 'https://api.congty.vn' }));
    expect(await run(movedApi, answer(`code=${CODE}&org=cong-ty&state=st1`))).toBe('failed');
    expect(movedApi.calls).toHaveLength(0);
    expect(Object.keys((await loadState(movedApi.local)).accounts)).toEqual([]);

    const failing = await setup();
    const result = await completeTabSignIn(answer(`code=${CODE}&org=cong-ty&state=st1`), {
      session: failing.session,
      local: failing.local,
      now: NOW,
      exchange: async () => {
        throw new Error('down');
      },
    });
    expect(result).toBe('failed');
    expect(Object.keys((await loadState(failing.local)).accounts)).toEqual([]);
  });

  it('a storage that fails is a failed sign-in, not an exception', async () => {
    const s = await setup();
    const broken: StorageArea = { get: async () => Promise.reject(new Error('storage')), set: async () => undefined, remove: async () => undefined };
    expect(await completeTabSignIn(answer(`code=${CODE}&org=cong-ty&state=st1`), { session: broken, local: s.local, now: NOW, exchange: s.exchange })).toBe('failed');
    expect(s.calls).toHaveLength(0);
  });

  it('remembers an org that gave no notes scope, for this session', async () => {
    const s = await setup();
    const noNotes = (scopes: string[]) => ({ token: 'crx_new', orgId: 'org1', scopes, expiresAt: '2027-01-01T00:00:00.000Z' });
    await completeTabSignIn(answer(`code=${CODE}&org=cong-ty&state=st1`), { session: s.session, local: s.local, now: NOW, exchange: async () => noNotes(['meetings']) });
    expect([...(await loadNotesExcluded(s.session))]).toEqual(['org1']);
    await s.session.set({ [PENDING_KEY]: pending() });
    await completeTabSignIn(answer(`code=${CODE}&org=cong-ty&state=st1`), { session: s.session, local: s.local, now: NOW, exchange: async () => noNotes(['meetings', 'notes']) });
    expect([...(await loadNotesExcluded(s.session))]).toEqual([]);
    await rememberNotesExcluded(s.session, 'org2', true);
    expect([...(await loadNotesExcluded(s.session))]).toEqual(['org2']);
  });
});

describe('the answer in an extension page address', () => {
  it('is read by scheme, host and path, with the state of the flow', async () => {
    const pkce = { ...(await newPkce()), state: 's1' };
    expect(parseConnectResult(answer(`code=crc_x&org=cong-ty&state=s1`), pkce, REDIRECT)).toEqual({ code: 'crc_x', org: 'cong-ty' });
    expect(parseConnectResult(answer(`code=crc_x&org=cong-ty&state=other`), pkce, REDIRECT)).toEqual({ error: 'invalid' });
    expect(parseConnectResult(`chrome-extension://${'b'.repeat(32)}/connected.html?code=crc_x&org=a&state=s1`, pkce, REDIRECT)).toEqual({ error: 'invalid' });
    expect(parseConnectResult(`chrome-extension://${ID}/popup.html?code=crc_x&org=a&state=s1`, pkce, REDIRECT)).toEqual({ error: 'invalid' });
  });
});
