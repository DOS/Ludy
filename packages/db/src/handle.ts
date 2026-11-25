// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema.ts';

// The handle every query helper takes: the pool's Kysely or the Transaction of a command. It names both classes on purpose. A
// Transaction<Database> is a Kysely<Database> by inheritance, but TypeScript compares the two structurally, and the generic
// $omitTables, $pickTables and withTables of the subclass make it pair every table name with every other: with N tables that is
// N * N unions, which passes the compiler's 100000 limit at 317 tables (TS2590, #5026). Written as this union, a transaction is
// identical to one member and no comparison runs; the inherited methods have the same type on both members, so calls behave as before.
// A signature that asks for `Kysely<Database>` alone and is handed a transaction brings the comparison back: take `Db` instead.
export type Db = Kysely<Database> | Transaction<Database>;
