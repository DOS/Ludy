// SPDX-License-Identifier: AGPL-3.0-only
// S3BlobStore.beginStagedWrite and direct.openStaged against a fake client (#2780): the multipart upload to a staging key, the
// copy to the content address, the integrity checks and the cleanup. The MinIO integration suite runs the same against a server.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { BlobConflictError, BlobNotFoundError, BlobTooLargeError, S3BlobStore, fileKey, newStagingKey, sha256Hex, type S3Sender } from '../src/index.ts';

type Cmd =
  | CreateMultipartUploadCommand
  | UploadPartCommand
  | CompleteMultipartUploadCommand
  | AbortMultipartUploadCommand
  | CopyObjectCommand
  | HeadObjectCommand
  | GetObjectCommand
  | DeleteObjectCommand;

const s3Error = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const PART = 8 * 1024 * 1024;

// An S3 that keeps objects and multipart uploads in memory, and records every command.
function fakeS3(options: { versionId?: string; shortBy?: number; store?: ConstructorParameters<typeof S3BlobStore>[2] } = {}) {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer>; aborted: boolean }>();
  const sent: string[] = [];
  const copies: unknown[] = [];
  const client = {
    send: async (command: Cmd) => {
      sent.push(command.constructor.name);
      if (command instanceof CreateMultipartUploadCommand) {
        const id = randomUUID();
        uploads.set(id, { key: command.input.Key!, parts: new Map(), aborted: false });
        return { UploadId: id };
      }
      if (command instanceof UploadPartCommand) {
        const upload = uploads.get(command.input.UploadId!)!;
        const body = Buffer.from(command.input.Body as Uint8Array);
        upload.parts.set(command.input.PartNumber!, body);
        return { ETag: `"${command.input.PartNumber}"`, ChecksumSHA256: createHash('sha256').update(body).digest('base64') };
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        const upload = uploads.get(command.input.UploadId!)!;
        const ordered = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
        const whole = Buffer.concat(ordered);
        objects.set(upload.key, options.shortBy ? whole.subarray(0, whole.length - options.shortBy) : whole);
        return {};
      }
      if (command instanceof AbortMultipartUploadCommand) {
        uploads.get(command.input.UploadId!)!.aborted = true;
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        const object = objects.get(command.input.Key!);
        if (!object) throw s3Error('NotFound', 404);
        return { ContentLength: object.length, VersionId: options.versionId ?? 'v1' };
      }
      if (command instanceof CopyObjectCommand) {
        copies.push(command.input);
        const source = objects.get(command.input.CopySource!.split('/').slice(1).join('/'));
        if (!source) throw s3Error('NoSuchKey', 404);
        objects.set(command.input.Key!, Buffer.from(source));
        return { VersionId: options.versionId ?? 'v1' };
      }
      if (command instanceof GetObjectCommand) {
        const object = objects.get(command.input.Key!);
        if (!object) throw s3Error('NoSuchKey', 404);
        return {
          ContentLength: object.length,
          VersionId: options.versionId ?? 'v1',
          Body: {
            transformToWebStream: () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  for (let at = 0; at < object.length; at += 1_000_000) controller.enqueue(object.subarray(at, at + 1_000_000));
                  controller.close();
                },
              }),
          },
        };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key!);
        return {};
      }
      throw new Error(`unexpected command ${(command as object).constructor.name}`);
    },
  } as unknown as S3Sender;
  return { store: new S3BlobStore(client, 'crove-files', { presigner: {} as never, ...options.store }), objects, uploads, sent, copies };
}

const orgId = randomUUID();
const directory = `org/${orgId}`;
const place = ({ sha256 }: { sha256: string }) => fileKey(orgId, sha256);

describe('S3BlobStore streamed write', () => {
  it('uploads parts of 8 MiB with their checksums, copies to the content address and leaves only that object', async () => {
    const { store, objects, sent } = fakeS3();
    const bytes = randomBytes(PART * 2 + 12345);
    const write = await store.beginStagedWrite(directory);
    for (let at = 0; at < bytes.length; at += 3_000_000) await write.write(bytes.subarray(at, at + 3_000_000));
    const stored = await write.commit(place, 'video/webm');
    expect(stored).toEqual({ key: fileKey(orgId, sha256Hex(bytes)), generation: 's3:v1', sha256: sha256Hex(bytes), size: bytes.length, created: true });
    expect([...objects.keys()]).toEqual([stored.key]);
    expect(objects.get(stored.key)!.equals(bytes)).toBe(true);
    expect(sent.filter((c) => c === 'UploadPartCommand')).toHaveLength(3);
    expect(sent.at(-1)).toBe('DeleteObjectCommand');
    expect(sent).not.toContain('AbortMultipartUploadCommand');
    await write.abort();
  });

  it('copies to the content address without the tags of the staging object, so an upload cannot carry the retention tag (#2789)', async () => {
    const { store, copies } = fakeS3();
    const write = await store.beginStagedWrite(directory);
    await write.write(randomBytes(5000));
    await write.commit(place, 'video/webm');
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ MetadataDirective: 'REPLACE', TaggingDirective: 'REPLACE' });
    expect(copies[0]).not.toHaveProperty('Tagging');
  });

  it('sends no tagging header where the store has no tagging (versioning off as on R2, or GCS interoperability)', async () => {
    for (const store of [{ versioning: 'off' as const }, { flavor: 'gcs' as const }]) {
      const { store: blobs, copies } = fakeS3({ store });
      const write = await blobs.beginStagedWrite(directory);
      await write.write(randomBytes(5000));
      await write.commit(place, 'video/webm');
      expect(copies[0]).toMatchObject({ MetadataDirective: 'REPLACE' });
      expect(copies[0]).not.toHaveProperty('TaggingDirective');
    }
  });

  it('refuses an object whose stored size is not what was written, and cleans up', async () => {
    const { store, objects, sent } = fakeS3({ shortBy: 1 });
    const write = await store.beginStagedWrite(directory);
    await write.write(randomBytes(5000));
    await expect(write.commit(place, 'audio/webm')).rejects.toThrow(/5000 were written/);
    expect(objects.size).toBe(0);
    expect(sent).not.toContain('CopyObjectCommand');
  });

  it('accepts a key that already holds the same bytes, and refuses one that holds other bytes', async () => {
    const same = fakeS3();
    const bytes = randomBytes(4000);
    same.objects.set(fileKey(orgId, sha256Hex(bytes)), Buffer.from(bytes));
    const write = await same.store.beginStagedWrite(directory);
    await write.write(bytes);
    await expect(write.commit(place, 'audio/webm')).resolves.toMatchObject({ sha256: sha256Hex(bytes), generation: 's3:v1', created: false });
    expect(same.sent).not.toContain('CopyObjectCommand');
    expect(same.objects.size).toBe(1);

    const other = fakeS3();
    other.objects.set(fileKey(orgId, sha256Hex(bytes)), Buffer.from('tampered contents, same length?'));
    const second = await other.store.beginStagedWrite(directory);
    await second.write(bytes);
    await expect(second.commit(place, 'audio/webm')).rejects.toBeInstanceOf(BlobConflictError);
    expect([...other.objects.keys()]).toEqual([fileKey(orgId, sha256Hex(bytes))]);
  });

  it('refuses a key outside the directory of the write, and cleans up', async () => {
    const { store, objects, sent } = fakeS3();
    const write = await store.beginStagedWrite(directory);
    await write.write(randomBytes(100));
    await expect(write.commit(({ sha256 }) => fileKey(randomUUID(), sha256), 'audio/webm')).rejects.toThrow(/outside the directory/);
    expect(objects.size).toBe(0);
    expect(sent).not.toContain('CopyObjectCommand');
  });

  it('refuses a key that is not the content address of what was written', async () => {
    const { store, objects } = fakeS3();
    const write = await store.beginStagedWrite(directory);
    await write.write(randomBytes(100));
    await expect(write.commit(() => fileKey(orgId, sha256Hex('other')), 'audio/webm')).rejects.toThrow(/does not match/);
    expect(objects.size).toBe(0);
  });

  it('aborts the multipart upload and deletes the staging key when abandoned', async () => {
    const { store, uploads, sent } = fakeS3();
    const write = await store.beginStagedWrite(directory);
    await write.write(randomBytes(PART + 10));
    await write.abort();
    expect([...uploads.values()].every((u) => u.aborted)).toBe(true);
    expect(sent.slice(-2)).toEqual(['AbortMultipartUploadCommand', 'DeleteObjectCommand']);
  });

  it('refuses a directory that is not an org directory', async () => {
    await expect(fakeS3().store.beginStagedWrite('staging')).rejects.toThrow(/invalid storage directory/);
  });
});

describe('S3BlobStore openStaged', () => {
  it('streams a staged object in pieces and refuses a declared size over the cap before reading', async () => {
    const { store, objects } = fakeS3();
    const key = newStagingKey();
    const bytes = randomBytes(2_500_000);
    objects.set(key, bytes);
    const opened = await store.direct!.openStaged!(key, bytes.length);
    expect(opened.size).toBe(bytes.length);
    const pieces: Buffer[] = [];
    for await (const piece of opened.chunks) pieces.push(Buffer.from(piece));
    expect(pieces.length).toBeGreaterThan(1);
    expect(Buffer.concat(pieces).equals(bytes)).toBe(true);
    await expect(store.direct!.openStaged!(key, bytes.length - 1)).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(store.direct!.openStaged!(newStagingKey(), 10)).rejects.toBeInstanceOf(BlobNotFoundError);
    await expect(store.direct!.openStaged!(fileKey(orgId, sha256Hex('x')), 10)).rejects.toThrow(/invalid staging key/);
    await expect(store.direct!.openStaged!(key, Number.NaN)).rejects.toThrow(/invalid read cap/);
  });

  const bodyOf = (pieces: number[], onCancel?: () => void) => ({
    transformToWebStream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const size of pieces) controller.enqueue(new Uint8Array(size));
          controller.close();
        },
        cancel: () => onCancel?.(),
      }),
  });
  const storeAnswering = (answer: () => unknown) => new S3BlobStore({ send: async () => answer() } as unknown as S3Sender, 'crove-files', { presigner: {} as never });

  it('stops a body that passes the cap while it streams, though it declared less', async () => {
    const store = storeAnswering(() => ({ ContentLength: 500, Body: bodyOf([600, 600]) }));
    const opened = await store.direct!.openStaged!(newStagingKey(), 1000);
    expect(opened.size).toBe(500);
    await expect((async () => { for await (const piece of opened.chunks) void piece; })()).rejects.toBeInstanceOf(BlobTooLargeError);
  });

  it('refuses an object that declares no length and closes its body instead of leaving the read open', async () => {
    let cancelled = false;
    const store = storeAnswering(() => ({ Body: bodyOf([10], () => (cancelled = true)) }));
    await expect(store.direct!.openStaged!(newStagingKey(), 1000)).rejects.toThrow(/declares no length/);
    expect(cancelled).toBe(true);
  });
});
