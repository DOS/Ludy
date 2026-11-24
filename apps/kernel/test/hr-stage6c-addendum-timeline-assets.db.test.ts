// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for HR Stage 6C (#4528):
// - Contract addendum lifecycle (create/update/issue/void, decimal wages, immutable guards, RLS)
// - Deterministic addendum PDF -> Ludy eSign handoff via sourceKind: 'hr_contract' (modules/sign untouched)
// - Metered Ly check (hr.addendum_check) + AI-off/kill-switch/leak-refusal parity
// - Chronological career timeline (employment + probation + issued addendums)
// - Asset handover checklist + self-service read (/hr/my) + unreturned asset termination guard/override
// - PDPL erasure + ludy_kernel.org_purge FK-safe cleanup
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metered, type AiMeter } from '@ludy/agent';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { vietnamToday } from '@ludy/kernel-contract';
import type {
  HrAddendumCheckResult,
  HrAddendumPdfResult,
  HrAddendumView,
  HrAddendumWriteResult,
  HrAssetView,
  HrAssetWriteResult,
  HrEmployeeErased,
  HrSelfAssetView,
  HrTimelineResult,
  HrWritten,
} from '@ludy/kernel-contract';
import {
  CredentialVault,
  Runtime,
  SUBJECT_WRAP_INFO,
  SubjectVault,
  contentGeneration,
  fileKey,
  parseVaultKey,
  sha256Hex,
  type BlobStore,
} from '@ludy/kernel-runtime';
import {
  hrCommands,
  hrQueries,
  type HrAddendumCheckSource,
} from '@ludy/mod-hr';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { checkAddendumDraft, hrAddendumAi, type HrAddendumPorts } from '../src/hr-addendum-ai.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

function makeMemoryBlobStore(): BlobStore {
  const map = new Map<string, Uint8Array>();
  return {
    put: async (key, bytes) => {
      map.set(key, bytes);
      return contentGeneration(sha256Hex(bytes));
    },
    get: async (key) => {
      const got = map.get(key);
      if (!got) throw new Error(`missing blob ${key}`);
      return got;
    },
    delete: async (key) => {
      map.delete(key);
    },
  };
}

suite('HR Stage 6C on PostgreSQL 17 (#4528)', () => {
  const dbName = `ludy_test_hr6c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  const store = makeMemoryBlobStore();

  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));

  const asUser = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal1' as const,
    sessionId: randomUUID(),
  });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const db = createDb(appPool);
    const person = (role: string, name: string) =>
      upsertIdentity(db, { issuer: 'hr6c', subject: `${role}-${tag}`, email: `${role}-${tag}@hr6c.test`, name });
    const owner = await person('owner', 'Chủ Doanh Nghiệp');
    const admin = await person('admin', 'Quản Trị Nhân Sự');
    const staffA = await person('staffa', 'Nguyễn Thị Minh Ánh');
    const staffB = await person('staffb', 'Trần Văn Bình');
    const viewer = await person('viewer', 'Người Xem');

    const { orgId } = await createOrg(rt, asUser(owner), `Cty Stage 6C ${tag}`);
    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
      [orgId, admin, staffA, staffB, viewer],
    );

    const exec = <O>(
      userId: string,
      name: string,
      input: unknown,
      actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId),
    ) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });

    return { orgId, owner, admin, staffA, staffB, viewer, exec, query };
  }

  beforeAll(async () => {
    const rootPool = new pg.Client({ connectionString: ADMIN as string });
    await rootPool.connect();
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';

    adminPool = createPool({ connectionString: adminUrl, max: 2, resetOnRelease: false });
    appPool = createPool({ connectionString: appUrl.toString(), max: 4 });
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });

    const rtOpts = {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      subjectVault,
      readAuditKey: randomBytes(32),
      stepUp: 'required' as const,
    };
    rt = new Runtime(createDb(appPool), rtOpts).register({
      commands: [...kernelCommands, ...hrCommands, ...signCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, ...signQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS, subjectVault }).register({
      commands: [...kernelCommands, ...hrCommands, orgPurgeCommand({ store })],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries],
    });
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = new pg.Client({ connectionString: ADMIN });
    await rootPool.connect();
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('manages contract addendums, enforces RLS & triggers, builds PDF -> eSign envelope, and aggregates career timeline', async () => {
    const o = await setupOrg();
    const o2 = await setupOrg();

    const addedEmp = await o.exec<HrWritten>(
      o.owner,
      'hr.payroll.employee.add',
      {
        displayName: 'Nguyễn Thị Minh Ánh',
        jobTitle: 'Chuyên viên Nhân sự',
        employment: {
          effectiveFrom: '2026-01-15',
          contractType: 'indefinite',
          region: 'I',
          baseWage: '15000000',
        },
      },
      asMfa(o.owner),
    );
    const empId = addedEmp.employeeId as string;

    const { rows: [empRow] } = await adminPool.query<{ id: string }>(
      `SELECT id FROM ludy_hr.payroll_employment WHERE org_id = $1 AND employee_id = $2`,
      [o.orgId, empId],
    );
    const employmentId = empRow!.id;

    // 1. Create draft addendum with fractional VND string (no float rounding), update draft, enforce unique number.
    const draft = await o.exec<HrAddendumWriteResult>(o.admin, 'hr.addendum.create', {
      employeeId: empId,
      employmentId,
      addendumNumber: 'PL-2026-01',
      effectiveOn: '2026-10-01',
      changeSummary: 'Điều chỉnh lương cơ bản và nâng ngạch chức danh.',
      previousPayRate: '15000000',
      newPayRate: '18500000.50',
      previousTitle: 'Chuyên viên Nhân sự',
      newTitle: 'Trưởng nhóm Nhân sự',
    });
    expect(draft.status).toBe('draft');

    await expect(
      o.exec(o.admin, 'hr.addendum.create', {
        employeeId: empId,
        employmentId,
        addendumNumber: 'PL-2026-01',
        effectiveOn: '2026-11-01',
        changeSummary: 'Trùng số phụ lục',
      }),
    ).rejects.toMatchObject({ code: 'HR_ADDENDUM_NUMBER_TAKEN', status: 409 });

    await o.exec(o.owner, 'hr.addendum.update', {
      addendumId: draft.addendumId,
      newPayRate: '19000000.75',
      changeSummary: 'Điều chỉnh lương cơ bản chính thức theo kỳ đánh giá Q3.',
    });

    // 2. Staff & viewer & cross-org users are denied at runtime and see 0 rows in raw RLS.
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empId, userId: o.staffA }, asMfa(o.owner));
    await expect(o.query(o.staffA, 'hr.addendum.list', { employeeId: empId })).rejects.toMatchObject({ status: 403 });
    await expect(o.query(o.viewer, 'hr.addendum.list', { employeeId: empId })).rejects.toMatchObject({ status: 403 });
    await expect(o2.query(o2.owner, 'hr.addendum.list', { employeeId: empId })).rejects.toMatchObject({ status: 404 });

    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, o.staffA, o.orgId);
      const res = await c.query(`SELECT id FROM ludy_hr.contract_addendum WHERE org_id = $1`, [o.orgId]);
      expect(res.rows).toHaveLength(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }

    // 3. Issue addendum -> immutable against edits in runtime and DB trigger, renders PDF, and attaches to sign.envelope cleanly.
    const issued = await o.exec<HrAddendumWriteResult>(o.owner, 'hr.addendum.issue', {
      addendumId: draft.addendumId,
    });
    expect(issued.status).toBe('issued');

    await expect(
      o.exec(o.owner, 'hr.addendum.update', {
        addendumId: draft.addendumId,
        changeSummary: 'Cố sửa sau khi phát hành',
      }),
    ).rejects.toMatchObject({ code: 'HR_ADDENDUM_NOT_DRAFT', status: 409 });

    const pdf = await o.query<HrAddendumPdfResult>(o.owner, 'hr.addendum.pdf', {
      addendumId: draft.addendumId,
      includeSignTags: true,
    });
    const pdfBytes = Buffer.from(pdf.pdfBase64, 'base64');
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.sha256).toBe(sha256Hex(pdfBytes));
    expect(pdfBytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');

    // Handoff to modules/sign with sourceKind: 'hr_contract' without touching modules/sign!
    const storageKey = fileKey(o.orgId, pdf.sha256);
    const generation = await store.put(storageKey, new Uint8Array(pdfBytes), 'application/pdf');
    const { fileId } = await o.exec<{ fileId: string }>(o.owner, 'kernel.file.ingest', {
      filename: pdf.filename,
      contentType: 'application/pdf',
      sizeBytes: pdfBytes.byteLength,
      sha256: pdf.sha256,
      storageKey,
      generation,
      source: 'sign_document',
    });
    const env = await o.exec<{ envelopeId: string }>(o.owner, 'sign.envelope.create', {
      title: 'Phụ lục PL-2026-01 - Nguyễn Thị Minh Ánh',
      sourceKind: 'hr_contract',
      sourceId: draft.addendumId,
      sourceFileId: fileId,
      routingMode: 'parallel',
    });
    expect(env.envelopeId).toBeTruthy();

    // 4. Create & void a second addendum (stays out of issued career timeline).
    const draft2 = await o.exec<HrAddendumWriteResult>(o.owner, 'hr.addendum.create', {
      employeeId: empId,
      employmentId,
      addendumNumber: 'PL-2026-02',
      effectiveOn: '2026-11-15',
      changeSummary: 'Phụ lục nháp chờ hủy',
    });
    const voided = await o.exec<HrAddendumWriteResult>(o.owner, 'hr.addendum.void', {
      addendumId: draft2.addendumId,
      reason: 'Nhập nhầm kỳ điều chỉnh',
    });
    expect(voided.status).toBe('voided');

    // 5. Probation review + timeline chronological order check
    await o.exec(o.owner, 'hr.probation.decide', {
      employeeId: empId,
      periodStart: '2026-01-15',
      periodEnd: '2026-03-15',
      probationEndOn: '2026-03-15',
      decision: 'pass',
      reviewNote: 'Hoàn thành tốt công việc thử việc.',
    });

    const timeline = await o.query<HrTimelineResult>(o.owner, 'hr.timeline.get', { employeeId: empId });
    expect(timeline.events.map((e) => e.kind)).toEqual([
      'employment_started',
      'probation_reviewed',
      'addendum_issued',
    ]);
    expect(timeline.events.map((e) => e.occurredOn)).toEqual(['2026-01-15', '2026-03-15', '2026-10-01']);
    expect(timeline.events[2]?.metadata).toMatchObject({
      addendumNumber: 'PL-2026-01',
      previousPayRate: '15000000',
      newPayRate: '19000000.75',
    });

    const listed = await o.query<HrAddendumView[]>(o.owner, 'hr.addendum.list', { employeeId: empId });
    expect(listed.map((r) => [r.addendumNumber, r.status])).toEqual([
      ['PL-2026-02', 'voided'],
      ['PL-2026-01', 'issued'],
    ]);
  });

  it('runs hr.addendum_check via metered AI bridge with AI-off parity, kill switch, and PII leak rejection', async () => {
    const o = await setupOrg();
    const { employeeId } = await o.exec<HrWritten>(
      o.owner,
      'hr.payroll.employee.add',
      {
        displayName: 'Lê Minh Tâm',
        jobTitle: 'Kế toán viên',
        employment: {
          effectiveFrom: '2026-02-01',
          contractType: 'indefinite',
          region: 'I',
          baseWage: '14000000',
        },
      },
      asMfa(o.owner),
    );
    const empId = employeeId as string;
    const { rows: [empRow] } = await adminPool.query<{ id: string }>(
      `SELECT id FROM ludy_hr.payroll_employment WHERE org_id = $1 AND employee_id = $2`,
      [o.orgId, empId],
    );
    const employmentId = empRow!.id;

    const actor = asUser(o.owner);
    const ports: HrAddendumPorts = {
      read: (inp) => rt.query<HrAddendumCheckSource>('hr.addendum.check.read', inp, { actor, orgId: o.orgId }),
      isAiStopped: async () => (await rt.query<{ aiStopped: boolean }>('hr.addendum.ai_status', {}, { actor, orgId: o.orgId })).aiStopped,
      record: (inp) => rt.execute('hr.addendum.check.audit', inp, { actor, orgId: o.orgId }),
    };

    const recordedCalls: number[] = [];
    const testMeter: AiMeter = {
      admit: async () => {},
      record: async (_call, usage) => {
        recordedCalls.push(usage.inputTokens + usage.outputTokens);
      },
    };

    // AI off: still evaluates deterministic rules accurately.
    const aiOffRes: HrAddendumCheckResult = await checkAddendumDraft(
      hrAddendumAi(null, new DraftBudget()),
      ports,
      rt,
      o.orgId,
      actor,
      {
        employeeId: empId,
        employmentId,
        addendumNumber: '',
        effectiveOn: '2026-11-01',
        changeSummary: 'ok',
        withAi: true,
      },
      testMeter,
    );
    expect(aiOffRes.readyToIssue).toBe(false);
    expect(aiOffRes.ai).toEqual({ ok: false, reason: 'ai_off' });
    expect(aiOffRes.findings.map((f) => f.code)).toContain('missing_addendum_number');
    expect(aiOffRes.findings.map((f) => f.code)).toContain('missing_summary');

    // Explicit null on previousPayRate/previousTitle preserves cleared draft inputs rather than falling back to DB wage/title.
    const clearedDraftRes = await checkAddendumDraft(
      hrAddendumAi(null, new DraftBudget()),
      ports,
      rt,
      o.orgId,
      actor,
      {
        employeeId: empId,
        employmentId,
        addendumNumber: 'PL-2026-07B',
        effectiveOn: '2026-11-01',
        changeSummary: 'Thỏa thuận bổ sung thời giờ làm việc linh hoạt.',
        previousPayRate: null,
        newPayRate: null,
        previousTitle: null,
        newTitle: null,
        withAi: false,
      },
      testMeter,
    );
    expect(clearedDraftRes.readyToIssue).toBe(true);
    expect(clearedDraftRes.findings.map((f) => f.code)).toContain('missing_change_delta');

    // Metered AI on: charges testMeter through withAiScope and passes clean note.
    const aiOkRes = await checkAddendumDraft(
      hrAddendumAi(
        {
          hrAddendumCheck: async () => {
            await metered('hr.addendum_check', async () => ({
              text: 'ok',
              usage: { inputTokens: 45, outputTokens: 25 },
            }));
            return {
              readyToIssue: true,
              findings: [],
              lyNote: 'P1 có đầy đủ ngày hiệu lực 2026-11-01 và mức điều chỉnh lương.',
              reason: 'ok',
              usage: { inputTokens: 45, outputTokens: 25 },
            };
          },
        },
        new DraftBudget(),
      ),
      ports,
      rt,
      o.orgId,
      actor,
      {
        employeeId: empId,
        employmentId,
        addendumNumber: 'PL-2026-08',
        effectiveOn: '2026-11-01',
        changeSummary: 'Điều chỉnh phụ cấp trách nhiệm',
        previousPayRate: '14000000',
        newPayRate: '16000000',
        withAi: true,
      },
      testMeter,
    );
    expect(aiOkRes.ai).toEqual({ ok: true, reason: 'ok' });
    expect(aiOkRes.lyNote).toContain('P1');
    expect(recordedCalls).toEqual([70]);

    // Metered AI on: alias P1 + leak refusal on real name!
    const aiLeakyRes = await checkAddendumDraft(
      hrAddendumAi(
        {
          hrAddendumCheck: async () => ({
            readyToIssue: true,
            findings: [],
            lyNote: null,
            reason: 'leak_refused',
            usage: { inputTokens: 30, outputTokens: 10 },
          }),
        },
        new DraftBudget(),
      ),
      ports,
      rt,
      o.orgId,
      actor,
      {
        employeeId: empId,
        employmentId,
        addendumNumber: 'PL-2026-09',
        effectiveOn: '2026-11-01',
        changeSummary: 'Điều chỉnh phụ cấp trách nhiệm',
        previousPayRate: '14000000',
        newPayRate: '16000000',
        withAi: true,
      },
      testMeter,
    );
    expect(aiLeakyRes.readyToIssue).toBe(true);
    expect(aiLeakyRes.ai).toEqual({ ok: false, reason: 'leak_refused' });

    // Kill switch engaged on org HR module blocks AI call while preserving deterministic output.
    await adminPool.query(
      `INSERT INTO ludy_kernel.kill_switch (org_id, scope, target, reason, engaged_by)
       VALUES ($1, 'module', 'hr', 'test pause', $2)`,
      [o.orgId, o.owner],
    );
    let llmCalledWhenKilled = false;
    const killedRes = await checkAddendumDraft(
      hrAddendumAi(
        {
          hrAddendumCheck: async () => {
            llmCalledWhenKilled = true;
            return { readyToIssue: true, findings: [], lyNote: 'ok', reason: 'ok', usage: null };
          },
        },
        new DraftBudget(),
      ),
      ports,
      rt,
      o.orgId,
      actor,
      {
        employeeId: empId,
        employmentId,
        addendumNumber: 'PL-2026-10',
        effectiveOn: '2026-11-01',
        changeSummary: 'Điều chỉnh chức danh lên Kế toán tổng hợp.',
        previousPayRate: '14000000',
        newPayRate: '18000000',
        withAi: true,
      },
      testMeter,
    );
    expect(llmCalledWhenKilled).toBe(false);
    expect(killedRes.ai).toEqual({ ok: false, reason: 'kill_switch' });
    expect(killedRes.readyToIssue).toBe(true);
  });

  it('tracks assets, exposes non-sensitive /hr/my list, blocks termination unless cleared or overridden, erases & purges cleanly', async () => {
    const o = await setupOrg();
    const { employeeId } = await o.exec<HrWritten>(
      o.owner,
      'hr.payroll.employee.add',
      {
        displayName: 'Phạm Quốc Bảo',
        employment: {
          effectiveFrom: '2026-03-01',
          contractType: 'indefinite',
          region: 'I',
          baseWage: '22000000',
        },
      },
      asMfa(o.owner),
    );
    const empId = employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empId, userId: o.staffA }, asMfa(o.owner));

    const { rows: [empRow] } = await adminPool.query<{ id: string }>(
      `SELECT id FROM ludy_hr.payroll_employment WHERE org_id = $1 AND employee_id = $2`,
      [o.orgId, empId],
    );
    const employmentId = empRow!.id;

    // Assign two assets and create an addendum
    const laptop = await o.exec<HrAssetWriteResult>(o.admin, 'hr.assets.assign', {
      employeeId: empId,
      assetCode: 'TS-MBP-01',
      assetName: 'MacBook Pro 14 M4',
      serialNumber: 'C02TEST01',
      handedOverOn: '2026-03-02',
      notes: 'Kèm sạc và túi chống sốc',
    });
    const monitor = await o.exec<HrAssetWriteResult>(o.admin, 'hr.assets.assign', {
      employeeId: empId,
      assetCode: 'TS-MON-02',
      assetName: 'Dell UltraSharp 27',
      serialNumber: 'DL999888',
      handedOverOn: '2026-03-02',
      notes: 'Bàn làm việc Q1',
    });

    await o.exec(o.admin, 'hr.addendum.create', {
      employeeId: empId,
      employmentId,
      addendumNumber: 'PL-RET-01',
      effectiveOn: '2026-06-01',
      changeSummary: 'Điều chỉnh phụ cấp cho Phạm Quốc Bảo',
      previousPayRate: '22000000',
      newPayRate: '24000000',
      previousTitle: 'Chuyên viên',
      newTitle: 'Trưởng phòng',
      issueImmediately: true,
    });

    // Self-service employee reads own non-sensitive items only; peer unlinked staffB gets 403 + 0 RLS rows.
    const selfAssets = await o.query<HrSelfAssetView[]>(o.staffA, 'hr.self.assets.list', {});
    expect(selfAssets).toHaveLength(2);
    expect(selfAssets[0]).not.toHaveProperty('notes');
    expect(selfAssets[0]).not.toHaveProperty('clearedBy');
    await expect(o.query(o.staffB, 'hr.self.assets.list', {})).rejects.toMatchObject({ status: 403 });
    await expect(o.query(o.viewer, 'hr.assets.list', { employeeId: empId })).rejects.toMatchObject({ status: 403 });

    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, o.staffB, o.orgId);
      const rlsOther = await c.query(`SELECT id FROM ludy_hr.employee_asset_handover WHERE org_id = $1`, [o.orgId]);
      expect(rlsOther.rows).toHaveLength(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }

    // Cannot terminate while assets remain assigned without explicit override note!
    await expect(
      o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empId, endedOn: '2026-09-30' }),
    ).rejects.toMatchObject({ code: 'HR_UNRETURNED_ASSETS', status: 409 });

    // Return one asset; second remains assigned -> still blocked without override, then allowed with override!
    const retLaptop = await o.exec<HrAssetWriteResult>(o.admin, 'hr.assets.update_status', {
      assetId: laptop.assetId,
      status: 'returned',
      returnedOn: '2026-09-29',
    });
    expect(retLaptop.status).toBe('returned');

    await expect(
      o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empId, endedOn: '2026-09-30' }),
    ).rejects.toMatchObject({ code: 'HR_UNRETURNED_ASSETS', status: 409 });

    await o.exec(o.owner, 'hr.payroll.employee.end', {
      employeeId: empId,
      endedOn: '2026-09-30',
      assetOverrideNote: 'Nhân viên đang chuyển phát màn hình về văn phòng, đối trừ công nợ cuối tháng',
    });

    // WORM audit_event records non-PII override marker only (never raw assetOverrideNote free text).
    const { rows: endAuditRows } = await adminPool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'hr.payroll.employee.end' ORDER BY occurred_at DESC LIMIT 1`,
      [o.orgId],
    );
    expect(endAuditRows[0]?.detail).toMatchObject({
      assetOverrideProvided: true,
    });
    expect(endAuditRows[0]?.detail).not.toHaveProperty('assetOverrideNote');

    // SQL trigger blocks reverting cleared assets back to 'assigned'.
    await expect(
      adminPool.query(
        `UPDATE ludy_hr.employee_asset_handover SET status = 'assigned', returned_on = NULL, cleared_by = NULL WHERE org_id = $1 AND id = $2`,
        [o.orgId, laptop.assetId],
      ),
    ).rejects.toThrow(/HR_ASSET_ALREADY_CLEARED/);

    // Can still clear remaining asset after termination ('lost_waived')
    const waived = await o.exec<HrAssetWriteResult>(o.admin, 'hr.assets.update_status', {
      assetId: monitor.assetId,
      status: 'lost_waived',
      notes: 'Đã khấu trừ khấu hao',
    });
    expect(waived.status).toBe('lost_waived');

    const assetsAfterClear = await o.query<HrAssetView[]>(o.owner, 'hr.assets.list', { employeeId: empId });
    expect(assetsAfterClear.map((a) => a.status).sort()).toEqual(['lost_waived', 'returned']);

    // Simulate retention elapsed (> 10 years) and verify PDPL erase wipes free text & serial numbers cleanly!
    await adminPool.query(
      `UPDATE ludy_hr.payroll_employee SET ended_on = '2010-01-01' WHERE org_id = $1 AND id = $2`,
      [o.orgId, empId],
    );
    const erased = await o.exec<HrEmployeeErased>(
      o.owner,
      'hr.payroll.employee.erase',
      { employeeId: empId },
      asMfa(o.owner),
    );
    expect(erased.cleared).toContain('contract addendum summaries, titles and void reasons');
    expect(erased.cleared).toContain('asset handover serial numbers and notes');

    const { rows: [addRow] } = await adminPool.query<{
      change_summary: string;
      previous_title: string | null;
      new_title: string | null;
      previous_pay_rate: string;
      new_pay_rate: string;
    }>(`SELECT change_summary, previous_title, new_title, previous_pay_rate, new_pay_rate FROM ludy_hr.contract_addendum WHERE org_id = $1`, [o.orgId]);
    expect(addRow).toMatchObject({
      change_summary: '[erased]',
      previous_title: null,
      new_title: null,
      previous_pay_rate: '22000000.00',
      new_pay_rate: '24000000.00',
    });

    const { rows: assetRows } = await adminPool.query<{ serial_number: string | null; notes: string | null }>(
      `SELECT serial_number, notes FROM ludy_hr.employee_asset_handover WHERE org_id = $1`,
      [o.orgId],
    );
    expect(assetRows.every((r) => r.serial_number === null && r.notes === null)).toBe(true);

    // SQL triggers block arbitrary post-erasure mutations to contract_addendum and employee_asset_handover.
    await expect(
      adminPool.query(
        `UPDATE ludy_hr.contract_addendum SET change_summary = 'rewritten' WHERE org_id = $1`,
        [o.orgId],
      ),
    ).rejects.toThrow(/HR_ADDENDUM_ERASE_IMMUTABLE/);
    await expect(
      adminPool.query(
        `UPDATE ludy_hr.employee_asset_handover SET serial_number = 'SN-POST-ERASE' WHERE org_id = $1`,
        [o.orgId],
      ),
    ).rejects.toThrow(/HR_ASSET_ERASE_IMMUTABLE/);

    // Org purge cleans contract_addendum and employee_asset_handover without FK errors
    const dayMs = 24 * 60 * 60 * 1000;
    const pClient = await adminPool.connect();
    let pInTx = false;
    let pBroken = false;
    try {
      await pClient.query('BEGIN');
      pInTx = true;
      await pClient.query('SET LOCAL session_replication_role = replica');
      await pClient.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [o.orgId]);
      await pClient.query('COMMIT');
      pInTx = false;
      await pClient.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}')`,
        [
          o.orgId,
          new Date(Date.now() - 40 * dayMs),
          o.owner,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * dayMs),
          randomUUID(),
        ],
      );
    } catch (err) {
      if (pInTx) {
        await pClient.query('ROLLBACK').catch(() => {
          pBroken = true;
        });
      }
      throw err;
    } finally {
      pClient.release(pBroken);
    }
    const purged = await purgeOrg(workerRt, 30, { ref: o.orgId, reason: 'Stage 6C purge check' });
    expect(purged.kind).toBe('purged');
    for (const tbl of ['ludy_hr.contract_addendum', 'ludy_hr.employee_asset_handover']) {
      const cntRes = await adminPool.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM ${tbl} WHERE org_id = $1`, [
        o.orgId,
      ]);
      expect(cntRes.rows[0]?.cnt).toBe(0);
    }

    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
