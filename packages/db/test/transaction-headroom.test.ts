// SPDX-License-Identifier: AGPL-3.0-only
// Headroom of the database handle (#5026). These are type-level checks: `pnpm typecheck` enforces them; the test run only executes the
// trivial assertions below. Kysely's Transaction<DB> extends Kysely<DB>, but TypeScript compares the two structurally, and the generic
// $omitTables, $pickTables and withTables of the subclass pair every table name with every other: N tables make N * N unions, which passes
// the compiler's 100000 limit at 317 tables (TS2590). `Db` therefore names both classes, so a transaction is identical to a union member and
// nothing is compared. A schema of 400 tables, far past the old limit, must keep typechecking when a transaction is passed as the handle.
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Db } from '../src/index.ts';
import type { Database } from '../src/schema.ts';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
// The names t000 to t399.
type TableName = `t${'0' | '1' | '2' | '3'}${Digit}${Digit}`;
type Wide = { [N in TableName]: { id: string; name: string } };
type WideDb = Kysely<Wide> | Transaction<Wide>;

function takesWide(_db: WideDb): void {}

// Compiled, never run: a command's transaction and the pool's handle both pass as the handle, and queries still type.
function compileOnly(tx: Transaction<Wide>, pool: Kysely<Wide>, handle: WideDb) {
  takesWide(tx);
  takesWide(pool);
  return [tx.selectFrom('t399').select('id'), handle.selectFrom('t000').selectAll()] as const;
}

describe('the database handle', () => {
  it('takes a Transaction at 400 tables (the union form has headroom)', () => {
    expect(typeof compileOnly).toBe('function');
  });

  it('is the union of the pool handle and the transaction, so no structural comparison runs', () => {
    expectTypeOf<Db>().toEqualTypeOf<Kysely<Database> | Transaction<Database>>();
  });
});
