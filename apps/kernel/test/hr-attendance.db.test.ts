// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 5C attendance integration & security tests on PostgreSQL 17 (#4447):
// - Self-service check-in/out (web & office QR stamp), server Vietnam timestamps, duplicate/locked guards
// - Tenant, entity, and peer isolation across RLS + RPC; viewer & unlinked member blocks; zero biometric columns
// - QR rotation invalidates previous secrets and hides qr_secret_hash from non-admins
// - Deterministic anomaly detection + audited metered Ly narration fallback & pseudonymization
// - 1-click rollup into draft payroll run matching CSV timekeeping calculation via decimal.js
// - PDPL employee.erase clears attendance_log.note + post-erasure mutation block; org_purge cleans all rows
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PayrollPromptLeakError } from '@ludy/agent';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  vietnamMonth,
  vietnamToday,
  type HrAttendanceAnomaliesSnapshot,
  type HrAttendanceListResult,
  type HrAttendanceLogView,
  type HrAttendanceQrRotateResult,
  type HrAttendanceRollupResult,
  type HrEmployee,
  type HrRunSheet,
  type HrRunWritten,
  type HrSelfAttendanceListResult,
  type HrWritten,
} from '@ludy/kernel-contract';
import { CredentialVault, DomainError, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { calculatePayroll, money, PAYROLL_RULES } from '@ludy/l10n-vn';
import { hrCommands, hrQueries } from '@ludy/mod-hr';
import { generateAttendanceAnomaliesBrief, type AttendanceAnomaliesAi } from '../src/attendance-coworker-ai.ts';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('HR Stage 5C attendance & monthly rollup on PostgreSQL (#4447)', () => {
  const dbName = `crove_test_hrattendance_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function runAsUserInOrg<T>(userId: string, orgId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const res = await fn(c);
      await c.query('COMMIT');
      return res;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await c.end();
    }
  }

  async function createAttendanceOrg() {
    const tag = randomUUID().slice(0, 8);
    const db = createDb(pool);
    const person = (role: string) =>
      upsertIdentity(db, { issuer: 'att', subject: `${role}-${tag}`, email: `${role}-${tag}@att.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const memberA = await person('member-a');
    const memberB = await person('member-b');
    const unlinked = await person('unlinked');
    const viewer = await person('viewer');

    const { orgId, slug } = await createOrg(rt, asUser(owner), `Chấm công ${tag}`);
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer')`,
        [orgId, admin, memberA, memberB, unlinked, viewer],
      ),
    );

    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });

    const hire = async (
      name: string,
      opts: { payBasis?: 'monthly' | 'hourly'; wage?: string; hourlyRate?: string; scheduledHoursPerDay?: string; effectiveFrom?: string } = {},
    ) =>
      exec<HrWritten>(owner, 'hr.payroll.employee.add', {
        displayName: name,
        employment: {
          effectiveFrom: opts.effectiveFrom ?? '2026-01-01',
          contractType: 'indefinite',
          region: 'I',
          payBasis: opts.payBasis ?? 'monthly',
          baseWage: opts.wage ?? '15000000',
          ...(opts.hourlyRate ? { hourlyRate: opts.hourlyRate } : {}),
          ...(opts.scheduledHoursPerDay ? { scheduledHoursPerDay: opts.scheduledHoursPerDay } : {}),
        },
      });

    const empARes = await hire('Nguyễn Văn A');
    const empBRes = await hire('Trần Thị B', { payBasis: 'hourly', wage: '8000000', hourlyRate: '80000' });
    const empAId = empARes.employeeId as string;
    const empBId = empBRes.employeeId as string;

    await exec(owner, 'hr.payroll.employee.link_member', { employeeId: empAId, userId: memberA });
    await exec(owner, 'hr.payroll.employee.link_member', { employeeId: empBId, userId: memberB });

    return {
      orgId,
      slug,
      owner,
      admin,
      memberA,
      memberB,
      unlinked,
      viewer,
      empAId,
      empBId,
      exec,
      query,
      hire,
    };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const workerUrl = new URL(url.toString());
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';

    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();

    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });

    const register = (target: pg.Pool) =>
      new Runtime(createDb(target), {
        manifests: TEST_MANIFESTS,
        subjectVault,
        readAuditKey: randomBytes(32),
      }).register({ commands: [...kernelCommands, ...hrCommands], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries] });

    rt = register(pool);
    workerRt = register(workerPool).register({ commands: [orgPurgeCommand({ store: new MemoryStore() })] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('stores zero biometric, FaceID, photo, or location columns under PDPL 91/2025/QH15', async () => {
    const cols = await withAdmin(async (c) => {
      const { rows } = await c.query<{ table_name: string; column_name: string }>(`
        SELECT c.relname AS table_name, a.attname AS column_name
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ludy_hr'
          AND c.relname IN ('attendance_log', 'attendance_qr_config')
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY 1, 2
      `);
      return rows;
    });

    const names = cols.map((r) => `${r.table_name}.${r.column_name}`);
    for (const col of names) {
      expect(col).not.toMatch(/biometric|face|photo|selfie|image|gps|lat|lng|location/i);
    }
    expect(names).toContain('attendance_log.work_date');
    expect(names).toContain('attendance_qr_config.qr_secret_hash');
  });

  it('supports 1-click web & QR check-in/out, QR rotation invalidation, and strict RLS/viewer/peer isolation', async () => {
    const o1 = await createAttendanceOrg();
    const o2 = await createAttendanceOrg();
    const today = vietnamToday(new Date());
    const month = vietnamMonth(new Date());

    // 1. Rotate office QR in o1; reject idempotencyKey replay persistence, invalid secret, and verify valid secret (also via full URL)
    await expect(
      rt.execute('hr.attendance.qr.rotate', {}, { actor: asUser(o1.owner), orgId: o1.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_UNSUPPORTED', status: 400 });
    const qr1 = await o1.exec<HrAttendanceQrRotateResult>(o1.owner, 'hr.attendance.qr.rotate', {});
    expect(qr1.secret.length).toBeGreaterThan(16);

    await expect(
      o1.exec(o1.memberA, 'hr.self.attendance.check_in', { method: 'qr', qrToken: 'wrong-secret' }),
    ).rejects.toMatchObject({ code: 'HR_ATTENDANCE_QR_INVALID' });

    // Non-admin member cannot read ludy_hr.attendance_qr_config directly at SQL level
    const memberQrCount = await runAsUserInOrg(o1.memberA, o1.orgId, async (c) => {
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ludy_hr.attendance_qr_config WHERE org_id = $1', [o1.orgId]);
      return rows[0]?.n;
    });
    expect(memberQrCount).toBe(0);

    // Check in memberA via full URL containing ?qr=<secret>
    const checkInA = await o1.exec<HrAttendanceLogView>(o1.memberA, 'hr.self.attendance.check_in', {
      method: 'qr',
      qrToken: `https://app.ludy.vn/o/${o1.slug}/hr/my?qr=${encodeURIComponent(qr1.secret)}`,
      note: 'Làm tại văn phòng Q1',
    });
    expect(checkInA.workDate).toBe(today);
    expect(checkInA.checkInMethod).toBe('qr');
    expect(checkInA.status).toBe('missing_checkout');
    expect(checkInA.checkedOutAt).toBeNull();

    // Duplicate same-day check-in is refused
    await expect(
      o1.exec(o1.memberA, 'hr.self.attendance.check_in', { method: 'web' }),
    ).rejects.toMatchObject({ code: 'HR_ATTENDANCE_ALREADY_CHECKED_IN' });

    // Rotate QR again -> previous qr1 secret becomes invalid for memberB
    const qr2 = await o1.exec<HrAttendanceQrRotateResult>(o1.admin, 'hr.attendance.qr.rotate', {});
    expect(qr2.secret).not.toBe(qr1.secret);
    await expect(
      o1.exec(o1.memberB, 'hr.self.attendance.check_in', { method: 'qr', qrToken: qr1.secret }),
    ).rejects.toMatchObject({ code: 'HR_ATTENDANCE_QR_INVALID' });

    // Valid new QR works for memberB using fragment #qr=<secret> URL format
    const checkInB = await o1.exec<HrAttendanceLogView>(o1.memberB, 'hr.self.attendance.check_in', {
      method: 'qr',
      qrToken: `https://app.ludy.vn/o/${o1.slug}/hr/my#qr=${encodeURIComponent(qr2.secret)}`,
    });
    expect(checkInB.employeeId).toBe(o1.empBId);

    // Peer & cross-org isolation via RPC and direct SQL RLS
    const listA = await o1.query<HrSelfAttendanceListResult>(o1.memberA, 'hr.self.attendance.list', { month });
    expect(listA.logs.map((l) => l.employeeId)).toEqual([o1.empAId]);

    const rlsSeenByA = await runAsUserInOrg(o1.memberA, o1.orgId, async (c) => {
      const { rows } = await c.query<{ id: string }>('SELECT id FROM ludy_hr.attendance_log ORDER BY id');
      return rows.map((r) => r.id);
    });
    expect(rlsSeenByA).toEqual([checkInA.id]);

    const rlsSeenByOrg2Owner = await runAsUserInOrg(o2.owner, o2.orgId, async (c) => {
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ludy_hr.attendance_log WHERE org_id = $1', [o1.orgId]);
      return rows[0]?.n;
    });
    expect(rlsSeenByOrg2Owner).toBe(0);

    // Unlinked member blocked cleanly at RPC and DB RLS
    await expect(o1.query(o1.unlinked, 'hr.self.attendance.list', { month })).rejects.toMatchObject({
      code: 'HR_SELF_NOT_LINKED',
    });
    const rlsUnlinked = await runAsUserInOrg(o1.unlinked, o1.orgId, async (c) => {
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ludy_hr.attendance_log WHERE org_id = $1', [o1.orgId]);
      return rows[0]?.n;
    });
    expect(rlsUnlinked).toBe(0);

    // Viewer blocked across RPC AND DB RLS even if an employee row with no today log was linked to the viewer's user_id
    const empViewerRes = await o1.hire('Lê Kiểm Tra Viewer');
    const empViewerId = empViewerRes.employeeId as string;
    await withAdmin((c) =>
      c.query('UPDATE ludy_hr.payroll_employee SET user_id = $1 WHERE org_id = $2 AND id = $3', [o1.viewer, o1.orgId, empViewerId]),
    );
    await expect(o1.query(o1.viewer, 'hr.self.attendance.list', { month })).rejects.toBeInstanceOf(DomainError);
    await expect(o1.exec(o1.viewer, 'hr.self.attendance.check_in', { method: 'web' })).rejects.toBeInstanceOf(DomainError);
    const rlsViewerRows = await runAsUserInOrg(o1.viewer, o1.orgId, async (c) => {
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ludy_hr.attendance_log WHERE org_id = $1', [o1.orgId]);
      return rows[0]?.n;
    });
    expect(rlsViewerRows).toBe(0);
    const empInfo = await withAdmin(async (c) => {
      const { rows } = await c.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM ludy_hr.payroll_employee WHERE org_id = $1 AND id = $2', [
        o1.orgId,
        empViewerId,
      ]);
      return rows[0]!;
    });
    const viewerSqlErr = await runAsUserInOrg(o1.viewer, o1.orgId, (c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
         VALUES ($1, $2, $3, (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, pg_catalog.now(), 'web', 'missing_checkout')`,
        [o1.orgId, empInfo.legal_entity_id, empViewerId],
      ),
    ).catch((e: unknown) => e as { code?: string });
    expect(viewerSqlErr).toMatchObject({ code: '42501' });

    // Relink that same employee (with no today log yet) to a regular linked member -> exact same SQL INSERT shape succeeds
    await withAdmin((c) =>
      c.query('UPDATE ludy_hr.payroll_employee SET user_id = $1 WHERE org_id = $2 AND id = $3', [o1.unlinked, o1.orgId, empViewerId]),
    );
    const memberSqlRes = await runAsUserInOrg(o1.unlinked, o1.orgId, (c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
         VALUES ($1, $2, $3, (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, pg_catalog.now(), 'web', 'missing_checkout')`,
        [o1.orgId, empInfo.legal_entity_id, empViewerId],
      ),
    );
    expect(memberSqlRes.rowCount).toBe(1);

    // Cross-member direct SQL INSERT is rejected with explicit 42501 (insufficient_privilege)
    const crossMemberSqlErr = await runAsUserInOrg(o1.memberA, o1.orgId, (c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
         VALUES ($1, $2, $3, (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, pg_catalog.now(), 'web', 'missing_checkout')`,
        [o1.orgId, empInfo.legal_entity_id, o1.empBId],
      ),
    ).catch((e: unknown) => e as { code?: string });
    expect(crossMemberSqlErr).toMatchObject({ code: '42501' });

    // Non-admin linked employee cannot clear an existing attendance note during direct SQL self check-out (42501)
    await expect(
      runAsUserInOrg(o1.memberA, o1.orgId, (c) =>
        c.query(
          `UPDATE ludy_hr.attendance_log
           SET checked_out_at = pg_catalog.now(),
               worked_minutes = LEAST(1440, GREATEST(0, pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now() - checked_in_at) / 60)))::integer,
               status = CASE WHEN LEAST(1440, GREATEST(0, pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now() - checked_in_at) / 60)))::integer >= 360 THEN 'present' ELSE 'half_day' END,
               note = NULL
           WHERE org_id = $1 AND id = $2`,
          [o1.orgId, checkInA.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/note/i) });

    // memberA check-out succeeds once, and double check-out fails
    const outA = await o1.exec<HrAttendanceLogView>(o1.memberA, 'hr.self.attendance.check_out', { workDate: today });
    expect(outA.checkedOutAt).not.toBeNull();
    expect(outA.workedMinutes).toBeGreaterThanOrEqual(0);
    expect(outA.status).toBe('half_day');
    expect(outA.note).toBe('Làm tại văn phòng Q1');
    await expect(o1.exec(o1.memberA, 'hr.self.attendance.check_out', { workDate: today })).rejects.toMatchObject({
      code: 'HR_ATTENDANCE_ALREADY_CHECKED_OUT',
    });

    // Non-admin member cannot insert 'manual' or tamper with check_in_method directly via SQL
    await expect(
      runAsUserInOrg(o1.memberA, o1.orgId, (c) =>
        c.query(
          `UPDATE ludy_hr.attendance_log SET check_in_method = 'manual' WHERE org_id = $1 AND id = $2`,
          [o1.orgId, checkInA.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // B1 DB invariants: non-admin member cannot insert forged completed rows, bypass QR proof, or forge checkout duration/status in raw SQL
    await expect(
      runAsUserInOrg(o1.memberA, o1.orgId, (c) =>
        c.query(
          `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, checked_out_at, check_in_method, worked_minutes, status)
           VALUES ($1, $2, $3, '2026-11-02', now() - interval '8 hours', now(), 'web', 1440, 'present')`,
          [o1.orgId, empInfo.legal_entity_id, o1.empAId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      runAsUserInOrg(o1.memberA, o1.orgId, async (c) => {
        await c.query(`SELECT pg_catalog.set_config('ludy_hr.qr_verified_hash', $1, true)`, ['f'.repeat(64)]);
        await c.query(
          `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
           VALUES ($1, $2, $3, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1, now(), 'qr', 'missing_checkout')`,
          [o1.orgId, empInfo.legal_entity_id, o1.empAId],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });

    // Same-day forged QR proof on an active linked employee hits explicit 42501 QR secret guard
    await expect(
      runAsUserInOrg(o1.memberA, o1.orgId, async (c) => {
        await c.query(`SELECT pg_catalog.set_config('ludy_hr.qr_verified_hash', $1, true)`, ['f'.repeat(64)]);
        await c.query(
          `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
           VALUES ($1, $2, $3, (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, pg_catalog.now(), 'qr', 'missing_checkout')`,
          [o1.orgId, empInfo.legal_entity_id, o1.empAId],
        );
      }),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/QR/i) });

    await expect(
      runAsUserInOrg(o1.memberB, o1.orgId, (c) =>
        c.query(
          `UPDATE ludy_hr.attendance_log
           SET checked_out_at = now(), worked_minutes = 999, status = 'present'
           WHERE org_id = $1 AND id = $2`,
          [o1.orgId, checkInB.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // CHECK constraint rejects 'present' rows without checkout/worked_minutes even as admin
    await expect(
      withAdmin((c) =>
        c.query(
          `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
           VALUES ($1, $2, $3, '2026-11-03', now(), 'manual', 'present')`,
          [o1.orgId, empInfo.legal_entity_id, o1.empAId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'attendance_log_completed_fields_ck' });

    // Overnight openLog: yesterday's missing_checkout surfaces in self.attendance.list when today has no log,
    // while stale (>= 2 days old) open shifts are rejected by attendance_log_update_guard (23514) and ended staff cannot check in/out via SQL
    await withAdmin((c) => c.query(`DELETE FROM ludy_hr.attendance_log WHERE org_id = $1 AND employee_id = $2`, [o1.orgId, o1.empBId]));
    const twoDaysAgoVn = vietnamToday(new Date(Date.now() - 2 * 86_400_000));
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
         SELECT org_id, legal_entity_id, id, $3::date, now() - interval '9 hours', 'web', 'missing_checkout'
         FROM ludy_hr.payroll_employee WHERE org_id = $1 AND id = $2`,
        [o1.orgId, o1.empBId, twoDaysAgoVn],
      ),
    );
    const staleSelfSqlErr = await runAsUserInOrg(o1.memberB, o1.orgId, (c) =>
      c.query(
        `UPDATE ludy_hr.attendance_log
         SET checked_out_at = pg_catalog.now(), worked_minutes = 540, status = 'present'
         WHERE org_id = $1 AND employee_id = $2 AND work_date = $3::date`,
        [o1.orgId, o1.empBId, twoDaysAgoVn],
      ),
    ).catch((e: unknown) => e as { code?: string; message?: string });
    expect(staleSelfSqlErr).toMatchObject({ code: '23514' });
    expect(String((staleSelfSqlErr as { message?: string }).message ?? '')).toContain('today or yesterday');
    await withAdmin((c) =>
      c.query(`DELETE FROM ludy_hr.attendance_log WHERE org_id = $1 AND employee_id = $2 AND work_date = $3::date`, [
        o1.orgId,
        o1.empBId,
        twoDaysAgoVn,
      ]),
    );

    const yesterdayVn = vietnamToday(new Date(Date.now() - 86_400_000));
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
         SELECT org_id, legal_entity_id, id, $3::date, now() - interval '9 hours', 'web', 'missing_checkout'
         FROM ludy_hr.payroll_employee WHERE org_id = $1 AND id = $2`,
        [o1.orgId, o1.empBId, yesterdayVn],
      ),
    );
    const overnightList = await o1.query<HrSelfAttendanceListResult>(o1.memberB, 'hr.self.attendance.list', { month });
    expect(overnightList.todayLog).toBeNull();
    expect(overnightList.openLog?.workDate).toBe(yesterdayVn);

    await o1.exec(o1.owner, 'hr.payroll.employee.end', { employeeId: o1.empBId, endedOn: today });
    const endedUpdate = await runAsUserInOrg(o1.memberB, o1.orgId, (c) =>
      c.query(
        `UPDATE ludy_hr.attendance_log
         SET checked_out_at = now(), worked_minutes = 540, status = 'present'
         WHERE org_id = $1 AND employee_id = $2 AND work_date = $3::date`,
        [o1.orgId, o1.empBId, yesterdayVn],
      ),
    );
    expect(endedUpdate.rowCount).toBe(0);
    await expect(
      runAsUserInOrg(o1.memberB, o1.orgId, (c) =>
        c.query(
          `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
           VALUES ($1, $2, $3, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, now(), 'web', 'missing_checkout')`,
          [o1.orgId, empInfo.legal_entity_id, o1.empBId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Ended employee still reads historical attendance list via RPC/RLS, with yesterday's row unchanged
    const endedList = await o1.query<HrSelfAttendanceListResult>(o1.memberB, 'hr.self.attendance.list', {
      month: yesterdayVn.slice(0, 7),
    });
    expect(endedList.openLog).toBeNull();
    const endedYesterday = endedList.logs.find((l) => l.workDate === yesterdayVn);
    expect(endedYesterday?.status).toBe('missing_checkout');
    expect(endedYesterday?.checkedOutAt).toBeNull();
  });

  it('detects anomalies, narrates safely via metered Ly fallback/alias, and rolls up decimal.js figures into draft payroll with CSV parity', async () => {
    const o = await createAttendanceOrg();
    const targetMonth = '2026-09';

    // Record 22 normal working days (08:30-17:30 ICT) + 1 missing checkout + 1 holiday (09-02 08:30-12:30 ICT) + 1 long Sunday (09-27 14:00-01:00 ICT)
    const regularWeekdays = [
      '2026-09-01', '2026-09-03', '2026-09-04', '2026-09-05',
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12',
      '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19',
      '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26',
    ];
    for (const d of regularWeekdays) {
      await o.exec(o.owner, 'hr.attendance.adjust', {
        employeeId: o.empAId,
        workDate: d,
        checkedInAt: `${d}T01:30:00Z`,
        checkedOutAt: `${d}T10:30:00Z`,
        checkInMethod: 'manual',
        status: 'present',
      });
    }
    // 2026-09-02 holiday 4h
    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empAId,
      workDate: '2026-09-02',
      checkedInAt: '2026-09-02T01:30:00Z',
      checkedOutAt: '2026-09-02T05:30:00Z',
      checkInMethod: 'manual',
      status: 'half_day',
    });
    // 2026-09-28 short day 2h (< 4h anomaly)
    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empAId,
      workDate: '2026-09-28',
      checkedInAt: '2026-09-28T01:30:00Z',
      checkedOutAt: '2026-09-28T03:30:00Z',
      checkInMethod: 'manual',
      status: 'half_day',
    });
    // Missing checkout log on empB for 2026-09-14
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
         SELECT org_id, legal_entity_id, id, '2026-09-14', '2026-09-14T01:30:00Z', 'web', 'missing_checkout'
         FROM ludy_hr.payroll_employee WHERE org_id = $1 AND id = $2`,
        [o.orgId, o.empBId],
      ),
    );

    const adminView = await o.query<HrAttendanceListResult>(o.admin, 'hr.attendance.list', {
      month: targetMonth,
      anomaliesOnly: true,
    });
    const kinds = adminView.anomalies.map((a) => a.kind);
    expect(kinds).toContain('holiday_work');
    expect(kinds).toContain('short_day');
    expect(kinds).toContain('missing_checkout');

    // Ly anomalies brief: deterministic AI off fallback + pseudonymized mock generator
    const ports = {
      read: (inp: { month?: string; legalEntityId?: string; lang?: 'vi' | 'en' }) =>
        o.query<HrAttendanceAnomaliesSnapshot>(o.admin, 'hr.attendance.anomalies.read', inp),
      record: (m: string, le: string, aiReason: string) =>
        o.exec(o.admin, 'hr.attendance.anomalies.audit', { month: m, legalEntityId: le, aiReason }).then(() => undefined),
    };
    const offAi: AttendanceAnomaliesAi = { reader: null, budget: new DraftBudget() };
    const offBrief = await generateAttendanceAnomaliesBrief(offAi, ports, o.orgId, o.admin, { month: targetMonth, lang: 'vi' });
    expect(offBrief.ai).toEqual({ ok: false, reason: 'off' });
    expect(offBrief.anomalies.length).toBe(adminView.anomalies.length);

    let seenPromptInput: unknown = null;
    const mockAi: AttendanceAnomaliesAi = {
      budget: new DraftBudget(),
      reader: {
        attendanceAnomalies: async (inp) => {
          seenPromptInput = inp;
          return {
            summary: `Tháng ${targetMonth} phát hiện ${inp.anomalies.length} bất thường.`,
            highlights: ['Kiểm tra lại lượt thiếu check-out trước khi chốt công.'],
            ai: { ok: true, reason: 'ok' },
          };
        },
      },
    };
    const onBrief = await generateAttendanceAnomaliesBrief(mockAi, ports, o.orgId, o.admin, { month: targetMonth, lang: 'vi' });
    expect(onBrief.ai).toEqual({ ok: true, reason: 'ok' });
    expect(seenPromptInput).not.toBeNull();

    // N4: reader throwing PayrollPromptLeakError or runtime error degrades deterministically without throwing
    const leakAi: AttendanceAnomaliesAi = {
      budget: new DraftBudget(),
      reader: {
        attendanceAnomalies: async () => {
          throw new PayrollPromptLeakError();
        },
      },
    };
    const leakBrief = await generateAttendanceAnomaliesBrief(leakAi, ports, o.orgId, o.admin, { month: targetMonth, lang: 'vi' });
    expect(leakBrief.ai).toEqual({ ok: false, reason: 'refused' });
    expect(leakBrief.summary).toContain(targetMonth);

    const errAi: AttendanceAnomaliesAi = {
      budget: new DraftBudget(),
      reader: {
        attendanceAnomalies: async () => {
          throw new Error('upstream timeout');
        },
      },
    };
    const errBrief = await generateAttendanceAnomaliesBrief(errAi, ports, o.orgId, o.admin, { month: targetMonth, lang: 'vi' });
    expect(errBrief.ai).toEqual({ ok: false, reason: 'unavailable' });

    // B2: Add empC, open draft payroll run, then end empC before targetMonth so stale draft line stays excluded from people
    const empCRes = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Lê Cũ',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', payBasis: 'monthly', baseWage: '10000000' },
    });
    const empCId = empCRes.employeeId as string;
    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: empCId,
      workDate: '2026-09-10',
      checkedInAt: '2026-09-10T01:30:00Z',
      checkedOutAt: '2026-09-10T10:30:00Z',
      status: 'present',
    });

    // Open draft payroll run for 2026-09
    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: targetMonth });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empCId, endedOn: '2026-08-15' });

    // Refuses rollup while empB has unresolved missing_checkout unless allowIncomplete
    await expect(
      o.exec(o.owner, 'hr.attendance.rollup_to_payroll', { runId: run.runId, allowIncomplete: false }),
    ).rejects.toMatchObject({ code: 'HR_ATTENDANCE_MISSING_CHECKOUT' });

    // With allowIncomplete: true, empB (only missing_checkout) is skipped rather than docked 26 unpaid days,
    // and unapproved annual_leave rows for empA do NOT count as paid leave.
    await o.exec(o.owner, 'hr.payroll.leave.set', {
      employeeId: o.empAId,
      month: targetMonth,
      kind: 'annual_leave',
      days: '1',
      approved: false,
    });
    const incompleteRollup = await o.exec<HrAttendanceRollupResult>(o.owner, 'hr.attendance.rollup_to_payroll', {
      runId: run.runId,
      allowIncomplete: true,
    });
    expect(incompleteRollup.updatedCount).toBe(1);
    expect(incompleteRollup.skippedEmployeeCount).toBe(2);
    expect(incompleteRollup.rows.find((r) => r.employeeId === o.empAId)?.paidLeaveDays).toBe('0');

    // Thread #10: allowIncomplete still refuses when an open row has a secondary weekend/holiday anomaly (Sunday 2026-09-20)
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
         SELECT org_id, legal_entity_id, id, '2026-09-20', '2026-09-20T01:30:00Z', 'web', 'missing_checkout'
         FROM ludy_hr.payroll_employee WHERE org_id = $1 AND id = $2`,
        [o.orgId, o.empBId],
      ),
    );
    await expect(
      o.exec(o.owner, 'hr.attendance.rollup_to_payroll', { runId: run.runId, allowIncomplete: true }),
    ).rejects.toMatchObject({ code: 'HR_ATTENDANCE_MISSING_CHECKOUT' });
    await withAdmin((c) =>
      c.query(`DELETE FROM ludy_hr.attendance_log WHERE org_id = $1 AND employee_id = $2 AND work_date = '2026-09-20'`, [o.orgId, o.empBId]),
    );

    // Non-run employee (empC, ended before 2026-09 and excluded from draft pay lines) with a Sunday missing_checkout MUST NOT block rollup!
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
         SELECT org_id, legal_entity_id, id, '2026-09-20', '2026-09-20T01:30:00Z', 'web', 'missing_checkout'
         FROM ludy_hr.payroll_employee WHERE org_id = $1 AND id = $2`,
        [o.orgId, empCId],
      ),
    );
    const ignoredOutOfRun = await o.exec<HrAttendanceRollupResult>(o.owner, 'hr.attendance.rollup_to_payroll', {
      runId: run.runId,
      allowIncomplete: true,
    });
    expect(ignoredOutOfRun.missingCheckoutCount).toBe(1); // Only empB's 2026-09-14 row counts, not empC's Sunday row
    await withAdmin((c) =>
      c.query(`DELETE FROM ludy_hr.attendance_log WHERE org_id = $1 AND employee_id = $2 AND work_date = '2026-09-20'`, [o.orgId, empCId]),
    );

    // Also verify adjust clearing checkedOutAt resets worked_minutes to null, and note-only edit preserves credited minutes
    const tempAdj = await o.exec<HrAttendanceLogView>(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empBId,
      workDate: '2026-09-14',
      checkedInAt: '2026-09-14T02:00:00Z',
      checkedOutAt: '2026-09-14T11:00:00Z',
      workedMinutes: 480,
      status: 'present',
    });
    expect(tempAdj.workedMinutes).toBe(480);
    const noteOnlyAdj = await o.exec<HrAttendanceLogView>(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empBId,
      workDate: '2026-09-14',
      checkedInAt: '2026-09-14T02:00:00Z',
      checkedOutAt: '2026-09-14T11:00:00Z',
      status: 'present',
      note: 'Trừ 1 tiếng nghỉ trưa, giữ 8h công',
    });
    expect(noteOnlyAdj.workedMinutes).toBe(480);
    const clearedAdj = await o.exec<HrAttendanceLogView>(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empBId,
      workDate: '2026-09-14',
      checkedInAt: '2026-09-14T01:30:00Z',
      checkedOutAt: null,
      status: 'adjusted',
    });
    expect(clearedAdj.workedMinutes).toBeNull();

    // Note-only edit with an unchanged null timestamp preserves stored workedMinutes when omitted
    await o.exec<HrAttendanceLogView>(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empBId,
      workDate: '2026-09-14',
      checkedInAt: '2026-09-14T01:30:00Z',
      checkedOutAt: null,
      workedMinutes: 480,
      status: 'adjusted',
      note: 'Ghi nhận 8h không có giờ ra',
    });
    const noteOnlyNullTs = await o.exec<HrAttendanceLogView>(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empBId,
      workDate: '2026-09-14',
      checkedInAt: '2026-09-14T01:30:00Z',
      checkedOutAt: null,
      status: 'adjusted',
      note: 'Cập nhật ghi chú vẫn giữ 480 phút',
    });
    expect(noteOnlyNullTs.workedMinutes).toBe(480);

    // Self check-out rejects old historical dates (< yesterday)
    await expect(
      o.exec(o.memberB, 'hr.self.attendance.check_out', { workDate: '2026-09-14' }),
    ).rejects.toMatchObject({ code: 'HR_ATTENDANCE_TIME_INVALID' });

    // Adjust rejects present/half_day without checkedOutAt or with explicit null workedMinutes cleanly (422 DomainError instead of PG 23514)
    await expect(
      o.exec(o.owner, 'hr.attendance.adjust', {
        employeeId: o.empBId,
        workDate: '2026-09-14',
        checkedInAt: '2026-09-14T01:30:00Z',
        checkedOutAt: null,
        status: 'present',
      }),
    ).rejects.toMatchObject({ code: 'HR_ATTENDANCE_TIME_INVALID' });
    await expect(
      o.exec(o.owner, 'hr.attendance.adjust', {
        employeeId: o.empBId,
        workDate: '2026-09-14',
        checkedInAt: '2026-09-14T01:30:00Z',
        checkedOutAt: '2026-09-14T09:30:00Z',
        workedMinutes: null,
        status: 'present',
      }),
    ).rejects.toMatchObject({ code: 'HR_ATTENDANCE_MINUTES_REQUIRED' });

    // Resolve empB's missing checkout via admin adjust (8h = 480m)
    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empBId,
      workDate: '2026-09-14',
      checkedInAt: '2026-09-14T01:30:00Z',
      checkedOutAt: '2026-09-14T09:30:00Z',
      status: 'adjusted',
      note: 'Quên check-out, quản lý xác nhận 8h',
    });

    const rolled = await o.exec<HrAttendanceRollupResult>(o.owner, 'hr.attendance.rollup_to_payroll', {
      runId: run.runId,
    });
    expect(rolled.updatedCount).toBe(2);
    expect(rolled.missingCheckoutCount).toBe(0);

    const rowA = rolled.rows.find((r) => r.employeeId === o.empAId)!;
    // 22 full normal days + 1 half normal day (2026-09-28) = 22.5 workedDays + 1 paid holiday (2026-09-02) -> 2.5 unpaid days out of 26 + 4h holiday OT
    expect(rowA.workedDays).toBe('22.5');
    expect(rowA.unpaidLeaveDays).toBe('2.5');
    expect(rowA.overtimeHours).toBe('4');

    const rowB = rolled.rows.find((r) => r.employeeId === o.empBId)!;
    expect(rowB.workedHours).toBe('8');

    // Verify rolled payroll_line calculation matches calculator parity
    const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const lineA = sheet.lines.find((l) => l.employeeId === o.empAId)!;
    if (!lineA.figures) throw new Error('expected payroll figures on owner sheet');
    const expectedA = calculatePayroll(
      { region: 'I', contract: 'indefinite', contractTermMonths: null, resident: true, insured: true, baseWage: '15000000', allowances: [] },
      { month: targetMonth, standardWorkingDays: '26', unpaidLeaveDays: '2.5', overtime: [{ dayKind: 'holiday', night: false, hours: '4' }], nightHours: '0' },
      PAYROLL_RULES,
    );
    expect(money(lineA.figures.gross).eq(expectedA.gross)).toBe(true);
    expect(money(lineA.figures.net).eq(expectedA.net)).toBe(true);
  });

  it('clears attendance_log.note on PDPL employee.erase and cleans attendance rows in org_purge', async () => {
    const o = await createAttendanceOrg();
    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empAId,
      workDate: '2014-01-10',
      checkedInAt: '2014-01-10T01:30:00Z',
      checkedOutAt: '2014-01-10T10:30:00Z',
      status: 'present',
      note: 'Ghi chú nhạy cảm của nhân viên A',
    });

    // End and erase empA after backdating retention (> 10 years ago), matching payroll_employee retention rules.
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: o.empAId, endedOn: '2026-08-20' });
    await withAdmin((c) =>
      c.query(`UPDATE ludy_hr.payroll_employee SET ended_on = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date WHERE org_id = $1 AND id = $2`, [
        o.orgId,
        o.empAId,
      ]),
    );
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: o.empAId }, asMfa(o.owner));

    const erasedRow = await withAdmin(async (c) => {
      const { rows } = await c.query<{ note: string | null; worked_minutes: number | null }>(
        'SELECT note, worked_minutes FROM ludy_hr.attendance_log WHERE org_id = $1 AND employee_id = $2',
        [o.orgId, o.empAId],
      );
      return rows[0];
    });
    expect(erasedRow?.note).toBeNull();
    expect(erasedRow?.worked_minutes).toBe(540);

    // Post-erasure adjustment is blocked cleanly
    await expect(
      o.exec(o.owner, 'hr.attendance.adjust', {
        employeeId: o.empAId,
        workDate: '2014-01-11',
        checkedInAt: '2014-01-11T01:30:00Z',
        checkedOutAt: '2014-01-11T10:30:00Z',
        status: 'present',
      }),
    ).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ERASED' });

    // Triggers and RLS policies also refuse post-erasure mutations and direct SQL inserts (including owner/admin)
    await expect(
      withAdmin((c) =>
        c.query(`UPDATE ludy_hr.attendance_log SET worked_minutes = 120 WHERE org_id = $1 AND employee_id = $2`, [o.orgId, o.empAId]),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/erased/i) });
    await expect(
      runAsUserInOrg(o.owner, o.orgId, (c) =>
        c.query(
          `INSERT INTO ludy_hr.attendance_log (org_id, employee_id, work_date, checked_in_at, checked_out_at, check_in_method, worked_minutes, status, note)
           VALUES ($1, $2, '2014-01-12', '2014-01-12T01:30:00Z', '2014-01-12T10:30:00Z', 'manual', 540, 'present', 'Chèn trái phép sau xóa')`,
          [o.orgId, o.empAId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/erased/i) });
    await expect(
      runAsUserInOrg(o.admin, o.orgId, (c) =>
        c.query(
          `INSERT INTO ludy_hr.attendance_log (org_id, employee_id, work_date, checked_in_at, check_in_method, status)
           VALUES ($1, $2, '2014-01-13', '2014-01-13T01:30:00Z', 'web', 'missing_checkout')`,
          [o.orgId, o.empAId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/erased/i) });

    // Rotate QR so org has both attendance_log and attendance_qr_config before org_purge
    await o.exec(o.owner, 'hr.attendance.qr.rotate', {});

    // Run org_purge path cleanly (offboarding + aged export audit rows) and verify 0 attendance_log / attendance_qr_config remain
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [o.orgId]);
      await c.query('COMMIT');
      await c.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, now() - interval '40 days', 'user', $2, 'kernel.org.offboard', $3, 'ok', $5, '{}'::jsonb),
                ($1, now() - interval '31 days', 'system', NULL, 'kernel.org.export.record', $4, 'ok', $5, $6)`,
        [o.orgId, o.owner, randomUUID(), randomUUID(), '0'.repeat(64), JSON.stringify({ format: 'crove.org-export.v2', file_count: 2 })],
      );
    });
    const purged = await workerRt.execute<{ counts: { deleted: Record<string, number> } }>(
      'kernel.org.purge',
      { minDays: 30, reason: 'Owner closed org' },
      { actor: { type: 'system', component: 'operator' }, orgId: o.orgId },
    );
    expect(purged.counts.deleted['ludy_hr.attendance_log']).toBe(1);
    expect(purged.counts.deleted['ludy_hr.attendance_qr_config']).toBe(1);

    const remaining = await withAdmin(async (c) => {
      const a = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ludy_hr.attendance_log WHERE org_id = $1', [o.orgId]);
      const q = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ludy_hr.attendance_qr_config WHERE org_id = $1', [o.orgId]);
      return { logs: a.rows[0]?.n, qr: q.rows[0]?.n };
    });
    expect(remaining).toEqual({ logs: 0, qr: 0 });
  });

  it('excludes attendance logs and missing_checkout rows outside [hireDate, endedOn] from payroll rollup', async () => {
    const o = await createAttendanceOrg();
    const targetMonth = '2026-09';
    const empMidRes = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Phạm Giữa Tháng',
      employment: {
        effectiveFrom: '2026-09-12',
        contractType: 'indefinite',
        region: 'I',
        payBasis: 'hourly',
        baseWage: '8000000',
        hourlyRate: '80000',
      },
    });
    const empMidId = empMidRes.employeeId as string;

    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: empMidId,
      workDate: '2026-09-08', // before hireDate (2026-09-12)
      checkedInAt: '2026-09-08T01:30:00Z',
      checkedOutAt: '2026-09-08T11:30:00Z',
      workedMinutes: 600,
      status: 'present',
    });
    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: empMidId,
      workDate: '2026-09-14', // in window (8h)
      checkedInAt: '2026-09-14T01:30:00Z',
      checkedOutAt: '2026-09-14T09:30:00Z',
      workedMinutes: 480,
      status: 'present',
    });

    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: targetMonth });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empMidId, endedOn: '2026-09-20' });

    // Out-of-window completed shift + Sunday missing_checkout AFTER endedOn must neither block nor inflate rollup
    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: empMidId,
      workDate: '2026-09-24',
      checkedInAt: '2026-09-24T01:30:00Z',
      checkedOutAt: '2026-09-24T11:30:00Z',
      workedMinutes: 600,
      status: 'present',
    });
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date, checked_in_at, check_in_method, status)
         SELECT org_id, legal_entity_id, id, '2026-09-27', '2026-09-27T01:30:00Z', 'web', 'missing_checkout'
         FROM ludy_hr.payroll_employee WHERE org_id = $1 AND id = $2`,
        [o.orgId, empMidId],
      ),
    );

    const rolled = await o.exec<HrAttendanceRollupResult>(o.owner, 'hr.attendance.rollup_to_payroll', {
      runId: run.runId,
      allowIncomplete: false,
    });
    expect(rolled.missingCheckoutCount).toBe(0);
    expect(rolled.updatedCount).toBe(1);
    const midRow = rolled.rows.find((r) => r.employeeId === empMidId)!;
    expect(midRow.workedHours).toBe('8');
    expect(midRow.overtimeHours).toBe('0');
  });

  it('rejects stale expectedUpdatedAt adjust after employee self check-out while allowing deliberate clear with fresh updatedAt', async () => {
    const o = await createAttendanceOrg();
    const openShift = await o.exec<HrAttendanceLogView>(o.memberA, 'hr.self.attendance.check_in', { method: 'web' });
    expect(openShift.status).toBe('missing_checkout');
    expect(openShift.checkedOutAt).toBeNull();

    // Employee checks out before HR submits the previously opened note edit form
    const closedShift = await o.exec<HrAttendanceLogView>(o.memberA, 'hr.self.attendance.check_out', {
      workDate: openShift.workDate,
    });
    expect(closedShift.checkedOutAt).not.toBeNull();
    expect(closedShift.updatedAt).not.toBe(openShift.updatedAt);

    // Stale expectedUpdatedAt is rejected with 409 HR_ATTENDANCE_CONFLICT and leaves checkout intact
    await expect(
      o.exec(o.owner, 'hr.attendance.adjust', {
        employeeId: o.empAId,
        workDate: openShift.workDate,
        checkedInAt: openShift.checkedInAt,
        checkedOutAt: null,
        checkInMethod: 'web',
        status: 'adjusted',
        note: 'Ghi chú khi mở form cũ',
        expectedUpdatedAt: openShift.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'HR_ATTENDANCE_CONFLICT', status: 409 });

    const persisted = await o.query<HrAttendanceListResult>(o.owner, 'hr.attendance.list', {
      month: openShift.workDate.slice(0, 7),
    });
    const currentRow = persisted.logs.find((l) => l.id === openShift.id);
    expect(currentRow?.checkedOutAt).toBe(closedShift.checkedOutAt);

    // Deliberate clear after refreshing to fresh updatedAt succeeds
    const cleared = await o.exec<HrAttendanceLogView>(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empAId,
      workDate: openShift.workDate,
      checkedInAt: closedShift.checkedInAt,
      checkedOutAt: null,
      checkInMethod: 'web',
      status: 'adjusted',
      note: 'Quản lý chủ động xóa giờ check-out sau khi tải lại',
      expectedUpdatedAt: closedShift.updatedAt,
    });
    expect(cleared.checkedOutAt).toBeNull();
    expect(cleared.workedMinutes).toBeNull();

    // Admin can still clear an active employee's note cleanly via hr.attendance.adjust
    const noteCleared = await o.exec<HrAttendanceLogView>(o.admin, 'hr.attendance.adjust', {
      employeeId: o.empAId,
      workDate: openShift.workDate,
      checkedInAt: cleared.checkedInAt,
      checkedOutAt: null,
      checkInMethod: 'web',
      status: 'adjusted',
      note: null,
      expectedUpdatedAt: cleared.updatedAt,
    });
    expect(noteCleared.note).toBeNull();
  });

  it('persists scheduled_hours_per_day with DB CHECK guard and auto-credits Art. 112 hourly paid public holidays in payroll rollup (#4486)', async () => {
    const o = await createAttendanceOrg();
    const targetMonth = '2026-09'; // Includes National Day 2026-09-02 (Wednesday)

    // 1. Part-time hourly worker hired before 2026-09-02 with contractual 4.5h/day schedule
    const scheduledRes = await o.hire('Đặng Theo Giờ Lễ', {
      payBasis: 'hourly',
      wage: '0',
      hourlyRate: '80000',
      scheduledHoursPerDay: '4.5',
      effectiveFrom: '2026-01-01',
    });
    const scheduledEmpId = scheduledRes.employeeId as string;

    // 2. Hourly worker with contractual 4.5h/day hired AFTER 2026-09-02 (must get 0 paid holiday hours)
    const lateHireRes = await o.hire('Đặng Vào Sau Lễ', {
      payBasis: 'hourly',
      wage: '0',
      hourlyRate: '80000',
      scheduledHoursPerDay: '4.5',
      effectiveFrom: '2026-09-05',
    });
    const lateHireEmpId = lateHireRes.employeeId as string;

    // Read back via hr.payroll.employee.get and verify employment.add persists updated schedule
    const detailBefore = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: scheduledEmpId });
    expect(detailBefore.current?.scheduledHoursPerDay).toBe('4.50');

    await o.exec<HrWritten>(o.owner, 'hr.payroll.employment.add', {
      employeeId: scheduledEmpId,
      effectiveFrom: '2026-08-01',
      contractType: 'indefinite',
      region: 'I',
      payBasis: 'hourly',
      hourlyRate: '80000',
      scheduledHoursPerDay: '5.5',
    });
    const detailAfter = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: scheduledEmpId });
    expect(detailAfter.current?.scheduledHoursPerDay).toBe('5.50');

    // DB CHECK constraint enforces scheduled_hours_per_day IN (0, 24]
    await expect(
      withAdmin((c) =>
        c.query(
          `INSERT INTO ludy_hr.payroll_employment (org_id, legal_entity_id, employee_id, effective_from, contract_type, region, base_wage, pay_basis, hourly_rate, scheduled_hours_per_day)
           SELECT org_id, legal_entity_id, employee_id, '2026-10-01', 'indefinite', 'I', 0, 'hourly', 80000, 0
           FROM ludy_hr.payroll_employment WHERE org_id = $1 AND employee_id = $2 LIMIT 1`,
          [o.orgId, scheduledEmpId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'payroll_employment_scheduled_hours_per_day_ck' });
    await expect(
      withAdmin((c) =>
        c.query(
          `INSERT INTO ludy_hr.payroll_employment (org_id, legal_entity_id, employee_id, effective_from, contract_type, region, base_wage, pay_basis, hourly_rate, scheduled_hours_per_day)
           SELECT org_id, legal_entity_id, employee_id, '2026-10-02', 'indefinite', 'I', 0, 'hourly', 80000, 24.01
           FROM ludy_hr.payroll_employment WHERE org_id = $1 AND employee_id = $2 LIMIT 1`,
          [o.orgId, scheduledEmpId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'payroll_employment_scheduled_hours_per_day_ck' });

    // Record 1 normal 8h shift (2026-09-14) for scheduledEmp, lateHireEmp, and unscheduled empB
    for (const empId of [scheduledEmpId, lateHireEmpId, o.empBId]) {
      await o.exec(o.owner, 'hr.attendance.adjust', {
        employeeId: empId,
        workDate: '2026-09-14',
        checkedInAt: '2026-09-14T01:30:00Z',
        checkedOutAt: '2026-09-14T09:30:00Z',
        status: 'present',
      });
    }

    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: targetMonth });
    const rolled = await o.exec<HrAttendanceRollupResult>(o.owner, 'hr.attendance.rollup_to_payroll', {
      runId: run.runId,
    });
    expect(rolled.updatedCount).toBe(3);

    // scheduledEmp uses in-force 2026-08-01 terms (5.5h/day) -> 8h normal + 5.5h National Day = 13.5h
    const rowScheduled = rolled.rows.find((r) => r.employeeId === scheduledEmpId)!;
    expect(rowScheduled.workedHours).toBe('13.5');
    expect(rowScheduled.overtimeHours).toBe('0');

    // lateHireEmp hired 2026-09-05 (after 2026-09-02) -> 8h only, 0 paid holiday hours
    const rowLate = rolled.rows.find((r) => r.employeeId === lateHireEmpId)!;
    expect(rowLate.workedHours).toBe('8');

    // empB has scheduled_hours_per_day = NULL -> backward-compatible 8h only
    const rowUnscheduled = rolled.rows.find((r) => r.employeeId === o.empBId)!;
    expect(rowUnscheduled.workedHours).toBe('8');

    // Verify payroll sheet figures match calculatePayroll with workedHours = 13.5 via decimal.js
    const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const lineScheduled = sheet.lines.find((l) => l.employeeId === scheduledEmpId)!;
    if (!lineScheduled.figures) throw new Error('expected payroll figures on scheduled hourly line');
    const expectedScheduled = calculatePayroll(
      { region: 'I', contract: 'indefinite', contractTermMonths: null, resident: true, insured: true, payBasis: 'hourly', hourlyRate: '80000', baseWage: '0', allowances: [] },
      { month: targetMonth, standardWorkingDays: '26', workedHours: '13.5', unpaidLeaveDays: '24', overtime: [], nightHours: '0' },
      PAYROLL_RULES,
    );
    expect(money(lineScheduled.figures.gross).eq(expectedScheduled.gross)).toBe(true);
    expect(money(lineScheduled.figures.net).eq(expectedScheduled.net)).toBe(true);
    expect(money(lineScheduled.figures.gross).eq(money('13.5').times('80000'))).toBe(true);
  });

  it('restricts erased-employee attendance note clearing strictly to org owner actor (42501) (#4486)', async () => {
    const o = await createAttendanceOrg();
    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: o.empAId,
      workDate: '2014-01-10',
      checkedInAt: '2014-01-10T01:30:00Z',
      checkedOutAt: '2014-01-10T10:30:00Z',
      status: 'present',
      note: 'Ghi chú nhạy cảm chờ xóa',
    });

    // Simulate the mid-erasure state right after payroll_employee.erased_at is stamped (retention > 10y passed)
    // before attendance_log.note has been cleared.
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: o.empAId, endedOn: '2026-08-20' });
    await withAdmin((c) =>
      c.query(
        `UPDATE ludy_hr.payroll_employee
         SET ended_on = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date,
             erased_at = now()
         WHERE org_id = $1 AND id = $2`,
        [o.orgId, o.empAId],
      ),
    );

    // Non-owner admin and uncontextualized SQL callers cannot clear notes of an erased employee (42501)
    await expect(
      runAsUserInOrg(o.admin, o.orgId, (c) =>
        c.query(`UPDATE ludy_hr.attendance_log SET note = NULL WHERE org_id = $1 AND employee_id = $2`, [o.orgId, o.empAId]),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/owner/i) });
    await expect(
      withAdmin((c) =>
        c.query(`UPDATE ludy_hr.attendance_log SET note = NULL WHERE org_id = $1 AND employee_id = $2`, [o.orgId, o.empAId]),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/owner/i) });

    // Owner still cannot alter non-note columns on an erased employee (23514)
    await expect(
      runAsUserInOrg(o.owner, o.orgId, (c) =>
        c.query(`UPDATE ludy_hr.attendance_log SET note = NULL, worked_minutes = 120 WHERE org_id = $1 AND employee_id = $2`, [o.orgId, o.empAId]),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/erased/i) });

    // Org owner note-only wipe succeeds cleanly (preserving worked_minutes)
    const ownerCleared = await runAsUserInOrg(o.owner, o.orgId, (c) =>
      c.query(`UPDATE ludy_hr.attendance_log SET note = NULL WHERE org_id = $1 AND employee_id = $2`, [o.orgId, o.empAId]),
    );
    expect(ownerCleared.rowCount).toBe(1);
    const afterRow = await withAdmin(async (c) => {
      const { rows } = await c.query<{ note: string | null; worked_minutes: number | null }>(
        'SELECT note, worked_minutes FROM ludy_hr.attendance_log WHERE org_id = $1 AND employee_id = $2',
        [o.orgId, o.empAId],
      );
      return rows[0];
    });
    expect(afterRow).toEqual({ note: null, worked_minutes: 540 });
  });
});
