// SPDX-License-Identifier: AGPL-3.0-only
// The real database handle (#5026). A type-level check: `pnpm typecheck` enforces it. `Db` names the pool's Kysely and the Transaction of a
// command, so a transaction is identical to one union member and no structural comparison of the two classes runs (it passes the compiler's
// union limit at 317 tables); this pins that definition, so reverting `Db` to Kysely<Database> alone fails the typecheck.
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Db } from '../src/index.ts';
import type { Database } from '../src/schema.ts';

function takesDb(_db: Db): void {}

// Compiled, never run: a command's transaction and the pool's handle both pass as `Db`.
function compileOnly(tx: Transaction<Database>, pool: Kysely<Database>) {
  takesDb(tx);
  takesDb(pool);
}

describe('Db', () => {
  it('is the union of the pool handle and the transaction', () => {
    expectTypeOf<Db>().toEqualTypeOf<Kysely<Database> | Transaction<Database>>();
    expect(typeof compileOnly).toBe('function');
  });
});
