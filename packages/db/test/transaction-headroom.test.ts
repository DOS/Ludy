// SPDX-License-Identifier: AGPL-3.0-only
// Headroom of the database handle (#5026). A type-level check: `pnpm typecheck` enforces it, the test run only executes the assertion below.
// Kysely's Transaction<DB> extends Kysely<DB>, but TypeScript compares the two structurally, and the generic $omitTables, $pickTables and
// withTables of the subclass pair every table name with every other: N tables make N * N unions, which passes the compiler's 100000 limit at
// 317 tables (TS2590). A handle written as the union of the two classes needs no comparison, so a schema of 400 tables, far past that limit,
// must keep typechecking when a transaction is passed as the handle.
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
// The names t000 to t399.
type N400 = `t${'0' | '1' | '2' | '3'}${Digit}${Digit}`;
type Wide = { [N in N400]: { id: string } };

declare function takesWide(db: Kysely<Wide> | Transaction<Wide>): void;

// Compiled, never run.
function compileOnly(tx: Transaction<Wide>) {
  takesWide(tx);
}

describe('the database handle at 400 tables', () => {
  it('takes a Transaction through the union of the two classes', () => {
    expect(typeof compileOnly).toBe('function');
  });
});
