// SPDX-License-Identifier: AGPL-3.0-only
// WIP matrix A for #5026 (never merged): no import of the real schema. H1 declared function first, H2 function with a body, distinct row types.
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type N400 = `t${'0' | '1' | '2' | '3'}${Digit}${Digit}`;
type W1 = { [N in N400]: { id: string } };
type W2 = { [N in N400]: { id: number } };

declare function declaredTakes(db: Kysely<W1> | Transaction<W1>): void;
function bodyTakes(_db: Kysely<W2> | Transaction<W2>): void {}

export function h1(t: Transaction<W1>) {
  declaredTakes(t);
}
export function h2(t: Transaction<W2>) {
  bodyTakes(t);
}

describe('matrix A', () => {
  it('runs', () => {
    expect(typeof h1).toBe('function');
    expect(typeof h2).toBe('function');
  });
});
