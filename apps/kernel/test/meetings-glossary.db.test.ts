// SPDX-License-Identifier: AGPL-3.0-only
// The glossary an organization keeps (#4043, step 2: the table, the commands) on a real database. Only an owner or admin reads or writes it, in the command and in the database itself (a member's
// own SELECT sees no row and a direct INSERT is refused); a term is plain text (control and invisible characters stripped, Unicode form C), judged by the same rules in the contract and the
// database; one row per term whatever the case; at most 60 terms; another org's terms are neither read nor changed; and the audit row carries ids and counts, never a term.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { EXPORT_TABLE_NAMES, OWNER_RUN_EXPORT_TABLE_NAMES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { GlossaryTerms } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the glossary an organization keeps (#4043)', () => {
  const dbName = `crove_test_glossary_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let appPool: pg.Pool;
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown, org = orgId) => runtime.execute<O>(name, input, { actor: asUser(who), orgId: org });
  const query = <O = unknown>(who: string, name: string, input: unknown = {}, org = orgId) => runtime.query<O>(name, input, { actor: asUser(who), orgId: org });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  type Done = { termId: string };
  const add = (who: string, term: string, org = orgId) => exec<Done>(who, 'meetings.glossary.add', { term }, org);
  const list = (who: string, org = orgId) => query<GlossaryTerms>(who, 'meetings.glossary.list', {}, org).then((r) => r.terms);
  const stored = async (termId: string) => (await sqlAdmin<{ term: string }>('SELECT term FROM crove_meetings.glossary_term WHERE id = $1', [termId])).rows[0]?.term;
  const wipe = (org = orgId) => sqlAdmin('DELETE FROM crove_meetings.glossary_term WHERE org_id = $1', [org]);

  // A plain statement in a member's sealed context, with no command in between; rolled back whatever happens.
  async function asContext(who: string, org: string, fn: (run: (statement: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<void>) {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users[who], org]);
      await fn((statement, params = []) => client.query(statement, params));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = new URL(adminUrl);
    login.username = 'crove_app';
    login.password = 'test-app-pw';
    appPool = createPool({ connectionString: login.toString(), max: 4 });
    pools.push(appPool);
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS, readAuditKey: randomBytes(32) }).register(registry);
    for (const key of ['owner', 'adm', 'rec', 'viewer', 'ownerB', 'ownerC']) users[key] = await upsertIdentity(createDb(appPool), { issuer: 'glossary', subject: key, email: `${key}@glossary.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Mẫu')).orgId;
    otherOrgId = (await createOrg(runtime, asUser('ownerB'), 'Công ty Khác')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, users.adm, users.rec, users.viewer]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets an owner or admin keep terms, refuses a member and a viewer for every command and for the list, and audits ids and counts only', async () => {
    await wipe();
    const first = await add('owner', 'Crove');
    const second = await add('adm', 'MISA AMIS');
    for (const who of ['rec', 'viewer']) {
      expect(await refuses(add(who, `Của ${who}`)), `${who} add`).not.toBeNull();
      expect(await refuses(exec(who, 'meetings.glossary.update', { termId: first.termId, term: 'Đổi' })), `${who} update`).not.toBeNull();
      expect(await refuses(exec(who, 'meetings.glossary.remove', { termId: first.termId })), `${who} remove`).not.toBeNull();
      expect(await refuses(query(who, 'meetings.glossary.list')), `${who} list`).not.toBeNull();
    }
    expect((await list('owner')).map((t) => t.term)).toEqual(['Crove', 'MISA AMIS']);
    expect((await list('adm')).map((t) => t.id)).toEqual([first.termId, second.termId]);
    const audit = await sqlAdmin<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.glossary.add' AND outcome = 'ok' ORDER BY occurred_at`, [orgId]);
    expect(audit.rows.map((r) => r.detail)).toEqual([expect.objectContaining({ termId: first.termId, termCount: 1 }), expect.objectContaining({ termId: second.termId, termCount: 2 })]);
    expect(JSON.stringify(audit.rows)).not.toContain('MISA');
    expect(JSON.stringify(audit.rows)).not.toContain('Crove');
  });

  it('keeps a term once whatever its case, renames without clashing with itself, and answers not found for an unknown term or one of another org', async () => {
    await wipe();
    const a = await add('owner', 'Ludy');
    expect(await refuses(add('adm', 'LUDY'))).toBe('GLOSSARY_TERM_TAKEN');
    const b = await add('adm', 'Vy');
    expect(await refuses(exec('owner', 'meetings.glossary.update', { termId: b.termId, term: 'ludy' }))).toBe('GLOSSARY_TERM_TAKEN');
    await exec('owner', 'meetings.glossary.update', { termId: a.termId, term: 'LUDY' });
    expect(await stored(a.termId)).toBe('LUDY');
    expect(await refuses(exec('owner', 'meetings.glossary.update', { termId: randomUUID(), term: 'Khác' }))).toBe('GLOSSARY_TERM_NOT_FOUND');
    expect(await refuses(exec('owner', 'meetings.glossary.remove', { termId: randomUUID() }))).toBe('GLOSSARY_TERM_NOT_FOUND');
    // Another org's owner neither reads nor changes this org's terms, and may keep the same term of their own.
    expect(await list('ownerB', otherOrgId)).toEqual([]);
    expect(await refuses(exec('ownerB', 'meetings.glossary.update', { termId: a.termId, term: 'Của B' }, otherOrgId))).toBe('GLOSSARY_TERM_NOT_FOUND');
    expect(await refuses(exec('ownerB', 'meetings.glossary.remove', { termId: a.termId }, otherOrgId))).toBe('GLOSSARY_TERM_NOT_FOUND');
    const theirs = await add('ownerB', 'Ludy', otherOrgId);
    expect(await stored(a.termId)).toBe('LUDY');
    expect((await list('ownerB', otherOrgId)).map((t) => t.id)).toEqual([theirs.termId]);
    await wipe(otherOrgId);
  });

  it('keeps at most 60 terms, and a removed term frees its place', async () => {
    await wipe();
    for (let i = 0; i < 60; i += 1) await add('owner', `Thuật ngữ ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    expect(await refuses(add('owner', 'Thuật ngữ thứ sáu mươi mốt'))).toBe('GLOSSARY_MAX');
    const [one] = await list('owner');
    expect(await exec('owner', 'meetings.glossary.remove', { termId: (one as { id: string }).id })).toEqual({ termId: (one as { id: string }).id });
    expect((await add('adm', 'Thuật ngữ thứ sáu mươi mốt')).termId).toBeTruthy();
    expect(await stored((one as { id: string }).id)).toBeUndefined();
  });

  it('cleans a term to plain text and refuses what is not a term', async () => {
    await wipe();
    // Control, bidirectional and zero-width characters go; whitespace collapses; Unicode form C; markup stays literal text.
    const cleaned = await add('owner', '  Mặt\u200b  Trời\u202e\n');
    expect(await stored(cleaned.termId)).toBe('Mặt Trời');
    // 'C', 'a', a combining circumflex and a combining grave accent: one name in form D, stored in form C.
    const decomposed = await add('owner', ['C', 'a', String.fromCodePoint(0x302), String.fromCodePoint(0x300)].join(''));
    expect(await stored(decomposed.termId)).toBe(['C', 'a', String.fromCodePoint(0x302), String.fromCodePoint(0x300)].join('').normalize('NFC'));
    const markup = await add('owner', '<b>VAT</b>');
    expect(await stored(markup.termId)).toBe('<b>VAT</b>');
    for (const bad of ['', '   ', 'x'.repeat(41), '12345', '0912 345 678', 'an@example.com', 'https://example.com', 'www.example.com', '\u200b\u200b']) {
      expect(await refuses(add('owner', bad)), JSON.stringify(bad)).not.toBeNull();
    }
    // 40 characters and up to 4 digits are fine.
    expect((await add('owner', 'x'.repeat(40))).termId).toBeTruthy();
    expect((await add('owner', 'Hợp đồng 2026')).termId).toBeTruthy();
  });

  it('holds the same shape in the database, and shows a member no row and lets a member write none', async () => {
    await wipe();
    const one = await add('owner', 'Crove');
    // The table's own CHECK refuses what the contract refuses, whatever wrote it (the admin connection skips the policy, not the CHECK).
    for (const bad of ['', ' Crove', 'x'.repeat(41), '12345', 'an@example.com', 'a\u200bb', 'see www.example.com', 'Crove\n']) {
      const code = await sqlAdmin(`INSERT INTO crove_meetings.glossary_term (org_id, term, created_by) VALUES ($1, $2, $3)`, [orgId, bad, users.owner]).then(() => null, (e: { code?: string }) => e.code ?? 'ERR');
      expect(code, JSON.stringify(bad)).toBe('23514');
    }
    expect((await sqlAdmin('SELECT count(*)::int AS n FROM crove_meetings.glossary_term WHERE org_id = $1', [orgId])).rows[0]?.n).toBe(1);
    // A member's own statements: no row to read, no row to change, no row to add.
    await asContext('rec', orgId, async (run) => {
      expect((await run('SELECT count(*)::int AS n FROM crove_meetings.glossary_term')).rows[0]?.n).toBe(0);
      expect((await run(`UPDATE crove_meetings.glossary_term SET term = 'Hỏng' WHERE id = $1`, [one.termId])).rowCount).toBe(0);
      expect((await run('DELETE FROM crove_meetings.glossary_term WHERE id = $1', [one.termId])).rowCount).toBe(0);
    });
    await asContext('rec', orgId, async (run) => {
      await expect(run(`INSERT INTO crove_meetings.glossary_term (org_id, term, created_by) VALUES ($1, 'Của member', $2)`, [orgId, users.rec])).rejects.toMatchObject({ code: '42501' });
    });
    // An owner's own statements see their org's rows and no other org's.
    await asContext('owner', orgId, async (run) => {
      expect((await run('SELECT count(*)::int AS n FROM crove_meetings.glossary_term')).rows[0]?.n).toBe(1);
    });
    expect(await stored(one.termId)).toBe('Crove');
  });

  // The export (#4043, found by the shared-core review): the table's owner_admin policy shows the system actor nothing, so the export job's snapshot would write an empty file. The owner's own session
  // reads it while the org is closing, like the HR owner_admin tables (kernel.org.export.people).
  it('exports the glossary through the owner own session while the org closes, not through the snapshot, and only this org terms', async () => {
    expect(EXPORT_TABLE_NAMES as readonly string[]).not.toContain('meetings.glossary_term');
    expect(OWNER_RUN_EXPORT_TABLE_NAMES as readonly string[]).toContain('meetings.glossary_term');
    const closing = await createOrg(runtime, asUser('ownerC'), 'Công ty Đóng cửa');
    const mfa = { type: 'user' as const, userId: users.ownerC as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const first = await add('ownerC', 'Crove Cloud', closing.orgId);
    const second = await add('ownerC', 'Thông tư 99', closing.orgId);
    await wipe(otherOrgId);
    const theirs = await add('ownerB', 'Của nhà khác', otherOrgId);
    const read = async (org: string, actor: Parameters<Runtime['stream']>[2]['actor']) => {
      const lines: string[] = [];
      await runtime.stream('kernel.org.export.people', { table: 'meetings.glossary_term' }, { actor, orgId: org }, async (raw) => {
        lines.push(...(raw as { lines: string[] }).lines);
      });
      return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    };
    // The download is part of closing the org: an active org reads nothing.
    expect(await refuses(read(closing.orgId, mfa))).toBe('ORG_NOT_OFFBOARDING');
    await runtime.execute('kernel.org.offboard', { confirmSlug: closing.slug }, { actor: mfa, orgId: closing.orgId });
    const rows = await read(closing.orgId, mfa);
    expect(rows.map((r) => r.id).sort()).toEqual([first.termId, second.termId].sort());
    expect(rows.map((r) => r.term).sort()).toEqual(['Crove Cloud', 'Thông tư 99']);
    expect(rows.every((r) => r.org_id === closing.orgId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('Của nhà khác');
    // The other org's terms are untouched by it.
    expect(theirs.termId).toBeTruthy();
    expect((await list('ownerB', otherOrgId)).map((t) => t.id)).toEqual([theirs.termId]);
    await wipe(otherOrgId);
  });
});
