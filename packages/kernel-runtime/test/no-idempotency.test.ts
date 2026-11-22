// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for CommandDef.noIdempotency registration and nested execution guards (#3428).
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Database, Db } from '@ludy/db';
import { Runtime, defineCommand, type UserActor } from '../src/runtime.ts';

const ORG = '01900000-0000-7000-8000-000000000001';
const USER: UserActor = { type: 'user', userId: '01900000-0000-7000-8000-0000000000aa', aal: 'aal1' };

function fakeDb(role: string): Db {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const rows = /crove_kernel\.enter_(?:user_)?context\(/.test(query.sql)
        ? [{ role }]
        : /pg_attribute/.test(query.sql)
          ? [{ present: true }]
          : /"apps_off"/.test(query.sql)
            ? [{ apps_off: [] }]
            : [];
      return { rows: rows as R[] };
    },
    // oxlint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

describe('Runtime noIdempotency guards (#3428)', () => {
  it('refuses proposal and proposal_revision commands declaring noIdempotency at registration', () => {
    const db = fakeDb('owner');
    const base = {
      input: z.object({}),
      risk: 'R2' as const,
      sideEffect: 'internal' as const,
      handler: async () => ({ token: 'secret' }),
    };

    expect(() =>
      new Runtime(db, { manifests: [] }).register({
        commands: [defineCommand({ ...base, name: 'kernel.prop_bad', access: 'proposal', noIdempotency: true })],
      }),
    ).toThrow(/proposal or proposal_revision command cannot declare noIdempotency/);

    expect(() =>
      new Runtime(db, { manifests: [] }).register({
        commands: [
          defineCommand({ ...base, name: 'kernel.prop_base', access: 'proposal' }),
          defineCommand({
            ...base,
            name: 'kernel.prop_rev_bad',
            access: 'proposal_revision',
            revises: 'kernel.prop_base',
            noIdempotency: true,
          }),
        ],
      }),
    ).toThrow(/proposal or proposal_revision command cannot declare noIdempotency/);
  });

  it('refuses ctx.run and ctx.tryRun of a noIdempotency command from an unflagged caller while allowing a flagged caller', async () => {
    const db = fakeDb('owner');
    const flaggedLeaf = defineCommand({
      name: 'kernel.flagged_leaf',
      input: z.object({}),
      risk: 'R1',
      sideEffect: 'internal',
      access: ['owner'],
      noIdempotency: true,
      handler: async () => ({ raw: 'one-time' }),
    });
    const caughtInside: string[] = [];
    const unflaggedCaller = defineCommand({
      name: 'kernel.unflagged_caller',
      input: z.object({}),
      risk: 'R1',
      sideEffect: 'internal',
      access: ['owner'],
      handler: async (ctx) => {
        try {
          return await ctx.run('kernel.flagged_leaf', {});
        } catch (err) {
          caughtInside.push(err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
    });
    const unflaggedTryCaller = defineCommand({
      name: 'kernel.unflagged_try_caller',
      input: z.object({}),
      risk: 'R1',
      sideEffect: 'internal',
      access: ['owner'],
      handler: async (ctx) => {
        try {
          return await ctx.tryRun('kernel.flagged_leaf', {}, { recover: () => true });
        } catch (err) {
          caughtInside.push(err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
    });
    const flaggedCaller = defineCommand({
      name: 'kernel.flagged_caller',
      input: z.object({}),
      risk: 'R1',
      sideEffect: 'internal',
      access: ['owner'],
      noIdempotency: true,
      handler: async (ctx) => ctx.tryRun<{ raw: string }>('kernel.flagged_leaf', {}, { recover: () => true }),
    });

    const runtime = new Runtime(db, { manifests: [] }).register({
      commands: [flaggedLeaf, unflaggedCaller, unflaggedTryCaller, flaggedCaller],
    });

    await expect(
      runtime.execute('kernel.unflagged_caller', {}, { actor: USER, orgId: ORG }),
    ).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });

    await expect(
      runtime.execute('kernel.unflagged_try_caller', {}, { actor: USER, orgId: ORG }),
    ).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });

    expect(caughtInside[0]).toMatch(
      /cannot run kernel\.flagged_leaf \(noIdempotency\) unless kernel\.unflagged_caller also declares noIdempotency: true/,
    );
    expect(caughtInside[1]).toMatch(
      /cannot run kernel\.flagged_leaf \(noIdempotency\) unless kernel\.unflagged_try_caller also declares noIdempotency: true/,
    );

    await expect(
      runtime.execute('kernel.flagged_caller', {}, { actor: USER, orgId: ORG }),
    ).resolves.toEqual({ status: 'ok', value: { raw: 'one-time' } });
  });
});
