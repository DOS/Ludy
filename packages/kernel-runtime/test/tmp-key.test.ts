// SPDX-License-Identifier: AGPL-3.0-only
// The tmp/ prefix of the temporary sealed video (#3341, #3337): the key is a content address under its own prefix per org, accepted by every store's key check, written by a streamed write begun for
// tmp/<org_id> only, listed (and so swept by the retention job) as tmp/ and nothing else, and its temporary files are swept at startup like the other prefixes'. Local disk on a temporary
// directory; the S3 half is in s3-staged-write.test.ts and blob-list.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStore, assertContentAddress, assertStorageKey, exportKey, fileKey, isListedKey, sha256Hex, tmpKey } from '../src/index.ts';

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const HASH = 'a'.repeat(64);

describe('the tmp/ key', () => {
  it('is tmp/<org_id>/<sha256>, accepted by the key check, and nothing looser', () => {
    expect(tmpKey(ORG, HASH)).toBe(`tmp/${ORG}/${HASH}`);
    expect(() => assertStorageKey(tmpKey(ORG, HASH))).not.toThrow();
    for (const bad of [`tmp/${HASH}`, `tmp/${ORG}/short`, `tmp/${ORG}/${HASH}/extra`, `tmp/not-an-org/${HASH}`, `tmp/${ORG}/${'A'.repeat(64)}`, `tmpx/${ORG}/${HASH}`, `/tmp/${ORG}/${HASH}`]) {
      expect(() => assertStorageKey(bad), bad).toThrow(/invalid storage key/);
    }
  });

  it('is a content address: its last segment must be the sha256 of the bytes, like org/, export/ and archive/', () => {
    const bytes = randomBytes(64);
    expect(() => assertContentAddress(tmpKey(ORG, sha256Hex(bytes)), sha256Hex(bytes))).not.toThrow();
    expect(() => assertContentAddress(tmpKey(ORG, HASH), sha256Hex(bytes))).toThrow(/does not match/);
  });

  it('is listed under tmp/ only, and no other prefix lists it', () => {
    expect(isListedKey('tmp/', tmpKey(ORG, HASH))).toBe(true);
    expect(isListedKey('tmp/', fileKey(ORG, HASH))).toBe(false);
    expect(isListedKey('tmp/', exportKey(ORG, HASH))).toBe(false);
    expect(isListedKey('tmp/', `tmp/${ORG}/not-a-hash`)).toBe(false);
    expect(isListedKey('export/', tmpKey(ORG, HASH))).toBe(false);
    expect(isListedKey('inbound/', tmpKey(ORG, HASH))).toBe(false);
  });
});

describe('LocalDiskStore with tmp/', () => {
  let root = '';
  let store: LocalDiskStore;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crove-tmp-key-'));
    store = new LocalDiskStore(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seal(orgId: string, bytes: Uint8Array): Promise<string> {
    const write = await store.beginStagedWrite(`tmp/${orgId}`);
    await write.write(bytes);
    return (await write.commit(({ sha256 }) => tmpKey(orgId, sha256), 'application/octet-stream')).key;
  }

  it('writes a streamed temporary seal to its content address under tmp/, reads it back and deletes it', async () => {
    const bytes = randomBytes(2048);
    const key = await seal(ORG, bytes);
    expect(key).toBe(tmpKey(ORG, sha256Hex(bytes)));
    expect(Buffer.from(await store.get(key)).equals(bytes)).toBe(true);
    await store.delete(key);
    expect(await store.list('tmp/', null, 10)).toEqual({ blobs: [], next: null });
  });

  it('refuses a write whose directory is not tmp/<org id>, and one that places a key outside it', async () => {
    await expect(store.beginStagedWrite('tmp/not-an-org')).rejects.toThrow(/invalid storage directory/);
    await expect(store.beginStagedWrite('tmp')).rejects.toThrow(/invalid storage directory/);
    await expect(store.beginStagedWrite('inbound')).rejects.toThrow(/invalid storage directory/);
    const write = await store.beginStagedWrite(`tmp/${ORG}`);
    await write.write(randomBytes(32));
    await expect(write.commit(({ sha256 }) => fileKey(ORG, sha256), 'application/octet-stream')).rejects.toThrow(/outside the directory/);
    await write.abort();
    expect(await readdir(join(root, 'tmp', ORG))).toEqual([]);
  });

  it('lists the temporary seals in key order across orgs and pages, and never an org/, export/ or foreign file, nor a temporary file of a write', async () => {
    const keys = [await seal(OTHER, randomBytes(100)), await seal(ORG, randomBytes(101)), await seal(ORG, randomBytes(102))].sort();
    const evidence = randomBytes(50);
    await store.put(fileKey(ORG, sha256Hex(evidence)), evidence);
    const exported = randomBytes(51);
    await store.put(exportKey(ORG, sha256Hex(exported)), exported);
    await writeFile(join(root, 'tmp', ORG, 'README'), 'x');
    await writeFile(join(root, 'tmp', ORG, `${'b'.repeat(64)}.123.${randomUUID()}.tmp`), 'partial');
    await mkdir(join(root, 'tmp', 'not-an-org'), { recursive: true });
    await writeFile(join(root, 'tmp', 'not-an-org', 'c'.repeat(64)), 'x');
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page = await store.list('tmp/', after, 2);
      pages++;
      seen.push(...page.blobs.map((b) => b.key));
      after = page.next;
    } while (after !== null && pages < 10);
    expect(seen).toEqual(keys);
    expect(pages).toBe(2);
    for (const key of keys) await store.delete(key);
  });

  it('removes the temporary files a crashed write left under tmp/ at startup, once they are old, and never a seal', async () => {
    const key = await seal(ORG, randomBytes(77));
    const leftover = join(root, 'tmp', ORG, `${'d'.repeat(64)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(leftover, 'partial');
    const old = new Date(Date.now() - 3 * 86_400_000);
    await utimes(leftover, old, old);
    expect(await store.sweepTempFiles()).toBeGreaterThanOrEqual(1);
    await expect(stat(leftover)).rejects.toThrow();
    expect((await stat(join(root, key))).isFile()).toBe(true);
    await store.delete(key);
  });
});
