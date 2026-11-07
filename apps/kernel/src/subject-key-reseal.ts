// SPDX-License-Identifier: AGPL-3.0-only
// Wraps the subject keys again after a credential key rotation (#2643, ADR-0017 section 7). With CREDENTIAL_KEY set to the new key and CREDENTIAL_KEY_PREVIOUS to the old one, the
// worker reads the subject keys still wrapped under another key id, wraps each data key again under the current one in its own memory (SubjectVault.rewrap), and writes them through
// the system command kernel.subject_key.reseal, one org at a time. Once none is left under an older key, CREDENTIAL_KEY_PREVIOUS can go (docs/runbooks/credential-key.md).
//
// Only wrapped data keys move: no sealed value is read or changed, and the database never sees a data key. A row the worker cannot unwrap (a key id it does not open, damaged
// bytes) is counted and left as it is, never dropped, and a key id it cannot open is reported with its count (the key was lost, or CREDENTIAL_KEY_PREVIOUS removed too early).
// Key ids and counts are all that is logged.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { SUBJECT_WRAP_INFO, SubjectVault, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { SUBJECT_KEY_RESEAL_BATCH } from '@crove/kernel';
import { workerConnection } from './credential-reseal.ts';

const ACTOR: SystemActor = { type: 'system', component: 'kernel.subject_key.reseal' };
const LOCK_KEY = 'crove.subject-key-reseal';
const RESEAL_LIMIT = SUBJECT_KEY_RESEAL_BATCH;
// At most this many pages a pass; the rest waits for the next pass.
const RESEAL_PAGES = 5;

export interface SubjectKeyResealDeps {
  runtime: Runtime;
  vault: SubjectVault;
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

// The vault of the subject keys from the worker's broker: the wrap keys HKDF-derived from the credential key and CREDENTIAL_KEY_PREVIOUS the same way, the derived buffers wiped
// once the vault holds its own copies. Null when the broker derives none (no credential key).
export function subjectVaultOfBroker(broker: CredentialBroker | undefined): SubjectVault | null {
  const keys = broker?.deriveKeys?.(SUBJECT_WRAP_INFO) ?? [];
  if (keys.length === 0) return null;
  const vault = new SubjectVault(keys);
  for (const k of keys) k.key.fill(0);
  return vault;
}

export async function resealSubjectKeys(deps: SubjectKeyResealDeps): Promise<SubjectKeyResealOutcome> {
  const outcome: SubjectKeyResealOutcome = { resealed: 0, failed: 0, left: 0, unopenable: [], skipped: false };
  const current = deps.vault.keyId;
  return workerConnection(deps.workerDb).execute(async (db) => {
    const { rows: lock } = await sql<{ locked: boolean }>`SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended(${LOCK_KEY}, 0)) AS locked`.execute(db);
    if (!lock[0]?.locked) return { ...outcome, skipped: true };
    try {
      let after = null as { orgId: string; id: string } | null;
      for (let page = 0; page < RESEAL_PAGES; page += 1) {
        const { rows } = await sql<{ org_id: string; id: string; key_id: string; wrapped_key: Buffer }>`
          SELECT org_id, id, key_id, wrapped_key FROM crove_kernel.subject_key_reseal_due(${current}, ${RESEAL_LIMIT}::int, ${after?.orgId ?? null}::uuid, ${after?.id ?? null}::uuid)`.execute(db);
        // Rows come in (org, id) order: one batch per org.
        const byOrg = new Map<string, Array<{ id: string; fromKeyId: string; fromWrapped: string; keyId: string; wrapped: string }>>();
        for (const row of rows) {
          try {
            const next = deps.vault.rewrap(row.org_id, row.id, row.key_id, row.wrapped_key);
            const items = byOrg.get(row.org_id) ?? [];
            items.push({ id: row.id, fromKeyId: row.key_id, fromWrapped: Buffer.from(row.wrapped_key).toString('base64'), keyId: next.keyId, wrapped: next.wrapped.toString('base64') });
            byOrg.set(row.org_id, items);
          } catch (error) {
            // The key id only: never the subject, the bytes or what they wrap.
            outcome.failed += 1;
            console.error(`[subject-key-reseal] a subject key under ${row.key_id} did not unwrap`, error instanceof Error ? error.name : typeof error);
          }
        }
        for (const [orgId, items] of byOrg) {
          try {
            const done = await deps.runtime.execute<{ resealed: number; skipped: number }>('kernel.subject_key.reseal', { items }, { actor: ACTOR, orgId });
            outcome.resealed += done.resealed;
          } catch (error) {
            outcome.failed += items.length;
            console.error(`[subject-key-reseal] org ${createHash('sha256').update(orgId).digest('hex').slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
          }
        }
        const last = rows.at(-1);
        if (!last || rows.length < RESEAL_LIMIT) break;
        after = { orgId: last.org_id, id: last.id };
      }
      const { rows: counts } = await sql<{ key_id: string; n: string }>`SELECT key_id, n FROM crove_kernel.subject_key_key_counts()`.execute(db);
      const openable = new Set(deps.vault.keyIds);
      for (const c of counts) {
        if (c.key_id === current) continue;
        outcome.left += Number(c.n);
        if (!openable.has(c.key_id)) outcome.unopenable.push({ keyId: c.key_id, count: Number(c.n) });
      }
      outcome.unopenable.sort((a, b) => a.keyId.localeCompare(b.keyId));
      return outcome;
    } finally {
      await sql`SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(${LOCK_KEY}, 0))`.execute(db);
    }
  });
}

// What a pass logs for subject keys under a key the worker cannot open: the key was lost, or CREDENTIAL_KEY_PREVIOUS removed before they were resealed. Key ids and counts only.
export function unopenableSubjectKeysLog(keys: ReadonlyArray<{ keyId: string; count: number }>): string[] {
  if (keys.length === 0) return [];
  return [
    `[subject-key-reseal] ERROR subject keys wrapped under a key this worker cannot open: ${keys.map((k) => `${k.keyId} (${k.count})`).join('; ')}. ` +
      'The key was lost, or CREDENTIAL_KEY_PREVIOUS removed before they were resealed: set that key again as CREDENTIAL_KEY_PREVIOUS on the API and the worker. ' +
      'Without it the values sealed under those subjects can never be opened (docs/runbooks/credential-key.md)',
  ];
}
