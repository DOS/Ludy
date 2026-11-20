// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7, issue #2691 N1 and N2):
// - N1: crove_hr.payroll_employment stays append-only for everyone except crove_kernel.org_purge(integer): its append_only_row
//   trigger, crove_hr.employment_append_only, refuses every UPDATE, TRUNCATE, and DELETE unless running as org_purge's owner
//   with the purge's mark naming the row's org, on crove_worker, in that org's system context, while the org offboards; no
//   other function in any user schema contains a static or dynamic DELETE targeting crove_hr.payroll_employment.
// - N2: crove_hr.payroll_employee enforces the 10-year retention window (Vietnam UTC+7 calendar day against ended_on + 10 years,
//   matching retentionEnds in modules/hr/src/employees.ts, including leap-day rollover) and locks erased_at, ended_on, and status
//   once erased_at is set, via crove_hr.employee_retention_guard (b_employee_retention), while org_purge still deletes rows.
// Keep this directory self-contained: import only fixtures in test/invariant/ and workspace packages under test.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { orgPurgeCommand, purgeOrg } from '../../src/org-purge.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const EMPLOYMENT_TABLE = 'crove_hr.payroll_employment';
const EMPLOYEE_TABLE = 'crove_hr.payroll_employee';
const APPEND_ONLY = /is append-only/;
const DAY_MS = 24 * 60 * 60 * 1000;

const noBlobs: BlobStore = {
  put: async () => {
    throw new Error('not used');
  },
  get: async () => {
    throw new Error('not used');
  },
  delete: async () => {},
};

type Org = { orgId: string; owner: string; employeeId: string; employmentId: string };
type Session = { login: 'crove_worker' | 'crove_app'; context: { system: string } | { user: { orgId: string; owner: string } } | null };

const suite = ADMIN ? describe : describe.skip;

suite('HR employment append-only guard and employee retention DB guard (#2691)', () => {
  const dbName = `crove_test_hr_retention_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // An org with one employee and one employment row, moved to the given status as staff.
  async function seeded(status: 'active' | 'offboarding'): Promise<Org> {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), {
      issuer: 'test',
      subject: `hr-owner-${tag}`,
      email: `hr-owner-${tag}@example.com`,
      name: null,
    });
    const org = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, `Công ty HR ${tag}`);
    const { employeeId, employmentId } = await withClient(adminUrl, async (c) => {
      const empId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_hr.payroll_employee (org_id, display_name) VALUES ($1, $2) RETURNING id`,
          [org.orgId, `Nhân viên ${tag}`],
        )
      ).rows[0]?.id as string;
      const termId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_hr.payroll_employment (org_id, employee_id, effective_from, contract_type, region, base_wage)
           VALUES ($1, $2, '2026-01-01', 'indefinite', 'I', 15000000) RETURNING id`,
          [org.orgId, empId],
        )
      ).rows[0]?.id as string;
      if (status === 'offboarding') {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [org.orgId]);
        await c.query('COMMIT');
      }
      return { employeeId: empId, employmentId: termId };
    });
    return { orgId: org.orgId, owner, employeeId, employmentId };
  }

  // Runs `statement` ($1 = target org when non-null) inside a probe definer owned by org_purge's owner (or another role),
  // with crove.org_purge set to `mark`, from the given session, inside a rolled-back transaction.
  async function probe(
    session: Session,
    mark: string | null,
    statement: string,
    target: string | null,
    owner: 'purger' | 'other' = 'purger',
  ): Promise<string> {
    return withClient(adminUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`CREATE FUNCTION crove_hr.t2691_probe(p_mark text, p_sql text, p_org uuid) RETURNS bigint
          LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
          DECLARE v_n bigint;
          BEGIN
            PERFORM pg_catalog.set_config('crove.org_purge', coalesce(p_mark, ''), true);
            IF p_org IS NULL THEN EXECUTE p_sql; ELSE EXECUTE p_sql USING p_org; END IF;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            RETURN v_n;
          END $$`);
        let role = (
          await c.query<{ owner: string }>(
            `SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid = 'crove_kernel.org_purge(integer)'::regprocedure`,
          )
        ).rows[0]?.owner as string;
        if (owner === 'other') {
          role = `t2691_other_${randomUUID().slice(0, 8)}`;
          await c.query(`CREATE ROLE ${role} NOLOGIN BYPASSRLS`);
          await c.query(`GRANT USAGE ON SCHEMA crove_kernel, crove_hr TO ${role}`);
          await c.query(`GRANT SELECT, UPDATE, DELETE ON ${EMPLOYMENT_TABLE} TO ${role}`);
        }
        await c.query(`ALTER FUNCTION crove_hr.t2691_probe(text, text, uuid) OWNER TO ${role}`);
        await c.query(`GRANT EXECUTE ON FUNCTION crove_hr.t2691_probe(text, text, uuid) TO ${session.login}`);
        await c.query(`SET SESSION AUTHORIZATION ${session.login}`);
        const context = session.context;
        if (context && 'system' in context) {
          await c.query('SELECT crove_kernel.enter_system_context($1)', [context.system]);
        } else if (context) {
          await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
            context.user.orgId,
            contextToken(context.user.owner, context.user.orgId),
          ]);
        }
        const { rows } = await c.query<{ n: string }>('SELECT crove_hr.t2691_probe($1, $2, $3) AS n', [
          mark,
          statement,
          target,
        ]);
        return `${rows[0]?.n} row(s)`;
      } catch (e) {
        return (e as Error).message;
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  const employmentCount = (orgId: string) =>
    withClient(adminUrl, async (c) =>
      Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${EMPLOYMENT_TABLE} WHERE org_id = $1`, [orgId])).rows[0]?.n),
    );

  // Executes SQL directly as crove_app inside the owner's sealed user context, returning either 'ok' or { code, message }.
  async function runAsOwner(
    org: { orgId: string; owner: string },
    sqlText: string,
    params: unknown[],
    options: { rollback?: boolean } = {},
  ): Promise<{ ok: true; rowCount: number } | { ok: false; code?: string; message: string }> {
    return withClient(appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
          org.orgId,
          contextToken(org.owner, org.orgId),
        ]);
        const res = await c.query(sqlText, params);
        if (options.rollback) await c.query('ROLLBACK');
        else await c.query('COMMIT');
        return { ok: true, rowCount: res.rowCount ?? 0 };
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        const err = e as Error & { code?: string };
        return { ok: false, ...(err.code !== undefined ? { code: err.code } : {}), message: err.message };
      }
    });
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();
    pool = createPool({ connectionString: appUrl, max: 2 });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    const registry = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register(registry);
    workerRuntime = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS })
      .register(registry)
      .register({ commands: [orgPurgeCommand({ store: noBlobs })] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets a DELETE on crove_hr.payroll_employment through only as org_purge, for its org, on crove_worker, in that org system context, while offboarding', async () => {
    const a = await seeded('offboarding');
    const b = await seeded('offboarding');
    const live = await seeded('active');
    const before = { a: await employmentCount(a.orgId), b: await employmentCount(b.orgId), live: await employmentCount(live.orgId) };
    const worker = (orgId: string): Session => ({ login: 'crove_worker', context: { system: orgId } });
    const remove = `DELETE FROM ${EMPLOYMENT_TABLE} WHERE org_id = $1`;
    const update = `UPDATE ${EMPLOYMENT_TABLE} SET base_wage = 1 WHERE org_id = $1`;

    expect(await probe(worker(a.orgId), a.orgId, remove, a.orgId)).toBe('1 row(s)');

    const refused: Array<[string, Session, string | null, string, string, ('purger' | 'other')?]> = [
      ['no mark', worker(a.orgId), null, remove, a.orgId],
      ["a definer of another role than org_purge's owner", worker(a.orgId), a.orgId, remove, a.orgId, 'other'],
      ['a mark naming another org', worker(a.orgId), b.orgId, remove, a.orgId],
      ["another org's rows, under its mark, from this org's context", worker(a.orgId), b.orgId, remove, b.orgId],
      ["another org's rows, under this org's mark", worker(a.orgId), a.orgId, remove, b.orgId],
      ['the worker outside a context', { login: 'crove_worker', context: null }, a.orgId, remove, a.orgId],
      ["the API login in the owner's context", { login: 'crove_app', context: { user: a } }, a.orgId, remove, a.orgId],
      ['the API login outside a context', { login: 'crove_app', context: null }, a.orgId, remove, a.orgId],
      ['an org that is not offboarding', worker(live.orgId), live.orgId, remove, live.orgId],
      ['an UPDATE under every other condition', worker(a.orgId), a.orgId, update, a.orgId],
    ];
    for (const [label, session, mark, statement, target, owner] of refused) {
      expect([label, await probe(session, mark, statement, target, owner)]).toEqual([label, expect.stringMatching(APPEND_ONLY)]);
    }

    expect({ a: await employmentCount(a.orgId), b: await employmentCount(b.orgId), live: await employmentCount(live.orgId) }).toEqual(before);
    expect(before).toEqual({ a: 1, b: 1, live: 1 });
  });

  it('keeps TRUNCATE refused on crove_hr.payroll_employment and pins trigger metadata and function hardening', async () => {
    const { appendGuarded, appendTruncate, retentionTriggers, shapes } = await withClient(adminUrl, async (c) => {
      const appendGuarded = (
        await c.query<{ t: string; name: string; enabled: string }>(
          `SELECT t.tgrelid::regclass::text AS t, t.tgname AS name, t.tgenabled::text AS enabled
             FROM pg_trigger t
            WHERE t.tgfoid = 'crove_hr.employment_append_only()'::regprocedure
            ORDER BY 1`,
        )
      ).rows;
      const appendTruncate = (
        await c.query<{ t: string; enabled: string }>(
          `SELECT t.tgrelid::regclass::text AS t, t.tgenabled::text AS enabled
             FROM pg_trigger t
            WHERE t.tgname = 'append_only_truncate' AND t.tgrelid = $1::regclass
            ORDER BY 1`,
          [EMPLOYMENT_TABLE],
        )
      ).rows;
      const retentionTriggers = (
        await c.query<{ t: string; name: string; enabled: string }>(
          `SELECT t.tgrelid::regclass::text AS t, t.tgname AS name, t.tgenabled::text AS enabled
             FROM pg_trigger t
            WHERE t.tgfoid = 'crove_hr.employee_retention_guard()'::regprocedure
            ORDER BY 1`,
        )
      ).rows;
      const shapes = (
        await c.query<{ fn: string; definer: boolean; config: string[]; public: boolean }>(
          `SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, p.proconfig AS config,
                  EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
             FROM pg_proc p
            WHERE p.oid IN ('crove_hr.employment_append_only()'::regprocedure, 'crove_hr.employee_retention_guard()'::regprocedure)
            ORDER BY 1`,
        )
      ).rows;
      return { appendGuarded, appendTruncate, retentionTriggers, shapes };
    });

    expect(appendGuarded).toEqual([{ t: EMPLOYMENT_TABLE, name: 'append_only_row', enabled: 'O' }]);
    expect(appendTruncate).toEqual([{ t: EMPLOYMENT_TABLE, enabled: 'O' }]);
    expect(retentionTriggers).toEqual([{ t: EMPLOYEE_TABLE, name: 'b_employee_retention', enabled: 'O' }]);
    expect(shapes).toEqual([
      { fn: 'crove_hr.employee_retention_guard()', definer: false, config: ['search_path=pg_catalog, pg_temp'], public: false },
      { fn: 'crove_hr.employment_append_only()', definer: false, config: ['search_path=pg_catalog, pg_temp'], public: false },
    ]);

    const org = await seeded('offboarding');
    expect(
      await probe({ login: 'crove_worker', context: { system: org.orgId } }, org.orgId, `TRUNCATE ${EMPLOYMENT_TABLE} CASCADE`, null),
    ).toMatch(APPEND_ONLY);
  });

  it('has no function in any user schema except crove_kernel.org_purge(integer) deleting from crove_hr.payroll_employment', async () => {
    const STATIC = String.raw`delete\s+from\s+(only\s+)?"?crove_hr"?\s*\.\s*"?payroll_employment\M`;
    const DYNAMIC = String.raw`delete\s+from\s+(only\s+)?("?crove_hr"?\s*\.\s*)?%`;
    const deleters = async (c: pg.Client, pattern: string) =>
      (
        await c.query<{ fn: string }>(
          `SELECT p.oid::regprocedure::text AS fn
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND p.prokind IN ('f', 'p')
              AND pg_get_functiondef(p.oid) ~* $1
            ORDER BY 1`,
          [pattern],
        )
      ).rows.map((r) => r.fn);

    await withClient(adminUrl, async (c) => {
      expect(await deleters(c, STATIC)).toEqual(['crove_kernel.org_purge(integer)']);
      expect(await deleters(c, DYNAMIC)).toEqual(['crove_kernel.org_purge(integer)']);

      // Probe fixtures proving the scan catches schema-qualified %I, bare %I, and SQL-standard atomic deletes (rolled back).
      await c.query('BEGIN');
      try {
        await c.query(`CREATE FUNCTION crove_hr.t2691_dynamic_qualified(p_org uuid) RETURNS void
          LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
          BEGIN EXECUTE pg_catalog.format('DELETE FROM crove_hr.%I WHERE org_id = $1', 'payroll_employment') USING p_org; END $$`);
        await c.query(`CREATE FUNCTION crove_hr.t2691_dynamic_bare(p_org uuid) RETURNS void
          LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
          BEGIN EXECUTE pg_catalog.format('DELETE FROM %I WHERE org_id = $1', 'payroll_employment') USING p_org; END $$`);
        await c.query(`CREATE FUNCTION crove_hr.t2691_atomic(p_org uuid) RETURNS void
          LANGUAGE sql SET search_path = pg_catalog, pg_temp
          BEGIN ATOMIC DELETE FROM crove_hr.payroll_employment WHERE org_id = p_org; END`);

        expect(await deleters(c, DYNAMIC)).toEqual([
          'crove_hr.t2691_dynamic_bare(uuid)',
          'crove_hr.t2691_dynamic_qualified(uuid)',
          'crove_kernel.org_purge(integer)',
        ]);
        expect(await deleters(c, STATIC)).toEqual(['crove_hr.t2691_atomic(uuid)', 'crove_kernel.org_purge(integer)']);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it('enforces the 10-year retention window and erased-row immutability directly in PostgreSQL while allowing org_purge (#2691 N2)', async () => {
    const org = await seeded('active');

    // Active employee: direct SQL erasure is refused by check constraint / trigger.
    const activeErase = await runAsOwner(
      org,
      `UPDATE crove_hr.payroll_employee SET erased_at = '2040-01-01T00:00:00Z' WHERE org_id = $1 AND id = $2`,
      [org.orgId, org.employeeId],
    );
    expect(activeErase).toMatchObject({ ok: false, code: '23514' });

    // Direct INSERT with erased_at set before retention expires is refused; past retention succeeds (rolled back).
    const earlyInsert = await runAsOwner(
      org,
      `INSERT INTO crove_hr.payroll_employee (org_id, display_name, status, ended_on, erased_at)
       VALUES ($1, 'Sớm quá', 'ended', '2026-01-01', '2036-01-01T16:59:59Z')`,
      [org.orgId],
      { rollback: true },
    );
    expect(earlyInsert).toMatchObject({ ok: false, code: '23514' });

    const eligibleInsert = await runAsOwner(
      org,
      `INSERT INTO crove_hr.payroll_employee (org_id, display_name, status, ended_on, erased_at)
       VALUES ($1, 'Đã hết hạn', 'ended', '2016-02-29', '2026-03-01T17:00:00Z')`,
      [org.orgId],
      { rollback: true },
    );
    expect(eligibleInsert).toEqual({ ok: true, rowCount: 1 });

    // Move employee to ended on 2026-08-31: recent date and exact UTC+7 boundary day (2036-08-31 23:59:59+07) are refused.
    expect(
      await runAsOwner(org, `UPDATE crove_hr.payroll_employee SET status = 'ended', ended_on = '2026-08-31' WHERE org_id = $1 AND id = $2`, [
        org.orgId,
        org.employeeId,
      ]),
    ).toEqual({ ok: true, rowCount: 1 });

    const recentErase = await runAsOwner(
      org,
      `UPDATE crove_hr.payroll_employee SET erased_at = '2026-09-01T00:00:00Z' WHERE org_id = $1 AND id = $2`,
      [org.orgId, org.employeeId],
    );
    expect(recentErase).toMatchObject({ ok: false, code: '23514', message: expect.stringContaining('retention period has not passed') });

    // 2036-08-31T16:59:59Z is 2036-08-31 23:59:59 UTC+7 (v_vn_day = v_until): still within retention, refused.
    const exactBoundaryRefused = await runAsOwner(
      org,
      `UPDATE crove_hr.payroll_employee SET erased_at = '2036-08-31T16:59:59Z' WHERE org_id = $1 AND id = $2`,
      [org.orgId, org.employeeId],
    );
    expect(exactBoundaryRefused).toMatchObject({ ok: false, code: '23514' });

    // 2036-08-31T17:00:00Z is 2036-09-01 00:00:00 UTC+7 (v_vn_day = v_until + 1): allowed (rolled back for leap-day check).
    const nextDayAllowed = await runAsOwner(
      org,
      `UPDATE crove_hr.payroll_employee SET erased_at = '2036-08-31T17:00:00Z' WHERE org_id = $1 AND id = $2`,
      [org.orgId, org.employeeId],
      { rollback: true },
    );
    expect(nextDayAllowed).toEqual({ ok: true, rowCount: 1 });

    // Leap-day rule matching JS Date.UTC(2016 + 10, 1, 29) -> 2026-03-01:
    // ended_on = 2016-02-29 must be refused on 2026-03-01 (2026-03-01T16:59:59Z = 2026-03-01 23:59:59 UTC+7)
    // and allowed on 2026-03-02 (2026-03-01T17:00:00Z = 2026-03-02 00:00:00 UTC+7).
    expect(
      await runAsOwner(org, `UPDATE crove_hr.payroll_employee SET ended_on = '2016-02-29' WHERE org_id = $1 AND id = $2`, [
        org.orgId,
        org.employeeId,
      ]),
    ).toEqual({ ok: true, rowCount: 1 });

    const leapBoundaryRefused = await runAsOwner(
      org,
      `UPDATE crove_hr.payroll_employee SET erased_at = '2026-03-01T16:59:59Z' WHERE org_id = $1 AND id = $2`,
      [org.orgId, org.employeeId],
    );
    expect(leapBoundaryRefused).toMatchObject({ ok: false, code: '23514', message: expect.stringContaining('2026-03-01') });

    const leapNextDayCommitted = await runAsOwner(
      org,
      `UPDATE crove_hr.payroll_employee SET erased_at = '2026-03-01T17:00:00Z' WHERE org_id = $1 AND id = $2`,
      [org.orgId, org.employeeId],
    );
    expect(leapNextDayCommitted).toEqual({ ok: true, rowCount: 1 });

    // Once erased_at is set, clearing erased_at, changing erased_at, moving ended_on, or changing status is refused.
    const tamperCases: Array<[string, string, unknown[]]> = [
      ['clear erased_at', `UPDATE crove_hr.payroll_employee SET erased_at = NULL WHERE org_id = $1 AND id = $2`, [org.orgId, org.employeeId]],
      [
        'change erased_at',
        `UPDATE crove_hr.payroll_employee SET erased_at = '2026-03-05T00:00:00Z' WHERE org_id = $1 AND id = $2`,
        [org.orgId, org.employeeId],
      ],
      ['move ended_on', `UPDATE crove_hr.payroll_employee SET ended_on = '2010-01-01' WHERE org_id = $1 AND id = $2`, [org.orgId, org.employeeId]],
      [
        'reopen status and clear ended_on',
        `UPDATE crove_hr.payroll_employee SET status = 'active', ended_on = NULL WHERE org_id = $1 AND id = $2`,
        [org.orgId, org.employeeId],
      ],
    ];
    for (const [label, sqlText, params] of tamperCases) {
      expect([label, await runAsOwner(org, sqlText, params)]).toEqual([label, expect.objectContaining({ ok: false, code: '23514' })]);
    }

    // Also add a non-erased employee so org_purge exercises deleting both erased and non-erased rows + employment rows.
    await withClient(adminUrl, async (c) => {
      await c.query(`INSERT INTO crove_hr.payroll_employee (org_id, display_name) VALUES ($1, 'Nhân viên còn làm')`, [org.orgId]);
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [org.orgId]);
      await c.query('COMMIT');
      const requestedAt = new Date(Date.now() - 40 * DAY_MS);
      const exportedAt = new Date(Date.now() - 31 * DAY_MS);
      await c.query(
        `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, $8)`,
        [
          org.orgId,
          requestedAt,
          org.owner,
          randomUUID(),
          '0'.repeat(64),
          exportedAt,
          randomUUID(),
          JSON.stringify({ format: 'crove.org-export.v2', file_count: 0 }),
        ],
      );
    });

    const purgeResult = await purgeOrg(workerRuntime, 30, { ref: org.orgId, reason: 'Retention invariant test' });

    expect(purgeResult).toMatchObject({ kind: 'purged', orgId: org.orgId });
    if (purgeResult.kind === 'purged') {
      expect(purgeResult.result.counts.deleted['crove_hr.payroll_employee']).toBe(2);
      expect(purgeResult.result.counts.deleted['crove_hr.payroll_employment']).toBe(1);
    }
    expect(await employmentCount(org.orgId)).toBe(0);
    await withClient(adminUrl, async (c) => {
      const n = Number(
        (await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_hr.payroll_employee WHERE org_id = $1`, [org.orgId])).rows[0]?.n,
      );
      expect(n).toBe(0);
    });
  });
});
