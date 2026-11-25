// SPDX-License-Identifier: AGPL-3.0-only
// WIP experiment 3 for #5026 (never merged in this form): which part of the first headroom test hit TS2590 at 400 tables.
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Db } from '../src/index.ts';
import type { Database } from '../src/schema.ts';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type TableName = `t${'0' | '1' | '2' | '3'}${Digit}${Digit}`;
type Wide = { [N in TableName]: { id: string; name: string } };
type WideDb = Kysely<Wide> | Transaction<Wide>;

function takesWide(_db: WideDb): void {}

// F1: a function with a body, a transaction passed as the union handle.
export function f1(tx: Transaction<Wide>) {
  takesWide(tx);
}
// F2: the pool handle passed as the union handle.
export function f2(pool: Kysely<Wide>) {
  takesWide(pool);
}
// F3: queries through the transaction and through the union.
export function f3(tx: Transaction<Wide>, handle: WideDb) {
  return [tx.selectFrom('t399').select('id'), handle.selectFrom('t000').selectAll()] as const;
}

describe('experiment 3', () => {
  it('compiles', () => {
    expect([f1, f2, f3].length).toBe(3);
  });

  // F4: the real Db pinned with the identity assertion of expect-type.
  it('pins Db', () => {
    expectTypeOf<Db>().toEqualTypeOf<Kysely<Database> | Transaction<Database>>();
  });
});
