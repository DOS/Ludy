// SPDX-License-Identifier: AGPL-3.0-only
// The layout of a bank's bulk-salary file (#2532, payroll plan 6.4, ADR-0046) on a real PostgreSQL 17, through the runtime:
// - owners and admins add, change, read and delete templates; a member and a viewer read and write nothing (the database's policies refuse, not only the commands' access lists);
// - an entity keeps several templates, one per bank, unique on (org, entity, name);
// - the layout must hold the six columns once each, a header on each, and a content text whose only brace form is `{month}`;
// - only the name, the layout and the stamp change: a template never moves to another entity.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { tableWrite } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, defineCommand, defineQuery, parseVaultKey, type CommandDef, type QueryDef } from '@crove/kernel-runtime';
import { hrCommands, hrManifest, hrQueries } from '@crove/mod-hr';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const COLUMNS = [
  { key: 'sequence', header: 'STT' },
  { key: 'name', header: 'Ten' },
  { key: 'account', header: 'So tai khoan' },
  { key: 'bank', header: 'Ngan hang' },
  { key: 'amount', header: 'So tien' },
  { key: 'content', header: 'Noi dung' },
];
const layout = (over: Record<string, unknown> = {}) => ({ columns: COLUMNS, content: 'Luong thang {month}', ...over });

suite('HR bank template on PostgreSQL (#2532)', () => {
  const dbName = `crove_test_hr_bank_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  // Test-only commands and queries that every role may call, so the database's policies are what refuse a member.
  const ADD = defineCommand({
    name: 't2532.add',
    input: z.object({ name: z.string(), layout: z.unknown() }),
    risk: 'R1',
    sideEffect: 'internal',
    access: ['owner', 'admin', 'member', 'viewer'],
    writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_bank_template', ['id', 'legal_entity_id', 'name', 'layout'])],
    handler: async (ctx, input) => {
      const row = await ctx.trx
        .insertInto('crove_hr.payroll_bank_template')
        .values({ org_id: ctx.orgId, name: input.name, layout: JSON.stringify(input.layout) })
        .returning(['id', 'legal_entity_id'])
        .executeTakeFirstOrThrow();
      return { id: row.id, legalEntityId: row.legal_entity_id };
    },
  }) as CommandDef<unknown, unknown>;
  const CHANGE = defineCommand({
    name: 't2532.change',
    input: z.object({ id: z.string(), name: z.string().optional(), layout: z.unknown().optional() }),
    risk: 'R1',
    sideEffect: 'internal',
    access: ['owner', 'admin', 'member', 'viewer'],
    writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_bank_template', ['name', 'layout', 'updated_at'])],
    handler: async (ctx, input) => {
      const set: { name?: string; layout?: string; updated_at: Date } = { updated_at: ctx.now };
      if (input.name !== undefined) set.name = input.name;
      if (input.layout !== undefined) set.layout = JSON.stringify(input.layout);
      const rows = await ctx.trx.updateTable('crove_hr.payroll_bank_template').set(set).where('org_id', '=', ctx.orgId).where('id', '=', input.id).returning('id').execute();
      return { changed: rows.length };
    },
  }) as CommandDef<unknown, unknown>;
  const MOVE = defineCommand({
    name: 't2532.move',
    input: z.object({ id: z.string(), legalEntityId: z.string() }),
    risk: 'R1',
    sideEffect: 'internal',
    access: ['owner', 'admin'],
    writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_bank_template', ['legal_entity_id'])],
    handler: async (ctx, input) => {
      await ctx.trx.executeQuery({
        sql: 'UPDATE crove_hr.payroll_bank_template SET legal_entity_id = $1 WHERE org_id = $2 AND id = $3',
        parameters: [input.legalEntityId, ctx.orgId, input.id],
        query: { kind: 'RawNode' },
      } as never);
      return {};
    },
  }) as CommandDef<unknown, unknown>;
  const REMOVE = defineCommand({
    name: 't2532.remove',
    input: z.object({ id: z.string() }),
    risk: 'R1',
    sideEffect: 'internal',
    access: ['owner', 'admin', 'member', 'viewer'],
    writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_bank_template', ['id'])],
    handler: async (ctx, input) => {
      const rows = await ctx.trx.deleteFrom('crove_hr.payroll_bank_template').where('org_id', '=', ctx.orgId).where('id', '=', input.id).returning('id').execute();
      return { removed: rows.length };
    },
  }) as CommandDef<unknown, unknown>;
  const PEEK = defineQuery({
    name: 't2532.peek',
    input: z.object({}),
    access: ['owner', 'admin', 'member', 'viewer'],
    handler: async (ctx) => {
      const rows = await ctx.trx.selectFrom('crove_hr.payroll_bank_template').select(['id', 'name']).where('org_id', '=', ctx.orgId).orderBy('name').execute();
      return rows;
    },
  }) as QueryDef<unknown, unknown>;

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org() {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hr', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner), `Ngân hàng ${tag}`);
    await withAdmin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, admin, member, viewer]),
    );
    const exec = <O>(userId: string, name: string, input: unknown = {}) => rt.execute<O>(name, input, { actor: asUser(userId), orgId });
    const peek = <O>(userId: string) => rt.query<O>('t2532.peek', {}, { actor: asUser(userId), orgId });
    return { orgId, owner, admin, member, viewer, exec, peek };
  }

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    rt = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      subjectVault: new SubjectVault(new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO)),
      readAuditKey: randomBytes(32),
    }).register({ commands: [...kernelCommands, ...hrCommands, ADD, CHANGE, MOVE, REMOVE], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, PEEK] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('lets an owner and an admin keep several templates, one per bank, and read them', async () => {
    const o = await org();
    await o.exec(o.owner, 't2532.add', { name: 'Bank A', layout: layout() });
    await o.exec(o.admin, 't2532.add', { name: 'Bank B', layout: layout({ content: 'Salary {month}' }) });
    const names = (await o.peek<{ name: string }[]>(o.admin)).map((r) => r.name);
    expect(names).toEqual(['Bank A', 'Bank B']);
  });

  it('refuses a duplicate name in the same entity', async () => {
    const o = await org();
    await o.exec(o.owner, 't2532.add', { name: 'Bank A', layout: layout() });
    await expect(o.exec(o.owner, 't2532.add', { name: 'Bank A', layout: layout() })).rejects.toThrow();
  });

  it('shows a member and a viewer nothing and lets them write nothing', async () => {
    const o = await org();
    const made = await o.exec<{ id: string }>(o.owner, 't2532.add', { name: 'Bank A', layout: layout() });
    for (const who of [o.member, o.viewer]) {
      expect(await o.peek<unknown[]>(who)).toEqual([]);
      await expect(o.exec(who, 't2532.add', { name: 'Mine', layout: layout() })).rejects.toThrow();
      expect(await o.exec(who, 't2532.change', { id: made.id, name: 'Changed' })).toEqual({ changed: 0 });
      expect(await o.exec(who, 't2532.remove', { id: made.id })).toEqual({ removed: 0 });
    }
    expect((await o.peek<{ name: string }[]>(o.owner)).map((r) => r.name)).toEqual(['Bank A']);
  });

  it('accepts only a layout with the six columns once each, a header on each and a safe content text', async () => {
    const o = await org();
    const refused = [
      layout({ columns: COLUMNS.slice(0, 5) }),
      layout({ columns: [...COLUMNS.slice(0, 5), { key: 'amount', header: 'Again' }] }),
      layout({ columns: [...COLUMNS.slice(0, 5), { key: 'iban', header: 'IBAN' }] }),
      layout({ columns: COLUMNS.map((c) => (c.key === 'bank' ? { key: 'bank', header: '' } : c)) }),
      layout({ content: 'Pay {name}' }),
      layout({ content: '' }),
      { columns: COLUMNS },
    ];
    for (const [i, bad] of refused.entries()) {
      await expect(o.exec(o.owner, 't2532.add', { name: `Bad ${i}`, layout: bad }), `refused layout ${i}`).rejects.toThrow();
    }
    await o.exec(o.owner, 't2532.add', { name: 'Good', layout: layout({ content: 'Luong {month} dot 1' }) });
  });

  it('changes the name and the layout, deletes a template, and never moves one to another entity', async () => {
    const o = await org();
    const made = await o.exec<{ id: string; legalEntityId: string }>(o.owner, 't2532.add', { name: 'Bank A', layout: layout() });
    expect(await o.exec(o.admin, 't2532.change', { id: made.id, name: 'Bank A (new)', layout: layout({ content: 'Pay {month}' }) })).toEqual({ changed: 1 });
    const other = await withAdmin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.legal_entity (org_id, name, is_default, created_by) VALUES ($1, 'Second entity', false, $2) RETURNING id`,
        [o.orgId, o.owner],
      );
      return rows[0]?.id as string;
    });
    expect(other).toBeTruthy();
    await expect(o.exec(o.owner, 't2532.move', { id: made.id, legalEntityId: other })).rejects.toThrow();
    // Still in the entity it was made in.
    expect(await withAdmin(async (c) => (await c.query('SELECT 1 FROM crove_hr.payroll_bank_template WHERE org_id = $1 AND id = $2 AND legal_entity_id = $3', [o.orgId, made.id, made.legalEntityId])).rowCount)).toBe(1);
    expect(await o.exec(o.owner, 't2532.remove', { id: made.id })).toEqual({ removed: 1 });
    expect(await o.peek<unknown[]>(o.owner)).toEqual([]);
  });
});
