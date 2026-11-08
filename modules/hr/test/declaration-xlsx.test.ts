// SPDX-License-Identifier: AGPL-3.0-only
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { HR_DECLARATION_KINDS, zHrDeclarationDocument, zHrDeclarationQuery, hrDeclarationPeriodOk, type HrDeclarationDocument } from '@crove/kernel-contract';
import { DECLARATION_KINDS, DECLARATION_LAYOUTS, buildQuarterly } from '../src/declarations.ts';
import { amountCell, buildDeclarationWorkbook } from '../src/declaration-xlsx.ts';

const INJECTIONS = ['=HYPERLINK("http://example.test","x")', '+84901234567', '-ABC', '@SUM(A1)', '\t=1+1'];

function documentWith(names: string[]): HrDeclarationDocument {
  const doc = buildQuarterly({
    quarter: '2026-Q3',
    employer: { name: INJECTIONS[0] as string, taxCode: '0100000000', address: null },
    persons: names.map((name, i) => ({ employeeId: String(i + 1), name, birthDate: null, taxCode: INJECTIONS[1] as string, insuranceNumber: null, identityNumber: INJECTIONS[3] as string, startedOn: '2025-01-01', endedOn: null, finalizationAuthorizedYears: [] })),
    lines: names.map((_, i) => ({
      month: '2026-07',
      employeeId: String(i + 1),
      kind: 'pay' as const,
      gross: '1234567890123456.78',
      employeeInsurance: '0',
      employerInsurance: '0',
      unionFee: '0',
      taxableIncome: '1000.5',
      pit: '100',
      breakdown: null,
    })),
    approvedMonths: ['2026-07'],
  });
  return zHrDeclarationDocument.parse({ ...doc, used: { months: ['2026-07'] } });
}

describe('the declaration workbook (#2533)', () => {
  it('writes every text cell as a string cell, never a formula, whatever the text starts with', async () => {
    const bytes = await buildDeclarationWorkbook(documentWith(INJECTIONS), 'Ludy');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    let checked = 0;
    for (const sheet of workbook.worksheets) {
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          expect(cell.formula, `${sheet.name} ${cell.address}`).toBeUndefined();
          expect(cell.type, `${sheet.name} ${cell.address}`).not.toBe(ExcelJS.ValueType.Formula);
          if (typeof cell.value === 'string') {
            expect(cell.type).toBe(ExcelJS.ValueType.String);
            checked += 1;
          }
        }),
      );
    }
    expect(checked).toBeGreaterThan(20);
    // The hostile names are in the file as text, byte for byte.
    const all = workbook.worksheets.flatMap((s) => {
      const out: string[] = [];
      s.eachRow((r) => r.eachCell((c) => out.push(String(c.value))));
      return out;
    });
    for (const text of INJECTIONS) expect(all).toContain(text);
  });

  it('says what the file is, which layout it has and that it is a draft, on every sheet', async () => {
    const bytes = await buildDeclarationWorkbook(documentWith(['An']), 'Ludy');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(workbook.worksheets.length).toBe(3);
    for (const sheet of workbook.worksheets) {
      const head = [1, 2, 3, 4].map((i) => String(sheet.getRow(i).getCell(1).value));
      expect(head[0]).toBe('BẢNG KÊ ĐỂ KHAI BÁO');
      expect(head.join(' ')).toContain(DECLARATION_LAYOUTS.kk.version);
      expect(head.join(' ')).toContain('BẢN NHÁP');
    }
    expect(workbook.creator).toBe('Ludy');
  });

  it('keeps an amount exact: a number cell only when Excel would show the same decimal, else the decimal as text', () => {
    expect(amountCell('1500000.00')).toEqual({ kind: 'number', value: 1500000, numFmt: '#,##0' });
    expect(amountCell('0.00')).toMatchObject({ kind: 'number', value: 0 });
    expect(amountCell('1234567890123456.78')).toEqual({ kind: 'text', value: '1234567890123456.78' });
    expect(amountCell('1000.50')).toMatchObject({ kind: 'number', value: 1000.5, numFmt: '#,##0.0' });
  });
});

describe('the declaration contract matches the module', () => {
  it('names the same kinds, and checks the period by kind', () => {
    expect([...HR_DECLARATION_KINDS]).toEqual([...DECLARATION_KINDS]);
    expect(hrDeclarationPeriodOk('d02lt', '2026-09')).toBe(true);
    expect(hrDeclarationPeriodOk('d02lt', '2026-13')).toBe(false);
    expect(hrDeclarationPeriodOk('kk', '2026-Q4')).toBe(true);
    expect(hrDeclarationPeriodOk('kk', '2026-Q5')).toBe(false);
    expect(hrDeclarationPeriodOk('qtt', '2026')).toBe(true);
    expect(hrDeclarationPeriodOk('certificate', '2026-09')).toBe(false);
    expect(zHrDeclarationQuery.safeParse({ kind: 'kk', period: '2026-09' }).success).toBe(false);
    expect(zHrDeclarationQuery.safeParse({ kind: 'kk', period: '2026-Q3', extra: 1 }).success).toBe(false);
  });
});
