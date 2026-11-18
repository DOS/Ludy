// SPDX-License-Identifier: AGPL-3.0-only
// A keyed hash of a short value a module needs to compare but never to read back (#3113: "is this the same bank account", "did the account change"). HMAC-SHA256 under a key that HKDF
// derives from the deployment's key material for one purpose and one org (domain separation: the same value in two orgs, or under two purposes, gives two unrelated hashes). The key never
// leaves the runtime: not the database, not a log, not an error. The hash is not reversible and, unlike a plain SHA-256 of a short number, cannot be guessed offline without the server key.
// It survives the shred of a subject's key by design (it is not sealed under it); brute-forcing it needs the server key.
import { createHmac, hkdfSync } from 'node:crypto';

/** The HKDF info prefix; the purpose and the org follow it. */
export const KEYED_HASH_DOMAIN = 'crove.keyed-hash.v1';
export const KEYED_HASH_MAX_VALUE_BYTES = 4096;
const PURPOSE = /^[a-z][a-z0-9_.]{0,63}$/;
const ORG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class KeyedHashError extends Error {
  override name = 'KeyedHashError';
}

/** The lowercase hex HMAC-SHA256 of `value` under the key derived for `purpose` and `orgId` from `root` (the deployment's derived secret). */
export function keyedHash(root: Buffer, orgId: string, purpose: string, value: string): string {
  if (!PURPOSE.test(purpose)) throw new KeyedHashError('keyedHash: the purpose is malformed');
  if (!ORG.test(orgId)) throw new KeyedHashError('keyedHash: the org is malformed');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > KEYED_HASH_MAX_VALUE_BYTES) throw new KeyedHashError('keyedHash: the value must be 1 byte to 4 KiB');
  const key = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), `${KEYED_HASH_DOMAIN}|${purpose}|${orgId}`, 32));
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}
