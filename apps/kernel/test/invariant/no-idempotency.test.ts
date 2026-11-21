// SPDX-License-Identifier: AGPL-3.0-only
// Exact-list and runtime nesting invariants for CommandDef.noIdempotency (#3428, L1):
//   - Only reviewed commands that return one-time plaintext secrets (never payment or proposal commands) declare noIdempotency: true.
//   - Runtime.register() refuses noIdempotency together with access 'proposal' or 'proposal_revision' (proposals persist their result).
//   - ctx.run and ctx.tryRun refuse calling a noIdempotency command unless the calling command also declares noIdempotency: true.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
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
import type { Database, Db } from '@crove/db';
import { Runtime, defineCommand, type UserActor } from '@crove/kernel-runtime';
import { loadConfig } from '../../src/config.ts';
import { moduleDefinitions } from '../../src/kernel.ts';

const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/x',
  AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef',
  AUTH_ISSUER: 'crove-auth',
});
const { commands } = moduleDefinitions(config);

const ORG = '01900000-0000-7000-8000-000000000001';
const USER: UserActor = { type: 'user', userId: '01900000-0000-7000-8000-0000000000aa', aal: 'aal1' };

function fakeDb(role: string): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
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
    beginTransaction: async () => {
      statements.push('BEGIN');
    },
    commitTransaction: async () => {
      statements.push('COMMIT');
    },
    rollbackTransaction: async () => {
      statements.push('ROLLBACK');
    },
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const db: Db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

describe('commands that declare noIdempotency (#3428)', () => {
  const PINNED_NO_IDEMPOTENCY_COMMANDS = [
    'finance.bank_feed.hook_set',
    'sign.direct.otp_mail_data',
    'sign.envelope.send',
    'sign.public.otp_mail_data',
    'sign.signer.create_link',
    'sign.signer.mail_data',
    'sign.template.direct_link_rotate',
    'sign.template.direct_link_set',
    'sign.template.instantiate',
  ].sort();

  it('are an exact reviewed list and never proposal or bootstrap commands', () => {
    const flagged = (commands as ReadonlyArray<{
      name: string;
      noIdempotency?: unknown;
      access?: unknown;
      bootstrap?: unknown;
    }>).filter((c) => c.noIdempotency !== undefined);

    expect(flagged.map((c) => c.name).sort()).toEqual(PINNED_NO_IDEMPOTENCY_COMMANDS);
    for (const def of flagged) {
      expect(def.noIdempotency, def.name).toBe(true);
      expect(def.access, def.name).not.toBe('proposal');
      expect(def.access, def.name).not.toBe('proposal_revision');
      expect(def.bootstrap, def.name).toBeUndefined();
    }
  });

  it('refuses noIdempotency with proposal or proposal_revision access at registration', () => {
    const { db } = fakeDb('owner');
    const base = {
      input: z.object({}),
      risk: 'R2' as const,
      sideEffect: 'internal' as const,
      handler: async () => ({ secret: 'raw-token' }),
    };

    expect(() =>
      new Runtime(db, { manifests: [] }).register({
        commands: [
          defineCommand({
            ...base,
            name: 'probe.proposal_flagged',
            access: 'proposal',
            noIdempotency: true,
          }),
        ],
      }),
    ).toThrow(/proposal or proposal_revision command cannot declare noIdempotency/);

    expect(() =>
      new Runtime(db, { manifests: [] }).register({
        commands: [
          defineCommand({
            ...base,
            name: 'probe.target_proposal',
            access: 'proposal',
          }),
          defineCommand({
            ...base,
            name: 'probe.revision_flagged',
            access: 'proposal_revision',
            revises: 'probe.target_proposal',
            noIdempotency: true,
          }),
        ],
      }),
    ).toThrow(/proposal or proposal_revision command cannot declare noIdempotency/);
  });

  it('refuses ctx.run and ctx.tryRun of a noIdempotency command unless the caller also declares noIdempotency', async () => {
    const { db, statements } = fakeDb('owner');
    const innerSecret = defineCommand({
      name: 'kernel.inner_secret',
      input: z.object({}),
      risk: 'R1',
      sideEffect: 'internal',
      access: ['owner'],
      noIdempotency: true,
      handler: async () => ({ token: 'ephemeral-secret' }),
    });
    const caughtInside: string[] = [];
    const outerNormalRun = defineCommand({
      name: 'kernel.outer_normal_run',
      input: z.object({}),
      risk: 'R1',
      sideEffect: 'internal',
      access: ['owner'],
      handler: async (ctx) => {
        try {
          return await ctx.run('kernel.inner_secret', {});
        } catch (err) {
          caughtInside.push(err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
    });
    const outerNormalTryRun = defineCommand({
      name: 'kernel.outer_normal_try_run',
      input: z.object({}),
      risk: 'R1',
      sideEffect: 'internal',
      access: ['owner'],
      handler: async (ctx) => {
        try {
          return await ctx.tryRun('kernel.inner_secret', {}, { recover: () => true });
        } catch (err) {
          caughtInside.push(err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
    });
    const outerFlagged = defineCommand({
      name: 'kernel.outer_flagged',
      input: z.object({}),
      risk: 'R1',
      sideEffect: 'internal',
      access: ['owner'],
      noIdempotency: true,
      handler: async (ctx) => ctx.run<{ token: string }>('kernel.inner_secret', {}),
    });

    const runtime = new Runtime(db, { manifests: [] }).register({
      commands: [innerSecret, outerNormalRun, outerNormalTryRun, outerFlagged],
    });

    await expect(
      runtime.execute('kernel.outer_normal_run', {}, { actor: USER, orgId: ORG }),
    ).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });

    await expect(
      runtime.execute('kernel.outer_normal_try_run', {}, { actor: USER, orgId: ORG }),
    ).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });

    expect(caughtInside[0]).toMatch(
      /cannot run kernel\.inner_secret \(noIdempotency\) unless kernel\.outer_normal_run also declares noIdempotency: true/,
    );
    expect(caughtInside[1]).toMatch(
      /cannot run kernel\.inner_secret \(noIdempotency\) unless kernel\.outer_normal_try_run also declares noIdempotency: true/,
    );
    expect(statements.filter((s) => s === 'ROLLBACK').length).toBeGreaterThanOrEqual(2);

    await expect(
      runtime.execute('kernel.outer_flagged', {}, { actor: USER, orgId: ORG }),
    ).resolves.toEqual({ token: 'ephemeral-secret' });
  });
});
