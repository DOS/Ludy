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
import type { Database, Db } from '@ludy/db';
import { Runtime, defineCommand, type UserActor } from '@ludy/kernel-runtime';
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
      const rows = /(?:crove|ludy)_kernel\.enter_(?:user_)?context\(/.test(query.sql)
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

// A command that declares noIdempotency in a feature PR whose invariant change lands second, listed for a limited time so the
// two steps can land apart (the pending pattern of the RLS matrix and of job-egress.test.ts). The exact list below stays exact:
// a flagged command is accepted if it is pinned, or if it is pending here; a pending entry may be flagged or not yet. A pending
// entry fails the test after its expiry date (a fixed date written here, not computed: the feature's PR moves the name into
// the pinned list and removes it here), if its name is also pinned, or if its reason names no issue (#<number>).
interface PendingNoIdempotency {
  reason: string;
  // yyyy-mm-dd; the test fails on any later day.
  expires: string;
}
const PENDING_NO_IDEMPOTENCY_COMMANDS: Readonly<Record<string, PendingNoIdempotency>> = {};

// What is wrong between the commands that declare noIdempotency and the two lists, one line each.
function noIdempotencyListProblems(
  flagged: readonly string[],
  pinned: readonly string[],
  pending: Readonly<Record<string, PendingNoIdempotency>>,
  today: string,
): string[] {
  const out: string[] = [];
  const flaggedSet = new Set(flagged);
  if (flaggedSet.size !== flagged.length) out.push('a command name is flagged twice');
  for (const name of flagged) {
    if (!pinned.includes(name) && !Object.hasOwn(pending, name)) out.push(`${name}: declares noIdempotency but is on neither the pinned list nor the pending list`);
  }
  for (const name of pinned) {
    if (!flaggedSet.has(name)) out.push(`${name}: is pinned but no command of that name declares noIdempotency`);
  }
  for (const [name, { reason, expires }] of Object.entries(pending)) {
    if (!/#\d+/.test(reason)) out.push(`${name}: the reason names no issue (#<number>)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) out.push(`${name}: the expiry date is not a yyyy-mm-dd date`);
    else if (today > expires) out.push(`${name}: the pending entry expired on ${expires} (${reason}); move it to the pinned list and remove it here`);
    if (pinned.includes(name)) out.push(`${name}: on the pinned list and the pending list; remove it from the pending list`);
  }
  return out;
}

describe('commands that declare noIdempotency (#3428)', () => {
  const PINNED_NO_IDEMPOTENCY_COMMANDS = [
    'finance.bank_feed.hook_set',
    'finance.marketplace_connection.push_hook_set',
    'hr.attendance.qr.rotate',
    'meetings.minutes_link.create',
    'sign.direct.otp_mail_data',
    'sign.envelope.send',
    'sign.public.otp_mail_data',
    'sign.signer.correct_recipient',
    'sign.signer.create_link',
    'sign.signer.mail_data',
    'sign.signer.start_in_person',
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

    expect(noIdempotencyListProblems(flagged.map((c) => c.name).sort(), PINNED_NO_IDEMPOTENCY_COMMANDS, PENDING_NO_IDEMPOTENCY_COMMANDS, new Date().toISOString().slice(0, 10))).toEqual([]);
    for (const def of flagged) {
      expect(def.noIdempotency, def.name).toBe(true);
      expect(def.access, def.name).not.toBe('proposal');
      expect(def.access, def.name).not.toBe('proposal_revision');
      expect(def.bootstrap, def.name).toBeUndefined();
    }
  });

  it('reports an unlisted command, a vanished pinned one, and a pending entry that expired, names no issue or is also pinned', () => {
    const pinned = ['a.one', 'a.two'];
    const pending = { 'a.three': { reason: 'the one-time key (#1)', expires: '2030-01-01' } };
    // The two accepted states: the pending command not flagged yet, and flagged.
    expect(noIdempotencyListProblems(['a.one', 'a.two'], pinned, pending, '2029-12-31')).toEqual([]);
    expect(noIdempotencyListProblems(['a.one', 'a.two', 'a.three'], pinned, pending, '2029-12-31')).toEqual([]);
    expect(noIdempotencyListProblems(['a.one', 'a.two', 'a.four'], pinned, pending, '2029-12-31')).toEqual([
      'a.four: declares noIdempotency but is on neither the pinned list nor the pending list',
    ]);
    expect(noIdempotencyListProblems(['a.one'], pinned, pending, '2029-12-31')).toEqual(['a.two: is pinned but no command of that name declares noIdempotency']);
    // A name that is a property of every object is not on the pending list, and a name flagged twice is reported.
    expect(noIdempotencyListProblems(['a.one', 'a.two', 'constructor'], pinned, pending, '2029-12-31')).toEqual([
      'constructor: declares noIdempotency but is on neither the pinned list nor the pending list',
    ]);
    expect(noIdempotencyListProblems(['a.one', 'a.one', 'a.two'], pinned, pending, '2029-12-31')).toEqual(['a command name is flagged twice']);
    // The expiry day itself is still allowed; the day after is not (checked below).
    expect(noIdempotencyListProblems(['a.one', 'a.two', 'a.three'], pinned, pending, '2030-01-01')).toEqual([]);
    expect(noIdempotencyListProblems(['a.one', 'a.two', 'a.three'], pinned, pending, '2030-01-02')).toEqual([
      'a.three: the pending entry expired on 2030-01-01 (the one-time key (#1)); move it to the pinned list and remove it here',
    ]);
    expect(noIdempotencyListProblems(['a.one', 'a.two', 'a.three'], pinned, { 'a.three': { reason: 'no issue', expires: '2030-01-01' } }, '2029-12-31')).toEqual([
      'a.three: the reason names no issue (#<number>)',
    ]);
    expect(noIdempotencyListProblems(['a.one', 'a.two'], pinned, { 'a.two': { reason: 'moved (#2)', expires: '2030-01-01' } }, '2029-12-31')).toEqual([
      'a.two: on the pinned list and the pending list; remove it from the pending list',
    ]);
    expect(noIdempotencyListProblems(['a.one', 'a.two'], pinned, { 'a.three': { reason: 'bad date (#3)', expires: 'soon' } }, '2029-12-31')).toEqual([
      'a.three: the expiry date is not a yyyy-mm-dd date',
    ]);
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
