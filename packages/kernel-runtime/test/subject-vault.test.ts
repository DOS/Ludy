// SPDX-License-Identifier: AGPL-3.0-only
// The subject vault (ADR-0017, #2640): a data key per person wrapped under a key derived from the credential key, values sealed under it.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialVault, SUBJECT_WRAP_INFO, SubjectKeyError, SubjectVault, WRAPPED_SUBJECT_KEY_BYTES, parseSealed, parseVaultKey } from '../src/index.ts';

const root = () => parseVaultKey(randomBytes(32).toString('base64'));
const vaultOf = (...roots: ReturnType<typeof root>[]) => new SubjectVault(new CredentialVault(roots).deriveKeys(SUBJECT_WRAP_INFO));
const org = randomUUID();
const subject = randomUUID();
const PLACE = 'crove_hr.payroll_employee.national_id';

describe('SubjectVault', () => {
  it('seals a value that opens under the subject key, and shows nothing of it in the text', () => {
    const vault = vaultOf(root());
    const { dataKey, keyId, wrapped } = vault.newDataKey(org, subject);
    expect(wrapped).toHaveLength(WRAPPED_SUBJECT_KEY_BYTES);
    const sealed = vault.seal(dataKey, org, subject, PLACE, '079123456789');
    expect(sealed).toMatch(new RegExp(`^crove:s1:${subject}:[A-Za-z0-9_-]+$`));
    expect(sealed).not.toContain('079123456789');
    const parsed = parseSealed(sealed);
    expect(parsed?.subjectId).toBe(subject);
    const reopened = vault.unwrap(org, subject, keyId, wrapped);
    expect(vault.open(reopened, org, subject, PLACE, (parsed as NonNullable<typeof parsed>).packed)).toBe('079123456789');
  });

  it('uses a fresh nonce for every wrap and every seal', () => {
    const vault = vaultOf(root());
    const a = vault.newDataKey(org, subject);
    const b = vault.newDataKey(org, subject);
    expect(a.wrapped.subarray(0, 12).equals(b.wrapped.subarray(0, 12))).toBe(false);
    expect(a.dataKey.equals(b.dataKey)).toBe(false);
    expect(vault.seal(a.dataKey, org, subject, PLACE, 'same')).not.toBe(vault.seal(a.dataKey, org, subject, PLACE, 'same'));
  });

  it('does not open a wrapped key for another org, subject or key id', () => {
    const vault = vaultOf(root());
    const { keyId, wrapped } = vault.newDataKey(org, subject);
    expect(() => vault.unwrap(randomUUID(), subject, keyId, wrapped)).toThrow(SubjectKeyError);
    expect(() => vault.unwrap(org, randomUUID(), keyId, wrapped)).toThrow(SubjectKeyError);
    expect(() => vault.unwrap(org, subject, 'k1-unknown', wrapped)).toThrow(/unknown key/);
    const damaged = Buffer.from(wrapped);
    damaged[40] = (damaged[40] ?? 0) ^ 1;
    expect(() => vault.unwrap(org, subject, keyId, damaged)).toThrow(SubjectKeyError);
    expect(() => vault.unwrap(org, subject, keyId, wrapped.subarray(1))).toThrow(/damaged/);
  });

  it('does not open a value for another org, subject or place, or under another key', () => {
    const vault = vaultOf(root());
    const { dataKey } = vault.newDataKey(org, subject);
    const parsed = parseSealed(vault.seal(dataKey, org, subject, PLACE, 'secret')) as NonNullable<ReturnType<typeof parseSealed>>;
    expect(() => vault.open(dataKey, randomUUID(), subject, PLACE, parsed.packed)).toThrow(SubjectKeyError);
    expect(() => vault.open(dataKey, org, randomUUID(), PLACE, parsed.packed)).toThrow(SubjectKeyError);
    expect(() => vault.open(dataKey, org, subject, 'crove_hr.payroll_employee.bank_account', parsed.packed)).toThrow(SubjectKeyError);
    expect(() => vault.open(randomBytes(32), org, subject, PLACE, parsed.packed)).toThrow(SubjectKeyError);
  });

  it('opens after a credential key rotation while the old key is kept, and wraps under the new one', () => {
    const oldRoot = root();
    const newRoot = root();
    const before = vaultOf(oldRoot);
    const { keyId, wrapped } = before.newDataKey(org, subject);
    const after = vaultOf(newRoot, oldRoot);
    expect(after.keyId).not.toBe(keyId);
    expect(() => after.unwrap(org, subject, keyId, wrapped)).not.toThrow();
    expect(() => vaultOf(newRoot).unwrap(org, subject, keyId, wrapped)).toThrow(/unknown key/);
    expect(after.newDataKey(org, subject).keyId).toBe(after.keyId);
  });

  it('derives its wrap key by HKDF, never the credential key itself, and a different key per purpose', () => {
    const k = root();
    const credentials = new CredentialVault([k]);
    const [wrap] = credentials.deriveKeys(SUBJECT_WRAP_INFO);
    expect(wrap?.id).toBe(credentials.keyId);
    expect(wrap?.key.equals(k.key)).toBe(false);
    expect(wrap?.key.equals(credentials.deriveKeys('crove.other.v1')[0]?.key ?? Buffer.alloc(0))).toBe(false);
    expect(credentials.deriveKeys(SUBJECT_WRAP_INFO)[0]?.key.equals(wrap?.key ?? Buffer.alloc(0))).toBe(true);
  });

  it('refuses a value that is empty or over 4 KiB, a vault with no key, and text that is not a sealed value', () => {
    const vault = vaultOf(root());
    const { dataKey } = vault.newDataKey(org, subject);
    expect(() => vault.seal(dataKey, org, subject, PLACE, '')).toThrow(SubjectKeyError);
    expect(() => vault.seal(dataKey, org, subject, PLACE, 'x'.repeat(4097))).toThrow(SubjectKeyError);
    expect(() => new SubjectVault([])).toThrow(SubjectKeyError);
    expect(parseSealed('079123456789')).toBeNull();
    expect(parseSealed(`crove:s1:not-a-uuid:abc`)).toBeNull();
    expect(parseSealed(`crove:s1:${subject}:`)).toBeNull();
  });

  it('wraps a data key again under the current key (rotation, #2643): it opens with the new key alone, the values stay readable, and a fresh nonce is drawn', () => {
    const [oldRoot, newRoot] = [root(), root()];
    const before = vaultOf(oldRoot);
    const { dataKey, keyId, wrapped } = before.newDataKey(org, subject);
    const sealed = before.seal(dataKey, org, subject, PLACE, 'v');
    const rotated = vaultOf(newRoot, oldRoot);
    const next = rotated.rewrap(org, subject, keyId, wrapped);
    expect(next.keyId).toBe(rotated.keyId);
    expect(next.keyId).not.toBe(keyId);
    expect(next.wrapped.length).toBe(WRAPPED_SUBJECT_KEY_BYTES);
    expect(next.wrapped.equals(wrapped)).toBe(false);
    // The previous key is no longer needed: the new vault alone opens the key, and the value sealed before the rotation reads as it did.
    const alone = vaultOf(newRoot);
    const opened = alone.unwrap(org, subject, next.keyId, next.wrapped);
    expect(opened.equals(dataKey)).toBe(true);
    expect(alone.open(opened, org, subject, PLACE, parseSealed(sealed)?.packed ?? Buffer.alloc(0))).toBe('v');
    // Again under the same key: a new nonce each time.
    expect(rotated.rewrap(org, subject, next.keyId, next.wrapped).wrapped.equals(next.wrapped)).toBe(false);
    expect(rotated.keyIds).toEqual([rotated.keyId, keyId]);
  });

  it('refuses to wrap again a key under an unknown key id, damaged bytes, or another org or subject', () => {
    const [oldRoot, newRoot] = [root(), root()];
    const { keyId, wrapped } = vaultOf(oldRoot).newDataKey(org, subject);
    const rotated = vaultOf(newRoot, oldRoot);
    expect(() => vaultOf(newRoot).rewrap(org, subject, keyId, wrapped)).toThrow(/unknown key/);
    expect(() => rotated.rewrap(org, subject, keyId, wrapped.subarray(0, 40))).toThrow(SubjectKeyError);
    expect(() => rotated.rewrap(randomUUID(), subject, keyId, wrapped)).toThrow(SubjectKeyError);
    expect(() => rotated.rewrap(org, randomUUID(), keyId, wrapped)).toThrow(SubjectKeyError);
    const damaged = Buffer.from(wrapped);
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
    expect(() => rotated.rewrap(org, subject, keyId, damaged)).toThrow(SubjectKeyError);
  });
});
