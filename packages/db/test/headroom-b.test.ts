// SPDX-License-Identifier: AGPL-3.0-only
// WIP matrix B for #5026 (never merged): the real schema is imported (and used elsewhere). H3 declared function, H4 function with a body.
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/index.ts';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type N400 = `t${'0' | '1' | '2' | '3'}${Digit}${Digit}`;
type W3 = { [N in N400]: { id: boolean } };
type W4 = { [N in N400]: { id: bigint } };

declare function declaredTakes(db: Kysely<W3> | Transaction<W3>): void;
function bodyTakes(_db: Kysely<W4> | Transaction<W4>): void {}

export function h3(t: Transaction<W3>) {
  declaredTakes(t);
}
export function h4(t: Transaction<W4>) {
  bodyTakes(t);
}
export function usesDb(db: Db) {
  return db;
}

describe('matrix B', () => {
  it('runs', () => {
    expect(typeof h3).toBe('function');
    expect(typeof h4).toBe('function');
    expect(typeof usesDb).toBe('function');
  });
});
