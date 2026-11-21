// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 end-to-end tests for the payroll coworker follow-ups (#2815, follow-up of #2808 / #2534):
// - non-admin callers (`member`, `viewer`) and disabled-app orgs (`MODULE_OFF`) are refused before any sensitive-read audit row is written and before spending any rate ticket;
// - rate-limited owners/admins receive `ai: 'busy'` before `hr.payroll.run.sheet`, `hr.payroll.run.list` or `hr.payroll.line.payslip` runs, leaving zero new `before_read` audit rows;
// - `QUIET` runs (no deterministic signals or anomalies) refund the rate ticket so subsequent model calls are not throttled;
// - `hr.payroll.run.list` accepts optional `legalEntityId` filtering (backwards-compatible when omitted) and the coworker scopes prior-month lookup to the target run's legal entity even when other entities hold >120 newer runs;
// - single-word employee display names ("Lan", "An") pass `promptLeaks` on real English prompts without false refusals.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InboxReader } from '@ludy/agent';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  HrCoworkerExplained,
  HrCoworkerFlagged,
  HrCoworkerPrepared,
  HrPayslip,
  HrRunSheet,
  HrRunSummary,
  HrRunWritten,
  HrWritten,
} from '@ludy/kernel-contract';
import {
  CredentialVault,
  Runtime,
  SUBJECT_WRAP_INFO,
  SubjectVault,
  parseVaultKey,
  sha256Hex,
  type BlobStore,
} from '@ludy/kernel-runtime';
import { PAYROLL_RULES } from '@ludy/l10n-vn';
import { hrCommands, hrQueries } from '@ludy/mod-hr';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { explainPayslip, flagMonth, prepareMonth, type PayrollAi, type PayrollReads } from '../src/payroll-coworker-ai.ts';
import { TEST_MANIFESTS } from './manifests.ts';

class EmptyBlobStore implements BlobStore {
  async put(_key: string, bytes: Uint8Array) {
    return `content:${sha256Hex(bytes)}`;
  }
  async get(): Promise<Uint8Array> {
    throw new Error('unused');
  }
  async delete(): Promise<void> {}
}

vi.mock('@ludy/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ludy/l10n-vn')>();
  return { ...real, PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })) };
});

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const FINDING = /^- ([AS]\d+) \(([a-z_]+)\): (.+)$/gmu;

suite('HR payroll coworker hardening on PostgreSQL 17 (#2815)', () => {
  const dbName = `crove_test_hrcoworker_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function sensitiveAuditCount(orgId: string): Promise<number> {
    return withAdmin(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM crove_kernel.audit_event
          WHERE org_id = $1
            AND detail ->> 'read' = 'sensitive'
            AND detail ->> 'stage' = 'before_read'`,
        [orgId],
      );
      return Number(rows[0]?.n ?? '0');
    });
  }

  function buildReader(seenPrompts: string[] = []) {
    return new InboxReader(
      { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' },
      {
        payroll: {
          prepare: async ({ system, prompt }) => {
            seenPrompts.push(`${system}\n${prompt}`);
            return {
              output: {
                items: [...prompt.matchAll(FINDING)].map((m) => ({
                  id: m[1] as string,
                  field: 'none' as const,
                  note: m[3] as string,
                })),
              },
              usage: { inputTokens: 4, outputTokens: 4 },
            };
          },
          flag: async ({ system, prompt }) => {
            seenPrompts.push(`${system}\n${prompt}`);
            return {
              output: {
                items: [...prompt.matchAll(FINDING)].map((m) => ({
                  id: m[1] as string,
                  sentence: m[3] as string,
                })),
              },
              usage: { inputTokens: 4, outputTokens: 4 },
            };
          },
          explain: async ({ system, prompt }) => {
            seenPrompts.push(`${system}\n${prompt}`);
            const netMatch = /(?:Thực nhận|Net pay): ([^\n]+)/u.exec(prompt);
            const text = netMatch ? `Khoản nhận cuối cùng là ${netMatch[1]}.` : 'Không có số liệu.';
            return { output: { text }, usage: { inputTokens: 4, outputTokens: 4 } };
          },
        },
      },
    );
  }

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) =>
      upsertIdentity(createDb(pool), {
        issuer: 'hrcoworker',
        subject: `${name}-${tag}`,
        email: `${name}-${tag}@hr.test`,
        name: null,
      });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Coworker Co ${tag}`);
    await withAdmin((c) =>
      c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
        [orgId, admin, member, viewer],
      ),
    );
    const defaultEntityId = await withAdmin(
      async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]!
          .id,
    );
    const exec = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.execute<O>(name, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });
    const readsFor = (userId: string): PayrollReads => ({
      authorize: () => query(userId, 'hr.payroll.coworker.access', {}),
      sheet: (runId) => query<HrRunSheet>(userId, 'hr.payroll.run.sheet', { runId }),
      runs: (legalEntityId) => query<HrRunSummary[]>(userId, 'hr.payroll.run.list', { limit: 120, legalEntityId }),
      payslip: (lineId) => query<HrPayslip>(userId, 'hr.payroll.line.payslip', { lineId }),
    });
    return { orgId, slug, defaultEntityId, owner, admin, member, viewer, exec, query, readsFor };
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
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    rt = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      subjectVault,
      readAuditKey: randomBytes(32),
    }).register({
      commands: [...kernelCommands, ...hrCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('enforces owner/admin auth and MODULE_OFF before spending rate tickets or writing sensitive-read audit rows on /api/rpc', async () => {
    const o = await setupOrg();
    await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Lan',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
    });
    const opened = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-11' });
    const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: opened.runId });
    const lineId = sheet.lines[0]!.id;

    const users = new Map<string, AuthUser>(
      [o.owner, o.admin, o.member, o.viewer].map((id) => [
        id,
        { userId: id, email: '', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null },
      ]),
    );
    const reader = buildReader();
    const app = createHttpApp({
      config: loadConfig({
        DATABASE_URL: appUrl,
        AUTH_JWT_SECRET: 'test-only-jwt-secret-for-hr-coworker-0123456789',
        AUTH_ISSUER: 'test-auth',
        WEB_DIST: '/nonexistent',
      }),
      runtime: rt,
      store: new EmptyBlobStore(),
      authenticate: async (header) => users.get(String(header).replace('Bearer ', ''))!,
      pool,
      aiEnabled: true,
      conversationReader: reader,
    });
    const rpcPost = (path: string, userId: string, body: unknown) =>
      app.request(`/api/rpc/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userId}`,
          'x-crove-org': o.slug,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ json: body }),
      });

    const baselineAudits = await sensitiveAuditCount(o.orgId);

    // Non-admin roles (`member`, `viewer`) get 403 FORBIDDEN on all three coworker RPCs with zero sensitive-read audit rows.
    for (const roleUser of [o.member, o.viewer]) {
      expect((await rpcPost('hr/payroll/coworker/prepare', roleUser, { runId: opened.runId, lang: 'en' })).status).toBe(403);
      expect((await rpcPost('hr/payroll/coworker/flag', roleUser, { runId: opened.runId, lang: 'en' })).status).toBe(403);
      expect((await rpcPost('hr/payroll/coworker/explain', roleUser, { lineId, lang: 'vi' })).status).toBe(403);
    }
    expect(await sensitiveAuditCount(o.orgId)).toBe(baselineAudits);

    // Switching the HR app off refuses with 404 MODULE_OFF and zero sensitive-read audit rows.
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'hr', enabled: false });
    expect((await rpcPost('hr/payroll/coworker/prepare', o.owner, { runId: opened.runId, lang: 'en' })).status).toBe(404);
    expect((await rpcPost('hr/payroll/coworker/flag', o.owner, { runId: opened.runId, lang: 'en' })).status).toBe(404);
    expect((await rpcPost('hr/payroll/coworker/explain', o.owner, { lineId, lang: 'vi' })).status).toBe(404);
    expect(await sensitiveAuditCount(o.orgId)).toBe(baselineAudits);
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'hr', enabled: true });

    // Owner succeeds on parallel prepare + flag (as MonthCoworker fires `Promise.all`) even with single-word name "Lan" in English.
    const [prepRes, flagRes, explainRes] = await Promise.all([
      rpcPost('hr/payroll/coworker/prepare', o.owner, { runId: opened.runId, lang: 'en' }),
      rpcPost('hr/payroll/coworker/flag', o.owner, { runId: opened.runId, lang: 'en' }),
      rpcPost('hr/payroll/coworker/explain', o.owner, { lineId, lang: 'vi' }),
    ]);
    expect(prepRes.status).toBe(200);
    expect(flagRes.status).toBe(200);
    expect(explainRes.status).toBe(200);
    const prepBody = (await prepRes.json()) as { json: HrCoworkerPrepared };
    const flagBody = (await flagRes.json()) as { json: HrCoworkerFlagged };
    const explainBody = (await explainRes.json()) as { json: HrCoworkerExplained };
    expect(prepBody.json.ai).toBe('quiet');
    expect(flagBody.json.ai).toBe('used');
    expect(explainBody.json.ai).toBe('used');
  });

  it('triggers zero sensitive-read audit rows when rate-limited and refunds the rate ticket on QUIET runs', async () => {
    const o = await setupOrg();
    await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'An',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
    });
    const calmRun = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-08' });
    const calmSheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: calmRun.runId });
    const lineId = calmSheet.lines[0]!.id;

    // Temporarily mark shipped payroll rules confirmed so `calmRun` has zero blocking rules and `flagMonth` is QUIET too.
    const savedStatuses = PAYROLL_RULES.map((r) => r.status);
    for (const r of PAYROLL_RULES) (r as { status: string }).status = 'confirmed';
    try {
      const seenPrompts: string[] = [];
      const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
      const ai: PayrollAi = { reader: buildReader(seenPrompts), budget };
      const ownerReads: PayrollReads = {
        authorize: () => o.query(o.owner, 'hr.payroll.coworker.access', {}),
        sheet: (runId) => o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId }),
        runs: (legalEntityId) => o.query<HrRunSummary[]>(o.owner, 'hr.payroll.run.list', { limit: 120, legalEntityId }),
        payslip: (id) => o.query<HrPayslip>(o.owner, 'hr.payroll.line.payslip', { lineId: id }),
      };
      const memberReads: PayrollReads = {
        authorize: () => o.query(o.member, 'hr.payroll.coworker.access', {}),
        sheet: (runId) => o.query<HrRunSheet>(o.member, 'hr.payroll.run.sheet', { runId }),
        runs: (legalEntityId) => o.query<HrRunSummary[]>(o.member, 'hr.payroll.run.list', { limit: 120, legalEntityId }),
        payslip: (id) => o.query<HrPayslip>(o.member, 'hr.payroll.line.payslip', { lineId: id }),
      };

      // Forbidden member fails before touching the 1/min org rate budget and writes zero sensitive audit rows.
      const beforeMember = await sensitiveAuditCount(o.orgId);
      await expect(flagMonth(ai, memberReads, o.orgId, o.member, calmRun.runId, 'vi')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await sensitiveAuditCount(o.orgId)).toBe(beforeMember);

      // Both prepareMonth and flagMonth on `calmRun` are QUIET: zero model calls, and both refund the 1/min rate ticket.
      expect(await prepareMonth(ai, ownerReads, o.orgId, o.owner, calmRun.runId, 'vi')).toEqual({ ai: 'quiet', items: [] });
      expect(await flagMonth(ai, ownerReads, o.orgId, o.owner, calmRun.runId, 'vi')).toEqual({ ai: 'quiet', items: [] });
      expect(seenPrompts).toEqual([]);

      // Restore commentary rules so `flagMonth` now finds `rule_blocks` and spends the 1/min rate ticket.
      PAYROLL_RULES.forEach((r, idx) => {
        (r as { status: string }).status = savedStatuses[idx]!;
      });
      const usedFlag = await flagMonth(ai, ownerReads, o.orgId, o.owner, calmRun.runId, 'en');
      expect(usedFlag.ai).toBe('used');
      expect(seenPrompts).toHaveLength(1);

      // Now the 1/min ticket is spent: further prepareMonth, flagMonth and explainPayslip calls return `busy` with ZERO new sensitive-read audit rows.
      const auditsAfterUsed = await sensitiveAuditCount(o.orgId);
      expect(await prepareMonth(ai, ownerReads, o.orgId, o.owner, calmRun.runId, 'en')).toEqual({ ai: 'busy', items: [] });
      expect(await flagMonth(ai, ownerReads, o.orgId, o.owner, calmRun.runId, 'en')).toEqual({ ai: 'busy', items: [] });
      expect(await explainPayslip(ai, ownerReads, o.orgId, o.owner, lineId, 'vi')).toEqual({ ai: 'busy', text: null });
      expect(await sensitiveAuditCount(o.orgId)).toBe(auditsAfterUsed);
    } finally {
      PAYROLL_RULES.forEach((r, idx) => {
        (r as { status: string }).status = savedStatuses[idx]!;
      });
    }
  });

  it('filters hr.payroll.run.list by legalEntityId and finds prior-month runs even when other entities have >120 newer runs', async () => {
    const o = await setupOrg();
    const emp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Lan',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
    });
    const febRun = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', {
      month: '2026-02',
      legalEntityId: o.defaultEntityId,
    });
    // Raise base wage in 2026-03 (>20% net increase and `component_changed` signal against 2026-02).
    await o.exec<HrWritten>(o.owner, 'hr.payroll.employment.add', {
      employeeId: emp.employeeId,
      effectiveFrom: '2026-03-01',
      contractType: 'indefinite',
      region: 'I',
      baseWage: '16000000',
    });
    const marRun = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', {
      month: '2026-03',
      legalEntityId: o.defaultEntityId,
    });

    // Insert a second legal entity with 125 newer runs (2027-01 .. 2037-05) so an unfiltered `limit: 120` query drops 2026-02 and 2026-03.
    const branchId = await withAdmin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by)
         VALUES ($1, 'Chi nhánh phía Nam', 'branch', $2)
         RETURNING id`,
        [o.orgId, o.owner],
      );
      const id = rows[0]!.id;
      await c.query(
        `INSERT INTO crove_hr.payroll_run (org_id, legal_entity_id, month, status, working_days, created_by)
         SELECT $1,
                $2,
                to_char(date '2027-01-01' + ((g - 1) || ' months')::interval, 'YYYY-MM'),
                'draft',
                '26',
                $3
           FROM generate_series(1, 125) AS g`,
        [o.orgId, id, o.owner],
      );
      return id;
    });

    // Backwards-compatible when omitted: returns 120 newest runs org-wide (all belonging to `branchId`).
    const unfiltered = await o.query<HrRunSummary[]>(o.owner, 'hr.payroll.run.list', { limit: 120 });
    expect(unfiltered).toHaveLength(120);
    expect(unfiltered.every((r) => r.legalEntityId === branchId)).toBe(true);
    expect(unfiltered.some((r) => r.id === febRun.runId)).toBe(false);

    // Filtered by `legalEntityId`: returns only the default entity's two runs.
    const entityRuns = await o.query<HrRunSummary[]>(o.owner, 'hr.payroll.run.list', {
      limit: 120,
      legalEntityId: o.defaultEntityId,
    });
    expect(entityRuns.map((r) => r.id)).toEqual([marRun.runId, febRun.runId]);

    // Coworker prepareMonth and flagMonth find the 2026-02 prior-month run for `defaultEntityId` despite the 125 newer branch runs.
    const ownerReads: PayrollReads = {
      authorize: () => o.query(o.owner, 'hr.payroll.coworker.access', {}),
      sheet: (runId) => o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId }),
      runs: (legalEntityId) => o.query<HrRunSummary[]>(o.owner, 'hr.payroll.run.list', { limit: 120, legalEntityId }),
      payslip: (id) => o.query<HrPayslip>(o.owner, 'hr.payroll.line.payslip', { lineId: id }),
    };
    const ai: PayrollAi = {
      reader: buildReader(),
      budget: new DraftBudget({ perUserPerMinute: 10 }),
      prepareBudget: new DraftBudget({ perUserPerMinute: 10 }),
      flagBudget: new DraftBudget({ perUserPerMinute: 10 }),
    };
    const [prepared, flagged] = await Promise.all([
      prepareMonth(ai, ownerReads, o.orgId, o.owner, marRun.runId, 'en'),
      flagMonth(ai, ownerReads, o.orgId, o.owner, marRun.runId, 'en'),
    ]);
    expect(prepared.ai).toBe('used');
    expect(flagged.ai).toBe('used');
    expect(prepared.items.some((i) => i.kind === 'component_changed' && i.employeeId === emp.employeeId)).toBe(true);
    expect(flagged.items.some((i) => i.kind === 'pay_moved' && i.employeeId === emp.employeeId)).toBe(true);
  });
});
