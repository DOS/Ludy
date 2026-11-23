// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createSessionStore, type FileIO, type SecretBox, type StoredSession } from '../src/token-store.ts';

const SESSION: StoredSession = { ludyUrl: 'https://ludy.example.vn', token: `crx_${'t'.repeat(43)}`, tokenId: 'tid', orgId: 'oid', orgSlug: 'acme', expiresAt: '2027-02-01T00:00:00.000Z' };

function setup(available = true) {
  const files = new Map<string, Uint8Array>();
  const io: FileIO = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, data) => void files.set(path, data),
    remove: async (path) => void files.delete(path),
  };
  // A stand-in cipher: reversible, and unlike the plain text it protects.
  const box: SecretBox = {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(plain, 'utf8').reverse(),
    decrypt: (blob) => Buffer.from(blob).reverse().toString('utf8'),
  };
  return { files, store: () => createSessionStore({ file: 'session.bin', box, io }) };
}

describe('session store', () => {
  it('keeps the session only as an encrypted blob and loads it in a new process', async () => {
    const { files, store } = setup();
    expect(await store().save(SESSION)).toBe('persisted');
    expect(Buffer.from(files.get('session.bin')!).toString('utf8')).not.toContain(SESSION.token);
    expect(Buffer.from(files.get('session.bin')!).reverse().toString('utf8')).toContain(SESSION.token);
    expect(await store().load(SESSION.ludyUrl)).toEqual(SESSION);
  });

  it('writes nothing when the OS cannot encrypt: the session lives in memory only', async () => {
    const { files, store } = setup(false);
    const s = store();
    expect(await s.save(SESSION)).toBe('memory-only');
    expect(files.size).toBe(0);
    expect(await s.load(SESSION.ludyUrl)).toEqual(SESSION);
    expect(await store().load(SESSION.ludyUrl)).toBeNull();
  });

  it('never hands the token to another Ludy address', async () => {
    const { store } = setup();
    await store().save(SESSION);
    expect(await store().load('https://other.example.vn')).toBeNull();
  });

  it('drops a blob it cannot read, and clear removes the session', async () => {
    const { files, store } = setup();
    files.set('session.bin', Buffer.from('garbage'));
    expect(await store().load(SESSION.ludyUrl)).toBeNull();
    expect(files.has('session.bin')).toBe(false);
    const s = store();
    await s.save(SESSION);
    await s.clear();
    expect(files.size).toBe(0);
    expect(await s.load(SESSION.ludyUrl)).toBeNull();
  });
});
