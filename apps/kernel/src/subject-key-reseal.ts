// SPDX-License-Identifier: AGPL-3.0-only
// Wraps the subject keys again after a credential key rotation (#2643, ADR-0017 section 7). With CREDENTIAL_KEY set to the new key and CREDENTIAL_KEY_PREVIOUS to the old one, the
// worker reads the subject keys still wrapped under another key id, wraps each data key again under the current one in its own memory (SubjectVault.rewrap), and writes them through
// the system command kernel.subject_key.reseal, one org at a time. Once none is left under an older key, CREDENTIAL_KEY_PREVIOUS can go (docs/runbooks/credential-key.md).
//
// Only wrapped data keys move: no sealed value is read or changed, and the database never sees a data key. The pass reads only rows under a key id its vault opens, so rows under a lost
// key never crowd the others out of a page; they stay in the database and are reported with their count (the key was lost, or CREDENTIAL_KEY_PREVIOUS removed too early). A row under
// an openable key that still does not unwrap (damaged bytes) is counted as failed and left as it is, never dropped. Key ids and counts are all that is logged.
import type { Db } from '@crove/db';
import type { Runtime } from '@crove/kernel-runtime';

// The vault is the runtime's own (Runtime.subjectKeyReseal): the worker's runtime is built like the API's, so the pass wraps under the key the API opens, never under one taken from another source.
export interface SubjectKeyResealDeps {
  runtime: Runtime;
  workerDb: Db;
}

export interface SubjectKeyResealOutcome {
  resealed: number;
  failed: number;
  // Subject keys still under a key other than the current one.
  left: number;
  // Of those, the ones under a key id the vault cannot open: they never reseal.
  unopenable: Array<{ keyId: string; count: number }>;
  skipped: boolean;
}

// The pass itself is in credential-reseal.ts: that file is the one the write-path invariant lists as holding a worker handle (apps/kernel/test/invariant/write-path.test.ts).
export { resealSubjectKeys } from './credential-reseal.ts';

// What a pass logs for subject keys under a key the worker cannot open: the key was lost, or CREDENTIAL_KEY_PREVIOUS removed before they were resealed. Key ids and counts only.
export function unopenableSubjectKeysLog(keys: ReadonlyArray<{ keyId: string; count: number }>): string[] {
  if (keys.length === 0) return [];
  return [
    `[subject-key-reseal] ERROR subject keys wrapped under a key this worker cannot open: ${keys.map((k) => `${k.keyId} (${k.count})`).join('; ')}. ` +
      'The key was lost, or CREDENTIAL_KEY_PREVIOUS removed before they were resealed: set that key again as CREDENTIAL_KEY_PREVIOUS on the API and the worker. ' +
      'Without it the values sealed under those subjects can never be opened (docs/runbooks/credential-key.md)',
  ];
}
