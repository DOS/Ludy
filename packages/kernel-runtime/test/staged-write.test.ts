// SPDX-License-Identifier: AGPL-3.0-only
// StagedWrite (#2780): a blob that arrives in pieces and is stored under the content address of everything written. Local disk
// here; S3 in s3-staged-write.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobConflictError, LocalDiskStore, bufferedStagedWrite, fileKey, sha256Hex, stagedWriteFor, type StagedWrite } from '../src/index.ts';

describe('LocalDiskStore streamed write', () => {
  let root = '';
  let store: LocalDiskStore;
  const orgId = randomUUID();
  const directory = `org/${orgId}`;
  const filesIn = async () => readdir(join(root, 'org', orgId)).catch(() => [] as string[]);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crove-staged-write-'));
    store = new LocalDiskStore(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeAll = async (write: StagedWrite, bytes: Buffer, piece: number) => {
    for (let at = 0; at < bytes.length; at += piece) await write.write(bytes.subarray(at, at + piece));
  };

  it('stores the pieces under the sha256 of all of them and reads back whole, leaving no temporary file', async () => {
    const bytes = randomBytes(300_000);
    const write = await store.beginStagedWrite(directory);
    await writeAll(write, bytes, 70_001);
    const stored = await write.commit(({ sha256 }) => fileKey(orgId, sha256), 'audio/webm');
    expect(stored).toMatchObject({ key: fileKey(orgId, sha256Hex(bytes)), sha256: sha256Hex(bytes), size: bytes.length, generation: `content:${sha256Hex(bytes)}` });
    expect(Buffer.from(await store.get(stored.key))).toEqual(bytes);
    expect(await filesIn()).toEqual([sha256Hex(bytes)]);
    await write.abort();
    expect(await filesIn()).toEqual([sha256Hex(bytes)]);
  });

  it('accepts the same bytes written twice, and refuses a key that is not their content address', async () => {
    const bytes = randomBytes(5000);
    const first = await store.beginStagedWrite(directory);
    await first.write(bytes);
    const a = await first.commit(({ sha256 }) => fileKey(orgId, sha256), 'audio/webm');
    const second = await store.beginStagedWrite(directory);
    await second.write(bytes);
    const b = await second.commit(({ sha256 }) => fileKey(orgId, sha256), 'audio/webm');
    expect(b).toEqual(a);
    const wrong = await store.beginStagedWrite(directory);
    await wrong.write(bytes);
    await expect(wrong.commit(() => fileKey(orgId, sha256Hex('something else')), 'audio/webm')).rejects.toThrow(/does not match/);
    expect((await filesIn()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('raises a conflict when the key already holds other bytes', async () => {
    const bytes = randomBytes(3000);
    const key = fileKey(orgId, sha256Hex(bytes));
    // Different bytes planted under the address (a swapped file).
    await writeFile(join(root, key), 'tampered');
    const write = await store.beginStagedWrite(directory);
    await write.write(bytes);
    await expect(write.commit(() => key, 'audio/webm')).rejects.toBeInstanceOf(BlobConflictError);
    expect((await filesIn()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('removes the temporary file when aborted, also after an interrupted write', async () => {
    const before = await filesIn();
    const write = await store.beginStagedWrite(directory);
    await write.write(randomBytes(1000));
    expect((await filesIn()).filter((f) => f.endsWith('.tmp'))).toHaveLength(1);
    await write.abort();
    expect(await filesIn()).toEqual(before);
    await write.abort();
  });

  it('falls back to a rename onto a free key on a filesystem without hard links', async () => {
    const logs: string[] = [];
    const noLinks = new LocalDiskStore(root, {
      link: async () => {
        throw Object.assign(new Error('no links'), { code: 'EPERM' });
      },
      log: (m) => logs.push(m),
    });
    const bytes = randomBytes(2048);
    const write = await noLinks.beginStagedWrite(directory);
    await write.write(bytes);
    const stored = await write.commit(({ sha256 }) => fileKey(orgId, sha256), 'audio/webm');
    expect(Buffer.from(await noLinks.get(stored.key))).toEqual(bytes);
    expect(logs).toHaveLength(1);
    // The key now exists: the same bytes dedupe through the same path.
    const again = await noLinks.beginStagedWrite(directory);
    await again.write(bytes);
    await expect(again.commit(({ sha256 }) => fileKey(orgId, sha256), 'audio/webm')).resolves.toEqual(stored);
  });

  it('refuses a directory that is not an org directory, and a store without a streamed write falls back to the buffered one', async () => {
    await expect(store.beginStagedWrite('org/../../escape')).rejects.toThrow(/invalid storage directory/);
    await expect(store.beginStagedWrite('inbound')).rejects.toThrow(/invalid storage directory/);
    const puts: Array<{ key: string; bytes: number; contentType: string }> = [];
    const plain = { put: async (key: string, bytes: Uint8Array, contentType: string) => (puts.push({ key, bytes: bytes.length, contentType }), 'content:x'), get: async () => new Uint8Array(), delete: async () => undefined };
    const write = await stagedWriteFor(plain, directory);
    await write.write(Buffer.from('abc'));
    await write.write(Buffer.from('def'));
    const stored = await write.commit(({ sha256 }) => fileKey(orgId, sha256), 'audio/ogg');
    expect(stored).toMatchObject({ sha256: sha256Hex('abcdef'), size: 6 });
    expect(puts).toEqual([{ key: fileKey(orgId, sha256Hex('abcdef')), bytes: 6, contentType: 'audio/ogg' }]);
    expect(bufferedStagedWrite(plain)).toBeDefined();
  });

  it('keeps the memory of a large write at a piece: 256 MiB written in 1 MiB pieces', async () => {
    const piece = randomBytes(1024 * 1024);
    const write = await store.beginStagedWrite(directory);
    // Settle the heap, then compare after the write: the blob is never held, so growth stays far below its size.
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = 0;
    for (let i = 0; i < 256; i += 1) {
      await write.write(piece);
      if (i % 16 === 0) peak = Math.max(peak, process.memoryUsage().rss - before);
    }
    const stored = await write.commit(({ sha256 }) => fileKey(orgId, sha256), 'video/webm');
    expect(stored.size).toBe(256 * 1024 * 1024);
    expect(peak).toBeLessThan(96 * 1024 * 1024);
    await store.delete(stored.key);
  }, 120_000);
});
