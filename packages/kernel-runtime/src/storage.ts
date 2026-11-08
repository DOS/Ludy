import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import { link as fsLink, mkdir, open, opendir, readFile, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// Object storage adapter. Local disk is the default; S3-compatible stores implement the same interface.
// Bodies are buffered in memory as a Uint8Array in both directions, so a blob costs its full size in RAM while
// it is read or written (at most MAX_UPLOAD_BYTES for a document, MAX_SOCIAL_VIDEO_BYTES for a Social video, whose uploads
// the API limits to two at a time, and MAX_EMAIL_BYTES for a raw message).
//
// Evidence integrity (ADR-0013, plan §7.6, red-team S25): every write returns the generation of the object it
// created or found, and every file row keeps the triple (key, generation, sha256). Reads go through readVerified,
// which asks the store for that exact generation and refuses bytes whose sha256 differs, so an object swapped
// after approval is never served or read as the original.
// A byte range [start, end] is two non-negative safe integers in order; anything else is a programming error, refused before
// the store is touched (a negative start would read from the file position, not the start).
export function assertRange(start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError('invalid byte range');
  }
}

export interface BlobStore {
  // An org key must end in the sha256 of the bytes (a content address); any other key is refused.
  // Writes are create-only: a key that already holds the same bytes is accepted (a re-upload dedupes), and a key
  // that holds different bytes raises BlobConflictError. A stored blob is never replaced.
  // Returns the generation (see GENERATION_PATTERN) of the object now under the key.
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  // Throws BlobNotFoundError when nothing is stored under the key. With a versioned generation (s3:, gcs:) the store
  // reads that exact version; content: and null read the current object. Callers that hold a file reference use
  // readVerified, which also checks the sha256. With maxBytes the store refuses a larger object (BlobTooLargeError)
  // without reading more than that; a store that ignores it is checked by readVerified after the read. A maxBytes that
  // is not a whole number of bytes (assertReadCap) is refused with a RangeError before anything is read (#1189).
  get(key: string, generation?: string | null, maxBytes?: number): Promise<Uint8Array>;
  // Reads a byte slice [start, end] (inclusive) of the blob.
  getRange?(key: string, start: number, end: number, generation?: string | null, maxBytes?: number): Promise<Uint8Array>;
  // Removes the blob; a missing key is not an error.
  delete(key: string): Promise<void>;
  // Starts a write whose bytes arrive in pieces and whose content address is known only at the end (sealed meeting
  // media: the key is the sha256 of the ciphertext). Memory is bounded by a piece (local disk) or a multipart part (S3),
  // not by the blob. `directory` is the key's directory, org/<org_id>. A store without it is written through
  // bufferedStagedWrite, which holds the blob whole. See StagedWrite.
  beginStagedWrite?(directory: string): Promise<StagedWrite>;
  // Present when browsers transfer bytes to and from the store directly (S3 presigned URLs); absent for local
  // disk, where uploads and downloads stream through the kernel.
  direct?: DirectTransfers | undefined;
  // Present when the store can sign a download for a platform that takes media by URL (Zalo OA, Instagram, Threads;
  // issue #2192). Independent of `direct`: it exists with S3_PRESIGNED_URLS=false too (Cloudflare R2), because it signs
  // reads only and never lets a browser write. Absent for local disk and for GCS.
  fetchUrls?: FetchUrls | undefined;
  // Deletes staging/ objects last modified before `before` (abandoned presigned uploads), looking at no more than
  // `limit` keys per call. For stores without a lifecycle rule on staging/; the worker's daily retention job calls
  // it. Absent where no staging objects exist (local disk).
  sweepStaging?(before: Date, limit: number): Promise<StagingSweep>;
  // One page of the blobs under inbound/ or export/, in key order, starting after the key `after` (null: from the
  // start) and looking at no more than `limit` keys. For the daily retention job, which decides what to delete (issue
  // #212); keys outside the prefix's pattern (temporary files, foreign objects) are never returned. Absent on a store
  // that cannot list.
  list?(prefix: ListPrefix, after: string | null, limit: number): Promise<BlobListing>;
  // Per-object retention holds on evidence files (issue #1009). Absent on a store without per-object retention (local
  // disk); the worker then sets no holds and says so at start.
  holds?: EvidenceHolds | undefined;
}

// Retention holds on the object versions that back posted journal entries (issue #1009, ADR-0013). Set by the worker
// after the posting committed, never inside a command's transaction.
export interface EvidenceHolds {
  // Whether the store can hold objects at all (S3: Object Lock enabled on the bucket). Asked once per run, so a bucket
  // without Object Lock is reported once rather than file by file.
  available(): Promise<boolean>;
  // Holds the version the reference records until at least retainUntil, in GOVERNANCE mode, and returns the
  // retention that version has afterwards. A longer retention, or a COMPLIANCE one, is kept as it is: a hold is
  // never shortened or weakened. A reference without a pinned version holds the current version once its bytes match
  // the recorded sha256 (BlobIntegrityError otherwise). Only org/ keys; a missing version raises BlobNotFoundError.
  hold(ref: BlobRef, retainUntil: Date): Promise<Date>;
}

// The prefixes the retention job sweeps: raw inbound mail and org exports. Never org/ (evidence) or staging/ (its own
// sweep).
export type ListPrefix = 'inbound/' | 'export/';

export interface ListedBlob {
  key: string;
  lastModified: Date;
}

export interface BlobListing {
  blobs: ListedBlob[];
  // Pass as `after` for the next page; null when the listing reached the end.
  next: string | null;
}

export interface StagingSweep {
  // Staging objects deleted.
  deleted: number;
  // The listing stopped at the limit, so older objects may remain for the next run.
  more: boolean;
}

// What a file row records about its object: the triple of plan §7.6. generation is null only on rows written
// before ADR-0013, whose reads are checked by sha256 alone.
export interface BlobRef {
  key: string;
  generation: string | null;
  sha256: string;
}

// A presigned S3 POST form: the browser sends `fields` plus the file (last) as multipart/form-data to `url`.
export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
  maxBytes: number;
}

export interface DirectTransfers {
  // A form for one staging key (plan §7.6 step 1): valid for UPLOAD_TTL_SECONDS, 1 to maxBytes bytes. The grant row
  // in crove_kernel.file_upload makes it single-use: the server reads the staging key at most once.
  presignUpload(stagingKey: string, maxBytes: number): Promise<PresignedUpload>;
  // A short-lived GET for the exact version, as an attachment. null when the generation cannot be pinned (content:
  // or a row from before ADR-0013): the caller then streams the bytes through readVerified instead.
  presignDownload(ref: BlobRef, file: { filename: string; contentType: string }): Promise<string | null>;
  // Streams a staged object, refusing more than maxBytes, and returns its bytes with their sha256.
  readStaged(stagingKey: string, maxBytes: number): Promise<{ bytes: Uint8Array; sha256: string }>;
  // Opens a staged object as a stream, for a caller that never holds it whole (sealed meeting media). The declared size
  // above maxBytes is refused (BlobTooLargeError) before a byte is read, and a stream that passes maxBytes while it is
  // read stops with the same error. BlobNotFoundError when nothing is staged under the key.
  openStaged?(stagingKey: string, maxBytes: number): Promise<{ size: number | null; chunks: AsyncIterable<Uint8Array> }>;
}

// A blob written by a StagedWrite: where it is, the generation of that object, and what was written.
export interface StoredBlob {
  key: string;
  generation: string;
  sha256: string;
  size: number;
}

// One write of a blob that arrives in pieces. write() in order, then commit() once, or abort(); abort() is also safe
// after commit() and after a failed one, and leaves nothing behind.
export interface StagedWrite {
  write(bytes: Uint8Array): Promise<void>;
  // Ends the bytes and stores them create-only under place(...), which must be the org key of the sha256 the store
  // computed over everything written (a content address, like put). The same bytes already there dedupe; different
  // bytes raise BlobConflictError. The returned size is the number of bytes written.
  commit(place: (done: { sha256: string; size: number }) => string, contentType: string): Promise<StoredBlob>;
  abort(): Promise<void>;
}

// A StagedWrite for a store without its own: the pieces are held whole and handed to put() at the end, so memory is the
// blob's size.
export function bufferedStagedWrite(store: Pick<BlobStore, 'put'>): StagedWrite {
  const pieces: Uint8Array[] = [];
  return {
    async write(bytes) {
      pieces.push(Uint8Array.from(bytes));
    },
    async commit(place, contentType) {
      const bytes = Buffer.concat(pieces);
      pieces.length = 0;
      const sha256 = sha256Hex(bytes);
      const key = place({ sha256, size: bytes.byteLength });
      assertStorageKey(key);
      assertContentAddress(key, sha256);
      const generation = (await store.put(key, bytes, contentType)) ?? contentGeneration(sha256);
      return { key, generation, sha256, size: bytes.byteLength };
    },
    async abort() {
      pieces.length = 0;
    },
  };
}

// The write to use for a store: its own streamed one, or the buffered stand-in.
export const stagedWriteFor = (store: BlobStore, directory: string): Promise<StagedWrite> =>
  store.beginStagedWrite ? store.beginStagedWrite(directory) : Promise.resolve(bufferedStagedWrite(store));

// A short-lived read-only URL that a platform fetches an org file from, right after the call that names it.
export interface FetchUrls {
  // A GET for the exact bytes the reference records, valid DOWNLOAD_TTL_SECONDS, as an attachment. Only org/ files. A
  // reference pinned to an object version is signed for that version. One that cannot be pinned (S3_VERSIONING=off, a
  // content: generation, a row from before ADR-0013) is first read through sha256 and signed only when the bytes are
  // the recorded ones (BlobIntegrityError otherwise), so an object swapped after approval is never handed out; what
  // remains is the signing window itself. `signal` ends the check early (the caller's own deadline); the store has one
  // of its own as well.
  presign(ref: BlobRef, file: { filename: string; contentType: string }, signal?: AbortSignal): Promise<string>;
}

// Presigned uploads live 5 minutes (plan §7.6); presigned downloads 60 seconds.
export const UPLOAD_TTL_SECONDS = 300;
export const DOWNLOAD_TTL_SECONDS = 60;

// The generation of an object, tagged by where it lives:
//   s3:<VersionId>      an S3 object version (bucket versioning on)
//   gcs:<generation>    a GCS object generation (x-goog-generation)
//   content:<sha256>    no native version (local disk, or an S3 bucket run with S3_VERSIONING=off): the object is
//                       known by its content address only, and the sha256 check on read is the whole guarantee.
export const GENERATION_PATTERN = /^(?:s3|gcs):[!-~]{1,1024}$|^content:[0-9a-f]{64}$/;

export function contentGeneration(sha256: string): string {
  return `content:${sha256}`;
}

// The version id a versioned generation names, or null for content: and rows from before ADR-0013.
export function versionOf(generation: string | null | undefined): string | null {
  if (!generation) return null;
  const match = /^(?:s3|gcs):(.+)$/.exec(generation);
  return match?.[1] ?? null;
}

// The stored bytes do not match the reference a file row holds: the object was replaced or corrupted after it
// was recorded (red-team S25). Never served, never parsed; an operator must investigate.
export class BlobIntegrityError extends Error {
  readonly key: string;
  constructor(ref: BlobRef) {
    super(`stored blob does not match its recorded sha256: ${ref.key} (generation ${ref.generation ?? 'none'})`);
    this.name = 'BlobIntegrityError';
    this.key = ref.key;
  }
}

// A staged upload is larger than its grant allows. S3 enforces the presigned POST's content-length-range; the
// server checks again while it streams, so a store that ignores the condition cannot pass a larger file.
// Also a stored object larger than a capped read allows (readVerified with maxBytes, #1126).
export class BlobTooLargeError extends Error {
  readonly key: string;
  constructor(key: string, maxBytes: number) {
    super(`${key.startsWith('staging/') ? 'staged' : 'stored'} object exceeds ${maxBytes} bytes: ${key}`);
    this.name = 'BlobTooLargeError';
    this.key = key;
  }
}

// Writes a file's bytes and returns the generation its reference records. A store that reports none (one written
// against the interface before ADR-0013, which returned nothing) has no versions, so the generation is the content
// address and reads rest on the sha256 check. S3BlobStore always returns a version or throws (S3_VERSIONING).
export async function putFile(store: BlobStore, key: string, bytes: Uint8Array, contentType: string, sha256: string): Promise<string> {
  const generation: string | undefined = await store.put(key, bytes, contentType);
  return generation ?? contentGeneration(sha256);
}

// Reads the object a file row references and fails closed unless its bytes hash to the recorded sha256.
// maxBytes (#1126): the size the row records, or a caller's cap. A swapped object larger than that is refused
// (BlobTooLargeError) before it is read whole, rather than read in full and then refused by its hash.
export async function readVerified(store: BlobStore, ref: BlobRef, maxBytes?: number): Promise<Uint8Array> {
  assertReadCap(maxBytes);
  const bytes = await store.get(ref.key, ref.generation, maxBytes);
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new BlobTooLargeError(ref.key, maxBytes);
  if (sha256Hex(bytes) !== ref.sha256) throw new BlobIntegrityError(ref);
  return bytes;
}

// A read cap is a whole number of bytes, 0 or more; undefined reads uncapped. Each store checks it as well as
// readVerified (#1189): a NaN, negative, fractional or infinite cap compares false against every size, so a store
// that took it would read the object whole. Fails closed, before anything is read.
export function assertReadCap(maxBytes: number | undefined): void {
  if (maxBytes !== undefined && !(Number.isSafeInteger(maxBytes) && maxBytes >= 0)) throw new RangeError('invalid read cap');
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function fileKey(orgId: string, sha256: string): string {
  return `org/${orgId}/${sha256}`;
}

// An org export part (issue #212): content addressed like a file, under its own prefix, so the retention job can
// expire exports without ever touching a file blob (org/<org_id>/...), even one with the same bytes.
export function exportKey(orgId: string, sha256: string): string {
  return `export/${orgId}/${sha256}`;
}

// A part of a fiscal year's archive package (issue #922, plan §7.9): content addressed like a file, under its own
// prefix per org and year. Never listed and never deleted by Crove: the package is kept for the legal retention period.
export function archiveKey(orgId: string, year: number, sha256: string): string {
  return `archive/${orgId}/${year}/${sha256}`;
}

// A customer's image in a conversation (issue #2357): bound to one message, so under a random id of its own and never a content
// address (the same bytes sent by two customers are two blobs, and deleting one message's image never touches another's). The row
// that names it is crove_kernel.conversation_attachment; its blob is deleted by the worker when that row goes.
export function conversationKey(orgId: string, blobId: string): string {
  return `conversation/${orgId}/${blobId}`;
}

export function newConversationBlobId(): string {
  return randomBytes(32).toString('hex');
}

// Raw inbound email, stored by the API before any org is known, under a random id per delivery so the
// worker can delete it once handled without counting references. Only the worker reads it.
export function inboundKey(blobId: string): string {
  return `inbound/${blobId}`;
}

export function newInboundBlobId(): string {
  return randomBytes(32).toString('hex');
}

// A presigned upload lands here first (plan §7.6 step 1), under a random name, and never becomes a file itself: the
// server reads it, hashes it and writes the bytes it hashed to the org key.
export function stagingKey(id: string): string {
  return `staging/${id}`;
}

export function newStagingKey(): string {
  return stagingKey(randomBytes(32).toString('hex'));
}

export function isStagingKey(key: string): boolean {
  return /^staging\/[0-9a-f]{64}$/.test(key);
}

const KEY_PATTERN = /^(?:(?:org|export|conversation)\/[0-9a-f-]{36}|archive\/[0-9a-f-]{36}\/\d{4}|inbound|staging)\/[0-9a-f]{64}$/;
// The keys a listing of each sweepable prefix returns.
const LISTED_KEY: Record<ListPrefix, RegExp> = {
  'inbound/': /^inbound\/[0-9a-f]{64}$/,
  'export/': /^export\/[0-9a-f-]{36}\/[0-9a-f]{64}$/,
};

// Every store accepts the same keys: org/<org_id>/<sha256> (plan §7.6), export/<org_id>/<sha256>,
// archive/<org_id>/<year>/<sha256>, conversation/<org_id>/<random id>, inbound/<random id> and staging/<random id>.
export function assertStorageKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('invalid storage key');
}

// Whether a listing of the prefix may return the key.
export function isListedKey(prefix: ListPrefix, key: string): boolean {
  return LISTED_KEY[prefix].test(key);
}

// Checks the arguments of BlobStore.list, the same for every store.
export function assertListArgs(prefix: ListPrefix, after: string | null, limit: number): void {
  if (!Object.hasOwn(LISTED_KEY, prefix)) throw new Error('invalid list prefix');
  if (after !== null && (typeof after !== 'string' || !after.startsWith(prefix) || after.length > 200)) throw new Error('invalid list cursor');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid list limit');
}

// Org, export and archive keys are content addresses: their last segment must be the sha256 of the bytes stored under
// them.
export function assertContentAddress(key: string, sha256: string): void {
  if ((key.startsWith('org/') || key.startsWith('export/') || key.startsWith('archive/')) && !key.endsWith(`/${sha256}`)) {
    throw new Error('storage key does not match the content sha256');
  }
}

// Raised by every store for a missing blob, so callers never depend on which store is configured.
// The code matches the ENOENT that local disk surfaced before this class existed.
export class BlobNotFoundError extends Error {
  readonly code = 'ENOENT';
  readonly key: string;
  constructor(key: string) {
    super(`blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
    this.key = key;
  }
}

// The key already holds other bytes. Stored blobs are evidence and are never silently replaced.
export class BlobConflictError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`blob already exists with different content: ${key}`);
    this.name = 'BlobConflictError';
    this.key = key;
  }
}

export interface LocalDiskStoreOptions {
  // The hard link call; tests replace it to simulate a filesystem without hard links.
  link?: (existing: string, target: string) => Promise<void>;
  // Where the one-time "no hard links" warning goes.
  log?: (message: string) => void;
}

// link() fails with one of these when the filesystem has no hard links (SMB/CIFS, exFAT, some NFS servers,
// Docker Desktop bind mounts from a Windows host).
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);
// A directory fsync is not available everywhere (Windows, some network filesystems). Skipping it there only loses
// the guarantee that the new name survives a power cut, never the bytes behind it.
const NO_DIRECTORY_SYNC = new Set(['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF']);
// <64 hex>.<pid>.<uuid>.tmp, the names put gives its temporary files.
const TEMP_FILE = /^[0-9a-f]{64}\.\d+\.[0-9a-f-]{36}\.tmp$/;
const UUID_DIR = /^[0-9a-f-]{36}$/;
export const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

// Writes the bytes to a new file and flushes them to disk before returning, so a name linked to it later never
// points at empty or truncated data after a crash. Fails with EEXIST when the path exists; a file it created but
// could not finish is removed.
async function writeNewFileDurably(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
}

// Flushes a directory entry (a new name) to disk where the platform supports it.
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (error) {
    if (!NO_DIRECTORY_SYNC.has(errorCode(error) ?? '')) throw error;
  } finally {
    await handle?.close();
  }
}

// The sha256 of a file, read as a stream (never whole). ENOENT when it is not there.
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const piece of createReadStream(path)) hash.update(piece as Buffer);
  return hash.digest('hex');
}

export class LocalDiskStore implements BlobStore {
  private readonly root: string;
  private readonly link: (existing: string, target: string) => Promise<void>;
  private readonly log: (message: string) => void;
  private hardLinks = true;

  constructor(root: string, options: LocalDiskStoreOptions = {}) {
    this.root = resolve(root);
    this.link = options.link ?? fsLink;
    this.log = options.log ?? ((message) => console.warn(`[storage] ${message}`));
  }

  private path(key: string): string {
    assertStorageKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return full;
  }

  // Create-only, like the S3 store. The bytes go to a temporary file in the same directory and are flushed to disk
  // (fsync); the file is then hard linked to the key, and the directory is flushed too where the platform allows.
  // link() is atomic and fails with EEXIST when the key already exists, so a reader never sees a partial file, of
  // two concurrent writers exactly one creates the key, and after a crash the key is either missing or holds all
  // of its bytes. A writer that finds the key compares bytes: the same bytes dedupe, different bytes raise
  // BlobConflictError. The temporary file is removed on every path.
  //
  // On a filesystem without hard links the store warns once and creates the key itself exclusively ('wx'). That is
  // still create-only, but a concurrent reader (or a second writer comparing bytes) can see a file that is still
  // being written, and a crash during a write can leave it truncated.
  //
  // Local disk has no object versions, so the generation is the content address (content:<sha256>): the store only
  // ever creates a key once, and a file replaced behind its back is caught by the sha256 check on read. An inode
  // number or a modification time would change on a backup restore without any change in content.
  async put(key: string, bytes: Uint8Array): Promise<string> {
    const target = this.path(key);
    const sha256 = sha256Hex(bytes);
    assertContentAddress(key, sha256);
    await mkdir(dirname(target), { recursive: true });
    if (this.hardLinks) {
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeNewFileDurably(tmp, bytes);
        if (await this.createOrCompare(key, sha256, () => this.link(tmp, target), true)) return contentGeneration(sha256);
      } finally {
        await rm(tmp, { force: true });
      }
    }
    await this.createOrCompare(key, sha256, () => writeNewFileDurably(target, bytes), false);
    return contentGeneration(sha256);
  }

  // A streamed create-only write (see StagedWrite): the pieces go to a temporary file in the key's directory, hashed as they
  // are written, and commit() fsyncs it and hard links it to the key the caller derives from the hash, as put does. A key
  // that already exists is compared by hashing the file as a stream (never read whole): the same bytes dedupe. On a
  // filesystem without hard links the file is renamed to the key when the key is free, with the weaker guarantees put
  // documents for its own fallback. The temporary file is removed on every path; one a crash leaves is swept at startup.
  async beginStagedWrite(directory: string): Promise<StagedWrite> {
    if (!/^(?:org|export|conversation)\/[0-9a-f-]{36}$/.test(directory)) throw new Error('invalid storage directory');
    const dir = dirname(this.path(`${directory}/${'0'.repeat(64)}`));
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${randomBytes(32).toString('hex')}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(tmp, 'wx');
    const hash = createHash('sha256');
    let size = 0;
    let open_ = true;
    const close = async () => {
      if (!open_) return;
      open_ = false;
      await handle.close().catch(() => undefined);
    };
    return {
      write: async (bytes) => {
        let at = 0;
        while (at < bytes.byteLength) {
          const { bytesWritten } = await handle.write(bytes, at, bytes.byteLength - at);
          at += bytesWritten;
        }
        hash.update(bytes);
        size += bytes.byteLength;
      },
      commit: async (place) => {
        try {
          await handle.sync();
          await close();
          const sha256 = hash.digest('hex');
          const key = place({ sha256, size });
          assertContentAddress(key, sha256);
          const target = this.path(key);
          await this.place(tmp, target, key, sha256);
          await syncDirectory(dirname(target));
          return { key, generation: contentGeneration(sha256), sha256, size };
        } finally {
          await rm(tmp, { force: true });
        }
      },
      abort: async () => {
        await close();
        await rm(tmp, { force: true });
      },
    };
  }

  // Links the finished temporary file to its key, or accepts the same bytes already there (hashed as a stream).
  private async place(tmp: string, target: string, key: string, sha256: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.hardLinks) {
          try {
            await this.link(tmp, target);
            return;
          } catch (error) {
            const code = errorCode(error);
            if (code === 'EEXIST') throw error;
            if (code === undefined || !NO_HARD_LINKS.has(code)) throw error;
            if (this.hardLinks) this.log(`${this.root} does not support hard links (${code}); writes fall back to a rename onto a free key.`);
            this.hardLinks = false;
          }
        }
        // No hard links: the key must be free (stat), then the file moves there.
        try {
          await stat(target);
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
        await rename(tmp, target);
        return;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      // The key exists: the same bytes dedupe, other bytes conflict. Deleted in between: create it once more.
      let existing: string;
      try {
        existing = await hashFile(target);
      } catch (error) {
        if (errorCode(error) === 'ENOENT' && attempt < 2) continue;
        throw error;
      }
      if (existing !== sha256) throw new BlobConflictError(key);
      return;
    }
  }

  // Runs create() until it makes the key, or compares the bytes already stored there. Returns false when link()
  // showed that the filesystem has no hard links, so the caller falls back to an exclusive create.
  private async createOrCompare(key: string, sha256: string, create: () => Promise<void>, linking: boolean): Promise<boolean> {
    const target = this.path(key);
    // A key deleted between EEXIST and the read-back is created once more; a second disappearance is an error.
    for (let attempt = 1; ; attempt++) {
      try {
        await create();
        await syncDirectory(dirname(target));
        return true;
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'EEXIST') {
          if (linking && code !== undefined && NO_HARD_LINKS.has(code)) {
            // Concurrent puts can all find out at once; warn only the first time.
            if (this.hardLinks) this.log(
              `${this.root} does not support hard links (${code}); writes fall back to an exclusive create, which ` +
                'concurrent readers can see half written and a crash can leave truncated. Use a local filesystem.',
            );
            this.hardLinks = false;
            return false;
          }
          throw error;
        }
      }
      let stored: Uint8Array;
      try {
        stored = await this.get(key);
      } catch (error) {
        if (error instanceof BlobNotFoundError && attempt < 2) continue;
        throw error;
      }
      if (sha256Hex(stored) !== sha256) throw new BlobConflictError(key);
      return true;
    }
  }

  // Removes temporary files that a crashed put left behind, once they are older than maxAgeMs. It looks only where
  // put writes (inbound/, org/<org_id>/, export/<org_id>/ and conversation/<org_id>/) and only at the names put gives its temporary files,
  // so it never touches a blob. Returns how many it removed. Called once at startup.
  async sweepTempFiles(maxAgeMs: number = STALE_TEMP_AGE_MS): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const dirs = [join(this.root, 'inbound')];
    for (const top of ['org', 'export', 'conversation']) {
      for (const org of await entries(join(this.root, top))) {
        if (org.isDirectory() && UUID_DIR.test(org.name)) dirs.push(join(this.root, top, org.name));
      }
    }
    let removed = 0;
    for (const dir of dirs) {
      for (const entry of await entries(dir)) {
        if (!entry.isFile() || !TEMP_FILE.test(entry.name)) continue;
        const file = join(dir, entry.name);
        try {
          if ((await stat(file)).mtimeMs >= cutoff) continue;
          await rm(file);
          removed++;
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      }
    }
    return removed;
  }

  // One copy per key (see put), so the generation selects nothing; readVerified checks the bytes. With maxBytes, a
  // larger file is refused by its size before it is read (a blob is never rewritten in place, see put).
  async get(key: string, _generation?: string | null, maxBytes?: number): Promise<Uint8Array> {
    assertReadCap(maxBytes);
    const target = this.path(key);
    try {
      if (maxBytes === undefined) return new Uint8Array(await readFile(target));
      const handle = await open(target, 'r');
      try {
        if ((await handle.stat()).size > maxBytes) throw new BlobTooLargeError(key, maxBytes);
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new BlobNotFoundError(key);
      throw error;
    }
  }

  async getRange(key: string, start: number, end: number, _generation?: string | null, maxBytes?: number): Promise<Uint8Array> {
    assertStorageKey(key);
    assertReadCap(maxBytes);
    assertRange(start, end);
    const length = end - start + 1;
    if (maxBytes !== undefined && length > maxBytes) {
      throw new BlobTooLargeError(key, maxBytes);
    }
    const target = this.path(key);
    try {
      const handle = await open(target, 'r');
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, start);
        return new Uint8Array(buf.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof BlobTooLargeError) throw error;
      if (errorCode(error) === 'ENOENT') throw new BlobNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  // Lists inbound/<id> or export/<org_id>/<sha256> files in key order. The directories are walked once per call and
  // only the smallest keys after `after` are kept (one more than the limit, to know whether more remain), so memory
  // stays bounded by the page however many files there are. Temporary files of put are skipped.
  async list(prefix: ListPrefix, after: string | null, limit: number): Promise<BlobListing> {
    assertListArgs(prefix, after, limit);
    const keep = limit + 1;
    let page: string[] = [];
    const consider = (key: string) => {
      if (!isListedKey(prefix, key) || (after !== null && key <= after)) return;
      page.push(key);
      if (page.length >= keep * 4) page = page.sort().slice(0, keep);
    };
    if (prefix === 'inbound/') {
      for await (const entry of walk(join(this.root, 'inbound'))) if (entry.isFile()) consider(`inbound/${entry.name}`);
    } else {
      for await (const org of walk(join(this.root, 'export'))) {
        if (!org.isDirectory() || !UUID_DIR.test(org.name)) continue;
        // Every key of a directory before the cursor's directory sorts before the cursor.
        if (after !== null && `export/${org.name}/` < after.slice(0, 'export/'.length + 37)) continue;
        for await (const entry of walk(join(this.root, 'export', org.name))) if (entry.isFile()) consider(`export/${org.name}/${entry.name}`);
      }
    }
    page = page.sort().slice(0, keep);
    const keys = page.slice(0, limit);
    const blobs: ListedBlob[] = [];
    for (const key of keys) {
      try {
        blobs.push({ key, lastModified: (await stat(this.path(key))).mtime });
      } catch (error) {
        // Deleted since the walk: not listed.
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    return { blobs, next: page.length > limit ? (keys.at(-1) ?? null) : null };
  }
}

// The entries of a directory one by one, or none when it does not exist yet.
async function* walk(dir: string): AsyncGenerator<Dirent> {
  let handle;
  try {
    handle = await opendir(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  for await (const entry of handle) yield entry;
}

// The entries of a directory, or none when it does not exist yet.
async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}
