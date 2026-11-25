// SPDX-License-Identifier: AGPL-3.0-only
// WIP experiment for #5026 (never merged in this form): at which schema size does passing a Transaction as the union handle, and as the plain Kysely, hit TS2590.
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type Row = { id: string; name: string };
type N300 = `t${'0' | '1' | '2'}${Digit}${Digit}`;
type N330 = N300 | `t3${'0' | '1' | '2'}${Digit}`;
type N350 = N300 | `t3${'0' | '1' | '2' | '3' | '4'}${Digit}`;
type N400 = `t${'0' | '1' | '2' | '3'}${Digit}${Digit}`;
type W300 = { [N in N300]: Row };
type W330 = { [N in N330]: Row };
type W350 = { [N in N350]: Row };
type W400 = { [N in N400]: Row };

// A: the union handle, smallest first.
declare function unionTakes300(db: Kysely<W300> | Transaction<W300>): void;
declare function unionTakes330(db: Kysely<W330> | Transaction<W330>): void;
declare function unionTakes350(db: Kysely<W350> | Transaction<W350>): void;
declare function unionTakes400(db: Kysely<W400> | Transaction<W400>): void;
// B: the plain Kysely handle (the structural comparison), controls.
declare function plainTakes300(db: Kysely<W300>): void;
declare function plainTakes330(db: Kysely<W330>): void;

export function experiments(t300: Transaction<W300>, t330: Transaction<W330>, t350: Transaction<W350>, t400: Transaction<W400>) {
  unionTakes300(t300);
  unionTakes330(t330);
  unionTakes350(t350);
  unionTakes400(t400);
  plainTakes300(t300);
  plainTakes330(t330);
}

describe('experiment', () => {
  it('compiles', () => {
    expect(typeof experiments).toBe('function');
  });
});
