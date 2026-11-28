// SPDX-License-Identifier: AGPL-3.0-only
// The month a fiscal year ends cannot change while an org keeps Circular 99 books (issue #5311, follow-up of #1403) on PostgreSQL 17, through kernel.tax_profile.save: an org without a Circular 99 row moves the
// month and back; one that has the row (chosen through finance.books.set_regime) is refused, FISCAL_YEAR_END_LOCKED, with the profile and the audit as they were, and still saves the same month with other
// fields changed; the first save of an org that has no profile row yet is refused too when it names another month than December; a change to December is always allowed (a bad row can be repaired); the
// the guard sees Circular 99 books on an entity other than the default one; cancelling the books frees the month; the first save and the first switch never both succeed; and the guard is the table's, so a direct UPDATE meets it as well.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the fiscal-year month is locked while an org keeps Circular 99 books (#5311)', () => {
  const dbName = `ludy_test_fy_lock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const session = randomUUID();
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: session });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: session, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; status?: number; message?: string });

  // An org with an owner of its own, so one test's choice of books never reaches another's.
  type Org = { orgId: string; owner: string };
  async function makeOrg(name: string): Promise<Org> {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${randomUUID().slice(0, 8)}@fiscal-lock.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), name);
    return { orgId, owner };
  }
  const save = (o: Org, fiscalYearEndMonth: number, obligations: string[] = []) =>
    rt.execute<{ fiscalYearEndMonth: number }>('kernel.tax_profile.save', { obligations, pitFilingPeriod: null, fiscalYearEndMonth }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
  // The org's default entity chooses Circular 99 from a 1 January (R3: a fresh second factor).
  const switchToTt99 = (o: Org, legalEntityId?: string) =>
    rt.execute('finance.books.set_regime', { ...(legalEntityId ? { legalEntityId } : {}), effectiveFrom: '2040-01-01', taxAuthorityNotified: true }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
  const cancelTt99 = (o: Org, legalEntityId: string) =>
    rt.execute('finance.books.cancel_regime', { legalEntityId, effectiveFrom: '2040-01-01' }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
  const defaultEntity = (o: Org) =>
    admin(async (a) => (await a.query<{ id: string }>(`SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default`, [o.orgId])).rows[0]?.id as string);
  const tt99Rows = (o: Org) =>
    admin(async (a) => Number((await a.query<{ n: string }>(`SELECT count(*) AS n FROM ludy_finance.legal_entity_books WHERE org_id = $1 AND regime = 'tt99'`, [o.orgId])).rows[0]?.n));
  const monthOf = (o: Org) => admin(async (a) => (await a.query<{ m: number }>(`SELECT fiscal_year_end_month AS m FROM ludy_kernel.tax_profile WHERE org_id = $1`, [o.orgId])).rows[0]?.m);
  const savedCount = (o: Org) =>
    admin(async (a) =>
      Number((await a.query<{ n: string }>(`SELECT count(*) AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.tax_profile.save' AND outcome = 'ok'`, [o.orgId])).rows[0]?.n),
    );

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets an org that keeps no Circular 99 books move the month its fiscal year ends, and move it back, whatever another org keeps', async () => {
    const free = await makeOrg('Công ty chưa chuyển sổ');
    const keeping = await makeOrg('Công ty giữ sổ Thông tư 99');
    await switchToTt99(keeping);
    expect(await monthOf(free)).toBeUndefined();
    expect(await save(free, 3)).toMatchObject({ fiscalYearEndMonth: 3 });
    expect(await monthOf(free)).toBe(3);
    expect(await save(free, 12)).toMatchObject({ fiscalYearEndMonth: 12 });
    expect(await monthOf(free)).toBe(12);
  });

  it('refuses to change the month while the org keeps Circular 99 books, leaves the profile and the audit as they were, and still saves the same month with other fields changed', async () => {
    const o = await makeOrg('Công ty đã chọn Thông tư 99');
    // December is the default, so the first save and the choice both pass; the choice itself needs December.
    expect(await save(o, 12, ['financial_statements'])).toMatchObject({ fiscalYearEndMonth: 12 });
    await switchToTt99(o);
    const before = await savedCount(o);
    expect(await refusal(save(o, 3))).toMatchObject({ code: 'FISCAL_YEAR_END_LOCKED', status: 409 });
    expect(await monthOf(o)).toBe(12);
    expect(await savedCount(o)).toBe(before);
    // The same month is no change: the other fields save.
    expect(await save(o, 12, ['financial_statements', 'cit_finalization'])).toMatchObject({ fiscalYearEndMonth: 12 });
    expect(await savedCount(o)).toBe(before + 1);
  });

  it('refuses the first save of an org with no profile row when it names another month than December, and still saves December', async () => {
    const o = await makeOrg('Công ty chưa có hồ sơ thuế');
    await switchToTt99(o);
    expect(await monthOf(o)).toBeUndefined();
    expect(await refusal(save(o, 6))).toMatchObject({ code: 'FISCAL_YEAR_END_LOCKED', status: 409 });
    expect(await monthOf(o)).toBeUndefined();
    expect(await save(o, 12)).toMatchObject({ fiscalYearEndMonth: 12 });
    expect(await monthOf(o)).toBe(12);
  });

  it('is the guard of the table, not of one command: a direct update of the month is refused, the same month is not', async () => {
    const o = await makeOrg('Công ty cập nhật trực tiếp');
    await save(o, 12);
    await switchToTt99(o);
    const update = (month: number) => admin((a) => a.query(`UPDATE ludy_kernel.tax_profile SET fiscal_year_end_month = $2 WHERE org_id = $1`, [o.orgId, month]));
    expect(await refusal(update(6))).toMatchObject({ code: 'P0001', message: 'FISCAL_YEAR_END_LOCKED' });
    expect(await monthOf(o)).toBe(12);
    await update(12);
    expect(await monthOf(o)).toBe(12);
  });

  it('lets the month go back to December while Circular 99 books are kept, so a row left under another month can be repaired without cancelling the books', async () => {
    const o = await makeOrg('Công ty có hàng cần sửa');
    await save(o, 12, ['financial_statements']);
    await switchToTt99(o);
    // Put the row under June the way only a superuser can (the guard is switched off for this one statement), as a row left by an older build would be.
    await admin(async (a) => {
      await a.query(`ALTER TABLE ludy_kernel.tax_profile DISABLE TRIGGER tax_profile_fiscal_year_guard`);
      try {
        await a.query(`UPDATE ludy_kernel.tax_profile SET fiscal_year_end_month = 6 WHERE org_id = $1`, [o.orgId]);
      } finally {
        await a.query(`ALTER TABLE ludy_kernel.tax_profile ENABLE ALWAYS TRIGGER tax_profile_fiscal_year_guard`);
      }
    });
    expect(await monthOf(o)).toBe(6);
    // Another month is still refused, the same month saves with other fields, and December repairs the row.
    expect(await refusal(save(o, 3))).toMatchObject({ code: 'FISCAL_YEAR_END_LOCKED', status: 409 });
    expect(await save(o, 6, ['financial_statements', 'cit_finalization'])).toMatchObject({ fiscalYearEndMonth: 6 });
    expect(await save(o, 12, ['financial_statements', 'cit_finalization'])).toMatchObject({ fiscalYearEndMonth: 12 });
    expect(await monthOf(o)).toBe(12);
    expect(await tt99Rows(o)).toBe(1);
  });

  it('refuses the month when the Circular 99 books are on a legal entity other than the default one, and frees it when that row is cancelled', async () => {
    // The guard looks at every entity of the org, not only the default one. (An owner or admin sees every entity; only a member or viewer can be limited to one, and neither saves the tax profile.)
    const o = await makeOrg('Công ty hai pháp nhân');
    const branch = await admin(
      async (a) => (await a.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'company', $2) RETURNING id`, [o.orgId, o.owner])).rows[0]?.id as string,
    );
    await save(o, 12);
    await switchToTt99(o, branch);
    expect(await tt99Rows(o)).toBe(1);
    expect(await refusal(save(o, 3))).toMatchObject({ code: 'FISCAL_YEAR_END_LOCKED', status: 409 });
    expect(await monthOf(o)).toBe(12);
    await cancelTt99(o, branch);
    expect(await tt99Rows(o)).toBe(0);
    expect(await save(o, 3)).toMatchObject({ fiscalYearEndMonth: 3 });
  });

  it('frees the month again when the Circular 99 books are cancelled', async () => {
    const o = await makeOrg('Công ty hủy sổ Thông tư 99');
    const main = await defaultEntity(o);
    await save(o, 12);
    await switchToTt99(o);
    expect(await refusal(save(o, 3))).toMatchObject({ code: 'FISCAL_YEAR_END_LOCKED' });
    await cancelTt99(o, main);
    expect(await tt99Rows(o)).toBe(0);
    expect(await save(o, 3)).toMatchObject({ fiscalYearEndMonth: 3 });
    expect(await monthOf(o)).toBe(3);
    expect(await save(o, 12)).toMatchObject({ fiscalYearEndMonth: 12 });
  });

  it('serializes the first save of a month other than December with the first switch: never both, over several races', async () => {
    for (let i = 0; i < 5; i++) {
      const o = await makeOrg(`Công ty chạy đua ${i}`);
      expect(await monthOf(o)).toBeUndefined();
      const [switched, saved] = await Promise.all([refusal(switchToTt99(o)), refusal(save(o, 3))]);
      // One of the two wins and the other is refused: the switch (FISCAL_YEAR_END_LOCKED for the save) or the save (the switch needs December).
      expect(switched === null, `switch ${i}`).not.toBe(saved === null);
      const month = (await monthOf(o)) ?? 12;
      expect(month === 12 || (await tt99Rows(o)) === 0, `a Circular 99 row never sits under month ${month} (race ${i})`).toBe(true);
    }
  });

  it('keeps the guard function definer-owned with a pinned search_path and out of every role reach', async () => {
    const fn = await admin(async (a) => {
      const meta = (
        await a.query<{ definer: boolean; config: string[] | null }>(
          `SELECT p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'ludy_finance' AND p.proname = 'tax_profile_fiscal_year_guard'`,
        )
      ).rows;
      const privileges = (
        await a.query<{ role: string; can: boolean }>(
          `SELECT r.role, has_function_privilege(r.role, 'ludy_finance.tax_profile_fiscal_year_guard()', 'EXECUTE') AS can FROM (VALUES ('ludy_tenant'), ('ludy_app'), ('ludy_worker'), ('ludy_definer_tenant'), ('public')) AS r(role)`,
        )
      ).rows;
      return { meta, privileges };
    });
    expect(fn.meta).toEqual([{ definer: true, config: ['search_path=pg_catalog, pg_temp'] }]);
    expect(fn.privileges.filter((p) => p.can)).toEqual([]);
  });
});
