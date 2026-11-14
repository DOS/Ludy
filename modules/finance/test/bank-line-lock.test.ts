// SPDX-License-Identifier: AGPL-3.0-only
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { QueryContext } from '@crove/kernel-runtime';
import { lockBankLine } from '../src/bank-match.ts';

// The key of the lock a bank line's writers take is built from the line's id: the database builds it from the uuid's own text (lower case), and a stored proposal may carry the id in another case
// (the contract's zId only validates), so the lock must lower it or two writers of one line would take two locks (#2516).
const ORG = '0192a000-0000-7000-8000-0000000000aa';
const LINE = '0192a000-0000-7000-8000-0000000000bb';

async function keyOf(id: string): Promise<unknown> {
  const seen: unknown[][] = [];
  const trx = new Kysely<never>({
    dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(), createIntrospector: (db) => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler() },
    log: (event) => {
      if (event.level === 'query') seen.push([...event.query.parameters]);
    },
  });
  await lockBankLine({ orgId: ORG, trx } as unknown as QueryContext, id);
  return seen[0]?.[0];
}

describe('the bank line lock', () => {
  it('takes the same key for an id in upper case and in lower case', async () => {
    const lower = await keyOf(LINE);
    expect(lower).toBe(`crove_finance.bank_line:${ORG}:${LINE}`);
    expect(await keyOf(LINE.toUpperCase())).toBe(lower);
  });
});
