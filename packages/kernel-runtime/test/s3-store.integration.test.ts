// Integration tests against a real S3-compatible server (CI: MinIO). Set CROVE_TEST_S3_URL to
// http://<access key>:<secret>@<host>:<port>/<bucket>; the bucket is created if missing, with versioning enabled
// (evidence buckets need it, ADR-0013).
import { createHash, randomUUID } from 'node:crypto';
import {
  BucketVersioningStatus,
  ChecksumMode,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectRetentionCommand,
  GetObjectTaggingCommand,
  ListObjectVersionsCommand,
  PutBucketLifecycleConfigurationCommand,
  HeadObjectCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BlobConflictError,
  BlobIntegrityError,
  BlobNotFoundError,
  BlobStoreVersioningError,
  BlobTooLargeError,
  RETENTION_TAG_KEY,
  RETENTION_TAG_VALUE,
  S3BlobStore,
  UPLOAD_TTL_SECONDS,
  createS3Client,
  exportKey,
  fileKey,
  inboundKey,
  newInboundBlobId,
  newStagingKey,
  readVerified,
  sha256Hex,
  type PresignedUpload,
  type S3Sender,
  type S3StoreOptions,
} from '../src/index.ts';

const URL_ENV = process.env.CROVE_TEST_S3_URL;

function optionsFrom(url: string): S3StoreOptions {
  const parsed = new URL(url);
  return {
    endpoint: parsed.origin,
    region: 'us-east-1',
    bucket: parsed.pathname.replace(/^\//, '') || 'crove-test',
    accessKeyId: decodeURIComponent(parsed.username),
    secretAccessKey: decodeURIComponent(parsed.password),
    forcePathStyle: true,
  };
}

describe.skipIf(!URL_ENV)('S3BlobStore against a real S3-compatible server', () => {
  const options = optionsFrom(URL_ENV ?? 'http://x:y@localhost/none');
  let client: S3Client;
  const orgId = randomUUID();
  const encode = (s: string) => new TextEncoder().encode(s);

  // Records which commands the store sends, so a test can see that no read-back was needed.
  function recording() {
    const sent: string[] = [];
    const sender = {
      send: (command: { constructor: { name: string } }) => {
        sent.push(command.constructor.name);
        return (client.send as (c: unknown) => Promise<unknown>)(command);
      },
    } as unknown as S3Sender;
    return { store: new S3BlobStore(sender, options.bucket), sent };
  }

  beforeAll(async () => {
    client = createS3Client(options);
    await client.send(new CreateBucketCommand({ Bucket: options.bucket })).catch((error: { name?: string }) => {
      if (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists') throw error;
    });
    await client.send(new PutBucketVersioningCommand({ Bucket: options.bucket, VersioningConfiguration: { Status: BucketVersioningStatus.Enabled } }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores bytes with their content type and sha256, and a new store instance reads them back', async () => {
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = fileKey(orgId, sha256Hex(bytes));
    const { store, sent } = recording();
    const generation = await store.put(key, bytes, 'application/xml');
    // The server confirmed the sha256, so the store did not have to read the object back.
    expect(sent).toEqual(['PutObjectCommand']);

    const restarted = S3BlobStore.connect(options);
    expect(await restarted.get(key)).toEqual(bytes);
    const head = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key, ChecksumMode: ChecksumMode.ENABLED }));
    expect(head.ContentType).toBe('application/xml');
    expect(head.ContentLength).toBe(bytes.byteLength);
    expect(head.ChecksumSHA256).toBe(createHash('sha256').update(bytes).digest('base64'));
    // The generation is the version the bucket created (ADR-0013), and a re-upload records the same one.
    expect(generation).toBe(`s3:${head.VersionId}`);
    await expect(restarted.put(key, bytes, 'application/xml')).resolves.toBe(generation);
  });

  it('refuses a body that does not match the sha256 sent with it (the server verifies)', async () => {
    const bytes = encode('real bytes');
    await expect(
      client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: inboundKey(newInboundBlobId()),
          Body: bytes,
          ChecksumSHA256: createHash('sha256').update('other bytes').digest('base64'),
        }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 400 } });
  });

  it('never overwrites: the same bytes dedupe, different bytes conflict and the original stays', async () => {
    const store = S3BlobStore.connect(options);
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = fileKey(orgId, sha256Hex(bytes));
    await Promise.all([store.put(key, bytes, 'application/xml'), store.put(key, bytes, 'application/xml')]);
    await store.put(key, bytes, 'application/xml');
    expect(await store.get(key)).toEqual(bytes);

    const inbound = inboundKey(newInboundBlobId());
    const original = encode('first delivery');
    await store.put(inbound, original, 'message/rfc822');
    await expect(store.put(inbound, encode('a different message'), 'message/rfc822')).rejects.toBeInstanceOf(BlobConflictError);
    expect(await store.get(inbound)).toEqual(original);
  });

  it('writes once more when the existing object is deleted between the 412 and the read-back', async () => {
    const key = inboundKey(newInboundBlobId());
    const bytes = encode('raw message');
    await S3BlobStore.connect(options).put(key, bytes, 'message/rfc822');
    // The first read-back finds the object gone, as if a worker deleted it right after the 412.
    const sent: string[] = [];
    let raced = false;
    const sender = {
      send: async (command: { constructor: { name: string } }) => {
        sent.push(command.constructor.name);
        if (command.constructor.name === 'GetObjectCommand' && !raced) {
          raced = true;
          await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
        }
        return (client.send as (c: unknown) => Promise<unknown>)(command);
      },
    } as unknown as S3Sender;
    await new S3BlobStore(sender, options.bucket).put(key, bytes, 'message/rfc822');
    expect(sent).toEqual(['PutObjectCommand', 'GetObjectCommand', 'PutObjectCommand']);
    expect(await S3BlobStore.connect(options).get(key)).toEqual(bytes);
  });

  it('maps a missing object to BlobNotFoundError and deletes idempotently', async () => {
    const store = S3BlobStore.connect(options);
    const key = inboundKey(newInboundBlobId());
    await expect(store.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
    await store.put(key, encode('raw'), 'message/rfc822');
    await store.delete(key);
    await expect(store.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('fails loudly on a bucket that does not exist', async () => {
    const store = S3BlobStore.connect({ ...options, bucket: `missing-${randomUUID()}` });
    const error = await store.get(inboundKey(newInboundBlobId())).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BlobNotFoundError);
  });

  // Red-team S25: an object is replaced after the file row recorded it (and a proposal was approved on it), by
  // anyone with write access to the bucket, bypassing Crove's create-only writes.
  it('reads the recorded version after the key is overwritten, and fails closed on the current bytes or a deleted version', async () => {
    const store = S3BlobStore.connect(options);
    const original = encode(`<HDon>${randomUUID()}</HDon>`);
    const sha256 = sha256Hex(original);
    const key = fileKey(orgId, sha256);
    const generation = await store.put(key, original, 'application/xml');
    const swapped = encode('<HDon>swapped after approval</HDon>');
    const overwrite = await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: swapped }));
    expect(`s3:${overwrite.VersionId}`).not.toBe(generation);

    // The recorded triple still reads the original bytes, from a new store instance.
    expect(await readVerified(S3BlobStore.connect(options), { key, generation, sha256 })).toEqual(original);
    // A reference without a version (a row from before ADR-0013) gets the current bytes and refuses them.
    await expect(readVerified(store, { key, generation: null, sha256 })).rejects.toBeInstanceOf(BlobIntegrityError);
    await expect(readVerified(store, { key, generation: `content:${sha256}`, sha256 })).rejects.toBeInstanceOf(BlobIntegrityError);
    // Removing the recorded version does not fall back to the current object.
    await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key, VersionId: generation.slice('s3:'.length) }));
    await expect(readVerified(store, { key, generation, sha256 })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('fails closed on an unversioned bucket, unless versioning is explicitly off', async () => {
    const bucket = `crove-unversioned-${randomUUID().slice(0, 8)}`;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = fileKey(orgId, sha256Hex(bytes));
    await expect(S3BlobStore.connect({ ...options, bucket }).put(key, bytes, 'application/xml')).rejects.toBeInstanceOf(BlobStoreVersioningError);
    await expect(S3BlobStore.connect({ ...options, bucket, versioning: 'off' }).put(key, bytes, 'application/xml')).resolves.toBe(`content:${sha256Hex(bytes)}`);
  });

  // Evidence holds (issue #1009): a bucket created with Object Lock (which turns versioning on), as an evidence bucket
  // with holds must be. The holds here last a day; the CI server is thrown away after the run.
  it('holds the recorded version of an evidence file in GOVERNANCE mode, which a plain client cannot delete', async () => {
    const bucket = `crove-locked-${randomUUID().slice(0, 8)}`;
    await client.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    const store = S3BlobStore.connect({ ...options, bucket });
    await expect(store.holds.available()).resolves.toBe(true);
    // The test bucket has no Object Lock: the worker reports it and sets nothing.
    await expect(S3BlobStore.connect(options).holds.available()).resolves.toBe(false);

    const original = encode(`<HDon>${randomUUID()}</HDon>`);
    const sha256 = sha256Hex(original);
    const key = fileKey(orgId, sha256);
    const generation = await store.put(key, original, 'application/xml');
    const versionId = generation.slice('s3:'.length);
    const until = new Date(Math.ceil(Date.now() / 1000) * 1000 + 86_400_000);
    await expect(store.holds.hold({ key, generation, sha256 }, until)).resolves.toEqual(until);
    const retention = await client.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
    expect(retention.Retention?.Mode).toBe('GOVERNANCE');
    expect(retention.Retention?.RetainUntilDate?.getTime()).toBe(until.getTime());

    // Holding again for a shorter time keeps the longer hold (no bypass permission is ever used).
    await expect(store.holds.hold({ key, generation, sha256 }, new Date(until.getTime() - 3_600_000))).resolves.toEqual(until);
    // A longer one lengthens it.
    const later = new Date(until.getTime() + 86_400_000);
    await expect(store.holds.hold({ key, generation, sha256 }, later)).resolves.toEqual(later);

    // Deleting the held version is refused (AWS answers 403 AccessDenied, MinIO 400 InvalidRequest "Object is WORM
    // protected"); a plain delete only adds a delete marker, and the recorded version still reads.
    const refused = await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId })).then(
      () => null,
      (error: { name?: string }) => error.name,
    );
    expect(['AccessDenied', 'InvalidRequest']).toContain(refused);
    await store.delete(key);
    expect(await readVerified(store, { key, generation, sha256 })).toEqual(original);

    // A version that does not exist is a missing blob.
    await expect(store.holds.hold({ key, generation: 's3:00000000-0000-0000-0000-000000000000', sha256 }, until)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  // A retention delete (#2789) on the Object Lock bucket: the tag and the marker go on, and the held version stays: readable by its version id, with the same retain-until date,
  // and its version delete still refused. The lifecycle expiry itself runs in days on the server's clock, so the drill of docs/runbooks/provision-pilot.md checks it.
  it('leaves a held version untouched when a retention delete tags and deletes the object (#2789)', async () => {
    const bucket = `crove-locked-${randomUUID().slice(0, 8)}`;
    await client.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    const store = S3BlobStore.connect({ ...options, bucket });
    const original = encode(`<HDon>${randomUUID()}</HDon>`);
    const sha256 = sha256Hex(original);
    const key = fileKey(orgId, sha256);
    const generation = await store.put(key, original, 'application/xml');
    const versionId = generation.slice('s3:'.length);
    const until = new Date(Math.ceil(Date.now() / 1000) * 1000 + 86_400_000);
    await expect(store.holds.hold({ key, generation, sha256 }, until)).resolves.toEqual(until);

    await store.delete(key, { retention: 'expire' });

    // The current object is gone behind a marker, and the held version carries the tag.
    await expect(store.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
    const tags = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
    expect(tags.TagSet).toEqual([{ Key: RETENTION_TAG_KEY, Value: RETENTION_TAG_VALUE }]);
    // It still reads by its version id, with the retention it had.
    expect(await readVerified(store, { key, generation, sha256 })).toEqual(original);
    const retention = await client.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
    expect(retention.Retention?.Mode).toBe('GOVERNANCE');
    expect(retention.Retention?.RetainUntilDate?.getTime()).toBe(until.getTime());
    // And deleting that version is refused (AWS answers 403 AccessDenied, MinIO 400 InvalidRequest).
    const refused = await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId })).then(
      () => null,
      (error: { name?: string }) => error.name,
    );
    expect(['AccessDenied', 'InvalidRequest']).toContain(refused);
  });

  // The browser side of a presigned POST: the form fields, then the file last.
  async function post(form: PresignedUpload, bytes: Uint8Array, fields: Record<string, string> = form.fields) {
    const body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.append(name, value);
    body.append('file', new Blob([Buffer.from(bytes)]), 'upload.bin');
    return fetch(form.url, { method: 'POST', body });
  }

  it('takes a presigned upload to its staging key, which the server streams back with its sha256', async () => {
    const store = S3BlobStore.connect(options);
    const staging = newStagingKey();
    const form = await store.direct?.presignUpload(staging, 1024);
    if (!form) throw new Error('no presigned form');
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const response = await post(form, bytes);
    expect(response.status).toBe(204);
    expect(await store.direct?.readStaged(staging, 1024)).toEqual({ bytes, sha256: sha256Hex(bytes) });
    // The staging object is not a file: the server writes the bytes it hashed to the org key itself.
    const generation = await store.put(fileKey(orgId, sha256Hex(bytes)), bytes, 'application/xml');
    expect(generation).toMatch(/^s3:/);
    await store.delete(staging);
    await expect(store.get(staging)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('refuses a presigned upload over the size limit, to another key, or after the form expired', async () => {
    const store = S3BlobStore.connect(options);
    const staging = newStagingKey();
    const form = await store.direct?.presignUpload(staging, 16);
    if (!form) throw new Error('no presigned form');
    const tooLarge = await post(form, encode('x'.repeat(17)));
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.text()).toMatch(/EntityTooLarge/);
    // The policy names the key: the same signature cannot write anywhere else.
    const elsewhere = await post(form, encode('small'), { ...form.fields, key: newStagingKey() });
    expect(elsewhere.status).toBe(403);
    await expect(store.get(staging)).rejects.toBeInstanceOf(BlobNotFoundError);

    // A form signed just over UPLOAD_TTL_SECONDS ago has expired.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now - (UPLOAD_TTL_SECONDS + 5) * 1000);
    const late = newStagingKey();
    const stale = await store.direct?.presignUpload(late, 1024);
    vi.restoreAllMocks();
    if (!stale) throw new Error('no presigned form');
    const expired = await post(stale, encode('late'));
    expect(expired.status).toBe(403);
    expect(await expired.text()).toMatch(/expired/i);
    await expect(store.get(late)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('refuses to stream a staged object larger than the grant', async () => {
    const store = S3BlobStore.connect(options);
    const staging = newStagingKey();
    await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: staging, Body: encode('x'.repeat(64)) }));
    await expect(store.direct?.readStaged(staging, 63)).rejects.toBeInstanceOf(BlobTooLargeError);
  });

  // Issue #223. Its own unversioned bucket: a sweep of the shared one would race the staged uploads of other test files.
  it('sweeps staging objects older than the cutoff and nothing else', async () => {
    const bucket = `${options.bucket}-sweep`.slice(0, 63);
    await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((error: { name?: string }) => {
      if (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists') throw error;
    });
    const store = S3BlobStore.connect({ ...options, bucket, versioning: 'off' });
    // Leftovers of an earlier, interrupted run.
    await store.sweepStaging(new Date(Date.now() + 60_000), 10_000);
    const staged = [newStagingKey(), newStagingKey(), newStagingKey()];
    for (const key of staged) await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: encode('abandoned') }));
    const evidence = encode(`<HDon>${randomUUID()}</HDon>`);
    const evidenceKey = fileKey(orgId, sha256Hex(evidence));
    await store.put(evidenceKey, evidence, 'application/xml');

    // Nothing is older than an hour yet.
    await expect(store.sweepStaging(new Date(Date.now() - 3600_000), 100)).resolves.toEqual({ deleted: 0, more: false });
    // A limit smaller than the listing stops early and says so.
    const first = await store.sweepStaging(new Date(Date.now() + 60_000), 2);
    expect(first).toEqual({ deleted: 2, more: true });
    const rest = await store.sweepStaging(new Date(Date.now() + 60_000), 100);
    expect(rest).toEqual({ deleted: 1, more: false });
    for (const key of staged) await expect(store.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
    expect(await store.get(evidenceKey)).toEqual(evidence);
  });

  // Issue #212. Its own bucket, so other test files' objects never show in the listing.
  it('lists inbound/ and export/ page by page, in key order, and nothing else', async () => {
    const bucket = `${options.bucket}-list`.slice(0, 63);
    await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((error: { name?: string }) => {
      if (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists') throw error;
    });
    const store = S3BlobStore.connect({ ...options, bucket, versioning: 'off' });
    // Leftovers of an earlier run.
    for (const prefix of ['inbound/', 'export/'] as const) {
      for (let page = await store.list(prefix, null, 1000); ; ) {
        await Promise.all(page.blobs.map((b) => store.delete(b.key)));
        if (!page.next) break;
        page = await store.list(prefix, page.next, 1000);
      }
    }
    const mail = [newInboundBlobId(), newInboundBlobId(), newInboundBlobId()].map(inboundKey);
    for (const key of mail) await store.put(key, encode(key), 'message/rfc822');
    const part = encode(`part ${randomUUID()}`);
    const exported = exportKey(orgId, sha256Hex(part));
    await store.put(exported, part, 'application/octet-stream');
    const file = encode(`<HDon>${randomUUID()}</HDon>`);
    await store.put(fileKey(orgId, sha256Hex(file)), file, 'application/xml');
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: newStagingKey(), Body: encode('staged') }));

    const first = await store.list('inbound/', null, 2);
    expect(first.blobs.map((b) => b.key)).toEqual([...mail].sort().slice(0, 2));
    expect(first.blobs.every((b) => b.lastModified instanceof Date)).toBe(true);
    const rest = await store.list('inbound/', first.next, 2);
    expect(rest).toEqual({ blobs: [expect.objectContaining({ key: [...mail].sort()[2] })], next: null });
    expect((await store.list('export/', null, 10)).blobs.map((b) => b.key)).toEqual([exported]);
  });

  it('presigns a download of the recorded version, as an attachment, even after the key is overwritten', async () => {
    const store = S3BlobStore.connect(options);
    const original = encode(`<HDon>${randomUUID()}</HDon>`);
    const sha256 = sha256Hex(original);
    const key = fileKey(orgId, sha256);
    const generation = await store.put(key, original, 'application/xml');
    await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: encode('swapped') }));
    const url = await store.direct?.presignDownload({ key, generation, sha256 }, { filename: 'hd 1.xml', contentType: 'application/xml' });
    if (!url) throw new Error('no presigned url');
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''hd%201.xml`);
    expect(response.headers.get('content-type')).toBe('application/xml');
    // The version is part of the signature: pointing the URL at another version is refused.
    const tampered = new URL(url);
    tampered.searchParams.delete('versionId');
    expect((await fetch(tampered)).status).toBe(403);
  });
  // #2780: a blob that arrives in pieces goes to a multipart upload under a staging key, then to its content address.
  it('stores a streamed write of two parts under its sha256, accepts the same bytes again, and leaves no staging object', async () => {
    const { randomBytes } = await import('node:crypto');
    const bytes = randomBytes(12 * 1024 * 1024 + 321);
    const { store, sent } = recording();
    const write = await store.beginStagedWrite!(`org/${orgId}`);
    for (let at = 0; at < bytes.length; at += 1_500_000) await write.write(bytes.subarray(at, at + 1_500_000));
    const stored = await write.commit(({ sha256 }) => fileKey(orgId, sha256), 'video/webm');
    // What the commit sent, before the checks below read the object back through the same store.
    const committed = [...sent];
    expect(stored.sha256).toBe(sha256Hex(bytes));
    expect(stored.size).toBe(bytes.length);
    expect(stored.key).toBe(fileKey(orgId, sha256Hex(bytes)));
    const head = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: stored.key }));
    expect(head.ContentLength).toBe(bytes.length);
    expect(head.ContentType).toBe('video/webm');
    expect(stored.generation).toBe(`s3:${head.VersionId}`);
    expect(Buffer.from(await readVerified(store, { key: stored.key, generation: stored.generation, sha256: stored.sha256 })).equals(bytes)).toBe(true);
    // The staging object is deleted after the copy (the last command), and nothing is left to abort.
    expect(committed).toContain('CopyObjectCommand');
    expect(committed.at(-1)).toBe('DeleteObjectCommand');
    // The same bytes again (a retry): accepted, and it records the version that already holds them.
    const again = await store.beginStagedWrite!(`org/${orgId}`);
    await again.write(bytes);
    await expect(again.commit(({ sha256 }) => fileKey(orgId, sha256), 'video/webm')).resolves.toEqual({ ...stored, created: false });
  }, 120_000);

  it('tags the version a retention delete leaves behind, and the bucket takes the runbook lifecycle rules (#2789)', async () => {
    const key = fileKey(orgId, sha256Hex(encode('retention original')));
    const store = S3BlobStore.connect(options);
    const bytesIn = encode('retention original');
    await store.put(key, bytesIn, 'application/octet-stream');
    await store.delete(key, { retention: 'expire' });
    // The object reads as gone, a delete marker is current, and the one version left is noncurrent and carries the tag.
    await expect(store.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
    const listed = await client.send(new ListObjectVersionsCommand({ Bucket: options.bucket, Prefix: key }));
    expect(listed.DeleteMarkers?.filter((m) => m.Key === key && m.IsLatest)).toHaveLength(1);
    const versions = (listed.Versions ?? []).filter((v) => v.Key === key);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.IsLatest).toBe(false);
    const tags = await client.send(new GetObjectTaggingCommand({ Bucket: options.bucket, Key: key, VersionId: versions[0]?.VersionId }));
    expect(tags.TagSet).toEqual([{ Key: RETENTION_TAG_KEY, Value: RETENTION_TAG_VALUE }]);
    // A second retention delete (the job deletes again after its marker) finds nothing current to tag and still succeeds.
    await expect(store.delete(key, { retention: 'expire' })).resolves.toBeUndefined();
    // The lifecycle rules of docs/runbooks/provision-pilot.md for this: the server must accept the tag filter (with the noncurrent expiry) and the marker rule (no tag filter,
    // which S3 does not allow with ExpiredObjectDeleteMarker). The expiry itself runs on the server's clock, in days, so it is checked by the drill, not here.
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: options.bucket,
        LifecycleConfiguration: {
          Rules: [
            { ID: 'crove-retention-expired', Status: 'Enabled', Filter: { Tag: { Key: RETENTION_TAG_KEY, Value: RETENTION_TAG_VALUE } }, NoncurrentVersionExpiration: { NoncurrentDays: 1 } },
            { ID: 'crove-org-markers', Status: 'Enabled', Filter: { Prefix: 'org/' }, Expiration: { ExpiredObjectDeleteMarker: true } },
          ],
        },
      }),
    );
  });

  it('opens a staged object as a stream, and refuses one larger than the cap before reading', async () => {
    const { randomBytes } = await import('node:crypto');
    const bytes = randomBytes(3_000_000);
    const key = newStagingKey();
    await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: bytes }));
    const store = S3BlobStore.connect(options);
    const opened = await store.direct!.openStaged!(key, bytes.length);
    expect(opened.size).toBe(bytes.length);
    const pieces: Buffer[] = [];
    for await (const piece of opened.chunks) pieces.push(Buffer.from(piece));
    expect(Buffer.concat(pieces).equals(bytes)).toBe(true);
    await expect(store.direct!.openStaged!(key, bytes.length - 1)).rejects.toBeInstanceOf(BlobTooLargeError);
    await store.delete(key);
  });
});

