// SPDX-License-Identifier: AGPL-3.0-only
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@ludy/kernel-runtime';
import { acquireAdvisoryXactLock, advisoryLockKey } from '../src/advisory-lock.ts';

describe('shared PostgreSQL transaction advisory lock helper (#3447)', () => {
  it('builds canonical colon-delimited lock keys and rejects empty segments', () => {
    expect(advisoryLockKey('crove_hr.interview', 'org-1', 'user-2')).toBe('crove_hr.interview:org-1:user-2');
    expect(advisoryLockKey('  crove_hr.interview ', ' org-1 ')).toBe('crove_hr.interview:org-1');
    expect(() => advisoryLockKey('')).toThrow(/non-empty namespace/);
    expect(() => advisoryLockKey('   ')).toThrow(/non-empty namespace/);
    expect(() => advisoryLockKey('crove_hr.interview', 'org-1', '')).toThrow(/non-empty key parts/);
    expect(() => advisoryLockKey('crove_hr.interview', '   ')).toThrow(/non-empty key parts/);
  });

  it('executes parameterized pg_advisory_xact_lock(hashtextextended(key, 0)) on the given transaction', async () => {
    const executed: CompiledQuery[] = [];
    const baseDriver = new DummyDriver();
    const db = new Kysely<unknown>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
        createDriver: () => ({
          ...baseDriver,
          init: async () => undefined,
          acquireConnection: async () => ({
            executeQuery: async <R>(compiledQuery: CompiledQuery) => {
              executed.push(compiledQuery);
              return { rows: [] as R[] };
            },
            streamQuery: async function* <R>(): AsyncIterableIterator<{ rows: R[] }> {
              yield { rows: [] };
            },
          }),
          beginTransaction: async () => undefined,
          commitTransaction: async () => undefined,
          rollbackTransaction: async () => undefined,
          releaseConnection: async () => undefined,
          destroy: async () => undefined,
        }),
      },
    });

    await expect(acquireAdvisoryXactLock(db as unknown as CommandContext['trx'], '   ')).rejects.toThrow(/non-empty lock key/);
    expect(executed).toHaveLength(0);

    const key = advisoryLockKey('crove_hr.interview', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002');
    await acquireAdvisoryXactLock(db as unknown as CommandContext['trx'], key);
    await db.destroy();

    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toBe('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))');
    expect(executed[0]?.parameters).toEqual([key]);
  });
});
