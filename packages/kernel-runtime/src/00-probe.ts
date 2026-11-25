// SPDX-License-Identifier: AGPL-3.0-only
// Throwaway probe for #5026 (never merged). TS2590 is reported once, at the first node whose check builds the too-large union, so the probes
// run from the narrowest to the widest and this file is sorted before runtime.ts.
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '@ludy/db';

type T = Transaction<Database>;
type K = Kysely<Database>;

// A: one generic method at a time, source Transaction against target Kysely.
declare const mOmitT: T['$omitTables'];
export const pA: K['$omitTables'] = mOmitT;
declare const mPickT: T['$pickTables'];
export const pB: K['$pickTables'] = mPickT;
declare const mWithT: T['withTables'];
export const pC: K['withTables'] = mWithT;
declare const mExtT: T['$extendTables'];
export const pD: K['$extendTables'] = mExtT;
// E: the cheap overrides.
declare const mSchemaT: T['withSchema'];
export const pE1: K['withSchema'] = mSchemaT;
declare const mPluginT: T['withPlugin'];
export const pE2: K['withPlugin'] = mPluginT;
// F: the whole relation without the two table-list methods, then with them, then the call forms runtime.ts and audit-log.ts use.
declare const tx: Transaction<Database>;
export const pF1: Omit<K, '$omitTables' | '$pickTables'> = tx;
export const pF2: Kysely<Database> = tx;
declare function takesUnion(db: Kysely<Database> | Transaction<Database>): void;
export const pF3 = takesUnion(tx);
