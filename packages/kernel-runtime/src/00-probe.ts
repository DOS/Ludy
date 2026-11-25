// SPDX-License-Identifier: AGPL-3.0-only
// Throwaway probe for #5026 (never merged). TS2590 is reported at each node that first builds a too-large union, so each line below is a
// separate primitive; the first run showed the error at the $omitTables member comparison.
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '@ludy/db';

type K = Kysely<Database>;
type T = Transaction<Database>;
type Keys = keyof Database;

// Q1..Q5: the building blocks of Omit and Pick over every table name.
export declare const q1: Exclude<Keys, Keys>;
export declare const q2: Omit<Database, Keys>;
export declare const q3: Pick<Database, Keys>;
export declare const q4: Keys & string;
export declare const q5: { [P in Keys]: Database[P] };
// Q6..Q9: the generic table-list methods' return types, with the type parameter at its constraint.
export declare const q6: ReturnType<K['$omitTables']>;
export declare const q7: ReturnType<K['$pickTables']>;
export declare const q8: ReturnType<T['$omitTables']>;
export declare const q9: ReturnType<T['$pickTables']>;
// Q10, Q11: the method types themselves, and one explicit instantiation each.
export declare const q10: K['$omitTables'];
export declare const q11: T['$omitTables'];
export declare const q12: ReturnType<K['$omitTables']> extends infer R ? R : never;
// Q13: a union of two names only, as a control that should always pass.
export declare const q13: Omit<Database, 'ludy_kernel.tenant' | 'ludy_kernel.tenant_member'>;
// Q14: the relation of the two classes, last, after everything above is cached.
declare const tx: Transaction<Database>;
export const q14: Kysely<Database> = tx;
