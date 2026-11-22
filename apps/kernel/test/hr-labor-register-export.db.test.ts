// SPDX-License-Identifier: AGPL-3.0-only
// Stage 2b-1 (#3372 / #2541): Sổ quản lý lao động (`labor_register`) and Báo cáo 01/PLI (`01pli`)
// HTTP `.json`/`.xlsx` exports + pre-export AI compliance review (`hr.payroll.laborCheck`) on real PostgreSQL 17:
// - GET /api/payroll-export/labor_register.{json,xlsx} and /api/payroll-export/01pli.{json,xlsx} (`YYYY-H1`, `YYYY-H2`, `YYYY`) end-to-end with fresh MFA;
// - historical `asOf` snapshot masking (`ended_on > asOf`), approved line `contractTermMonths` -> `contractEndDate`, and `allowances` total;
// - STEP_UP_REQUIRED (403) without fresh MFA, 403 for non-manager `member`/`viewer` and foreign org, 422 on invalid dates/periods;
// - erased employee masked as `[Đã xóa theo yêu cầu]` without calling `subjectVault.open`, audit row logged (`months: []`, no PII);
// - POST /api/rpc/hr/payroll/laborCheck works WITHOUT 5-minute MFA, returns deterministic counts & findings with AI off, never calls `subjectVault.open`,
//   refuses `member`/`viewer` with 403, and logs sensitive read + `hr.payroll.labor_check.audit` (`{ kind, checked }` only, no PII).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the suite creates and drops its own disposable database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HrDeclarationDocument, HrDepartmentWritten, HrLaborCheckResult, HrRunSheet, HrRunWritten, HrWritten } from '@ludy/kernel-contract';
import { CredentialVault, DomainError, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { PAYROLL_RULES } from '@ludy/l10n-vn';
import { LABOR_REGISTER_ERASED_PLACEHOLDER, hrCommands, hrQueries, type HrLaborCheckSnapshot } from '@ludy/mod-hr';
import type { AuthUser } from '../src/auth.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
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

function zipEntry(zip: Uint8Array, name: string): string | null {
  const buf = Buffer.from(zip);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n -= 1) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    if (buf.toString('utf8', at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

vi.mock('@ludy/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ludy/l10n-vn')>();
  return { ...real, PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })) };
});
const setRuleStatus = (status: 'confirmed' | 'commentary') => {
  for (const row of PAYROLL_RULES) (row as { status: string }).status = status;
};

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const AN_NAME = 'Nguyễn Thị An Canary';
const AN_IDENTITY = '079321654987';
const AN_TAX = '8765432101';
const AN_INSURANCE = '7305186294';
const AN_ADDRESS = '12 Nguyễn Huệ, TP.HCM';

const BINH_NAME = 'Trần Văn Bình Canary';
const BINH_IDENTITY = '079111222333';
const BINH_ADDRESS = '34 Lê Lợi, Hà Nội';

const CHI_NAME = 'Lê Văn Chi Canary';
const CHI_ADDRESS = '56 Hai Bà Trưng, Hà Nội';

const DUNG_NAME = 'Phạm Văn Dũng Erasure';
const DUNG_IDENTITY = '079999888777';
const DUNG_TAX = '9998887776';
const DUNG_INSURANCE = '9988776655';
const DUNG_ADDRESS = '99 Đường Xóa Dữ Liệu';

suite('HR labor register and 01/PLI exports on PostgreSQL (#3372)', () => {
  const dbName = `crove_test_labor_reg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
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

  async function seedOrg(options: { withErased?: boolean } = {}) {
    const tag = randomUUID().slice(0, 8);
    const person = (role: string) => upsertIdentity(createDb(pool), { issuer: 'hrreg', subject: `${role}-${tag}`, email: `${role}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Sổ Lao Động ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, admin, member, viewer]));

    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });

    // An: complete indefinite employee starting before 2026
    const an = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: AN_NAME,
      birthDate: '1990-05-17',
      address: AN_ADDRESS,
      identityNumber: AN_IDENTITY,
      taxCode: AN_TAX,
      insuranceNumber: AN_INSURANCE,
      employment: { effectiveFrom: '2025-11-01', contractType: 'indefinite', region: 'I', baseWage: '22000000' },
    });

    // Bình: fixed_term hired 2026-01-01, missing insuranceNumber + birthDate, has approved line metadata
    const binh = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: BINH_NAME,
      address: BINH_ADDRESS,
      identityNumber: BINH_IDENTITY,
      employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '15000000' },
    });

    // Approve May 2026 payroll run with contractTermMonths = 6 and two allowances totaling 1,000,000 for Bình
    setRuleStatus('confirmed');
    try {
      const mayRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-05' });
      const sheetBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      const binhLine = sheetBefore.lines.find((l) => l.employeeId === binh.employeeId);
      expect(binhLine).toBeDefined();
      await exec(owner, 'hr.payroll.line.inputs.set', {
        lineId: binhLine!.id,
        inputs: {
          ...binhLine!.inputs,
          contractTermMonths: 6,
          allowances: [
            { label: 'Phụ cấp chức vụ', amount: '730000', type: 'other', namedInContract: true },
            { label: 'Xăng xe', amount: '270000', type: 'other', namedInContract: false },
          ],
        },
      });
      const sheetAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      await exec<HrRunWritten>(owner, 'hr.payroll.run.approve', { runId: mayRun.runId, fingerprint: sheetAfter.fingerprint, acceptFlags: true }, asMfa(owner));
    } finally {
      setRuleStatus('commentary');
    }

    // Give An a same-contract-type wage raise from 2026-06-01 (after May run); must preserve contractStartDate 2025-11-01 while updating baseWage.
    await exec(owner, 'hr.payroll.employment.add', {
      employeeId: an.employeeId,
      effectiveFrom: '2026-06-01',
      contractType: 'indefinite',
      region: 'I',
      baseWage: '24000000',
    });

    // Chi: 'none' contract hired 2026-04-01, missing identityNumber (added after May pay run so 'none' refusal does not block May approval)
    const chi = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: CHI_NAME,
      birthDate: '1995-08-20',
      address: CHI_ADDRESS,
      employment: { effectiveFrom: '2026-04-01', contractType: 'none', region: 'I', baseWage: '8000000' },
    });

    // Bình resigns on 2026-08-15 (after H1, before September snapshot)
    await exec(owner, 'hr.payroll.employee.end', { employeeId: binh.employeeId, endedOn: '2026-08-15' });

    let dungId: string | null = null;
    if (options.withErased) {
      const dung = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
        displayName: DUNG_NAME,
        birthDate: '1988-03-10',
        address: DUNG_ADDRESS,
        identityNumber: DUNG_IDENTITY,
        taxCode: DUNG_TAX,
        insuranceNumber: DUNG_INSURANCE,
        employment: { effectiveFrom: '2015-01-01', contractType: 'indefinite', region: 'I', baseWage: '12000000' },
      });
      dungId = dung.employeeId as string;
      await exec(owner, 'hr.payroll.employee.end', { employeeId: dungId, endedOn: '2016-01-01' });
      await withAdmin((c) => c.query(`UPDATE ludy_hr.payroll_employee SET ended_on = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date WHERE id = $1`, [dungId]));
      await exec(owner, 'hr.payroll.employee.erase', { employeeId: dungId }, asMfa(owner));
    }

    return { orgId, slug, owner, admin, member, viewer, anId: an.employeeId as string, binhId: binh.employeeId as string, chiId: chi.employeeId as string, dungId, exec, query };
  }

  function makeHttp(o: Awaited<ReturnType<typeof seedOrg>>, elsewhere?: Awaited<ReturnType<typeof seedOrg>>) {
    const nowS = Math.floor(Date.now() / 1000);
    const users = new Map<string, AuthUser>([
      ...([o.owner, o.admin, o.member, o.viewer].map((id) => [id, { userId: id, email: '', name: null, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: nowS }] as const)),
      ['stale-owner', { userId: o.owner, email: '', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null }],
      ...(elsewhere ? [['other-owner', { userId: elsewhere.owner, email: '', name: null, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: nowS }] as const] : []),
    ]);
    const exports = new ConcurrencyLimiter({ total: 2, perKey: 2 });
    const app = createHttpApp({
      exports,
      config: loadConfig({
        DATABASE_URL: appUrl,
        AUTH_JWT_SECRET: 'test-only-jwt-secret-for-labor-register-3372',
        AUTH_ISSUER: 'test-auth',
        WEB_DIST: '/nonexistent',
        EXPORT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
      runtime: rt,
      store: new MemoryStore(),
      authenticate: async (header) => {
        const token = String(header ?? '').replace('Bearer ', '');
        const user = users.get(token);
        if (!user) throw new DomainError('UNAUTHENTICATED', 401, 'unauthenticated');
        return user;
      },
      pool,
      aiEnabled: false,
    });
    const getExport = (file: string, query: string, token: string, slug = o.slug) => app.request(`/api/payroll-export/${file}?${query}`, { headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug } });
    const postLaborCheck = async (token: string, input: unknown, slug = o.slug) => {
      const res = await app.request('/api/rpc/hr/payroll/laborCheck', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-crove-org': slug },
        body: JSON.stringify({ json: input }),
      });
      const raw = (await res.json().catch(() => null)) as { json?: HrLaborCheckResult } & Record<string, unknown> | null;
      return { status: res.status, body: (raw && 'json' in raw ? raw.json : raw) as HrLaborCheckResult & Record<string, unknown> };
    };
    return { app, exports, getExport, postLaborCheck };
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
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 6 });
    rt = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      subjectVault,
      readAuditKey: randomBytes(32),
      stepUp: 'required',
    }).register({ commands: [...kernelCommands, ...hrCommands], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('serves labor_register.json and .xlsx with historical asOf snapshot, derived contractEndDate, allowance, and audit row', async () => {
    const o = await seedOrg();
    const { exports, getExport } = makeHttp(o);

    // Snapshot as of 2026-06-20: Binh had NOT resigned yet, so endedOn is masked to empty; An & Chi are active too.
    const juneJsonRes = await getExport('labor_register.json', 'period=2026-06-20', o.owner);
    expect(juneJsonRes.status).toBe(200);
    expect(juneJsonRes.headers.get('cache-control')).toBe('private, no-store');
    const juneDoc = (await juneJsonRes.json()) as HrDeclarationDocument;
    expect(juneDoc.layout.version).toBe('ludy-hr-labor-register/1');
    expect(juneDoc.used).toEqual({ months: [] });
    const juneRows = juneDoc.sheets[0]?.rows ?? [];
    expect(juneRows).toHaveLength(3);
    const binhJune = juneRows.find((r) => r.name === BINH_NAME);
    expect(binhJune).toMatchObject({
      name: BINH_NAME,
      identityNumber: BINH_IDENTITY,
      address: BINH_ADDRESS,
      contractType: 'Xác định thời hạn',
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-06-30',
      baseWage: '15000000.00',
      endedOn: '',
    });
    const anJune = juneRows.find((r) => r.name === AN_NAME);
    expect(anJune).toMatchObject({
      identityNumber: AN_IDENTITY,
      taxCode: AN_TAX,
      insuranceNumber: AN_INSURANCE,
      birthDate: '1990-05-17',
      address: AN_ADDRESS,
      contractStartDate: '2025-11-01',
      baseWage: '24000000.00',
    });

    // Snapshot as of 2026-09-01: Binh shows endedOn = 2026-08-15.
    const sepXlsxRes = await getExport('labor_register.xlsx', 'period=2026-09-01', o.admin);
    expect(sepXlsxRes.status).toBe(200);
    expect(sepXlsxRes.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(sepXlsxRes.headers.get('cache-control')).toBe('private, no-store');
    expect(sepXlsxRes.headers.get('content-disposition')).toContain('attachment');
    const bytes = new Uint8Array(await sepXlsxRes.arrayBuffer());
    expect(String.fromCharCode(bytes[0] as number, bytes[1] as number)).toBe('PK');
    const sheetXml = zipEntry(bytes, 'xl/worksheets/sheet1.xml') ?? '';
    expect(sheetXml).not.toContain('<f>');
    const shared = zipEntry(bytes, 'xl/sharedStrings.xml') ?? '';
    expect(`${shared}${sheetXml}`).toContain('2026-08-15');
    expect(exports.inUse).toBe(0);

    // Invalid calendar date or period rejected with 422
    expect((await getExport('labor_register.json', 'period=2026-02-30', o.owner)).status).toBe(422);
    expect((await getExport('labor_register.json', 'period=2026-04-31', o.owner)).status).toBe(422);

    // Export audit row recorded with months: [] and zero PII
    const auditRows = await withAdmin(async (c) => (await c.query<{ detail: string; row: string }>(`SELECT detail::text AS detail, audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'hr.payroll.declaration.export' ORDER BY id`, [o.orgId])).rows);
    expect(auditRows).toHaveLength(2);
    expect(JSON.parse(auditRows[0]!.detail)).toMatchObject({ kind: 'labor_register', period: '2026-06-20', months: [], rows: 3, via: 'view' });
    expect(JSON.parse(auditRows[1]!.detail)).toMatchObject({ kind: 'labor_register', period: '2026-09-01', months: [], rows: 3, via: 'xlsx' });
    for (const row of auditRows) {
      for (const pii of [AN_NAME, AN_IDENTITY, AN_TAX, AN_INSURANCE, BINH_NAME, BINH_IDENTITY]) expect(row.row).not.toContain(pii);
    }
  });

  it('serves 01pli.json and .xlsx for YYYY-H1, YYYY-H2, and annual YYYY periods', async () => {
    const o = await seedOrg();
    const { getExport } = makeHttp(o);

    // 2026-H1: An started before H1 (atStart=1), Binh & Chi hired in H1 (hired=2), Binh not ended yet as of 2026-06-30 (ended=0, atEnd=3)
    const h1Res = await getExport('01pli.json', 'period=2026-H1', o.owner);
    expect(h1Res.status).toBe(200);
    const h1 = (await h1Res.json()) as HrDeclarationDocument;
    expect(h1.layout.version).toBe('ludy-hr-01pli/1');
    expect(h1.used).toEqual({ months: [] });
    const h1Summary = new Map((h1.sheets[0]?.rows ?? []).map((r) => [r.item, r.value]));
    expect(h1Summary.get('Số lao động đầu kỳ')).toBe('1');
    expect(h1Summary.get('Số lao động tăng mới trong kỳ')).toBe('2');
    expect(h1Summary.get('Số lao động giảm trong kỳ')).toBe('0');
    expect(h1Summary.get('Số lao động cuối kỳ')).toBe('3');
    expect(h1Summary.get('Cuối kỳ: Lao động nữ (không gồm hồ sơ đã xóa)')).toBe('Chưa có dữ liệu');
    expect(h1.notes.join(' ')).toContain('Chưa đủ dữ liệu giới tính');
    const h1Binh = h1.sheets[1]?.rows.find((r) => r.name === BINH_NAME);
    expect(h1Binh).toMatchObject({ endedOn: '', contractEndDate: '2026-06-30', allowance: '1000000.00' });

    // 2026-H2: all 3 started before 2026-07-01 (atStart=3), Binh ended 2026-08-15 (ended=1, atEnd=2)
    const h2Res = await getExport('01pli.json', 'period=2026-H2', o.owner);
    expect(h2Res.status).toBe(200);
    const h2 = (await h2Res.json()) as HrDeclarationDocument;
    const h2Summary = new Map((h2.sheets[0]?.rows ?? []).map((r) => [r.item, r.value]));
    expect(h2Summary.get('Số lao động đầu kỳ')).toBe('3');
    expect(h2Summary.get('Số lao động giảm trong kỳ')).toBe('1');
    expect(h2Summary.get('Số lao động cuối kỳ')).toBe('2');

    // 2026 annual xlsx download
    const yrRes = await getExport('01pli.xlsx', 'period=2026', o.owner);
    expect(yrRes.status).toBe(200);
    const yrBytes = new Uint8Array(await yrRes.arrayBuffer());
    expect(String.fromCharCode(yrBytes[0] as number, yrBytes[1] as number)).toBe('PK');
    expect((await getExport('01pli.json', 'period=2026-Q1', o.owner)).status).toBe(422);
  });

  it('enforces STEP_UP_REQUIRED, rejects non-managers, and masks erased employees without calling subjectVault.open', async () => {
    const o = await seedOrg({ withErased: true });
    const elsewhere = await seedOrg();
    const { getExport } = makeHttp(o, elsewhere);

    // Missing fresh MFA -> 403 STEP_UP_REQUIRED
    const noMfa = await getExport('labor_register.json', 'period=2026-09-01', 'stale-owner');
    expect(noMfa.status).toBe(403);
    expect(await noMfa.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });

    // Non-managers and foreign owner -> 403
    for (const who of [o.member, o.viewer, 'other-owner']) {
      expect((await getExport('labor_register.json', 'period=2026-09-01', who)).status).toBe(403);
      expect((await getExport('01pli.xlsx', 'period=2026-H1', who)).status).toBe(403);
    }

    // Erased employee Dung is masked as `[Đã xóa theo yêu cầu]` and NEVER passed to subjectVault.open
    const openedRefs: string[] = [];
    const openedPlaces: string[] = [];
    const realOpen = subjectVault.open.bind(subjectVault);
    const spy = vi.spyOn(subjectVault, 'open').mockImplementation((dataKey, orgId, subjectId, place, packed) => {
      openedRefs.push(subjectId);
      openedPlaces.push(place);
      return realOpen(dataKey, orgId, subjectId, place, packed);
    });
    try {
      const regRes = await getExport('labor_register.json', 'period=2026-09-01', o.owner);
      expect(regRes.status).toBe(200);
      const reg = (await regRes.json()) as HrDeclarationDocument;
      const erasedRow = reg.sheets[0]?.rows.find((r) => r.name === LABOR_REGISTER_ERASED_PLACEHOLDER);
      expect(erasedRow).toBeDefined();
      expect(erasedRow).toMatchObject({
        name: LABOR_REGISTER_ERASED_PLACEHOLDER,
        identityNumber: '',
        taxCode: '',
        insuranceNumber: '',
        birthDate: '',
        address: '',
      });
      const bodyText = JSON.stringify(reg);
      for (const secret of [DUNG_NAME, DUNG_IDENTITY, DUNG_TAX, DUNG_INSURANCE, DUNG_ADDRESS]) expect(bodyText).not.toContain(secret);
      expect(openedRefs).not.toContain(`employee:${o.dungId}`);
      expect(openedPlaces).toContain('ludy_hr.payroll_employee.tax_code_sealed');

      // 01/PLI prints only identityNumber and insuranceNumber, so tax_code_sealed is never decrypted for 01pli.
      openedRefs.length = 0;
      openedPlaces.length = 0;
      const pliRes = await getExport('01pli.json', 'period=2026-H1', o.owner);
      expect(pliRes.status).toBe(200);
      expect(openedRefs).not.toContain(`employee:${o.dungId}`);
      expect(openedPlaces).toContain('ludy_hr.payroll_employee.national_id_sealed');
      expect(openedPlaces).toContain('ludy_hr.payroll_employee.insurance_number_sealed');
      expect(openedPlaces).not.toContain('ludy_hr.payroll_employee.tax_code_sealed');
    } finally {
      spy.mockRestore();
    }
  });

  it('exposes hr.payroll.laborCheck without MFA, enforces owner/admin access, never opens sealed columns, and logs clean audit rows', async () => {
    const o = await seedOrg({ withErased: true });
    const elsewhere = await seedOrg();
    const { postLaborCheck } = makeHttp(o, elsewhere);

    const openSpy = vi.spyOn(subjectVault, 'open');
    try {
      // Stale MFA owner succeeds without step-up on laborCheck as of 2026-06-20:
      // - Checked = 4 (An, Binh, Chi, plus historical Dung with effectiveFrom=2015-01-01 who is erased and skipped by issue counts)
      // - Missing identityNumber: Chi (1)
      // - Missing insuranceNumber (insured): Binh (1) (Chi has contractKind='none', not insured)
      // - Missing birthDate or address: Binh (missing birthDate) (1)
      // - Unwritten 'none' contracts: Chi (1)
      // - Contract alert: Binh's fixed_term starts 2026-01-01 + 6 months -> ends 2026-06-30 -> expiring in 10 days <= 30 -> contract_expiring_soon (1)
      const ownerRes = await postLaborCheck('stale-owner', { kind: 'labor_register', period: '2026-06-20', lang: 'vi' });
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.ai).toEqual({ ok: false, reason: 'off' });
      expect(ownerRes.body.summary).toBeNull();
      expect(ownerRes.body.counts).toEqual({
        checked: 4,
        employeesMissingIdentity: 1,
        employeesMissingInsuranceNumber: 1,
        employeesMissingBirthDateOrAddress: 1,
        unwrittenNoneContracts: 1,
        contractAlerts: 1,
      });
      expect(ownerRes.body.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ employeeId: o.chiId, employeeName: CHI_NAME, code: 'MISSING_IDENTITY_NUMBER', fieldOrRule: 'identityNumber' }),
          expect.objectContaining({ employeeId: o.chiId, employeeName: CHI_NAME, code: 'UNWRITTEN_NONE_CONTRACT', fieldOrRule: 'Labor Code 2019 Art. 14' }),
          expect.objectContaining({ employeeId: o.binhId, employeeName: BINH_NAME, code: 'MISSING_INSURANCE_NUMBER', fieldOrRule: 'insuranceNumber' }),
          expect.objectContaining({ employeeId: o.binhId, employeeName: BINH_NAME, code: 'MISSING_BIRTH_DATE', fieldOrRule: 'birthDate' }),
          expect.objectContaining({ employeeId: o.binhId, employeeName: BINH_NAME, code: 'contract_expiring_soon' }),
        ]),
      );

      // 01pli period also succeeds for admin without opening any vault values
      const pliRes = await postLaborCheck(o.admin, { kind: '01pli', period: '2026-H1', lang: 'en' });
      expect(pliRes.status).toBe(200);
      expect(pliRes.body.counts).toEqual({
        checked: 3,
        employeesMissingIdentity: 1,
        employeesMissingInsuranceNumber: 1,
        employeesMissingBirthDateOrAddress: 1,
        unwrittenNoneContracts: 1,
        contractAlerts: 1,
      });

      // Zero sealed values decrypted during laborCheck
      expect(openSpy).not.toHaveBeenCalled();

      // Non-managers and foreign owner refused 403
      for (const who of [o.member, o.viewer, 'other-owner']) {
        expect((await postLaborCheck(who, { kind: 'labor_register', period: '2026-06-20' })).status).toBe(403);
      }

      // Sensitive read + audit rows exist and carry ONLY `{ kind }` / `{ kind, checked }`, never PII
      const auditRows = await withAdmin(
        async (c) =>
          (
            await c.query<{ command: string; detail: string; row: string }>(
              `SELECT command, detail::text AS detail, audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND command IN ('hr.payroll.labor_check.read', 'hr.payroll.labor_check.audit') ORDER BY id`,
              [o.orgId],
            )
          ).rows,
      );
      const reads = auditRows.filter((r) => r.command === 'hr.payroll.labor_check.read');
      const checks = auditRows.filter((r) => r.command === 'hr.payroll.labor_check.audit');
      expect(reads.length).toBeGreaterThanOrEqual(2);
      expect(checks).toHaveLength(2);
      expect(JSON.parse(checks[0]!.detail)).toEqual({ kind: 'labor_register', checked: 4 });
      expect(JSON.parse(checks[1]!.detail)).toEqual({ kind: '01pli', checked: 3 });
      for (const row of auditRows) {
        for (const pii of [AN_NAME, BINH_NAME, CHI_NAME, DUNG_NAME, AN_IDENTITY, BINH_IDENTITY, DUNG_IDENTITY]) expect(row.row).not.toContain(pii);
      }
    } finally {
      openSpy.mockRestore();
    }
  });

  it('distinguishes fixed-term contract renewals from mid-term wage raises across payroll_employment history', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'hrreg', subject: `renew-${tag}`, email: `renew-${tag}@hr.test`, name: null });
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Renewal Test Co ${tag}`);
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });

    // Renewed: 2026-01-01 fixed_term (3m -> ended 2026-03-31), renewed 2026-04-01 fixed_term (12m -> ends 2027-03-31)
    const renewed = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Gia Hạn Canary',
      birthDate: '1992-01-10',
      address: '10 Trần Hưng Đạo, Hà Nội',
      identityNumber: '079200000111',
      insuranceNumber: '7302001000',
      employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '14000000' },
    });
    // Mid-term raise: 2026-01-01 fixed_term (12m -> ends 2026-12-31), wage raise on 2026-04-01 (inside 2026-01-01..2026-12-31)
    const raised = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Trần Tăng Lương Canary',
      birthDate: '1993-02-15',
      address: '20 Lý Thường Kiệt, Hà Nội',
      identityNumber: '079300000222',
      insuranceNumber: '7303002000',
      employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '16000000' },
    });

    setRuleStatus('confirmed');
    try {
      // Approve 2026-02 run: Renewed has 3 months (ends 2026-03-31), Raised has 12 months (ends 2026-12-31)
      const febRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-02' });
      const febBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: febRun.runId });
      const febRenewed = febBefore.lines.find((l) => l.employeeId === renewed.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: febRenewed.id, inputs: { ...febRenewed.inputs, contractTermMonths: 3 } });
      const febRaised = febBefore.lines.find((l) => l.employeeId === raised.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: febRaised.id, inputs: { ...febRaised.inputs, contractTermMonths: 12 } });
      const febAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: febRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: febRun.runId, fingerprint: febAfter.fingerprint, acceptFlags: true }, asMfa(owner));

      // On 2026-04-01: Renewed starts a new 12-month fixed_term (2026-04-01 > 2026-03-31), Raised gets a mid-term wage raise (2026-04-01 <= 2026-12-31)
      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: renewed.employeeId,
        effectiveFrom: '2026-04-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '15500000',
      });
      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: raised.employeeId,
        effectiveFrom: '2026-04-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '18500000',
      });

      // Approve 2026-05 run recording 12 months on Renewed's new employment row (2026-04-01..2027-03-31)
      const mayRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-05' });
      const mayBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      for (const id of [renewed.employeeId, raised.employeeId]) {
        const line = mayBefore.lines.find((l) => l.employeeId === id)!;
        await exec(owner, 'hr.payroll.line.inputs.set', { lineId: line.id, inputs: { ...line.inputs, contractTermMonths: 12 } });
      }
      const mayAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: mayRun.runId, fingerprint: mayAfter.fingerprint, acceptFlags: true }, asMfa(owner));
    } finally {
      setRuleStatus('commentary');
    }

    const doc = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-06-20' }, { actor: asMfa(owner), orgId });
    const rows = doc.sheets[0]?.rows ?? [];
    expect(rows.find((r) => r.name === 'Nguyễn Gia Hạn Canary')).toMatchObject({
      contractStartDate: '2026-04-01',
      contractEndDate: '2027-03-31',
      baseWage: '15500000.00',
    });
    expect(rows.find((r) => r.name === 'Trần Tăng Lương Canary')).toMatchObject({
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      baseWage: '18500000.00',
    });

    const { postLaborCheck } = makeHttp({
      orgId,
      slug,
      owner,
      admin: owner,
      member: owner,
      viewer: owner,
      anId: renewed.employeeId as string,
      binhId: raised.employeeId as string,
      chiId: raised.employeeId as string,
      dungId: null,
      exec,
      query,
    });
    const checkRes = await postLaborCheck(owner, { kind: 'labor_register', period: '2026-06-20', lang: 'vi' }, slug);
    expect(checkRes.status).toBe(200);
    // Renewed is on their 2nd fixed-term contract (`final_fixed_term_renewal`); Raised had only 1 fixed-term contract with a mid-term raise (0 alerts).
    expect(checkRes.body.counts.contractAlerts).toBe(1);
    expect(checkRes.body.findings).toEqual([
      {
        employeeId: renewed.employeeId,
        employeeName: 'Nguyễn Gia Hạn Canary',
        code: 'final_fixed_term_renewal',
        fieldOrRule: 'Labor Code 2019 Art. 20(2)',
      },
    ]);
  });

  it('tracks 3rd fixed-term conversion limit, approved insured=null reset over prior opt-out, and 01/PLI otherRegularPay', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'hrreg', subject: `edge-${tag}`, email: `edge-${tag}@hr.test`, name: null });
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Compliance Edge Co ${tag}`);
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });

    // Three consecutive 3-month fixed-term contracts (2026-01-01, 2026-04-01, 2026-07-01) -> exceeds Art. 20(2) renewal cap (`must_convert_to_indefinite`).
    const threeTimes = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Phạm Ba Lần Canary',
      birthDate: '1991-04-04',
      address: '30 Hai Bà Trưng, Hà Nội',
      identityNumber: '079100400400',
      insuranceNumber: '7304001000',
      employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '15000000' },
    });
    // Indefinite employee with initial `insured: false`, later amended + paid with `insured: null` (default insured = true) and no insuranceNumber.
    const defaultInsured = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Hoàng Mặc Định BHXH Canary',
      birthDate: '1994-05-05',
      address: '40 Điện Biên Phủ, Hà Nội',
      identityNumber: '079400500500',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '18000000' },
    });

    setRuleStatus('confirmed');
    try {
      const janRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-01' });
      const janBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: janRun.runId });
      const janThree = janBefore.lines.find((l) => l.employeeId === threeTimes.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: janThree.id, inputs: { ...janThree.inputs, contractTermMonths: 3 } });
      const janDefault = janBefore.lines.find((l) => l.employeeId === defaultInsured.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: janDefault.id, inputs: { ...janDefault.inputs, insured: false } });
      const janAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: janRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: janRun.runId, fingerprint: janAfter.fingerprint, acceptFlags: true }, asMfa(owner));

      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: threeTimes.employeeId,
        effectiveFrom: '2026-04-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '16000000',
      });
      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: defaultInsured.employeeId,
        effectiveFrom: '2026-04-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '20000000',
      });

      const aprRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-04' });
      const aprBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: aprRun.runId });
      const aprThree = aprBefore.lines.find((l) => l.employeeId === threeTimes.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', {
        lineId: aprThree.id,
        inputs: { ...aprThree.inputs, contractTermMonths: 3 },
      });
      const aprDefault = aprBefore.lines.find((l) => l.employeeId === defaultInsured.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: aprDefault.id, inputs: { ...aprDefault.inputs, insured: null } });
      const aprAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: aprRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: aprRun.runId, fingerprint: aprAfter.fingerprint, acceptFlags: true }, asMfa(owner));

      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: threeTimes.employeeId,
        effectiveFrom: '2026-07-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '17000000',
      });
      const julRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-07' });
      const julBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: julRun.runId });
      const julThree = julBefore.lines.find((l) => l.employeeId === threeTimes.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', {
        lineId: julThree.id,
        inputs: { ...julThree.inputs, contractTermMonths: 12, otherRegularPay: '2000000' },
      });
      const julAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: julRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: julRun.runId, fingerprint: julAfter.fingerprint, acceptFlags: true }, asMfa(owner));
    } finally {
      setRuleStatus('commentary');
    }

    const pliDoc = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: '01pli', period: '2026-H2' }, { actor: asMfa(owner), orgId });
    const pliRows = pliDoc.sheets[1]?.rows ?? [];
    expect(pliRows.find((r) => r.name === 'Phạm Ba Lần Canary')).toMatchObject({
      otherAmounts: '2000000.00',
      contractStartDate: '2026-07-01',
      contractEndDate: '2027-06-30',
    });

    const regDoc = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-07-15' }, { actor: asMfa(owner), orgId });
    const regRows = regDoc.sheets[0]?.rows ?? [];
    expect(regRows.find((r) => r.name === 'Hoàng Mặc Định BHXH Canary')).toMatchObject({
      insured: 'Có',
      baseWage: '20000000.00',
    });

    const { postLaborCheck } = makeHttp({
      orgId,
      slug,
      owner,
      admin: owner,
      member: owner,
      viewer: owner,
      anId: threeTimes.employeeId as string,
      binhId: defaultInsured.employeeId as string,
      chiId: threeTimes.employeeId as string,
      dungId: null,
      exec,
      query,
    });
    const checkRes = await postLaborCheck(owner, { kind: '01pli', period: '2026-H2', lang: 'vi' }, slug);
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.counts).toMatchObject({
      checked: 2,
      employeesMissingInsuranceNumber: 1,
      contractAlerts: 1,
    });
    const expectedFindings = [
      {
        employeeId: threeTimes.employeeId,
        employeeName: 'Phạm Ba Lần Canary',
        code: 'must_convert_to_indefinite',
        fieldOrRule: 'Labor Code 2019 Art. 20(2)',
      },
      {
        employeeId: defaultInsured.employeeId,
        employeeName: 'Hoàng Mặc Định BHXH Canary',
        code: 'MISSING_INSURANCE_NUMBER',
        fieldOrRule: 'insuranceNumber',
      },
    ].sort((a, b) => (a.employeeId as string).localeCompare(b.employeeId as string));
    expect(checkRes.body.findings).toEqual(expectedFindings);

    // Employee whose scheduled 2026-07-01 employment amendment ('none' / 30,000,000) never took effect because they left on 2026-06-15.
    const leftEarly = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Lê Nghỉ Sớm Canary',
      birthDate: '1990-06-10',
      address: '50 Kim Mã, Hà Nội',
      identityNumber: '079500600600',
      insuranceNumber: '7305001001',
      employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '12000000' },
    });
    await exec(owner, 'hr.payroll.employment.add', {
      employeeId: leftEarly.employeeId,
      effectiveFrom: '2026-07-01',
      contractType: 'none',
      region: 'I',
      baseWage: '30000000',
    });
    await exec(owner, 'hr.payroll.employee.end', { employeeId: leftEarly.employeeId, endedOn: '2026-06-15' });

    const annualPliDoc = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: '01pli', period: '2026' }, { actor: asMfa(owner), orgId });
    expect(annualPliDoc.sheets[1]?.rows.find((r) => r.name === 'Lê Nghỉ Sớm Canary')).toMatchObject({
      contractType: 'Xác định thời hạn',
      baseWage: '12000000.00',
      endedOn: '2026-06-15',
    });
    const yearEndRegDoc = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-12-31' }, { actor: asMfa(owner), orgId });
    expect(yearEndRegDoc.sheets[0]?.rows.find((r) => r.name === 'Lê Nghỉ Sớm Canary')).toMatchObject({
      contractType: 'Xác định thời hạn',
      baseWage: '12000000.00',
      endedOn: '2026-06-15',
    });
    const annualCheckRes = await postLaborCheck(owner, { kind: '01pli', period: '2026', lang: 'vi' }, slug);
    expect(annualCheckRes.status).toBe(200);
    expect(annualCheckRes.body.counts.unwrittenNoneContracts).toBe(0);
    expect(annualCheckRes.body.findings.some((f) => f.employeeId === leftEarly.employeeId)).toBe(false);
  });

  it('keeps unverified fixed-term boundaries blank and sequence null across partial payroll history', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'hrreg', subject: `gap-${tag}`, email: `gap-${tag}@hr.test`, name: null });
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Partial History Co ${tag}`);
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });

    // Employee A: fixed_term from 2026-01-01 (no approved payroll), then amendment on 2026-04-01 approved only in 2026-05 (12m term).
    // Without an approved pay line on the 2026-01-01 row, whether 2026-04-01 is a raise or renewal is unknown -> dates stay blank (not 2026-04-01 / 2027-03-31).
    const gapRaise = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Đặng Thiếu Kỳ Đầu Canary',
      birthDate: '1993-03-15',
      address: '12 Nguyễn Du, Hà Nội',
      identityNumber: '079300333300',
      insuranceNumber: '7303003001',
      employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '14000000' },
    });
    // Employee B: three consecutive fixed_term rows (2026-01-01 [unapproved], 2026-04-01 [3m], 2026-07-01 [12m]) -> 2026-07-01 must NOT be under-counted as #2.
    const gapTriple = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Bùi Đứt Đoạn Canary',
      birthDate: '1991-08-20',
      address: '88 Trần Phú, Hà Nội',
      identityNumber: '079100888800',
      insuranceNumber: '7308008002',
      employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '15000000' },
    });

    await exec(owner, 'hr.payroll.employment.add', {
      employeeId: gapRaise.employeeId,
      effectiveFrom: '2026-04-01',
      contractType: 'fixed_term',
      region: 'I',
      baseWage: '16000000',
    });
    await exec(owner, 'hr.payroll.employment.add', {
      employeeId: gapTriple.employeeId,
      effectiveFrom: '2026-04-01',
      contractType: 'fixed_term',
      region: 'I',
      baseWage: '16000000',
    });

    setRuleStatus('confirmed');
    try {
      const mayRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-05' });
      const mayBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      const mayA = mayBefore.lines.find((l) => l.employeeId === gapRaise.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: mayA.id, inputs: { ...mayA.inputs, contractTermMonths: 12 } });
      const mayB = mayBefore.lines.find((l) => l.employeeId === gapTriple.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: mayB.id, inputs: { ...mayB.inputs, contractTermMonths: 3 } });
      const mayAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: mayRun.runId, fingerprint: mayAfter.fingerprint, acceptFlags: true }, asMfa(owner));

      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: gapTriple.employeeId,
        effectiveFrom: '2026-07-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '17000000',
      });
      const julRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-07' });
      const julBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: julRun.runId });
      const julA = julBefore.lines.find((l) => l.employeeId === gapRaise.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: julA.id, inputs: { ...julA.inputs, contractTermMonths: 12 } });
      const julB = julBefore.lines.find((l) => l.employeeId === gapTriple.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: julB.id, inputs: { ...julB.inputs, contractTermMonths: 12 } });
      const julAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: julRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: julRun.runId, fingerprint: julAfter.fingerprint, acceptFlags: true }, asMfa(owner));
    } finally {
      setRuleStatus('commentary');
    }

    const regDoc = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-07-15' }, { actor: asMfa(owner), orgId });
    const regA = (regDoc.sheets[0]?.rows ?? []).find((r) => r.name === 'Đặng Thiếu Kỳ Đầu Canary');
    const regB = (regDoc.sheets[0]?.rows ?? []).find((r) => r.name === 'Bùi Đứt Đoạn Canary');
    expect(regA).toMatchObject({
      contractType: 'Xác định thời hạn',
      contractStartDate: '',
      contractEndDate: '',
      baseWage: '16000000.00',
    });
    expect(regA?.note).toContain('Chưa đủ kỳ lương đã duyệt');
    expect(regB).toMatchObject({
      contractType: 'Xác định thời hạn',
      contractStartDate: '',
      contractEndDate: '',
      baseWage: '17000000.00',
    });
    expect(regB?.note).toContain('Chưa đủ kỳ lương đã duyệt');

    const { postLaborCheck } = makeHttp({
      orgId,
      slug,
      owner,
      admin: owner,
      member: owner,
      viewer: owner,
      anId: gapRaise.employeeId as string,
      binhId: gapTriple.employeeId as string,
      chiId: gapRaise.employeeId as string,
      dungId: null,
      exec,
      query,
    });
    const checkRes = await postLaborCheck(owner, { kind: '01pli', period: '2026-H2', lang: 'vi' }, slug);
    expect(checkRes.status).toBe(200);
    // Neither employee emits final_fixed_term_renewal or contract_expired from fabricated dates; both emit MISSING_CONTRACT_TERM for review.
    expect(checkRes.body.findings).toEqual(
      [
        {
          employeeId: gapRaise.employeeId,
          employeeName: 'Đặng Thiếu Kỳ Đầu Canary',
          code: 'MISSING_CONTRACT_TERM',
          fieldOrRule: 'contractTermMonths',
        },
        {
          employeeId: gapTriple.employeeId,
          employeeName: 'Bùi Đứt Đoạn Canary',
          code: 'MISSING_CONTRACT_TERM',
          fieldOrRule: 'contractTermMonths',
        },
      ].sort((a, b) => (a.employeeId as string).localeCompare(b.employeeId as string)),
    );
  });

  it('preserves prior none-contract insured status across an unbilled none employment amendment', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'hrreg', subject: `noneins-${tag}`, email: `noneins-${tag}@hr.test`, name: null });
    const { orgId, slug } = await createOrg(rt, asUser(owner), `None Insured Co ${tag}`);
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });

    // Stays 'none' across amendment -> preserves approved May pay line's insured: true until a new run sets it otherwise.
    const stayedNone = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Phạm Bảo Lưu BHXH Canary',
      birthDate: '1994-04-12',
      address: '15 Hai Bà Trưng, Hà Nội',
      identityNumber: '079400400401',
      employment: { effectiveFrom: '2026-01-01', contractType: 'none', region: 'I', baseWage: '10000000' },
    });
    // Transitions fixed_term -> none without a new approved pay line -> resets insured to null (not carried over from fixed_term).
    const switchedToNone = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Hoàng Chuyển Sang None Canary',
      birthDate: '1995-06-18',
      address: '25 Phan Chu Trinh, Hà Nội',
      identityNumber: '079500600602',
      employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '11000000' },
    });

    setRuleStatus('confirmed');
    try {
      const mayRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-05' });
      const mayBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      const lineNone = mayBefore.lines.find((l) => l.employeeId === stayedNone.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: lineNone.id, inputs: { ...lineNone.inputs, insured: true } });
      const lineFixed = mayBefore.lines.find((l) => l.employeeId === switchedToNone.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', { lineId: lineFixed.id, inputs: { ...lineFixed.inputs, contractTermMonths: 6 } });
      const mayAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: mayRun.runId, fingerprint: mayAfter.fingerprint, acceptFlags: true }, asMfa(owner));

      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: stayedNone.employeeId,
        effectiveFrom: '2026-07-01',
        contractType: 'none',
        region: 'I',
        baseWage: '12000000',
      });
      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: switchedToNone.employeeId,
        effectiveFrom: '2026-07-01',
        contractType: 'none',
        region: 'I',
        baseWage: '12000000',
      });
    } finally {
      setRuleStatus('commentary');
    }

    const { postLaborCheck } = makeHttp({
      orgId,
      slug,
      owner,
      admin: owner,
      member: owner,
      viewer: owner,
      anId: stayedNone.employeeId as string,
      binhId: switchedToNone.employeeId as string,
      chiId: stayedNone.employeeId as string,
      dungId: null,
      exec,
      query,
    });
    const checkRes = await postLaborCheck(owner, { kind: '01pli', period: '2026-H2', lang: 'vi' }, slug);
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.counts.checked).toBe(2);
    expect(checkRes.body.counts.unwrittenNoneContracts).toBe(2);
    expect(checkRes.body.counts.employeesMissingInsuranceNumber).toBe(1);
    expect(checkRes.body.findings).toContainEqual({
      employeeId: stayedNone.employeeId,
      employeeName: 'Phạm Bảo Lưu BHXH Canary',
      code: 'MISSING_INSURANCE_NUMBER',
      fieldOrRule: 'insuranceNumber',
    });
    expect(checkRes.body.findings).not.toContainEqual(
      expect.objectContaining({ employeeId: switchedToNone.employeeId, code: 'MISSING_INSURANCE_NUMBER' }),
    );
  });

  it('excludes June 20 employment pay metadata when exporting June 10 after June payroll approval', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'hrreg', subject: `histpay-${tag}`, email: `histpay-${tag}@hr.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Hist Pay Meta Co ${tag}`);
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });

    // Employee A: started 2026-05-01 with approved May allowance 500000, then switched to employment B on 2026-06-20 with approved June allowance 3000000 + otherRegularPay 900000.
    const withMayBase = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Trần Có Tháng Trước Canary',
      birthDate: '1991-03-10',
      address: '10 Nguyễn Du, Hà Nội',
      identityNumber: '079100888800',
      insuranceNumber: '7308001000',
      employment: { effectiveFrom: '2026-05-01', contractType: 'fixed_term', region: 'I', baseWage: '12000000' },
    });
    // Employee B: started 2026-06-01 (no May run), then switched on 2026-06-20 with approved June allowance 4000000 + otherRegularPay 800000.
    const juneOnly = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Chỉ Tháng Sáu Canary',
      birthDate: '1992-07-20',
      address: '20 Trần Phú, Hà Nội',
      identityNumber: '079200000111',
      insuranceNumber: '7308002000',
      employment: { effectiveFrom: '2026-06-01', contractType: 'fixed_term', region: 'I', baseWage: '10000000' },
    });

    setRuleStatus('confirmed');
    try {
      const mayRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-05' });
      const mayBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      const mayLine = mayBefore.lines.find((l) => l.employeeId === withMayBase.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', {
        lineId: mayLine.id,
        inputs: {
          ...mayLine.inputs,
          contractTermMonths: 12,
          allowances: [{ label: 'Phụ cấp đi lại', amount: '500000', type: 'other', namedInContract: false }],
          otherRegularPay: '200000',
        },
      });
      const mayAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: mayRun.runId, fingerprint: mayAfter.fingerprint, acceptFlags: true }, asMfa(owner));

      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: withMayBase.employeeId,
        effectiveFrom: '2026-06-20',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '18000000',
      });
      await exec(owner, 'hr.payroll.employment.add', {
        employeeId: juneOnly.employeeId,
        effectiveFrom: '2026-06-20',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '15000000',
      });

      const junRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-06' });
      const junBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: junRun.runId });
      const junLineA = junBefore.lines.find((l) => l.employeeId === withMayBase.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', {
        lineId: junLineA.id,
        inputs: {
          ...junLineA.inputs,
          contractTermMonths: 12,
          allowances: [{ label: 'Phụ cấp chức vụ', amount: '3000000', type: 'other', namedInContract: true }],
          otherRegularPay: '900000',
        },
      });
      const junLineB = junBefore.lines.find((l) => l.employeeId === juneOnly.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', {
        lineId: junLineB.id,
        inputs: {
          ...junLineB.inputs,
          contractTermMonths: 6,
          allowances: [{ label: 'Phụ cấp trách nhiệm', amount: '4000000', type: 'other', namedInContract: true }],
          otherRegularPay: '800000',
        },
      });
      const junAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: junRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: junRun.runId, fingerprint: junAfter.fingerprint, acceptFlags: true }, asMfa(owner));
    } finally {
      setRuleStatus('commentary');
    }

    const june10 = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-06-10' }, { actor: asMfa(owner), orgId });
    const june10Rows = june10.sheets[0]?.rows ?? [];
    expect(june10Rows.find((r) => r.name === 'Trần Có Tháng Trước Canary')).toMatchObject({
      contractStartDate: '2026-05-01',
      contractEndDate: '2027-04-30',
      baseWage: '12000000.00',
    });
    expect(june10Rows.find((r) => r.name === 'Nguyễn Chỉ Tháng Sáu Canary')).toMatchObject({
      contractStartDate: '2026-06-01',
      contractEndDate: '2026-11-30',
      baseWage: '10000000.00',
    });

    const june25 = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-06-25' }, { actor: asMfa(owner), orgId });
    const june25Rows = june25.sheets[0]?.rows ?? [];
    expect(june25Rows.find((r) => r.name === 'Trần Có Tháng Trước Canary')).toMatchObject({
      baseWage: '18000000.00',
    });
    expect(june25Rows.find((r) => r.name === 'Nguyễn Chỉ Tháng Sáu Canary')).toMatchObject({
      contractStartDate: '2026-06-01',
      contractEndDate: '2026-11-30',
      baseWage: '15000000.00',
    });

    const pliBeforeEnd = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: '01pli', period: '2026-H1' }, { actor: asMfa(owner), orgId });
    const pliBeforeRows = pliBeforeEnd.sheets[1]?.rows ?? [];
    expect(pliBeforeRows.find((r) => r.name === 'Trần Có Tháng Trước Canary')).toMatchObject({
      baseWage: '18000000.00',
      allowance: '3000000.00',
      otherAmounts: '900000.00',
    });

    await exec(owner, 'hr.payroll.employee.end', { employeeId: withMayBase.employeeId, endedOn: '2026-06-10' });
    await exec(owner, 'hr.payroll.employee.end', { employeeId: juneOnly.employeeId, endedOn: '2026-06-10' });

    const pliAfterEnd = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: '01pli', period: '2026-H1' }, { actor: asMfa(owner), orgId });
    const pliAfterRows = pliAfterEnd.sheets[1]?.rows ?? [];
    expect(pliAfterRows.find((r) => r.name === 'Trần Có Tháng Trước Canary')).toMatchObject({
      endedOn: '2026-06-10',
      baseWage: '12000000.00',
      allowance: '3000000.00',
      otherAmounts: '900000.00',
    });
    expect(pliAfterRows.find((r) => r.name === 'Nguyễn Chỉ Tháng Sáu Canary')).toMatchObject({
      endedOn: '2026-06-10',
      baseWage: '10000000.00',
      allowance: '4000000.00',
      otherAmounts: '800000.00',
    });
  });

  it('uses Stage 2b-3 contract and probation fields in export and laborCheck without payroll runs', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'hrreg', subject: `stage2b3-${tag}`, email: `stage2b3-${tag}@hr.test`, name: null });
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Stage 2b3 Co ${tag}`);
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });

    const fixedRenewal = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Trần Gia Hạn Cuối Canary',
      birthDate: '1991-01-10',
      address: '10 Lê Lợi, TP.HCM',
      identityNumber: '079191000001',
      insuranceNumber: '7308001001',
      employment: {
        effectiveFrom: '2026-01-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '12000000',
        contractForm: 'written',
        termMonths: 6,
        fixedTermSequence: 2,
      },
    });
    const probEnding = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Sắp Hết Thử Việc Canary',
      birthDate: '1995-04-20',
      address: '20 Đồng Khởi, TP.HCM',
      identityNumber: '079195000002',
      insuranceNumber: '7308001002',
      employment: {
        effectiveFrom: '2026-05-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '10000000',
        contractForm: 'written',
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-06-15',
        probationWage: '8500000',
      },
    });
    const explicitEnd = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Lê Ngày Kết Thúc Riêng Canary',
      birthDate: '1993-08-12',
      address: '30 Pasteur, TP.HCM',
      identityNumber: '079193000003',
      insuranceNumber: '7308001003',
      employment: {
        effectiveFrom: '2026-03-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '11000000',
        contractForm: 'electronic',
        contractEndOn: '2026-06-20',
        fixedTermSequence: 1,
      },
    });

    const regDoc = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-06-10' }, { actor: asMfa(owner), orgId });
    const regRows = regDoc.sheets[0]?.rows ?? [];
    expect(regRows.find((r) => r.name === 'Trần Gia Hạn Cuối Canary')).toMatchObject({
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-06-30',
    });
    expect(regRows.find((r) => r.name === 'Lê Ngày Kết Thúc Riêng Canary')).toMatchObject({
      contractStartDate: '2026-03-01',
      contractEndDate: '2026-06-20',
    });

    const { postLaborCheck } = makeHttp({
      orgId,
      slug,
      owner,
      admin: owner,
      member: owner,
      viewer: owner,
      anId: fixedRenewal.employeeId as string,
      binhId: probEnding.employeeId as string,
      chiId: explicitEnd.employeeId as string,
      dungId: null,
      exec,
      query,
    });
    const checkRes = await postLaborCheck(owner, { kind: 'labor_register', period: '2026-06-10', lang: 'vi' }, slug);
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.counts).toEqual({
      checked: 3,
      employeesMissingIdentity: 0,
      employeesMissingInsuranceNumber: 0,
      employeesMissingBirthDateOrAddress: 0,
      unwrittenNoneContracts: 0,
      contractAlerts: 4,
    });
    expect(checkRes.body.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employeeId: fixedRenewal.employeeId, code: 'contract_expiring_soon' }),
        expect.objectContaining({ employeeId: fixedRenewal.employeeId, code: 'final_fixed_term_renewal' }),
        expect.objectContaining({ employeeId: probEnding.employeeId, code: 'probation_ending_soon' }),
        expect.objectContaining({ employeeId: explicitEnd.employeeId, code: 'contract_expiring_soon' }),
      ]),
    );
    expect(checkRes.body.findings.some((f: { code: string }) => f.code === 'MISSING_CONTRACT_TERM')).toBe(false);
  });

  it('preserves probation across amendments, anchors new fixed-term dates to effectiveFrom, and keeps saved termMonths on mid-term raises', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'hrreg', subject: `amendfix-${tag}`, email: `amendfix-${tag}@hr.test`, name: null });
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Amend Fix Co ${tag}`);
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });

    // 1) Subsequent fixed_term row with its own termMonths (without fixedTermSequence) must anchor contractStartDate to effectiveFrom instead of mixing prev start with new end.
    const nextFixed = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Trần Nối Hợp Đồng Canary',
      birthDate: '1991-01-10',
      address: '10 Lê Lợi, TP.HCM',
      identityNumber: '999191100001',
      insuranceNumber: '9998001001',
      employment: {
        effectiveFrom: '2026-01-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '12000000',
        termMonths: 6,
      },
    });
    await exec(owner, 'hr.payroll.employment.add', {
      employeeId: nextFixed.employeeId,
      effectiveFrom: '2026-04-01',
      contractType: 'fixed_term',
      region: 'I',
      baseWage: '13000000',
      termMonths: 6,
    });

    // 2) Wage amendment on an indefinite contract without probation fields must preserve active probation from the initial row.
    const keepProbation = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Giữ Thử Việc Canary',
      birthDate: '1995-04-20',
      address: '20 Đồng Khởi, TP.HCM',
      identityNumber: '999195100002',
      insuranceNumber: '9998001002',
      employment: {
        effectiveFrom: '2026-05-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '10000000',
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-06-15',
        probationWage: '8500000',
      },
    });
    await exec(owner, 'hr.payroll.employment.add', {
      employeeId: keepProbation.employeeId,
      effectiveFrom: '2026-06-01',
      contractType: 'indefinite',
      region: 'I',
      baseWage: '12000000',
    });

    // 3) Mid-term fixed_term raise with a differing approved pay-line contractTermMonths keeps prev saved (contractTermMonths=6, contractEndDate=2026-06-30).
    const midTermRaise = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Phạm Giữ Kỳ Hạn Canary',
      birthDate: '1993-08-12',
      address: '30 Pasteur, TP.HCM',
      identityNumber: '999193100003',
      insuranceNumber: '9998001003',
      employment: {
        effectiveFrom: '2026-01-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '11000000',
        termMonths: 6,
        fixedTermSequence: 1,
      },
    });
    await exec(owner, 'hr.payroll.employment.add', {
      employeeId: midTermRaise.employeeId,
      effectiveFrom: '2026-04-01',
      contractType: 'fixed_term',
      region: 'I',
      baseWage: '15000000',
    });

    setRuleStatus('confirmed');
    try {
      const mayRun = await exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month: '2026-05' });
      const mayBefore = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      const raiseLine = mayBefore.lines.find((l) => l.employeeId === midTermRaise.employeeId)!;
      await exec(owner, 'hr.payroll.line.inputs.set', {
        lineId: raiseLine.id,
        inputs: { ...raiseLine.inputs, contractTermMonths: 12 },
      });
      const mayAfter = await query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId: mayRun.runId });
      await exec(owner, 'hr.payroll.run.approve', { runId: mayRun.runId, fingerprint: mayAfter.fingerprint, acceptFlags: true }, asMfa(owner));
    } finally {
      setRuleStatus('commentary');
    }

    const juneReg = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-06-10' }, { actor: asMfa(owner), orgId });
    const juneRows = juneReg.sheets[0]?.rows ?? [];
    expect(juneRows.find((r) => r.name === 'Phạm Giữ Kỳ Hạn Canary')).toMatchObject({
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-06-30',
    });

    const septReg = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-09-20' }, { actor: asMfa(owner), orgId });
    const septRows = septReg.sheets[0]?.rows ?? [];
    expect(septRows.find((r) => r.name === 'Trần Nối Hợp Đồng Canary')).toMatchObject({
      contractStartDate: '2026-04-01',
      contractEndDate: '2026-09-30',
    });

    const { postLaborCheck } = makeHttp({
      orgId,
      slug,
      owner,
      admin: owner,
      member: owner,
      viewer: owner,
      anId: nextFixed.employeeId as string,
      binhId: keepProbation.employeeId as string,
      chiId: midTermRaise.employeeId as string,
      dungId: null,
      exec,
      query,
    });
    const juneCheck = await postLaborCheck(owner, { kind: 'labor_register', period: '2026-06-10', lang: 'vi' }, slug);
    expect(juneCheck.status).toBe(200);
    expect(juneCheck.body.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employeeId: keepProbation.employeeId, code: 'probation_ending_soon' }),
        expect.objectContaining({ employeeId: midTermRaise.employeeId, code: 'contract_expiring_soon' }),
      ]),
    );

    const septCheck = await postLaborCheck(owner, { kind: 'labor_register', period: '2026-09-20', lang: 'vi' }, slug);
    expect(septCheck.status).toBe(200);
    expect(septCheck.body.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employeeId: nextFixed.employeeId, code: 'contract_expiring_soon' }),
        expect.objectContaining({ employeeId: nextFixed.employeeId, code: 'final_fixed_term_renewal' }),
      ]),
    );
  });

  it('populates position from department and job_title in labor_register and 01pli, masks erased staff, and adds them to laborCheck forbidden (#3437)', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'hrreg', subject: `deptpos-${tag}`, email: `deptpos-${tag}@hr.test`, name: null });
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Dept Pos Co ${tag}`);
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });

    const { departmentId: salesDept } = await exec<HrDepartmentWritten>(owner, 'hr.department.add', { name: 'Kinh doanh Canary', code: 'KD', payFunction: 'sales' });
    const { departmentId: erasedDept } = await exec<HrDepartmentWritten>(owner, 'hr.department.add', { name: 'Phòng Bí Mật Đã Xóa', code: 'BM', payFunction: 'admin' });

    const both = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Đủ Bộ Phận Canary',
      birthDate: '1991-02-02',
      address: '10 Lê Lợi, TP.HCM',
      identityNumber: '000000000221',
      insuranceNumber: '7309122111',
      departmentId: salesDept,
      jobTitle: 'Trưởng phòng',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '22000000' },
    });
    const titleOnly = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Trần Chỉ Chức Danh Canary',
      birthDate: '1992-03-03',
      address: '20 Đồng Khởi, TP.HCM',
      identityNumber: '000000000222',
      insuranceNumber: '7309233222',
      jobTitle: 'Kế toán viên',
      employment: { effectiveFrom: '2026-02-01', contractType: 'fixed_term', region: 'I', baseWage: '15000000' },
    });
    const deptOnly = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Lê Chỉ Phòng Ban Canary',
      birthDate: '1993-04-04',
      address: '30 Pasteur, TP.HCM',
      identityNumber: '000000000223',
      insuranceNumber: '7309344333',
      departmentId: salesDept,
      employment: { effectiveFrom: '2026-03-01', contractType: 'indefinite', region: 'I', baseWage: '14000000' },
    });
    const erased = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Phạm Bị Xóa Bộ Phận Canary',
      birthDate: '1986-05-05',
      address: '99 Đường Xóa',
      identityNumber: '000000000224',
      insuranceNumber: '7308655444',
      departmentId: erasedDept,
      jobTitle: 'Chức Danh Bí Mật',
      employment: { effectiveFrom: '2015-01-01', contractType: 'indefinite', region: 'I', baseWage: '12000000' },
    });
    await exec(owner, 'hr.payroll.employee.end', { employeeId: erased.employeeId, endedOn: '2016-01-01' });
    await withAdmin((c) =>
      c.query(`UPDATE ludy_hr.payroll_employee SET ended_on = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date WHERE id = $1`, [erased.employeeId]),
    );
    await exec(owner, 'hr.payroll.employee.erase', { employeeId: erased.employeeId }, asMfa(owner));

    const regDoc = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: 'labor_register', period: '2026-06-20' }, { actor: asMfa(owner), orgId });
    const regRows = regDoc.sheets[0]?.rows ?? [];
    expect(regRows.find((r) => r.name === 'Nguyễn Đủ Bộ Phận Canary')?.position).toBe('Trưởng phòng - Kinh doanh Canary');
    expect(regRows.find((r) => r.name === 'Trần Chỉ Chức Danh Canary')?.position).toBe('Kế toán viên');
    expect(regRows.find((r) => r.name === 'Lê Chỉ Phòng Ban Canary')?.position).toBe('Kinh doanh Canary');
    expect(regRows.find((r) => r.name === LABOR_REGISTER_ERASED_PLACEHOLDER)?.position).toBe('');
    expect(JSON.stringify(regDoc)).not.toContain('Phòng Bí Mật Đã Xóa');
    expect(JSON.stringify(regDoc)).not.toContain('Chức Danh Bí Mật');

    const pliDoc = await rt.query<HrDeclarationDocument>('hr.payroll.declaration.get', { kind: '01pli', period: '2026-H1' }, { actor: asMfa(owner), orgId });
    const pliRows = pliDoc.sheets[1]?.rows ?? [];
    expect(pliRows.find((r) => r.name === 'Nguyễn Đủ Bộ Phận Canary')?.position).toBe('Trưởng phòng - Kinh doanh Canary');
    expect(pliRows.find((r) => r.name === 'Trần Chỉ Chức Danh Canary')?.position).toBe('Kế toán viên');
    expect(pliRows.find((r) => r.name === 'Lê Chỉ Phòng Ban Canary')?.position).toBe('Kinh doanh Canary');

    const checkSnap = await rt.query<HrLaborCheckSnapshot>('hr.payroll.labor_check.read', { kind: 'labor_register', period: '2026-06-20' }, { actor: asUser(owner), orgId });
    expect(checkSnap.forbidden).toContain('Kinh doanh Canary');
    expect(checkSnap.forbidden).toContain('Trưởng phòng');
    expect(checkSnap.forbidden).toContain('Kế toán viên');
    expect(checkSnap.forbidden).not.toContain('Phòng Bí Mật Đã Xóa');
    expect(checkSnap.forbidden).not.toContain('Chức Danh Bí Mật');

    const { postLaborCheck } = makeHttp({
      orgId,
      slug,
      owner,
      admin: owner,
      member: owner,
      viewer: owner,
      anId: both.employeeId as string,
      binhId: titleOnly.employeeId as string,
      chiId: deptOnly.employeeId as string,
      dungId: erased.employeeId as string,
      exec,
      query,
    });
    const checkHttp = await postLaborCheck(owner, { kind: 'labor_register', period: '2026-06-20', lang: 'vi' }, slug);
    expect(checkHttp.status).toBe(200);
    expect(checkHttp.body.counts.checked).toBe(4);
  });
});
