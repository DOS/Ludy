// SPDX-License-Identifier: AGPL-3.0-only
// WIP experiment 4 for #5026 (never merged in this form).
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Db } from '../src/index.ts';
import type { Database } from '../src/schema.ts';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type TableName = `t${'0' | '1' | '2' | '3'}${Digit}${Digit}`;
type Wide = { [N in TableName]: { id: string; name: string } };
type WideDb = Kysely<Wide> | Transaction<Wide>;

function takesWide(_db: WideDb): void {}
function takesDb(_db: Db): void {}

// G1: the union handle at 400 tables, a function with a body (no array literal anywhere).
export function g1(tx: Transaction<Wide>) {
  takesWide(tx);
}
// G2: the real handle type with the real schema.
export function g2(tx: Transaction<Database>, pool: Kysely<Database>) {
  takesDb(tx);
  takesDb(pool);
}
// G3: queries through the real handle (what every module does).
export function g3(db: Db) {
  return db.selectFrom('ludy_kernel.tenant').select('id');
}

describe('experiment 4', () => {
  it('runs', () => {
    expect(typeof g1).toBe('function');
    expect(typeof g2).toBe('function');
    expect(typeof g3).toBe('function');
  });
});

describe('experiment 4, expectTypeOf', () => {
  // G4: the real Db pinned with the identity assertion of expect-type.
  it('pins Db', () => {
    expectTypeOf<Db>().toEqualTypeOf<Kysely<Database> | Transaction<Database>>();
  });
});
