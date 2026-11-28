// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7, #2195): the retention of the parsed rows of a decided bank statement. The two definers that delete them are the worker login's alone,
// SECURITY DEFINER with a pinned search_path and no PUBLIC grant; `due` runs outside every context and returns ids only; `apply` runs only in the system context of the SAME org; neither
// accepts fewer than 90 days; and what `apply` deletes is exactly the OLDER bank_statement versions of a file whose newest version is a decided summary: never a statement still staged,
// another kind of file, a file under an evidence hold, a newer version, the decision's summary, the file row or the audit trail. extraction_guard still refuses an UPDATE of a finished
// version, and no tenant role can DELETE an extraction version or call either function. Part of the invariant suite: it imports package code under test, never helpers from outside
// test/invariant/. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, fileKey, sha256Hex } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { contextToken } from './fixtures/context-token.ts';
import { auditRoleFunctionExecute, createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const DUE_SIG = 'crove_finance.bank_statement_rows_due(integer,integer)';
const APPLY_SIG = 'crove_finance.bank_statement_rows_apply(uuid,uuid,integer)';
// What the staged rows carry about the other side, which must be nowhere once the rows are deleted.
const COUNTERPARTY = 'Nguyễn Văn Đối Tác Kín';
const COUNTERPARTY_ACCOUNT = '9704000099887766';

suite('retention of the staged rows of a decided bank statement (#2195)', () => {
  const dbName = `ludy_test_stmt_rows_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let api: Runtime;
  const users = { owner: '', other: '' };
  let orgId = '';
  let otherOrgId = '';
  let offOrgId = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  // Runs fn as a login role in a context; rolled back unless `commit`.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>, commit = false): Promise<T> {
    const c = createDbClient({ connectionString: url }, dbIds);
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      const out = await fn(c);
      if (commit) await c.query('COMMIT');
      return out;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }));
  const noContext = async () => undefined;
  const system = (org: string) => (c: pg.Client) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [org]);
  const user = (userId: string, org: string) => (c: pg.Client) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org, contextToken(userId, org)]);

  const due = (days = 90, limit = 1000) => inContext(workerUrl, noContext, async (c) => (await c.query<{ org_id: string; file_id: string }>('SELECT org_id, file_id FROM crove_finance.bank_statement_rows_due($1::int, $2::int)', [days, limit])).rows);
  const dueFiles = async () => new Set((await due()).map((r) => r.file_id));
  const apply = (org: string, file: string, days = 90, commit = false) =>
    inContext(workerUrl, system(org), async (c) => (await c.query<{ applied: boolean; versions: number }>('SELECT applied, versions FROM crove_finance.bank_statement_rows_apply($1::uuid, $2::uuid, $3::int)', [org, file, days])).rows[0], commit);

  // A file with its versions. `shape` lists them oldest first: a kind and a state ('staged' keeps the rows; any other state is a decision with the summary only).
  type Version = { kind: string; state: string };
  async function file(org: string, owner: string, versions: Version[], ageDays: number, hold = false): Promise<string> {
    const bytes = new TextEncoder().encode(`PK-sao-ke-${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const { fileId } = await api.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'sao-ke.zip', contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(org, sha256), generation: `content:${sha256}`, source: 'upload' },
      { actor: asUser(owner), orgId: org },
    );
    await admin(async (c) => {
      for (const v of versions) {
        if (v.state === 'failed') {
          // A read that failed: no result, no kind.
          await c.query("INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, result, checks, error) VALUES ($1, $2, 'unsupported', 'failed', NULL, '[]', 'read failed')", [org, fileId]);
          continue;
        }
        const summary = { state: v.state, filename: 'sao-ke.xlsx', bankAccount: '1121', accountNumber: '19880001234', lines: 2 };
        const result = v.state !== 'staged' ? { kind: v.kind, summary } : { kind: v.kind, summary, rows: [{ rowNo: 2, description: COUNTERPARTY, counterpartyAccount: COUNTERPARTY_ACCOUNT, moneyIn: '1000', moneyOut: '', balance: '', reference: 'FT1', date: '01/09/2026' }] };
        await c.query("INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, result, checks) VALUES ($1, $2, 'unsupported', 'done', $3::jsonb, $4::jsonb)", [org, fileId, JSON.stringify(result), JSON.stringify(v.state === 'staged' ? [{ check: COUNTERPARTY }] : [])]);
      }
      // Time passes: the guard on finished versions is switched off for this one session only.
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('UPDATE crove_kernel.extraction SET completed_at = now() - make_interval(days => $2) WHERE file_id = $1', [fileId, ageDays]);
      if (hold) await c.query("UPDATE crove_kernel.file SET held_until = now() + interval '5 years' WHERE id = $1", [fileId]);
      await c.query('COMMIT');
    });
    return fileId;
  }
  const decided = (state: 'imported' | 'rejected' = 'imported'): Version[] => [{ kind: 'bank_statement', state: 'staged' }, { kind: 'bank_statement', state }];
  const versionsOf = (fileId: string) => admin(async (c) => (await c.query<{ id: string; version: number; kind: string | null; state: string | null; result: unknown }>("SELECT id, version, result ->> 'kind' AS kind, result -> 'summary' ->> 'state' AS state, result FROM crove_kernel.extraction WHERE file_id = $1 ORDER BY version", [fileId])).rows);
  const fileRow = (fileId: string) => admin(async (c) => (await c.query('SELECT * FROM crove_kernel.file WHERE id = $1', [fileId])).rows[0]);
  const auditCount = (org: string) => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.audit_event WHERE org_id = $1', [org])).rows[0]?.n));

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(username) : username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const pool = createDbPool({ connectionString: appUrl, max: 4 }, dbIds);
    pools.push(pool);
    api = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(createDb(pool), { issuer: 'stmt-rows-retention', subject: key, email: `${key}@stmt-rows-retention.test`, name: null });
    }
    orgId = (await createOrg(api, asUser(users.owner), 'Hạn giữ dòng sao kê')).orgId;
    otherOrgId = (await createOrg(api, asUser(users.other), 'Công ty khác')).orgId;
    offOrgId = (await createOrg(api, asUser(users.other), 'Công ty tắt tài chính')).orgId;
    // The third org switched the finance app off (the audit rule on the switch is set aside for this one statement).
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE crove_kernel.tenant SET apps_off = ARRAY['finance'] WHERE org_id = $1", [offOrgId]);
      await c.query('COMMIT');
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('pins SECURITY DEFINER, the search_path, a non-login owner, no PUBLIC grant and EXECUTE for the worker login alone', async () => {
    await admin(async (c) => {
      for (const sig of [DUE_SIG, APPLY_SIG]) {
        const meta = await c.query<{ secdef: boolean; config: string[] | null; acl: string | null; login: boolean }>(
          'SELECT p.prosecdef AS secdef, p.proconfig AS config, p.proacl::text AS acl, r.rolcanlogin AS login FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner WHERE p.oid = $1::regprocedure',
          [dbIds ? dbIds.rewriteSql(sig) : sig],
        );
        expect(meta.rows[0]?.secdef, sig).toBe(true);
        expect(meta.rows[0]?.config, sig).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(meta.rows[0]?.login, sig).toBe(false);
        expect(meta.rows[0]?.acl ?? '', sig).not.toMatch(/(^|[{,])=X\//);
        const matrix = await auditRoleFunctionExecute(c, dbIds, sig, ['crove_worker'], 'non_system');
        expect(matrix.rows.filter((r) => r.ok !== r.expected), sig).toEqual([]);
        expect(matrix.rows.filter((r) => r.expected && r.ok).length, sig).toBeGreaterThan(0);
      }
    });
  });

  it('is refused to the tenant login in any context, and to the worker outside the right context', async () => {
    const f = await file(orgId, users.owner, decided(), 200);
    // The API login (the tenant's) has no EXECUTE on either, whatever its context.
    for (const [text, values] of [
      ['SELECT * FROM crove_finance.bank_statement_rows_due(90, 10)', []],
      ['SELECT * FROM crove_finance.bank_statement_rows_apply($1::uuid, $2::uuid, 90)', [orgId, f]],
    ] as const) {
      expect(await outcome(inContext(appUrl, user(users.owner, orgId), (c) => c.query(text, [...values]))), text).toMatchObject({ ok: false, code: '42501' });
      expect(await outcome(inContext(appUrl, noContext, (c) => c.query(text, [...values]))), text).toMatchObject({ ok: false, code: '42501' });
    }
    // The worker: `due` only with no context at all; `apply` only in the system context of the file's own org.
    expect(await outcome(inContext(workerUrl, system(orgId), (c) => c.query('SELECT * FROM crove_finance.bank_statement_rows_due(90, 10)')))).toMatchObject({ ok: false, code: '42501' });
    expect(await outcome(inContext(workerUrl, noContext, (c) => c.query('SELECT * FROM crove_finance.bank_statement_rows_apply($1::uuid, $2::uuid, 90)', [orgId, f])))).toMatchObject({ ok: false, code: '42501' });
    // Same org in the context and the argument, but the file is not that org's: nothing found, nothing deleted.
    expect(await outcome(apply(otherOrgId, f))).toMatchObject({ ok: true, value: { applied: false, versions: 0 } });
    expect(await outcome(inContext(workerUrl, system(otherOrgId), (c) => c.query('SELECT * FROM crove_finance.bank_statement_rows_apply($1::uuid, $2::uuid, 90)', [orgId, f])))).toMatchObject({ ok: false, code: '42501' });
    // Nothing was deleted by any of them.
    expect((await versionsOf(f)).length).toBe(2);
  });

  it('refuses fewer than 90 days, and a missing number of days, from both', async () => {
    const f = await file(orgId, users.owner, decided(), 200);
    for (const days of [89, 30, 0, -1]) {
      expect(await outcome(due(days)), `due ${days}`).toMatchObject({ ok: false, code: '22023' });
      expect(await outcome(apply(orgId, f, days)), `apply ${days}`).toMatchObject({ ok: false, code: '22023' });
    }
    expect(await outcome(inContext(workerUrl, noContext, (c) => c.query('SELECT * FROM crove_finance.bank_statement_rows_due(NULL, 10)')))).toMatchObject({ ok: false, code: '22023' });
    expect(await outcome(inContext(workerUrl, system(orgId), (c) => c.query('SELECT * FROM crove_finance.bank_statement_rows_apply($1::uuid, $2::uuid, NULL)', [orgId, f])))).toMatchObject({ ok: false, code: '22023' });
    expect((await versionsOf(f)).length).toBe(2);
  });

  it('lists a decided statement 90 days after its decision, with ids only, and nothing else', async () => {
    const imported = await file(orgId, users.owner, decided('imported'), 91);
    const rejected = await file(orgId, users.owner, decided('rejected'), 91);
    const young = await file(orgId, users.owner, decided(), 89);
    const staged = await file(orgId, users.owner, [{ kind: 'bank_statement', state: 'staged' }], 400);
    const reread = await file(orgId, users.owner, [...decided(), { kind: 'bank_statement', state: 'staged' }], 400);
    const orders = await file(orgId, users.owner, [{ kind: 'marketplace_orders', state: 'staged' }, { kind: 'marketplace_orders', state: 'imported' }], 400);
    const income = await file(orgId, users.owner, [{ kind: 'marketplace_income', state: 'staged' }, { kind: 'marketplace_income', state: 'rejected' }], 400);
    const held = await file(orgId, users.owner, decided(), 400, true);
    const nothingOlder = await file(orgId, users.owner, [{ kind: 'bank_statement', state: 'imported' }], 400);
    const offFile = await file(offOrgId, users.other, decided(), 400);
    const listed = await due();
    expect(listed.every((r) => Object.keys(r).sort().join() === 'file_id,org_id')).toBe(true);
    const files = new Set(listed.map((r) => r.file_id));
    expect(files.has(imported) && files.has(rejected)).toBe(true);
    // Not yet 90 days; still waiting for a member whatever its age; a newer staged read (a re-read) undoes the decision; another kind; under hold; nothing older left to delete; finance off.
    for (const [name, id] of Object.entries({ young, staged, reread, orders, income, held, nothingOlder, offFile })) expect(files.has(id), name).toBe(false);
    // A limit under 1 still returns one row at most, and a limit above 1000 never more than 1000.
    expect((await due(90, 0)).length).toBeLessThanOrEqual(1);
  });

  it('deletes the OLDER bank_statement versions of a due file and nothing else, and refuses every file that is not due', async () => {
    const target = await file(orgId, users.owner, [{ kind: 'bank_statement', state: 'staged' }, { kind: 'bank_statement', state: 'staged' }, { kind: 'bank_statement', state: 'imported' }], 120);
    const before = await versionsOf(target);
    const decisionBefore = before[2];
    const fileBefore = await fileRow(target);
    // The others are refused, and nothing changes in any of them.
    const notDue = {
      young: await file(orgId, users.owner, decided(), 89),
      staged: await file(orgId, users.owner, [{ kind: 'bank_statement', state: 'staged' }, { kind: 'bank_statement', state: 'staged' }], 400),
      reread: await file(orgId, users.owner, [...decided(), { kind: 'bank_statement', state: 'staged' }], 400),
      orders: await file(orgId, users.owner, [{ kind: 'marketplace_orders', state: 'staged' }, { kind: 'marketplace_orders', state: 'imported' }], 400),
      held: await file(orgId, users.owner, decided(), 400, true),
      nothingOlder: await file(orgId, users.owner, [{ kind: 'bank_statement', state: 'imported' }], 400),
    };
    for (const [name, id] of Object.entries(notDue)) {
      const had = (await versionsOf(id)).length;
      expect(await apply(orgId, id, 90, true), name).toEqual({ applied: false, versions: 0 });
      expect((await versionsOf(id)).length, name).toBe(had);
    }
    // A file of another org, named under this org's context: nothing, and the other org's rows are untouched.
    const foreign = await file(otherOrgId, users.other, decided(), 400);
    expect(await apply(orgId, foreign, 90, true)).toEqual({ applied: false, versions: 0 });
    expect((await versionsOf(foreign)).length).toBe(2);

    const auditBefore = await auditCount(orgId);
    expect(await apply(orgId, target, 90, true)).toEqual({ applied: true, versions: 2 });
    const after = await versionsOf(target);
    expect(after.map((v) => v.version)).toEqual([decisionBefore?.version]);
    // The decision's version is the same row with the same summary, and no row of the other side is left in it.
    expect(after[0]).toEqual(decisionBefore);
    expect(JSON.stringify(after)).not.toContain(COUNTERPARTY);
    expect(JSON.stringify(after)).not.toContain(COUNTERPARTY_ACCOUNT);
    // The file row (and its bytes' hash and key) and the audit trail are as they were; the numbering still goes on (extraction_assign_version takes the max).
    expect(await fileRow(target)).toEqual(fileBefore);
    expect(await auditCount(orgId)).toBe(auditBefore);
    // A second run finds nothing: the file is not listed and apply deletes nothing.
    expect((await dueFiles()).has(target)).toBe(false);
    expect(await apply(orgId, target, 90, true)).toEqual({ applied: false, versions: 0 });
  });

  it('keeps an older version of another kind, or a failed run, of the same file', async () => {
    const f = await file(orgId, users.owner, [{ kind: 'none', state: 'failed' }, { kind: 'invoice', state: 'staged' }, { kind: 'bank_statement', state: 'staged' }, { kind: 'bank_statement', state: 'rejected' }], 200);
    expect(await apply(orgId, f, 90, true)).toEqual({ applied: true, versions: 1 });
    expect((await versionsOf(f)).map((v) => [v.version, v.kind])).toEqual([[1, null], [2, 'invoice'], [4, 'bank_statement']]);
  });

  it('still refuses to change a finished version, and no tenant role can delete one', async () => {
    const f = await file(orgId, users.owner, decided(), 200);
    const [staged] = await versionsOf(f);
    expect(staged).toBeDefined();
    // extraction_guard is untouched: even the database owner's UPDATE of a finished version is refused.
    expect(await outcome(admin((c) => c.query("UPDATE crove_kernel.extraction SET result = '{}'::jsonb WHERE id = $1", [staged?.id])))).toMatchObject({ ok: false, code: '42501', message: expect.stringContaining('EXTRACTION_IMMUTABLE') });
    // A tenant login in a member's context has no DELETE on extraction, and cannot touch the rows through the table.
    expect(await outcome(inContext(appUrl, user(users.owner, orgId), (c) => c.query('DELETE FROM crove_kernel.extraction WHERE id = $1', [staged?.id])))).toMatchObject({ ok: false, code: '42501' });
    expect(await outcome(inContext(appUrl, user(users.owner, orgId), (c) => c.query('DELETE FROM crove_kernel.extraction WHERE file_id = $1', [f])))).toMatchObject({ ok: false, code: '42501' });
    // The worker's system context has none either: only the definer deletes.
    expect(await outcome(inContext(workerUrl, system(orgId), (c) => c.query('DELETE FROM crove_kernel.extraction WHERE file_id = $1', [f])))).toMatchObject({ ok: false, code: '42501' });
    expect((await versionsOf(f)).length).toBe(2);
  });
});
