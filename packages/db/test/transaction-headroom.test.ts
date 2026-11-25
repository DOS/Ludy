// SPDX-License-Identifier: AGPL-3.0-only
// WIP experiment 2 for #5026 (never merged in this form): which query call types at 300, 350 and 400 tables.
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type Row = { id: string; name: string };
type N300 = `t${'0' | '1' | '2'}${Digit}${Digit}`;
type N350 = N300 | `t3${'0' | '1' | '2' | '3' | '4'}${Digit}`;
type N400 = `t${'0' | '1' | '2' | '3'}${Digit}${Digit}`;
type W300 = { [N in N300]: Row };
type W350 = { [N in N350]: Row };
type W400 = { [N in N400]: Row };

export function queries(
  k300: Kysely<W300>,
  k350: Kysely<W350>,
  k400: Kysely<W400>,
  t400: Transaction<W400>,
  u400: Kysely<W400> | Transaction<W400>,
) {
  const a = k300.selectFrom('t000').select('id');
  const b = k350.selectFrom('t000').select('id');
  const c = k400.selectFrom('t000').select('id');
  const d = t400.selectFrom('t399').select('id');
  const e = u400.selectFrom('t000').selectAll();
  return [a, b, c, d, e] as const;
}

describe('experiment 2', () => {
  it('compiles', () => {
    expect(typeof queries).toBe('function');
  });
});
