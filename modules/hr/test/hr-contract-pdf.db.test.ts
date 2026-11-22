// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelManifest, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  HrCandidateHireResult,
  HrCandidateWritten,
  HrEmployeeContractPdf,
  HrOpeningWritten,
  HrWritten,
} from '@ludy/kernel-contract';
import { CredentialVault, DomainError, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { hrCommands, hrManifest, hrQueries } from '../src/index.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

type PoolHandle = ReturnType<typeof createPool>;

suite('hr.employee.contract_pdf sensitive query (#3548)', () => {
  const dbName = `crove_test_hr_cpdf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: PoolHandle;
  let appPool: PoolHandle;
  let rt: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function setupOrg(namePrefix: string) {
    const tag = randomUUID().slice(0, 8);
    const person = (role: string) =>
      upsertIdentity(createDb(appPool), {
        issuer: 'hr-contract-pdf',
        subject: `${role}-${tag}`,
        email: `${role}-${tag}@hr.test`,
        name: null,
      });
    const owner = await person('owner');
    const admin = await person('admin');
    const chiefAccountant = await person('chief');
    const viewer = await person('viewer');
    const created = await createOrg(rt, asUser(owner), `${namePrefix} ${tag}`);
    const orgId = created.orgId;
    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
      [orgId, admin, chiefAccountant, viewer],
    );
    // Assign Kế toán trưởng (finance.chief_accountant) to the member to prove HR contract PDF still answers 403 FORBIDDEN.
    await adminPool.query(
      `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, granted_by)
       VALUES ($1, $2, 'finance.chief_accountant', $3)`,
      [orgId, chiefAccountant, owner],
    );
    await adminPool.query(
      `UPDATE ludy_kernel.tenant SET tax_code = '0100000000', address = '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh' WHERE org_id = $1`,
      [orgId],
    );

    const exec = <O>(userId: string, name: string, input: unknown, actor: Parameters<Runtime['execute']>[2]['actor'] = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}, actor: Parameters<Runtime['query']>[2]['actor'] = asUser(userId)) =>
      rt.query<O>(name, input, { actor, orgId });

    return { orgId, owner, admin, chiefAccountant, viewer, exec, query };
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1, resetOnRelease: false });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    adminPool = createPool({ connectionString: adminUrl, max: 2, resetOnRelease: false });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    appPool = createPool({ connectionString: appUrl.toString(), max: 4 });

    rt = new Runtime(createDb(appPool), {
      manifests: [kernelManifest.tables, hrManifest.tables],
      subjectVault: new SubjectVault(new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO)),
      readAuditKey: randomBytes(32),
    }).register({
      commands: [...kernelCommands, ...hrCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries],
    });
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = createPool({ connectionString: ADMIN, max: 1, resetOnRelease: false });
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('allows owner and admin to generate valid contract PDFs, records sensitive-read audit with zero PII/wages, and resolves hired candidate email', async () => {
    const o = await setupOrg('Ánh Dương');
    const dept = await o.exec<{ departmentId: string }>(o.owner, 'hr.department.add', {
      name: 'Phòng Kế toán',
      code: 'KT',
      payFunction: 'admin',
    });
    const added = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Thị Hằng Canary',
      departmentId: dept.departmentId,
      jobTitle: 'Kế toán viên',
      birthDate: '1995-04-12',
      address: '88 Lê Lợi, Quận 1',
      identityNumber: '001090000000',
      employment: {
        effectiveFrom: '2026-01-01',
        contractType: 'fixed_term',
        contractForm: 'written',
        termMonths: 12,
        fixedTermSequence: 1,
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-03-01',
        probationWage: '15300000',
        region: 'I',
        baseWage: '18000000',
      },
    });
    const employeeId = added.employeeId as string;
    const termsId = added.employmentId as string;

    const ownerPdf = await o.query<HrEmployeeContractPdf>(o.owner, 'hr.employee.contract_pdf', { employeeId, termsId });
    expect(ownerPdf.contentType).toBe('application/pdf');
    expect(ownerPdf.filename).toBe('hop-dong-lao-dong-nguyen-thi-hang-canary-2026-01-01.pdf');
    expect(ownerPdf.title).toBe('Hợp đồng lao động - Nguyễn Thị Hằng Canary (2026-01-01)');
    expect(ownerPdf.employeeName).toBe('Nguyễn Thị Hằng Canary');
    expect(ownerPdf.employeeEmail).toBeNull();
    expect(ownerPdf.contractNumber).toMatch(/^HDLD-20260101-[0-9A-F]{6}$/);

    const pdfBytes = Buffer.from(ownerPdf.pdfBase64, 'base64');
    expect(pdfBytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
    expect(pdfBytes.toString('latin1').endsWith('%%EOF\n')).toBe(true);

    const adminPdf = await o.query<HrEmployeeContractPdf>(o.admin, 'hr.employee.contract_pdf', { employeeId, termsId });
    expect(adminPdf.pdfBase64).toBe(ownerPdf.pdfBase64);

    // Check audit_event rows: two sensitive reads committed, zero PII or wages in audit rows.
    const auditRes = await adminPool.query<{ target_type: string; target_id: string; row_text: string }>(
      `SELECT target_type, target_id, audit_event::text AS row_text
       FROM ludy_kernel.audit_event
       WHERE org_id = $1 AND command = 'hr.employee.contract_pdf'
       ORDER BY id`,
      [o.orgId],
    );
    expect(auditRes.rows).toHaveLength(2);
    for (const row of auditRes.rows) {
      expect(row.target_type).toBe('hr.payroll_employee');
      expect(row.target_id).toBe(employeeId);
      expect(row.row_text).not.toContain('Nguyễn Thị Hằng Canary');
      expect(row.row_text).not.toContain('18000000');
      expect(row.row_text).not.toContain('15300000');
      expect(row.row_text).not.toContain('001090000000');
    }

    // Hired candidate populates employeeEmail automatically for #3549 eSign handoff.
    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      title: 'Chuyên viên Nhân sự',
      contractType: 'indefinite',
      region: 'I',
      payFunction: 'admin',
    });
    const cand = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Trần Minh Khôi',
      email: 'khoi.tran@example.com',
      agreedWage: '20000000',
      plannedStartOn: '2026-05-01',
    });
    await o.exec(o.owner, 'hr.recruiting.candidate.move_stage', { candidateId: cand.candidateId, toStage: 'screening' });
    await o.exec(o.owner, 'hr.recruiting.candidate.move_stage', { candidateId: cand.candidateId, toStage: 'interview' });
    await o.exec(o.owner, 'hr.recruiting.candidate.move_stage', { candidateId: cand.candidateId, toStage: 'offer' });
    const hired = await o.exec<HrCandidateHireResult>(o.owner, 'hr.recruiting.candidate.hire', {
      candidateId: cand.candidateId,
    });
    const hiredPdf = await o.query<HrEmployeeContractPdf>(o.owner, 'hr.employee.contract_pdf', {
      employeeId: hired.employeeId,
      termsId: hired.employmentId,
    });
    expect(hiredPdf.employeeEmail).toBe('khoi.tran@example.com');

    // Short (< 3 months / 'none') contract emits proportional 10% PIT clause rather than progressive brackets.
    const shortEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Đỗ Văn Ngắn Hạn',
      employment: {
        effectiveFrom: '2026-06-01',
        contractType: 'none',
        contractForm: 'electronic',
        contractEndOn: '2026-06-20',
        region: 'I',
        baseWage: '8000000',
      },
    });
    const shortPdf = await o.query<HrEmployeeContractPdf>(o.owner, 'hr.employee.contract_pdf', {
      employeeId: shortEmp.employeeId,
      termsId: shortEmp.employmentId,
    });
    const decodePdfUnicode = (b64: string): string => {
      const raw = Buffer.from(b64, 'base64').toString('latin1');
      const objs = new Map<number, { dict: string; stream: Buffer | null }>();
      for (const m of raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj\n/g)) {
        const sm = /^([\s\S]*?)\nstream\n([\s\S]*)\nendstream$/.exec(m[2] ?? '');
        objs.set(Number(m[1]), sm ? { dict: sm[1] ?? '', stream: inflateSync(Buffer.from(sm[2] ?? '', 'latin1')) } : { dict: m[2] ?? '', stream: null });
      }
      const pagesDict = objs.get(2)?.dict ?? '';
      const fmaps = new Map<string, Map<number, string>>();
      for (const fm of pagesDict.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
        const fd = objs.get(Number(fm[2]))?.dict ?? '';
        const tu = Number(/\/ToUnicode (\d+) 0 R/.exec(fd)?.[1] ?? 0);
        const cmap = objs.get(tu)?.stream?.toString('latin1') ?? '';
        const gm = new Map<number, string>();
        for (const r of cmap.matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]+)>/g)) {
          const units: number[] = [];
          const hx = r[2] ?? '';
          for (let i = 0; i < hx.length; i += 4) units.push(Number.parseInt(hx.slice(i, i + 4), 16));
          gm.set(Number.parseInt(r[1] ?? '0', 16), String.fromCharCode(...units));
        }
        fmaps.set(fm[1] ?? '', gm);
      }
      const kids = /\/Kids \[([^\]]+)\]/.exec(pagesDict)?.[1] ?? '';
      const out: string[] = [];
      for (const pm of kids.matchAll(/(\d+) 0 R/g)) {
        const cid = Number(/\/Contents (\d+) 0 R/.exec(objs.get(Number(pm[1]))?.dict ?? '')?.[1] ?? 0);
        const cs = objs.get(cid)?.stream?.toString('latin1') ?? '';
        const lines: Array<{ y: string; t: string }> = [];
        for (const tj of cs.matchAll(/\/(F\d+) [\d.]+ Tf [\d.]+ ([\d.]+) Td <([0-9a-fA-F]+)> Tj/g)) {
          const gm = fmaps.get(tj[1] ?? '');
          let dec = '';
          const hx = tj[3] ?? '';
          for (let i = 0; i < hx.length; i += 4) dec += gm?.get(Number.parseInt(hx.slice(i, i + 4), 16)) ?? '?';
          const prev = lines.at(-1);
          if (prev && prev.y === tj[2]) prev.t += dec;
          else lines.push({ y: tj[2] ?? '', t: dec });
        }
        out.push(lines.map((l) => l.t).join(' '));
      }
      return out.join(' ');
    };
    expect(decodePdfUnicode(ownerPdf.pdfBase64)).toContain('biểu thuế lũy tiến từng phần');
    expect(decodePdfUnicode(shortPdf.pdfBase64)).toContain('khấu trừ thuế TNCN theo tỷ lệ toàn phần (10%');
  });

  it('enforces 403 FORBIDDEN for Kế toán trưởng (member) and viewer, 404 on mismatched/cross-org IDs, and 409 on erased employees', async () => {
    const orgA = await setupOrg('Org A');
    const orgB = await setupOrg('Org B');

    const emp1 = await orgA.exec<HrWritten>(orgA.owner, 'hr.payroll.employee.add', {
      displayName: 'Lê Văn Một',
      employment: { effectiveFrom: '2015-01-01', contractType: 'indefinite', region: 'I', baseWage: '12000000' },
    });
    const emp2 = await orgA.exec<HrWritten>(orgA.owner, 'hr.payroll.employee.add', {
      displayName: 'Phạm Thị Hai',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '14000000' },
    });

    // Member holding Kế toán trưởng and viewer receive 403 FORBIDDEN and write zero audit_event rows.
    await expect(
      orgA.query(orgA.chiefAccountant, 'hr.employee.contract_pdf', {
        employeeId: emp2.employeeId,
        termsId: emp2.employmentId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      orgA.query(orgA.viewer, 'hr.employee.contract_pdf', {
        employeeId: emp2.employeeId,
        termsId: emp2.employmentId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const forbiddenAudits = await adminPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'hr.employee.contract_pdf'`,
      [orgA.orgId],
    );
    expect(Number(forbiddenAudits.rows[0]?.n)).toBe(0);

    // Mismatched employeeId + termsId in same org -> 404.
    await expect(
      orgA.query(orgA.owner, 'hr.employee.contract_pdf', {
        employeeId: emp1.employeeId,
        termsId: emp2.employmentId,
      }),
    ).rejects.toMatchObject({ code: 'HR_EMPLOYEE_NOT_FOUND', status: 404 });

    // Cross-org access -> 404.
    await expect(
      orgB.query(orgB.owner, 'hr.employee.contract_pdf', {
        employeeId: emp2.employeeId,
        termsId: emp2.employmentId,
      }),
    ).rejects.toMatchObject({ code: 'HR_EMPLOYEE_NOT_FOUND', status: 404 });

    // PDPL-erased employee refuses contract PDF generation with 409 HR_EMPLOYEE_ERASED.
    await orgA.exec(orgA.owner, 'hr.payroll.employee.end', {
      employeeId: emp1.employeeId,
      endedOn: '2015-06-30',
    });
    await orgA.exec(orgA.owner, 'hr.payroll.employee.erase', { employeeId: emp1.employeeId }, asMfa(orgA.owner));

    let erasedErr: unknown;
    try {
      await orgA.query(orgA.owner, 'hr.employee.contract_pdf', {
        employeeId: emp1.employeeId,
        termsId: emp1.employmentId,
      });
    } catch (error) {
      erasedErr = error;
    }
    expect(erasedErr).toBeInstanceOf(DomainError);
    expect(erasedErr).toMatchObject({ code: 'HR_EMPLOYEE_ERASED', status: 409 });
  });
});
