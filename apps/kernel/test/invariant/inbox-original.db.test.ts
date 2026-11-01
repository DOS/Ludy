// SPDX-License-Identifier: AGPL-3.0-only
// Original-needed Inbox items on PostgreSQL 17 (#2286), through raw SQL in each context. The lookup code in such an item
// opens an invoice for anyone who has it, so who reads it is a database rule, not a screen's:
//   - owners, admins and members whose scope is the whole org read and dismiss an item of the kind
//     finance.invoice.original_needed; a viewer, a member limited to some legal entities, another org's members and an
//     agent do not;
//   - a member reads and dismisses that kind only: the dead-letter items stay with owners and admins;
//   - only the system context raises one, and nobody but it changes its detail, key, kind or raise time; a member
//     deletes none;
//   - the detail is the hint and nothing else: a text, a sender or a subject cannot be stored in it.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ORIGINAL = 'finance.invoice.original_needed';
const DEAD = 'kernel.job.dead_lettered';

suite('original-needed Inbox items on PostgreSQL (#2286)', () => {
  const dbName = `crove_test_inbox_original_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool | undefined;
  let runtime: Runtime;
  let orgId = '';
  let otherOrg = '';
  const users = { owner: '', admin: '', member: '', viewer: '', limited: '', outsider: '' };
  const items = { original: randomUUID(), dead: randomUUID() };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs fn as a login role in a context (or none), always rolled back.
  async function inContext<T>(url: string, enter: ((c: pg.Client) => Promise<unknown>) | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      if (enter) await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const asMember = (userId: string, org = () => orgId) => (c: pg.Client) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org(), contextToken(userId, org())]);
  const asSystem = (c: pg.Client) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
  const outcome = async (run: Promise<pg.QueryResult>) =>
    run.then(
      (r) => ({ ok: true as const, rows: r.rowCount }),
      (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code, message: e.message }),
    );
  const kindsRead = (c: pg.Client) =>
    c.query<{ kind: string }>('SELECT kind FROM crove_kernel.inbox_item WHERE org_id = $1 ORDER BY kind', [orgId]).then((r) => r.rows.map((x) => x.kind));
  const hint = { provider: 'misa', url: 'https://meinvoice.vn/tra-cuu', code: '4F7K2M9QXA3' };

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 2 });
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'inbox-original', subject: key, email: `${key}@inbox-original.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser(users.owner), 'Thư chỉ kèm đường dẫn')).orgId;
    otherOrg = (await createOrg(runtime, asUser(users.outsider), 'Công ty khác')).orgId;
    await admin(async (c) => {
      const entity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member')`,
        [orgId, users.admin, users.member, users.viewer, users.limited],
      );
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, users.limited, entity, users.owner]);
      await c.query(
        `INSERT INTO crove_kernel.inbox_item (org_id, id, kind, dedupe_key, detail) VALUES
           ($1, $2, '${ORIGINAL}', 'mail:${'a'.repeat(64)}:0', $4),
           ($1, $3, '${DEAD}', 'queue:finance-portal-list:2026-11-01', $5)`,
        [orgId, items.original, items.dead, JSON.stringify(hint), JSON.stringify({ queue: 'finance-portal-list', jobId: randomUUID(), retries: 0, failures: 1 })],
      );
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets owners, admins and members read an item of the kind, and only owners and admins the dead letters', async () => {
    expect(await inContext(appUrl, asMember(users.owner), kindsRead)).toEqual([DEAD, ORIGINAL]);
    expect(await inContext(appUrl, asMember(users.admin), kindsRead)).toEqual([DEAD, ORIGINAL]);
    expect(await inContext(appUrl, asMember(users.member), kindsRead)).toEqual([ORIGINAL]);
    expect(await inContext(workerUrl, asSystem, kindsRead)).toEqual([DEAD, ORIGINAL]);
  });

  it('shows a viewer, a member limited to some legal entities and another org nothing', async () => {
    expect(await inContext(appUrl, asMember(users.viewer), kindsRead)).toEqual([]);
    expect(await inContext(appUrl, asMember(users.limited), kindsRead)).toEqual([]);
    const own = (c: pg.Client) => c.query('SELECT count(*)::int AS n FROM crove_kernel.inbox_item').then((r) => r.rows[0]?.n);
    expect(await inContext(appUrl, asMember(users.outsider, () => otherOrg), own)).toBe(0);
  });

  it('lets a member dismiss an item of the kind in its own name, and nothing else of the table', async () => {
    const dismiss = (id: string) => (c: pg.Client) =>
      outcome(c.query('UPDATE crove_kernel.inbox_item SET dismissed_at = now(), dismissed_by = crove_kernel.ctx_user_id() WHERE id = $1', [id]));
    expect(await inContext(appUrl, asMember(users.member), dismiss(items.original))).toEqual({ ok: true, rows: 1 });
    expect(await inContext(appUrl, asMember(users.owner), dismiss(items.original))).toEqual({ ok: true, rows: 1 });
    // The dead letter is not theirs, nor is an update that names no row (a SELECT policy does not apply to one that reads no column).
    expect(await inContext(appUrl, asMember(users.member), dismiss(items.dead))).toEqual({ ok: true, rows: 0 });
    expect(
      await inContext(appUrl, asMember(users.member), (c) => outcome(c.query(`UPDATE crove_kernel.inbox_item SET dismissed_at = now(), dismissed_by = crove_kernel.ctx_user_id()`))),
    ).toEqual({ ok: true, rows: 1 });
    for (const user of [users.viewer, users.limited]) expect(await inContext(appUrl, asMember(user), dismiss(items.original)), user).toEqual({ ok: true, rows: 0 });
    // In another user's name: refused whatever the member reads.
    expect(
      await inContext(appUrl, asMember(users.member), (c) =>
        outcome(c.query('UPDATE crove_kernel.inbox_item SET dismissed_at = now(), dismissed_by = $2 WHERE id = $1', [items.original, users.owner])),
      ),
    ).toMatchObject({ ok: false, code: '42501' });
  });

  it('keeps the hint, the key, the kind and the raise time from every context but the system, and the hint only from it', async () => {
    for (const set of [`detail = '{"code":"ZZZZ99998888"}'::jsonb`, `kind = '${DEAD}'`, `dedupe_key = 'mail:x'`, 'raised_at = now()']) {
      for (const user of [users.member, users.owner]) {
        const result = await inContext(appUrl, asMember(user), (c) => outcome(c.query(`UPDATE crove_kernel.inbox_item SET ${set} WHERE id = $1`, [items.original])));
        expect(result.ok, `${user} ${set}`).toBe(false);
      }
    }
  });

  it('lets only the system context raise one, and only the system context delete', async () => {
    const insert = (c: pg.Client) =>
      outcome(c.query(`INSERT INTO crove_kernel.inbox_item (org_id, kind, dedupe_key, detail) VALUES ($1, '${ORIGINAL}', $2, $3)`, [orgId, `mail:${randomUUID()}`, JSON.stringify(hint)]));
    expect(await inContext(workerUrl, asSystem, insert)).toMatchObject({ ok: true, rows: 1 });
    for (const user of [users.member, users.admin, users.owner]) expect(await inContext(appUrl, asMember(user), insert), user).toMatchObject({ ok: false });
    const remove = (c: pg.Client) => outcome(c.query('DELETE FROM crove_kernel.inbox_item WHERE id = $1', [items.original]));
    for (const user of [users.member, users.admin, users.owner]) {
      const result = await inContext(appUrl, asMember(user), remove);
      expect(result.ok ? result.rows : 'refused', user).not.toBe(1);
    }
    expect(await inContext(workerUrl, asSystem, remove)).toEqual({ ok: true, rows: 1 });
  });

  it('stores the hint and nothing else in the detail', async () => {
    const insert = (detail: unknown) =>
      inContext(workerUrl, asSystem, (c) => outcome(c.query(`INSERT INTO crove_kernel.inbox_item (org_id, kind, dedupe_key, detail) VALUES ($1, '${ORIGINAL}', $2, $3)`, [orgId, `mail:${randomUUID()}`, JSON.stringify(detail)])));
    expect(await insert({ code: 'ABC12345' })).toMatchObject({ ok: true });
    for (const bad of [
      { code: 'ABC12345', text: 'Kính gửi Quý khách, hóa đơn của anh' },
      { code: 'ABC12345', from: 'ketoan@vendor.example' },
      { code: 'ABC12345', subject: 'Hoa don' },
      { url: 'https://meinvoice.vn/tra cuu' },
      { url: 'http://meinvoice.vn/tra-cuu' },
      { code: 'ABC 12345 and more words of a mail' },
      { provider: 'misa' },
      {},
    ]) {
      expect(await insert(bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: '23514' });
    }
  });
});
