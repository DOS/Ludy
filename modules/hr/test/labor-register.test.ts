// SPDX-License-Identifier: AGPL-3.0-only
import { HR_DECLARATION_MAX_PEOPLE } from '@crove/kernel-contract';
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
        samplePerson('2', 'Trần Bình'),
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
    expect(rows.map((r) => [r.seq, r.name, r.contractType, r.baseWage])).toEqual([
      ['1', 'Nguyễn An', 'Xác định thời hạn', '12500000.00'],
      ['2', 'Trần Bình', 'Không xác định thời hạn', '15000000.00'],
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
  });

  it('rejects invalid semiannual periods and invalid calendar dates', () => {
    expect(() => build01PliReport({ period: '2026-H3', employer, persons: [] })).toThrow(/01\/PLI/);
    expect(() => build01PliReport({ period: '2026-Q1', employer, persons: [] })).toThrow(/01\/PLI/);
    expect(() =>
      buildLaborRegister({ employer, asOf: '2026-02-30', persons: [] }),
    ).toThrow(/không hợp lệ/);
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
