// SPDX-License-Identifier: AGPL-3.0-only
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@ludy/kernel-runtime';
import {
  acquireAdvisoryXactLock,
  acquireAdvisoryXactLockShared,
  acquireChannelLocks,
  acquireChannelLocksForStoredRow,
  acquireNoteVyLock,
  advisoryLockKey,
  noteVyLockKey,
} from '../src/advisory-lock.ts';

function createCapturingDb() {
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
  return { db, executed };
}

describe('shared PostgreSQL transaction advisory lock helper (#3447)', () => {
  it('builds canonical colon-delimited lock keys and rejects empty segments', () => {
    expect(advisoryLockKey('ludy_hr.interview', 'org-1', 'user-2')).toBe('ludy_hr.interview:org-1:user-2');
    expect(advisoryLockKey('  ludy_hr.interview ', ' org-1 ')).toBe('ludy_hr.interview:org-1');
    expect(() => advisoryLockKey('')).toThrow(/non-empty namespace/);
    expect(() => advisoryLockKey('   ')).toThrow(/non-empty namespace/);
    expect(() => advisoryLockKey('ludy_hr.interview', 'org-1', '')).toThrow(/non-empty key parts/);
    expect(() => advisoryLockKey('ludy_hr.interview', '   ')).toThrow(/non-empty key parts/);
  });

  it('executes parameterized pg_advisory_xact_lock(hashtextextended(key, 0)) on the given transaction', async () => {
    const { db, executed } = createCapturingDb();

    await expect(acquireAdvisoryXactLock(db as unknown as CommandContext['trx'], '   ')).rejects.toThrow(/non-empty lock key/);
    expect(executed).toHaveLength(0);

    const key = advisoryLockKey('ludy_hr.interview', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002');
    await acquireAdvisoryXactLock(db as unknown as CommandContext['trx'], key);
    await db.destroy();

    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toBe('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))');
    expect(executed[0]?.parameters).toEqual([key]);
  });

  it('acquires channel locks via advisoryLockKey in global handover -> per-org order, trims segments, and fails fast on empty parts (#5047)', async () => {
    const { db, executed } = createCapturingDb();
    const trx = db as unknown as CommandContext['trx'];

    await expect(acquireChannelLocks(trx, '   ', 'whatsapp', '10400000001000')).rejects.toThrow(/non-empty key parts/);
    await expect(acquireChannelLocks(trx, 'org-1', '   ', '10400000001000')).rejects.toThrow(/non-empty key parts/);
    await expect(acquireChannelLocks(trx, 'org-1', 'whatsapp', '   ')).rejects.toThrow(/non-empty key parts/);
    expect(executed).toHaveLength(0);

    await acquireChannelLocks(trx, ' org-1 ', ' whatsapp ', ' 10400000001000 ');
    await acquireChannelLocks(trx, ' org-1 ', ' github_app ', ' 777123 ');
    await acquireChannelLocks(trx, 'org-2', 'facebook_page', 'page-99');
    await db.destroy();

    expect(executed.map((q) => q.parameters)).toEqual([
      ['ludy.whatsapp_handover:10400000001000'],
      ['crove.channel:org-1:whatsapp:10400000001000'],
      ['ludy.github_app_handover:777123'],
      ['crove.channel:org-1:github_app:777123'],
      ['crove.channel:org-2:facebook_page:page-99'],
    ]);
  });

  it('keeps stored-row disconnect/revoke locks functional for legacy whitespace-only external_account_id rows (#5047)', async () => {
    const { db, executed } = createCapturingDb();
    const trx = db as unknown as CommandContext['trx'];

    await expect(acquireChannelLocksForStoredRow(trx, '   ', 'whatsapp', '   ')).rejects.toThrow(/non-empty key parts/);
    await expect(acquireChannelLocksForStoredRow(trx, 'org-1', '   ', '   ')).rejects.toThrow(/non-empty key parts/);
    expect(executed).toHaveLength(0);

    await acquireChannelLocksForStoredRow(trx, 'org-1', 'whatsapp', '   ');
    await acquireChannelLocksForStoredRow(trx, 'org-1', 'github_app', '   ');
    await acquireChannelLocksForStoredRow(trx, 'org-2', 'facebook_page', '   ');
    await acquireChannelLocksForStoredRow(trx, ' org-3 ', ' whatsapp ', ' 10400000009999 ');
    await acquireChannelLocksForStoredRow(trx, ' org-3 ', ' github_app ', ' 999888 ');
    await db.destroy();

    expect(executed.map((q) => q.parameters)).toEqual([
      ['ludy.whatsapp_handover:'],
      ['crove.channel:org-1:whatsapp:'],
      ['ludy.github_app_handover:'],
      ['crove.channel:org-1:github_app:'],
      ['crove.channel:org-2:facebook_page:'],
      ['ludy.whatsapp_handover:10400000009999'],
      ['crove.channel:org-3:whatsapp:10400000009999'],
      ['ludy.github_app_handover:999888'],
      ['crove.channel:org-3:github_app:999888'],
    ]);
  });

  it('acquires lowercase canonical shared advisory locks via acquireAdvisoryXactLockShared and acquireNoteVyLock (#4725)', async () => {
    const executed: CompiledQuery[] = [];
    let currentIso = 'read committed';
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
              if (compiledQuery.sql.includes("current_setting('transaction_isolation')")) {
                return { rows: [{ iso: currentIso } as unknown as R] };
              }
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

    await expect(acquireAdvisoryXactLockShared(db as unknown as CommandContext['trx'], ' ')).rejects.toThrow(/non-empty lock key/);
    const orgUpper = '00000000-0000-7000-8000-0000000000AA';
    expect(noteVyLockKey(orgUpper)).toBe(`ludy.note_vy:${orgUpper.toLowerCase()}`);

    await acquireNoteVyLock(db as unknown as CommandContext['trx'], orgUpper);
    expect(executed).toHaveLength(2);
    expect(executed[0]?.sql).toBe("SELECT pg_catalog.current_setting('transaction_isolation') AS iso");
    expect(executed[1]?.sql).toBe('SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1, 0))');
    expect(executed[1]?.parameters).toEqual([`ludy.note_vy:${orgUpper.toLowerCase()}`]);

    currentIso = 'repeatable read';
    await expect(acquireNoteVyLock(db as unknown as CommandContext['trx'], orgUpper)).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
    expect(executed).toHaveLength(3);
    await db.destroy();
  });
});
