// SPDX-License-Identifier: AGPL-3.0-only
// Seals one person's personal values under that person's own key (ADR-0017 sections 2 to 4, #2640), so a value can sit in a row that cannot
// change and still be erased: deleting the subject's key (crove_kernel.subject_key_shred) makes every value sealed under it unreadable.
//
// Three layers, as the credential vault (vault.ts, ADR-0025):
// - the wrap key: HKDF-SHA256 of the deployment's credential key (the broker derives it, never the database holds it), one per credential key
//   id so a key kept in CREDENTIAL_KEY_PREVIOUS still opens what it wrapped;
// - the subject's data key: 32 random bytes, wrapped under the wrap key with the org, the subject and the key id as authenticated data;
// - the value: AES-256-GCM under the data key with the org, the subject and the value's place (`<schema>.<table>.<column>`) as authenticated data.
// Every wrap and every seal draws a fresh 96-bit nonce. A wrapped key or a sealed value moved to another org, subject or place does not open.
//
// A sealed value is the text `crove:s1:<subject id>:<base64url(nonce | tag | ciphertext)>`; a wrapped key is `nonce | tag | wrapped key` (60 bytes).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE = 12;
const TAG = 16;
const KEY = 32;
const DOMAIN = 'crove.subject.v1';
const PREFIX = 'crove:s1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WRAPPED_SUBJECT_KEY_BYTES = NONCE + TAG + KEY;
// A personal value is short (an identity number, a bank account); the column allows more, a seal does not.
export const MAX_SEALED_VALUE_BYTES = 4096;

/** The HKDF info the wrap key of the subject vault is derived with, from each credential key. */
export const SUBJECT_WRAP_INFO = `${DOMAIN}|wrap`;

export class SubjectKeyError extends Error {
  override name = 'SubjectKeyError';
}

export interface SubjectWrapKey {
  /** The id of the credential key this wrap key derives from (the same id the credential vault gives it). */
  id: string;
  key: Buffer;
}

function aad(layer: 'wrap' | 'data', orgId: string, subjectId: string, last: string): Buffer {
  for (const part of [orgId, subjectId, last]) {
    if (part.length === 0 || part.includes('\u0000')) throw new SubjectKeyError('invalid subject binding');
  }
  return Buffer.from([DOMAIN, layer, orgId, subjectId, last].join('\u0000'), 'utf8');
}

function encrypt(key: Buffer, plaintext: Buffer, additional: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additional);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decrypt(key: Buffer, packed: Buffer, additional: Buffer): Buffer {
  if (packed.length < NONCE + TAG) throw new SubjectKeyError('damaged envelope');
  const nonce = packed.subarray(0, NONCE);
  const tag = packed.subarray(NONCE, NONCE + TAG);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
  decipher.setAAD(additional);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(packed.subarray(NONCE + TAG)), decipher.final()]);
}

/** A sealed value split into its subject and its packed bytes, or null when the text is not a sealed value. */
export function parseSealed(text: string): { subjectId: string; packed: Buffer } | null {
  if (!text.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length);
  const at = rest.indexOf(':');
  if (at !== 36) return null;
  const subjectId = rest.slice(0, at);
  if (!UUID.test(subjectId)) return null;
  const body = rest.slice(at + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  return { subjectId, packed: Buffer.from(body, 'base64url') };
}

export class SubjectVault {
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly current: SubjectWrapKey;

  /** The first key wraps; every key unwraps (the others are the previous credential keys kept during a rotation). */
  constructor(keys: readonly SubjectWrapKey[]) {
    const [current] = keys;
    if (!current) throw new SubjectKeyError('the subject vault needs a key');
    const map = new Map<string, Buffer>();
    for (const k of keys) {
      if (k.key.length !== KEY) throw new SubjectKeyError('a subject wrap key must be 32 bytes');
      map.set(k.id, Buffer.from(k.key));
    }
    this.keys = map;
    this.current = { id: current.id, key: Buffer.from(current.key) };
  }

  get keyId(): string {
    return this.current.id;
  }

  /** A new data key for a subject, with its wrapped form for crove_kernel.subject_key. The caller wipes `dataKey` when done. */
  newDataKey(orgId: string, subjectId: string): { dataKey: Buffer; keyId: string; wrapped: Buffer } {
    const dataKey = randomBytes(KEY);
    try {
      return { dataKey, keyId: this.current.id, wrapped: encrypt(this.current.key, dataKey, aad('wrap', orgId, subjectId, this.current.id)) };
    } catch (error) {
      dataKey.fill(0);
      throw error;
    }
  }

  /** The subject's data key from its stored wrapped form. Throws when the key id is unknown, the bytes are damaged, or the key belongs to another org or subject. */
  unwrap(orgId: string, subjectId: string, keyId: string, wrapped: Buffer): Buffer {
    const wrapKey = this.keys.get(keyId);
    if (!wrapKey) throw new SubjectKeyError(`subject key wrapped under an unknown key (${keyId})`);
    if (wrapped.length !== WRAPPED_SUBJECT_KEY_BYTES) throw new SubjectKeyError('subject key envelope is damaged');
    try {
      return decrypt(wrapKey, wrapped, aad('wrap', orgId, subjectId, keyId));
    } catch (error) {
      if (error instanceof SubjectKeyError) throw error;
      throw new SubjectKeyError('subject key does not open: damaged, or wrapped for another org or subject');
    }
  }

  seal(dataKey: Buffer, orgId: string, subjectId: string, place: string, value: string): string {
    const plain = Buffer.from(value, 'utf8');
    try {
      if (plain.length === 0 || plain.length > MAX_SEALED_VALUE_BYTES) throw new SubjectKeyError('a sealed value must be 1 byte to 4 KiB');
      return `${PREFIX}${subjectId}:${encrypt(dataKey, plain, aad('data', orgId, subjectId, place)).toString('base64url')}`;
    } finally {
      plain.fill(0);
    }
  }

  open(dataKey: Buffer, orgId: string, subjectId: string, place: string, packed: Buffer): string {
    try {
      return decrypt(dataKey, packed, aad('data', orgId, subjectId, place)).toString('utf8');
    } catch (error) {
      if (error instanceof SubjectKeyError) throw error;
      throw new SubjectKeyError('sealed value does not open: damaged, or sealed for another org, subject or place');
    }
  }
}
