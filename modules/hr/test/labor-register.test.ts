// SPDX-License-Identifier: AGPL-3.0-only
import { HR_DECLARATION_MAX_PEOPLE } from '@ludy/kernel-contract';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  DECLARATION_NOT_SENT,
  DECLARATION_NOTICE,
  LABOR_REGISTER_ERASED_PLACEHOLDER,
  LABOR_REGISTER_LAYOUTS,
  build01PliReport,
  buildDeclarationWorkbook,
  buildLaborRegister,
  type DeclarationEmployer,
  type LaborRegisterPerson,
} from '../src/index.ts';
import { declarationGet, laborCheckRead } from '../src/declaration-export.ts';

const employer: DeclarationEmployer = {
  name: 'Công ty TNHH Thử Nghiệm SME',
  taxCode: '0100000000',
  address: 'Quận 1, TP. Hồ Chí Minh',
};

const samplePerson = (id: string, name: string, over: Partial<LaborRegisterPerson> = {}): LaborRegisterPerson => ({
  employeeId: id,
  name,
  gender: 'female',
  birthDate: '1992-05-10',
  nationality: 'Việt Nam',
  address: 'Hà Nội',
  identityNumber: `00109200000${id}`,
  taxCode: `800000000${id}`,
  insuranceNumber: `012345678${id}`,
  qualification: 'Đại học',
  position: 'Kế toán viên',
  workerGroup: 'high_technical',
  contractKind: 'indefinite',
  contractStartDate: '2025-01-01',
  contractEndDate: null,
  startedOn: '2025-01-01',
  endedOn: null,
  baseWage: '15000000',
  allowance: '1000000',
  otherAmounts: '0',
  insured: true,
  insuranceStartMonth: '2025-01',
  insuranceEndMonth: null,
  note: '',
  ...over,
});

describe('Sổ quản lý lao động (buildLaborRegister)', () => {
  it('carries notice, layout ludy-hr-labor-register/1, draft banner for row 17 (#2535), and deterministic Vietnamese sorting', () => {
    const doc = buildLaborRegister({
      employer,
      asOf: '2026-08-15',
      persons: [
        samplePerson('2', 'Trần Bình', { startedOn: '2023-05-01', contractStartDate: '2025-05-01' }),
        samplePerson('1', 'Nguyễn An', { contractKind: 'fixed_term', contractEndDate: '2027-01-01', baseWage: '12500000' }),
      ],
    });

    expect(doc.notice).toBe(DECLARATION_NOTICE);
    expect(doc.notSent).toBe(DECLARATION_NOT_SENT);
    expect(doc.layout).toEqual(LABOR_REGISTER_LAYOUTS.labor_register);
    expect(doc.layout.version).toBe('ludy-hr-labor-register/1');
    expect(doc.draft).toContain('BẢN NHÁP: dòng 17');
    expect(doc.draft).toContain('#2535');

    const rows = doc.sheets[0]?.rows ?? [];
    expect(rows.map((r) => [r.seq, r.name, r.startedOn, r.contractType, r.contractStartDate, r.baseWage])).toEqual([
      ['1', 'Nguyễn An', '2025-01-01', 'Xác định thời hạn', '2025-01-01', '12500000.00'],
      ['2', 'Trần Bình', '2023-05-01', 'Không xác định thời hạn', '2025-05-01', '15000000.00'],
    ]);
  });

  it('masks erased staff with [Đã xóa theo yêu cầu], blanks personal fields, and sorts by masked label', () => {
    const doc = buildLaborRegister({
      employer,
      persons: [
        samplePerson('b', 'Bình'),
        samplePerson('a', 'Ánh', {
          erased: true,
          endedOn: '2026-01-15',
          contractKind: 'fixed_term',
          contractEndDate: '2026-01-15',
          baseWage: '18000000',
          note: 'Lý do riêng tư',
        }),
      ],
    });

    const rows = doc.sheets[0]?.rows ?? [];
    // '[' sorts before 'B' in Vietnamese locale, avoiding alphabetical leak of original name 'Ánh'.
    expect(rows[0]).toMatchObject({
      seq: '1',
      name: LABOR_REGISTER_ERASED_PLACEHOLDER,
      gender: '',
      birthDate: '',
      nationality: '',
      address: '',
      identityNumber: '',
      taxCode: '',
      insuranceNumber: '',
      qualification: '',
      position: '',
      note: '',
      contractType: 'Xác định thời hạn',
      baseWage: '18000000.00',
      endedOn: '2026-01-15',
    });
    expect(rows[1]?.name).toBe('Bình');
    expect(doc.notes.join(' ')).toContain('1 hồ sơ đã xóa theo yêu cầu');
  });
});

describe('Báo cáo 01/PLI (build01PliReport)', () => {
  it('computes H1 headcount reconciliation, filters out-of-period staff, targets Sở Nội vụ, and masks erased rows', () => {
    const persons: LaborRegisterPerson[] = [
      // Active at start and end of 2026-H1.
      samplePerson('1', 'An', { gender: 'male', startedOn: '2025-03-01', contractKind: 'indefinite' }),
      // Hired during H1 and active at end of H1.
      samplePerson('2', 'Bình', { gender: 'female', startedOn: '2026-02-01', contractKind: 'fixed_term', contractEndDate: '2027-01-31' }),
      // Hired AND left within H1.
      samplePerson('3', 'Chi', { gender: 'female', startedOn: '2026-03-01', endedOn: '2026-04-30', contractKind: 'under_one_month', contractEndDate: '2026-04-20', insured: false }),
      // Started before H1, erased and left on last day of H1 (2026-06-30).
      samplePerson('4', 'Dũng', { erased: true, startedOn: '2024-01-01', endedOn: '2026-06-30', contractKind: 'fixed_term', contractEndDate: '2026-06-30' }),
      // Left before 2026-H1 -> excluded from H1.
      samplePerson('5', 'Em', { startedOn: '2024-01-01', endedOn: '2025-12-31' }),
      // Starts in 2026-H2 -> excluded from H1.
      samplePerson('6', 'Giang', { startedOn: '2026-07-01' }),
    ];

    const doc = build01PliReport({ period: '2026-H1', employer, persons });
    expect(doc.layout).toEqual(LABOR_REGISTER_LAYOUTS['01pli']);
    expect(doc.layout.version).toBe('ludy-hr-01pli/1');
    expect(doc.draft).toContain('BẢN NHÁP: dòng 17');
    expect(doc.header.find((h) => h.label === 'Cơ quan nhận')?.value).toBe('Sở Nội vụ');

    const [summary, detail] = doc.sheets;
    const metric = (prefix: string) => summary?.rows.find((r) => r.item?.startsWith(prefix))?.value;
    expect(metric('Tổng số lao động sử dụng trong kỳ')).toBe('4');
    expect(metric('Số lao động đầu kỳ')).toBe('2'); // An, Dũng
    expect(metric('Số lao động tăng mới trong kỳ')).toBe('2'); // Bình, Chi
    expect(metric('Số lao động giảm trong kỳ')).toBe('2'); // Chi, Dũng
    expect(metric('Số lao động cuối kỳ')).toBe('2'); // An, Bình (2 + 2 - 2 = 2)
    expect(metric('Cuối kỳ: Hợp đồng không xác định thời hạn')).toBe('1');
    expect(metric('Cuối kỳ: Hợp đồng xác định thời hạn')).toBe('1');
    expect(metric('Cuối kỳ: Hợp đồng dưới 1 tháng')).toBe('0');
    expect(metric('Cuối kỳ: Lao động nữ')).toBe('1');
    expect(metric('Cuối kỳ: Tham gia BHXH bắt buộc')).toBe('2');

    const detailRows = detail?.rows ?? [];
    expect(detailRows).toHaveLength(4);
    expect(detailRows[0]).toMatchObject({ name: LABOR_REGISTER_ERASED_PLACEHOLDER, identityNumber: '', insuranceNumber: '', endedOn: '2026-06-30' });
    expect(detailRows.map((r) => r.name)).toEqual([LABOR_REGISTER_ERASED_PLACEHOLDER, 'An', 'Bình', 'Chi']);
  });

  it('treats empty endedOn string identically to null and orders erased staff by employeeId without female/name leak', () => {
    const doc = build01PliReport({
      period: '2026-H1',
      employer,
      persons: [
        samplePerson('1', 'An', { gender: 'male', startedOn: '2025-01-01', endedOn: '' }),
        samplePerson('e2', 'Zoe Erased', { erased: true, gender: 'female', startedOn: '2025-01-01', endedOn: '' }),
        samplePerson('e1', 'Anh Erased', { erased: true, gender: 'female', startedOn: '2025-01-01', endedOn: null }),
      ],
    });
    const [summary, detail] = doc.sheets;
    const metric = (prefix: string) => summary?.rows.find((r) => r.item?.startsWith(prefix))?.value;
    expect(metric('Tổng số lao động sử dụng trong kỳ')).toBe('3');
    expect(metric('Số lao động đầu kỳ')).toBe('3');
    expect(metric('Số lao động giảm trong kỳ')).toBe('0');
    expect(metric('Số lao động cuối kỳ')).toBe('3');
    expect(metric('Cuối kỳ: Lao động nữ')).toBe('0');

    // Both erased rows share placeholder name and tie-break by employeeId (`e1` before `e2`) rather than Zoe vs Anh.
    expect(detail?.rows.map((r) => [r.name, r.gender])).toEqual([
      [LABOR_REGISTER_ERASED_PLACEHOLDER, ''],
      [LABOR_REGISTER_ERASED_PLACEHOLDER, ''],
      ['An', 'Nam'],
    ]);

    const unknownGenderDoc = build01PliReport({
      period: '2026-H1',
      employer,
      persons: [samplePerson('1', 'An', { gender: null, startedOn: '2025-01-01' })],
    });
    const unknownGenderSummary = new Map((unknownGenderDoc.sheets[0]?.rows ?? []).map((r) => [r.item, r.value]));
    expect(unknownGenderSummary.get('Cuối kỳ: Lao động nữ (không gồm hồ sơ đã xóa)')).toBe('Chưa có dữ liệu');
    expect(unknownGenderDoc.notes.join(' ')).toContain('Chưa đủ dữ liệu giới tính');
  });

  it('supports full-year YYYY 01/PLI reports capturing H1 exits alongside H2 hires', () => {
    const annual = build01PliReport({
      period: '2026',
      employer,
      persons: [
        samplePerson('1', 'An', { startedOn: '2025-03-01' }),
        samplePerson('2', 'Bình', { startedOn: '2026-02-01', endedOn: '2026-04-30' }),
        samplePerson('3', 'Chi', { startedOn: '2026-08-01' }),
        samplePerson('4', 'Em', { startedOn: '2024-01-01', endedOn: '2025-12-31' }),
      ],
    });
    const [summary, detail] = annual.sheets;
    const metric = (prefix: string) => summary?.rows.find((r) => r.item?.startsWith(prefix))?.value;
    expect(annual.header.find((h) => h.label === 'Kỳ báo cáo')?.value).toBe('2026 (2026-01-01 đến 2026-12-31)');
    expect(metric('Tổng số lao động sử dụng trong kỳ')).toBe('3');
    expect(metric('Số lao động đầu kỳ')).toBe('1');
    expect(metric('Số lao động tăng mới trong kỳ')).toBe('2');
    expect(metric('Số lao động giảm trong kỳ')).toBe('1');
    expect(metric('Số lao động cuối kỳ')).toBe('2');
    expect(detail?.rows.map((r) => r.name)).toEqual(['An', 'Bình', 'Chi']);
  });

  it('rejects invalid semiannual periods and invalid calendar dates', () => {
    expect(() => build01PliReport({ period: '2026-H3', employer, persons: [] })).toThrow(/01\/PLI/);
    expect(() => build01PliReport({ period: '2026-Q1', employer, persons: [] })).toThrow(/01\/PLI/);
    expect(() =>
      buildLaborRegister({ employer, asOf: '2026-02-30', persons: [] }),
    ).toThrow(/không hợp lệ/);
  });

  it('allows missing contractStartDate when contractKind is none, while still requiring it for signed contracts', () => {
    const noContractRegister = buildLaborRegister({
      employer,
      persons: [
        samplePerson('1', 'An', {
          contractKind: 'none',
          contractStartDate: null,
          startedOn: '2026-08-01',
        }),
        {
          employeeId: '2',
          name: 'Bình',
          contractKind: 'none',
          startedOn: '2026-08-05',
        },
      ],
    });
    expect(noContractRegister.sheets[0]?.rows.map((r) => [r.startedOn, r.contractType, r.contractStartDate])).toEqual([
      ['2026-08-01', 'Không ký HĐLĐ', ''],
      ['2026-08-05', 'Không ký HĐLĐ', ''],
    ]);

    const noContractPli = build01PliReport({
      period: '2026-H2',
      employer,
      persons: [
        samplePerson('1', 'An', {
          contractKind: 'none',
          contractStartDate: null,
          startedOn: '2026-08-01',
        }),
      ],
    });
    expect(noContractPli.sheets[1]?.rows[0]).toMatchObject({
      contractType: 'Không ký HĐLĐ',
      contractStartDate: '',
    });

    expect(() =>
      buildLaborRegister({
        employer,
        persons: [samplePerson('3', 'Chi', { contractKind: 'fixed_term', contractStartDate: null })],
      }),
    ).toThrow(/contractStartDate/);

    const uncertainContractDoc = buildLaborRegister({
      employer,
      asOf: '2026-06-30',
      persons: [
        samplePerson('4', 'Dương', {
          contractKind: 'fixed_term',
          contractStartDate: null,
          contractDateUncertain: true,
          contractEndDate: null,
          note: 'Chưa đủ kỳ lương đã duyệt để xác định ngày hợp đồng.',
        }),
      ],
    });
    expect(uncertainContractDoc.sheets[0]?.rows[0]).toMatchObject({
      contractType: 'Xác định thời hạn',
      contractStartDate: '',
      contractEndDate: '',
      note: 'Chưa đủ kỳ lương đã duyệt để xác định ngày hợp đồng.',
    });
  });

  it('keeps known female count on 01/PLI when another active worker has gender other, and only flags null/missing gender', () => {
    const knownOtherDoc = build01PliReport({
      period: '2026-H1',
      employer,
      persons: [
        samplePerson('1', 'Nguyễn Nữ', { gender: 'female', startedOn: '2026-01-01', contractStartDate: '2026-01-01' }),
        samplePerson('2', 'Trần Nam', { gender: 'male', startedOn: '2026-01-01', contractStartDate: '2026-01-01' }),
        samplePerson('3', 'Lê Khác', { gender: 'other', startedOn: '2026-01-01', contractStartDate: '2026-01-01' }),
      ],
    });
    const knownSummary = new Map((knownOtherDoc.sheets[0]?.rows ?? []).map((r) => [r.item, r.value]));
    expect(knownSummary.get('Cuối kỳ: Lao động nữ (không gồm hồ sơ đã xóa)')).toBe('1');
    expect(knownOtherDoc.notes.join(' ')).not.toContain('Chưa đủ dữ liệu giới tính');

    const missingGenderDoc = build01PliReport({
      period: '2026-H1',
      employer,
      persons: [
        samplePerson('1', 'Nguyễn Nữ', { gender: 'female', startedOn: '2026-01-01', contractStartDate: '2026-01-01' }),
        samplePerson('2', 'Phạm Thiếu Giới Tính', { gender: null, startedOn: '2026-01-01', contractStartDate: '2026-01-01' }),
      ],
    });
    const missingSummary = new Map((missingGenderDoc.sheets[0]?.rows ?? []).map((r) => [r.item, r.value]));
    expect(missingSummary.get('Cuối kỳ: Lao động nữ (không gồm hồ sơ đã xóa)')).toBe('Chưa có dữ liệu');
    expect(missingGenderDoc.notes.join(' ')).toContain('Chưa đủ dữ liệu giới tính');
  });
});

describe('HR_DECLARATION_MAX_PEOPLE cap & ExcelJS workbook output', () => {
  it('refuses more than HR_DECLARATION_MAX_PEOPLE with DomainError rather than truncating silently', () => {
    const tooMany = Array.from({ length: HR_DECLARATION_MAX_PEOPLE + 1 }, (_, i) =>
      samplePerson(String(i + 1), `Người ${i + 1}`),
    );
    expect(() => buildLaborRegister({ employer, persons: tooMany })).toThrow(/5000/);
    expect(() => build01PliReport({ period: '2026-H2', employer, persons: tooMany })).toThrow(/5000/);
  });

  it('generates a valid .xlsx workbook via buildDeclarationWorkbook with formula-injection safety', async () => {
    const injections = ['=HYPERLINK("http://example.test","x")', '+84901234567', '-ABC', '@SUM(A1)', '\t=1+1'];
    const doc = build01PliReport({
      period: '2026-H2',
      employer: { name: injections[0] as string, taxCode: '0100000000', address: injections[4] as string },
      persons: [
        samplePerson('1', injections[1] as string, {
          startedOn: '2026-07-01',
          contractStartDate: '2026-07-01',
          position: injections[2] as string,
          identityNumber: injections[3] as string,
          baseWage: '15000000',
        }),
        samplePerson('2', 'Đã xóa', {
          erased: true,
          startedOn: '2026-08-01',
          contractStartDate: '2026-08-01',
        }),
      ],
    });

    const bytes = await buildDeclarationWorkbook(doc, 'Ludy');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(['Tổng hợp 01-PLI', 'Chi tiết 01-PLI']);
    const flatText: string[] = [];
    for (const sheet of workbook.worksheets) {
      expect(String(sheet.getRow(1).getCell(1).value)).toBe('BẢNG KÊ ĐỂ KHAI BÁO');
      expect(String(sheet.getRow(3).getCell(1).value)).toContain(LABOR_REGISTER_LAYOUTS['01pli'].version);
      expect(String(sheet.getRow(4).getCell(1).value)).toContain('BẢN NHÁP: dòng 17');
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          expect(cell.formula, `${sheet.name} ${cell.address}`).toBeUndefined();
          expect(cell.type, `${sheet.name} ${cell.address}`).not.toBe(ExcelJS.ValueType.Formula);
          if (typeof cell.value === 'string') {
            expect(cell.type).toBe(ExcelJS.ValueType.String);
            flatText.push(cell.value);
          }
        }),
      );
    }
    for (const payload of injections) {
      expect(flatText).toContain(payload);
    }
    expect(flatText).toContain(LABOR_REGISTER_ERASED_PLACEHOLDER);

    const registerBytes = await buildDeclarationWorkbook(
      buildLaborRegister({ employer, persons: [samplePerson('1', 'Nguyễn Văn A')] }),
    );
    const registerWb = new ExcelJS.Workbook();
    await registerWb.xlsx.load(
      registerBytes.buffer.slice(registerBytes.byteOffset, registerBytes.byteOffset + registerBytes.byteLength) as ArrayBuffer,
    );
    expect(registerWb.worksheets[0]?.name).toBe('Sổ quản lý lao động');
    expect(String(registerWb.worksheets[0]?.getRow(3).getCell(1).value)).toContain('ludy-hr-labor-register/1');
  });
});

describe('declarationGet and laborCheckRead cutoff attribution for same-month post-cutoff employments (#3372)', () => {
  type Filter = { col: string; op: string; val: unknown };
  const colName = (col: string): string => {
    const dot = col.indexOf('.');
    return dot >= 0 ? col.slice(dot + 1) : col;
  };
  const matchesFilters = (row: Record<string, unknown>, filters: readonly Filter[]): boolean =>
    filters.every(({ col, op, val }) => {
      const actual = row[colName(col)];
      if (op === '=') return actual === val;
      if (op === '<=') return typeof actual === 'string' && typeof val === 'string' && actual <= val;
      if (op === 'in') return Array.isArray(val) && val.includes(actual);
      return true;
    });

  const makeCtx = (tables: Record<string, Array<Record<string, unknown>>>) => {
    const selectFrom = (table: string): unknown => {
      const baseTable = table.split(/\s+as\s+/i)[0]!;
      const filters: Filter[] = [];
      const orders: Array<{ col: string; dir: 'asc' | 'desc' }> = [];
      let joinDepartments = false;
      const runRows = (): Array<Record<string, unknown>> => {
        const depts = tables['crove_hr.department'] ?? [];
        const base = (tables[baseTable] ?? []).map((r) => {
          if (!joinDepartments) return r;
          const dept = depts.find((d) => d.org_id === r.org_id && d.id === r.department_id);
          return { ...r, department_name: dept?.name ?? null };
        });
        const filtered = base.filter((r) => matchesFilters(r, filters));
        if (orders.length === 0) return filtered;
        return [...filtered].sort((a, b) => {
          for (const { col, dir } of orders) {
            const key = colName(col);
            const av = String(a[key] ?? '');
            const bv = String(b[key] ?? '');
            if (av !== bv) return dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
          }
          return 0;
        });
      };
      const q: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === 'leftJoin') {
              return (joined: string) => {
                if (joined.startsWith('crove_hr.department')) joinDepartments = true;
                return q;
              };
            }
            if (prop === 'where') {
              return (col: string, op: string, val: unknown) => {
                filters.push({ col, op, val });
                return q;
              };
            }
            if (prop === 'orderBy') {
              return (col: string, dir: 'asc' | 'desc' = 'asc') => {
                orders.push({ col, dir });
                return q;
              };
            }
            if (prop === 'execute') return async () => runRows();
            if (prop === 'executeTakeFirst') return async () => runRows()[0];
            return () => q;
          },
        },
      );
      return q;
    };
    return {
      actor: { type: 'user', userId: 'owner-1', aal: 'aal2', sessionId: 's-1', mfaAt: Math.floor(Date.now() / 1000) },
      orgId: 'org-1',
      now: new Date('2026-06-30T00:00:00Z'),
      trx: { selectFrom },
      audit: () => {},
      openMany: async (items: ReadonlyArray<{ sealed: string }>) => items.map((item) => item.sealed),
    } as unknown as Parameters<typeof declarationGet.handler>[0];
  };

  it('excludes pay metadata and contract terms from employment rows effective after the employee cutoff', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      'crove_kernel.legal_entity': [
        { id: 'entity-1', org_id: 'org-1', name: employer.name, tax_code: employer.taxCode, is_default: true },
      ],
      'crove_hr.payroll_employee': [
        {
          id: 'emp-with-may',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Trần Tháng Trước',
          address: 'Hà Nội',
          birth_date: '1991-03-10',
          ended_on: null,
          erased_at: null,
          national_id_sealed: '001091000001',
          tax_code_sealed: '8000000001',
          insurance_number_sealed: '0123456781',
        },
        {
          id: 'emp-june-only',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Nguyễn Chỉ Tháng Sáu',
          address: 'Hà Nội',
          birth_date: '1992-07-20',
          ended_on: null,
          erased_at: null,
          national_id_sealed: '001092000002',
          tax_code_sealed: '8000000002',
          insurance_number_sealed: '0123456782',
        },
        {
          id: 'emp-null-legacy',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Lê Dòng Cũ Null',
          address: 'Hà Nội',
          birth_date: '1993-08-15',
          ended_on: null,
          erased_at: null,
          national_id_sealed: '001093000003',
          tax_code_sealed: '8000000003',
          insurance_number_sealed: '0123456783',
        },
      ],
      'crove_hr.payroll_employment': [
        { id: 'row-may-1', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-with-may', effective_from: '2026-05-01', contract_type: 'fixed_term', base_wage: '12000000' },
        { id: 'row-may-2', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-with-may', effective_from: '2026-06-20', contract_type: 'fixed_term', base_wage: '18000000' },
        { id: 'row-jun-1', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-june-only', effective_from: '2026-06-01', contract_type: 'none', base_wage: '10000000' },
        { id: 'row-jun-2', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-june-only', effective_from: '2026-06-20', contract_type: 'fixed_term', base_wage: '15000000' },
        { id: 'row-null-1', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-null-legacy', effective_from: '2026-06-01', contract_type: 'fixed_term', base_wage: '11000000' },
        { id: 'row-null-2', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-null-legacy', effective_from: '2026-06-20', contract_type: 'fixed_term', base_wage: '14000000' },
      ],
      'crove_hr.payroll_run': [
        { id: 'run-may', org_id: 'org-1', legal_entity_id: 'entity-1', status: 'approved', month: '2026-05' },
        { id: 'run-jun', org_id: 'org-1', legal_entity_id: 'entity-1', status: 'approved', month: '2026-06' },
      ],
      'crove_hr.payroll_line': [
        {
          run_id: 'run-may',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-with-may',
          employment_id: 'row-may-1',
          kind: 'pay',
          status: 'calculated',
          inputs: { contractTermMonths: 12, allowances: [{ amount: '500000' }], otherRegularPay: '200000' },
        },
        {
          run_id: 'run-jun',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-with-may',
          employment_id: 'row-may-2',
          kind: 'pay',
          status: 'calculated',
          inputs: { contractTermMonths: 6, allowances: [{ amount: '3000000' }], otherRegularPay: '900000' },
        },
        {
          run_id: 'run-jun',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-june-only',
          employment_id: 'row-jun-2',
          kind: 'pay',
          status: 'calculated',
          inputs: { contractTermMonths: 6, allowances: [{ amount: '4000000' }], otherRegularPay: '800000' },
        },
        {
          run_id: 'run-jun',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-null-legacy',
          employment_id: null,
          kind: 'pay',
          status: 'calculated',
          inputs: { allowances: [{ amount: '2500000' }], otherRegularPay: '600000' },
        },
      ],
    };

    const june10 = await declarationGet.handler(makeCtx(tables), { kind: 'labor_register', period: '2026-06-10' });
    const june10Rows = june10.sheets[0]?.rows ?? [];
    expect(june10Rows.find((r) => r.name === 'Trần Tháng Trước')).toMatchObject({
      contractStartDate: '2026-05-01',
      contractEndDate: '2027-04-30',
      baseWage: '12000000.00',
    });
    expect(june10Rows.find((r) => r.name === 'Nguyễn Chỉ Tháng Sáu')).toMatchObject({
      contractStartDate: '',
      contractEndDate: '',
      baseWage: '10000000.00',
    });

    const june25 = await declarationGet.handler(makeCtx(tables), { kind: 'labor_register', period: '2026-06-25' });
    const june25Rows = june25.sheets[0]?.rows ?? [];
    expect(june25Rows.find((r) => r.name === 'Trần Tháng Trước')).toMatchObject({
      baseWage: '18000000.00',
      contractStartDate: '2026-05-01',
      contractEndDate: '2026-10-31',
    });
    expect(june25Rows.find((r) => r.name === 'Nguyễn Chỉ Tháng Sáu')).toMatchObject({
      contractStartDate: '2026-06-20',
      contractEndDate: '2026-12-19',
      baseWage: '15000000.00',
    });

    const pliOpen = await declarationGet.handler(makeCtx(tables), { kind: '01pli', period: '2026-H1' });
    const pliOpenRows = pliOpen.sheets[1]?.rows ?? [];
    expect(pliOpenRows.find((r) => r.name === 'Trần Tháng Trước')).toMatchObject({
      baseWage: '18000000.00',
      allowance: '3000000.00',
      otherAmounts: '900000.00',
    });
    expect(pliOpenRows.find((r) => r.name === 'Lê Dòng Cũ Null')).toMatchObject({
      baseWage: '14000000.00',
      allowance: '2500000.00',
      otherAmounts: '600000.00',
    });

    for (const emp of tables['crove_hr.payroll_employee']!) {
      emp.ended_on = '2026-06-10';
    }
    const pliEnded = await declarationGet.handler(makeCtx(tables), { kind: '01pli', period: '2026-H1' });
    const pliEndedRows = pliEnded.sheets[1]?.rows ?? [];
    expect(pliEndedRows.find((r) => r.name === 'Trần Tháng Trước')).toMatchObject({
      endedOn: '2026-06-10',
      baseWage: '12000000.00',
      allowance: '500000.00',
      otherAmounts: '200000.00',
    });
    expect(pliEndedRows.find((r) => r.name === 'Nguyễn Chỉ Tháng Sáu')).toMatchObject({
      endedOn: '2026-06-10',
      baseWage: '10000000.00',
      allowance: '',
      otherAmounts: '',
    });
    expect(pliEndedRows.find((r) => r.name === 'Lê Dòng Cũ Null')).toMatchObject({
      endedOn: '2026-06-10',
      baseWage: '11000000.00',
      allowance: '',
      otherAmounts: '',
    });

    const checkEnded = await laborCheckRead.handler(makeCtx(tables) as unknown as Parameters<typeof laborCheckRead.handler>[0], {
      kind: '01pli',
      period: '2026-H1',
    });
    const checkWithMay = checkEnded.employees.find((e) => e.employeeId === 'emp-with-may');
    expect(checkWithMay).toMatchObject({ contractKind: 'fixed_term', contractStartDate: '2026-05-01', contractTermMonths: 12 });
    const checkJuneOnly = checkEnded.employees.find((e) => e.employeeId === 'emp-june-only');
    expect(checkJuneOnly).toMatchObject({ contractKind: 'none', contractStartDate: null, contractTermMonths: null });
  });

  it('prefers saved Stage 2b-3 contract and probation columns over payroll_line inputs and works without pay runs', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      'crove_kernel.legal_entity': [
        { id: 'entity-1', org_id: 'org-1', name: employer.name, tax_code: employer.taxCode, is_default: true },
      ],
      'crove_hr.payroll_employee': [
        {
          id: 'emp-saved-priority',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Phạm Lưu Trữ Trước Canary',
          address: 'Hà Nội',
          birth_date: '1990-01-15',
          ended_on: null,
          erased_at: null,
          national_id_sealed: '000000000101',
          tax_code_sealed: '8000000101',
          insurance_number_sealed: '0123456101',
        },
        {
          id: 'emp-explicit-end',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Đỗ Chỉ Ngày Kết Thúc Canary',
          address: 'Hà Nội',
          birth_date: '1992-05-20',
          ended_on: null,
          erased_at: null,
          national_id_sealed: '000000000102',
          tax_code_sealed: '8000000102',
          insurance_number_sealed: '0123456102',
        },
        {
          id: 'emp-probation',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Lê Thử Việc Canary',
          address: 'Hà Nội',
          birth_date: '1995-09-09',
          ended_on: null,
          erased_at: null,
          national_id_sealed: '000000000103',
          tax_code_sealed: '8000000103',
          insurance_number_sealed: '0123456103',
        },
        {
          id: 'emp-uncertain-recovered',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Vũ Gia Hạn Sau Thiếu Kỳ Canary',
          address: 'Hà Nội',
          birth_date: '1993-04-04',
          ended_on: null,
          erased_at: null,
          national_id_sealed: '000000000104',
          tax_code_sealed: '8000000104',
          insurance_number_sealed: '0123456104',
        },
      ],
      'crove_hr.payroll_employment': [
        {
          id: 'row-saved-1',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-saved-priority',
          effective_from: '2026-01-01',
          contract_type: 'fixed_term',
          base_wage: '12000000',
          term_months: 6,
          contract_end_on: '2026-06-30',
          fixed_term_sequence: 2,
        },
        {
          id: 'row-saved-2',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-saved-priority',
          effective_from: '2026-04-01',
          contract_type: 'fixed_term',
          base_wage: '14000000',
        },
        {
          id: 'row-end-only',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-explicit-end',
          effective_from: '2026-02-01',
          contract_type: 'fixed_term',
          base_wage: '11000000',
          term_months: null,
          contract_end_on: '2026-06-25',
          fixed_term_sequence: 1,
        },
        {
          id: 'row-prob',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-probation',
          effective_from: '2026-05-01',
          contract_type: 'indefinite',
          base_wage: '10000000',
          probation_role_tier: 'college_or_above',
          probation_end_on: '2026-06-15',
          probation_wage: '8500000',
        },
        {
          id: 'row-rec-1',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-uncertain-recovered',
          effective_from: '2025-01-01',
          contract_type: 'fixed_term',
          base_wage: '10000000',
        },
        {
          id: 'row-rec-2',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-uncertain-recovered',
          effective_from: '2026-01-01',
          contract_type: 'fixed_term',
          base_wage: '13000000',
          term_months: 12,
          contract_end_on: '2026-12-31',
          fixed_term_sequence: 2,
        },
      ],
      'crove_hr.payroll_run': [{ id: 'run-apr', org_id: 'org-1', legal_entity_id: 'entity-1', status: 'approved', month: '2026-04' }],
      'crove_hr.payroll_line': [
        {
          run_id: 'run-apr',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          employee_id: 'emp-saved-priority',
          employment_id: 'row-saved-1',
          kind: 'pay',
          status: 'calculated',
          inputs: { contractTermMonths: 12, allowances: [], otherRegularPay: '0' },
        },
      ],
    };

    const doc = await declarationGet.handler(makeCtx(tables), { kind: 'labor_register', period: '2026-06-05' });
    const rows = doc.sheets[0]?.rows ?? [];
    expect(rows.find((r) => r.name === 'Phạm Lưu Trữ Trước Canary')).toMatchObject({
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-06-30',
      baseWage: '14000000.00',
    });
    expect(rows.find((r) => r.name === 'Đỗ Chỉ Ngày Kết Thúc Canary')).toMatchObject({
      contractStartDate: '2026-02-01',
      contractEndDate: '2026-06-25',
    });
    expect(rows.find((r) => r.name === 'Vũ Gia Hạn Sau Thiếu Kỳ Canary')).toMatchObject({
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
    });

    const check = await laborCheckRead.handler(makeCtx(tables) as unknown as Parameters<typeof laborCheckRead.handler>[0], {
      kind: 'labor_register',
      period: '2026-06-05',
    });
    expect(check.employees.find((e) => e.employeeId === 'emp-saved-priority')).toMatchObject({
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-06-30',
      contractTermMonths: 6,
      fixedTermSequence: 2,
    });
    expect(check.employees.find((e) => e.employeeId === 'emp-explicit-end')).toMatchObject({
      contractEndDate: '2026-06-25',
      contractTermMonths: null,
      fixedTermSequence: 1,
    });
    expect(check.employees.find((e) => e.employeeId === 'emp-probation')).toMatchObject({
      contractKind: 'indefinite',
      contractEndDate: null,
      probation: {
        roleTier: 'college_or_above',
        startDate: '2026-05-01',
        endDate: '2026-06-15',
        wage: '8500000',
      },
    });
    expect(check.employees.find((e) => e.employeeId === 'emp-uncertain-recovered')).toMatchObject({
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      contractTermMonths: 12,
      fixedTermSequence: 2,
    });
  });

  it('populates position/workplace/contractType in declarationGet, masks erased employees, and adds job_title + department to laborCheckRead forbidden (#3437)', async () => {
    const funds = ['retirement_death', 'sickness_maternity', 'work_accident', 'health', 'unemployment'].map((fund) => ({
      fund,
      wage: '15000000',
      employee: '0',
      employer: '0',
    }));
    const breakdown = {
      insurance: { suspended: null, funds },
      tax: {
        mode: 'progressive',
        exemptMealCash: '0',
        exemptOvertime: '0',
        exemptNightWork: '0',
        personalDeduction: '15500000',
        dependentDeduction: '0',
        pensionDeduction: '0',
        assessableIncome: '0',
      },
    };
    const tables: Record<string, Array<Record<string, unknown>>> = {
      'crove_kernel.legal_entity': [
        { id: 'entity-1', org_id: 'org-1', name: employer.name, tax_code: employer.taxCode, is_default: true },
      ],
      'crove_hr.department': [
        { id: 'dept-sales', org_id: 'org-1', legal_entity_id: 'entity-1', name: 'Phòng Kinh doanh Canary' },
        { id: 'dept-secret', org_id: 'org-1', legal_entity_id: 'entity-1', name: 'Phòng Đã Xóa Bí Mật' },
      ],
      'crove_hr.payroll_employee': [
        {
          id: 'emp-full',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Nguyễn Văn Đủ Canary',
          address: '10 Nguyễn Huệ',
          birth_date: '1991-05-10',
          department_id: 'dept-sales',
          job_title: 'Trưởng nhóm Bán hàng',
          ended_on: null,
          erased_at: null,
          national_id_sealed: '000000000201',
          tax_code_sealed: null,
          insurance_number_sealed: '7309100101',
          finalization_authorized_years: [],
        },
        {
          id: 'emp-title-only',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Trần Chỉ Chức Danh Canary',
          address: '20 Lê Lợi',
          birth_date: '1993-02-14',
          department_id: null,
          job_title: 'Thủ quỹ',
          ended_on: null,
          erased_at: null,
          national_id_sealed: '000000000202',
          tax_code_sealed: null,
          insurance_number_sealed: '7309300102',
          finalization_authorized_years: [],
        },
        {
          id: 'emp-dept-only',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Lê Chỉ Phòng Ban Canary',
          address: '30 Pasteur',
          birth_date: '1994-09-01',
          department_id: 'dept-sales',
          job_title: null,
          ended_on: null,
          erased_at: null,
          national_id_sealed: null,
          tax_code_sealed: null,
          insurance_number_sealed: null,
          finalization_authorized_years: [],
        },
        {
          id: 'emp-erased',
          org_id: 'org-1',
          legal_entity_id: 'entity-1',
          display_name: 'Đã xóa theo yêu cầu',
          address: null,
          birth_date: null,
          // Simulate leftover non-null fields in row to verify handler masks strictly when erased_at !== null.
          department_id: 'dept-secret',
          job_title: 'Giám đốc Bí Mật',
          ended_on: null,
          erased_at: '2026-08-01T00:00:00Z',
          national_id_sealed: null,
          tax_code_sealed: null,
          insurance_number_sealed: null,
          finalization_authorized_years: [],
        },
      ],
      'crove_hr.payroll_employment': [
        { id: 'e1-1', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-full', effective_from: '2026-01-01', contract_type: 'fixed_term', base_wage: '15000000' },
        { id: 'e1-2', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-full', effective_from: '2026-07-01', contract_type: 'indefinite', base_wage: '15000000' },
        { id: 'e2-1', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-title-only', effective_from: '2026-08-10', contract_type: 'fixed_term', base_wage: '12000000' },
        { id: 'e3-1', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-dept-only', effective_from: '2026-05-01', contract_type: 'none', base_wage: '8000000' },
        { id: 'e4-1', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-erased', effective_from: '2026-01-01', contract_type: 'indefinite', base_wage: '20000000' },
      ],
      'crove_hr.payroll_run': [
        { id: 'run-jul', org_id: 'org-1', legal_entity_id: 'entity-1', status: 'approved', month: '2026-07' },
        { id: 'run-aug', org_id: 'org-1', legal_entity_id: 'entity-1', status: 'approved', month: '2026-08' },
      ],
      'crove_hr.payroll_line': [
        { run_id: 'run-jul', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-full', employment_id: 'e1-2', kind: 'pay', status: 'calculated', gross: '12000000', employee_insurance: '0', employer_insurance: '0', union_fee: '0', taxable_income: '12000000', pit: '0', breakdown: { ...breakdown, insurance: { suspended: null, funds: funds.map((f) => ({ ...f, wage: '12000000' })) } }, inputs: {} },
        { run_id: 'run-aug', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-full', employment_id: 'e1-2', kind: 'pay', status: 'calculated', gross: '15000000', employee_insurance: '0', employer_insurance: '0', union_fee: '0', taxable_income: '15000000', pit: '0', breakdown, inputs: {} },
        { run_id: 'run-aug', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-title-only', employment_id: 'e2-1', kind: 'pay', status: 'calculated', gross: '12000000', employee_insurance: '0', employer_insurance: '0', union_fee: '0', taxable_income: '12000000', pit: '0', breakdown, inputs: {} },
        { run_id: 'run-jul', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-erased', employment_id: 'e4-1', kind: 'pay', status: 'calculated', gross: '18000000', employee_insurance: '0', employer_insurance: '0', union_fee: '0', taxable_income: '18000000', pit: '0', breakdown: { ...breakdown, insurance: { suspended: null, funds: funds.map((f) => ({ ...f, wage: '18000000' })) } }, inputs: {} },
        { run_id: 'run-aug', org_id: 'org-1', legal_entity_id: 'entity-1', employee_id: 'emp-erased', employment_id: 'e4-1', kind: 'pay', status: 'calculated', gross: '20000000', employee_insurance: '0', employer_insurance: '0', union_fee: '0', taxable_income: '20000000', pit: '0', breakdown, inputs: {} },
      ],
    };

    const reg = await declarationGet.handler(makeCtx(tables), { kind: 'labor_register', period: '2026-08-15' });
    const regRows = reg.sheets[0]?.rows ?? [];
    expect(regRows.find((r) => r.name === 'Nguyễn Văn Đủ Canary')?.position).toBe('Trưởng nhóm Bán hàng - Phòng Kinh doanh Canary');
    expect(regRows.find((r) => r.name === 'Trần Chỉ Chức Danh Canary')?.position).toBe('Thủ quỹ');
    expect(regRows.find((r) => r.name === 'Lê Chỉ Phòng Ban Canary')?.position).toBe('Phòng Kinh doanh Canary');
    expect(regRows.find((r) => r.name === LABOR_REGISTER_ERASED_PLACEHOLDER)?.position).toBe('');
    expect(JSON.stringify(reg)).not.toContain('Giám đốc Bí Mật');
    expect(JSON.stringify(reg)).not.toContain('Phòng Đã Xóa Bí Mật');

    const pli = await declarationGet.handler(makeCtx(tables), { kind: '01pli', period: '2026-H2' });
    const pliRows = pli.sheets[1]?.rows ?? [];
    expect(pliRows.find((r) => r.name === 'Nguyễn Văn Đủ Canary')?.position).toBe('Trưởng nhóm Bán hàng - Phòng Kinh doanh Canary');
    expect(pliRows.find((r) => r.name === LABOR_REGISTER_ERASED_PLACEHOLDER)?.position).toBe('');

    const d02 = await declarationGet.handler(makeCtx(tables), { kind: 'd02lt', period: '2026-08' });
    expect(d02.layout.version).toBe('ludy-hr-d02lt/2');
    const d02Rows = d02.sheets[0]?.rows ?? [];
    expect(d02Rows.find((r) => r.name === 'Nguyễn Văn Đủ Canary')).toMatchObject({
      movement: 'Điều chỉnh mức đóng',
      position: 'Trưởng nhóm Bán hàng',
      workplace: 'Phòng Kinh doanh Canary',
      contractType: 'Không xác định thời hạn',
    });
    expect(d02Rows.find((r) => r.name === 'Trần Chỉ Chức Danh Canary')).toMatchObject({
      movement: 'Tăng lao động',
      position: 'Thủ quỹ',
      workplace: '',
      contractType: 'Xác định thời hạn',
    });
    expect(d02Rows.find((r) => r.name === 'Đã xóa theo yêu cầu')).toMatchObject({
      position: '',
      workplace: '',
      contractType: '',
    });
    expect(JSON.stringify(d02)).not.toContain('Giám đốc Bí Mật');
    expect(JSON.stringify(d02)).not.toContain('Phòng Đã Xóa Bí Mật');

    const check = await laborCheckRead.handler(makeCtx(tables) as unknown as Parameters<typeof laborCheckRead.handler>[0], {
      kind: 'labor_register',
      period: '2026-08-15',
    });
    expect(check.forbidden).toContain('Trưởng nhóm Bán hàng');
    expect(check.forbidden).toContain('Thủ quỹ');
    expect(check.forbidden).toContain('Phòng Kinh doanh Canary');
    expect(check.forbidden).not.toContain('Giám đốc Bí Mật');
    expect(check.forbidden).not.toContain('Phòng Đã Xóa Bí Mật');
  });
});
