// SPDX-License-Identifier: AGPL-3.0-only
// Throwaway probe for #5026 (never merged): which member of Transaction<Database> against Kysely<Database> blows the union limit.
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '@ludy/db';

declare const tx: Transaction<Database>;
declare const ky: Kysely<Database>;
type T = Transaction<Database>;
type K = Kysely<Database>;

// P1: the whole relation, as runtime.ts forUser does it.
export const p1: Kysely<Database> = tx;
// P2: a union that names the transaction, as audit-log.ts does.
declare function takesUnion(db: Kysely<Database> | Transaction<Database>): void;
export const p2 = takesUnion(tx);
// P3: the same relation without the two generic table-list methods.
export const p3: Omit<K, '$omitTables' | '$pickTables'> = tx;
// P4..P9: one member each, source Transaction against target Kysely.
declare const mOmitT: T['$omitTables'];
export const p4: K['$omitTables'] = mOmitT;
declare const mPickT: T['$pickTables'];
export const p5: K['$pickTables'] = mPickT;
declare const mWithT: T['withTables'];
export const p6: K['withTables'] = mWithT;
declare const mExtT: T['$extendTables'];
export const p7: K['$extendTables'] = mExtT;
declare const mSchemaT: T['withSchema'];
export const p8: K['withSchema'] = mSchemaT;
declare const mPluginT: T['withPlugin'];
export const p9: K['withPlugin'] = mPluginT;
// P10: the reverse (target is the subclass) is not expected to hold; skipped on purpose. P11: the base alone is cheap.
export const p11: Kysely<Database> = ky;
