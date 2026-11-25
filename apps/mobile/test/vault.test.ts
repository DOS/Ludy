// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createVault, SESSION_KEY, type StoredSession } from '../src/auth/vault.ts';
import { ENDPOINTS, memoryStore, SERVER } from './helpers.ts';

const session: StoredSession = { serverUrl: SERVER, endpoints: ENDPOINTS, refreshToken: 'refresh-1', orgSlug: null };

describe('vault', () => {
  it('keeps one session blob in the secure storage and reads it back', async () => {
    const kv = memoryStore();
    const vault = createVault(kv);
    await vault.save(session);
    expect([...kv.data.keys()]).toEqual([SESSION_KEY]);
    expect(await vault.load()).toEqual(session);
  });

  it('never holds an access token: only the refresh token and where it belongs', async () => {
    const kv = memoryStore();
    await createVault(kv).save(session);
    expect(Object.keys(JSON.parse(kv.data.get(SESSION_KEY) ?? '{}')).sort()).toEqual(['endpoints', 'orgSlug', 'refreshToken', 'serverUrl', 'v']);
  });

  it('deletes and ignores a blob that is not a session of this version', async () => {
    for (const bad of ['not json', '{}', JSON.stringify({ v: 2, ...session }), JSON.stringify({ v: 1, ...session, refreshToken: '' }), JSON.stringify({ v: 1, ...session, endpoints: null })]) {
      const kv = memoryStore();
      kv.data.set(SESSION_KEY, bad);
      expect(await createVault(kv).load()).toBeNull();
      expect(kv.data.size).toBe(0);
    }
  });

  it('reads as no session when the storage cannot be read', async () => {
    const kv = memoryStore();
    kv.failGet = true;
    expect(await createVault(kv).load()).toBeNull();
  });

  it('clears the session, and says so when the storage would not', async () => {
    const kv = memoryStore();
    const vault = createVault(kv);
    await vault.save(session);
    await vault.clear();
    expect(kv.data.size).toBe(0);
    await vault.save(session);
    kv.failRemove = true;
    await expect(vault.clear()).rejects.toThrow();
  });
});
