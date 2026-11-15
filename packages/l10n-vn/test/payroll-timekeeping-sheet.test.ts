// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PAYROLL_RULES, PayrollRefusedError, calculatePayroll, defineRule, parseTimekeepingSheet, type PayrollEmployment } from '../src/index.ts';

describe('parseTimekeepingSheet (#3348)', () => {
  it('parses accented Vietnamese TSV exports with title preamble and trailing total row', () => {
    const tsv = [
      'BẢNG CHẤM CÔNG THÁNG 08/2026',
      'Mã nhân viên\tHọ tên\tNgày nghỉ không lương\tNgày nghỉ phép năm\tNgày nghỉ việc riêng\tLàm thêm ngày thường\tLàm thêm ngày nghỉ hàng tuần\tLàm thêm ngày lễ\tLàm thêm ban đêm\tGiờ làm ban đêm\tNgày chưa làm',
      'NV01\tNguyễn Văn A\t1.5\t2\t1\t10\t4\t\t2.5\t6\t0',
      'NV02\tTrần Thị B\t\t0.5\t\t\t\t8\t\t\t3',
      'Tổng cộng\t\t1.5\t2.5\t1\t10\t4\t8\t2.5\t6\t3',
    ].join('\n');

    const res = parseTimekeepingSheet(tsv, { month: '2026-08' });
    expect(res.delimiter).toBe('\t');
    expect(res.headerRow).toBe(2);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.rulesUsed.map((r) => r.id)).toEqual(['overtime_caps.default@2021-01-01']);
    expect(res.rows).toHaveLength(2);

    expect(res.rows[0]).toEqual({
      rowNumber: 3,
      employeeKey: 'NV01',
      employeeCode: 'NV01',
      displayName: 'Nguyễn Văn A',
      unpaidLeaveDays: '1.5',
      annualLeaveDays: '2',
      personalPaidDays: '1',
      daysNotEmployed: '0',
      overtime: [
        { dayKind: 'normal_day', night: false, hours: '10' },
        { dayKind: 'weekly_rest_day', night: false, hours: '4' },
        { dayKind: 'normal_day', night: true, hours: '2.5' },
      ],
      nightHours: '6',
      totalOvertimeHours: '16.5',
      overtimeCapExceeded: false,
      payrollInputs: {
        unpaidLeaveDays: '1.5',
        daysNotEmployed: '0',
        overtime: [
          { dayKind: 'normal_day', night: false, hours: '10' },
          { dayKind: 'weekly_rest_day', night: false, hours: '4' },
          { dayKind: 'normal_day', night: true, hours: '2.5' },
        ],
        nightHours: '6',
      },
    });

    expect(res.rows[1]).toMatchObject({
      rowNumber: 4,
      employeeKey: 'NV02',
      unpaidLeaveDays: '0',
      annualLeaveDays: '0.5',
      personalPaidDays: '0',
      daysNotEmployed: '3',
      overtime: [{ dayKind: 'holiday', night: false, hours: '8' }],
      nightHours: '0',
      totalOvertimeHours: '8',
      overtimeCapExceeded: false,
    });
  });

  it('parses English camelCase and ASCII Vietnamese CSV exports and handles BOM and CRLF', () => {
    const csv =
      '\uFEFFcode,displayName,unpaidLeaveDays,annualLeaveDays,personalPaidDays,normalDayOtHours,weeklyRestDayOtHours,holidayOtHours,nightOtHours,nightHours,daysNotEmployed\r\n' +
      'E01,"Pham, Minh",0.0,1.0,0,8,0,0,2,5,0\r\n';

    const res = parseTimekeepingSheet(csv, { month: '2026-08', nightOtDayKind: 'weekly_rest_day' });
    expect(res.delimiter).toBe(',');
    expect(res.errors).toEqual([]);
    expect(res.rows[0]).toMatchObject({
      employeeCode: 'E01',
      displayName: 'Pham, Minh',
      unpaidLeaveDays: '0',
      annualLeaveDays: '1',
      overtime: [
        { dayKind: 'normal_day', night: false, hours: '8' },
        { dayKind: 'weekly_rest_day', night: true, hours: '2' },
      ],
      nightHours: '5',
      totalOvertimeHours: '10',
    });

    const ascii = 'ma nhan vien;nghi phep khong luong;nghi phep viec rieng;nghi phep nam;ngay sau nghi\nNV09;2;1;0.5;4\n';
    const semi = parseTimekeepingSheet(ascii);
    expect(semi.delimiter).toBe(';');
    expect(semi.errors).toEqual([]);
    expect(semi.rows[0]).toMatchObject({
      employeeCode: 'NV09',
      unpaidLeaveDays: '2',
      personalPaidDays: '1',
      annualLeaveDays: '0.5',
      daysNotEmployed: '4',
    });
  });

  it('supports explicit day-kind night overtime columns without collapsing them into normal_day', () => {
    const tsv = [
      'Employee Code\tOT dem ngay thuong\tOT dem ngay nghi\tOT dem ngay le\tGio lam ban dem',
      'NV01\t2\t3\t4\t10',
    ].join('\n');

    const res = parseTimekeepingSheet(tsv, { month: '2026-08' });
    expect(res.errors).toEqual([]);
    expect(res.rows[0]?.overtime).toEqual([
      { dayKind: 'normal_day', night: true, hours: '2' },
      { dayKind: 'weekly_rest_day', night: true, hours: '3' },
      { dayKind: 'holiday', night: true, hours: '4' },
    ]);
    expect(res.rows[0]?.nightHours).toBe('10');
    expect(res.rows[0]?.totalOvertimeHours).toBe('9');
  });

  it('flags monthly overtime exceeding the dated 40h cap while excluding ordinary nightHours from the cap', () => {
    const tsv = [
      'Ma NV\tLam them ngay thuong\tLam them ngay nghi hang tuan\tLam them ban dem\tGio lam ban dem',
      'NV01\t20\t15\t5\t20',
      'NV02\t25.5\t10\t5\t0',
    ].join('\n');

    const res = parseTimekeepingSheet(tsv, { month: '2026-08' });
    expect(res.errors).toEqual([]);
    // NV01 has exactly 40h OT (+ 20h ordinary night work, which does not count toward OT cap).
    expect(res.rows[0]?.totalOvertimeHours).toBe('40');
    expect(res.rows[0]?.overtimeCapExceeded).toBe(false);
    // NV02 has 40.5h OT -> flagged against overtime_caps.default@2021-01-01.
    expect(res.rows[1]?.totalOvertimeHours).toBe('40.5');
    expect(res.rows[1]?.overtimeCapExceeded).toBe(true);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatchObject({
      severity: 'warning',
      code: 'overtime_cap_exceeded',
      rowNumber: 3,
      employeeKey: 'NV02',
      value: '40.5',
      limit: '40',
      ruleId: 'overtime_caps.default@2021-01-01',
    });

    const raisedCapRules = [
      ...PAYROLL_RULES,
      defineRule({
        kind: 'overtime_caps',
        key: 'default',
        effectiveFrom: '2026-01-01',
        status: 'confirmed',
        source: { cite: 'Test rule raising monthly cap to 50h', confidence: 'primary' },
        value: { monthlyHours: '50', annualHours: '200' },
      }),
    ];
    expect(parseTimekeepingSheet(tsv, { month: '2026-08', rules: raisedCapRules }).warnings).toEqual([]);
  });

  it('rejects malformed or negative cells with row/column errors and flags duplicate employee keys', () => {
    const bad = [
      'Ma NV\tHo ten\tNgay nghi khong luong\tLam them ngay thuong',
      'NV01\tNguyen Van A\t1\t5',
      'nv01\tNguyen Van A\t2\t3',
      'NV02\tTran Thi B\tabc\t-2.5',
      '\t\t1\t0',
    ].join('\n');

    const res = parseTimekeepingSheet(bad, { month: '2026-08' });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.employeeCode).toBe('NV01');
    expect(res.errors.map((e) => [e.code, e.rowNumber, e.column])).toEqual([
      ['duplicate_employee', 3, 'employeeCode'],
      ['invalid_number', 4, 'unpaidLeaveDays'],
      ['negative_number', 4, 'normalDayOtHours'],
      ['missing_employee_key', 5, 'employeeCode'],
    ]);

    // Name-based deduplication ignores case and Vietnamese diacritics when employeeCode is absent.
    const dupByName = parseTimekeepingSheet('Họ tên\tLàm thêm ngày thường\nNguyễn Văn A\t2\nNguyen Van A\t3\n');
    expect(dupByName.rows).toHaveLength(1);
    expect(dupByName.errors.map((e) => e.code)).toEqual(['duplicate_employee']);
  });

  it('reports sheet-level errors cleanly and throws on invalid month or missing rule', () => {
    expect(parseTimekeepingSheet('   \n').errors[0]?.code).toBe('empty_input');
    expect(parseTimekeepingSheet('Ma NV\tHo ten\nNV01\tAn').errors[0]?.code).toBe('missing_timekeeping_columns');
    expect(parseTimekeepingSheet('Nghi khong luong\tLam them ngay thuong\n1\t2').errors[0]?.code).toBe('missing_employee_column');
    expect(parseTimekeepingSheet('Foo\tBar\n1\t2').errors[0]?.code).toBe('missing_header');

    expect(() => parseTimekeepingSheet('Ma NV\tNghi khong luong\nNV01\t1', { month: '2026-8' })).toThrow(PayrollRefusedError);
    expect(() => parseTimekeepingSheet('Ma NV\tNghi khong luong\nNV01\t1', { month: '2020-12' })).toThrow(PayrollRefusedError);
  });

  it('produces payrollInputs directly consumable by calculatePayroll without modifying calculatePayroll rulesUsed', () => {
    const tsv = 'Ma NV\tNgay nghi khong luong\tLam them ngay thuong\tLam them ngay le\tLam them ban dem\tGio lam ban dem\nNV01\t0\t10\t4\t2\t6\n';
    const parsed = parseTimekeepingSheet(tsv, { month: '2026-08' });
    const row = parsed.rows[0];
    expect(row).toBeDefined();

    const person: PayrollEmployment = {
      region: 'I',
      contract: 'indefinite',
      contractTermMonths: null,
      resident: true,
      insured: true,
      baseWage: '25000000',
      allowances: [],
    };
    const calc = calculatePayroll(person, { month: '2026-08', standardWorkingDays: '26', ...row?.payrollInputs });
    expect(calc.gross).toBe('28966347');
    expect(calc.rulesUsed.some((r) => r.kind === 'overtime_caps' || r.kind === 'annual_leave')).toBe(false);
  });

  it('classifies holiday OT ("ngay nghi le"), day/night word orders, unpaid personal leave, and shift OT accurately', () => {
    const vn = [
      'Ma NV\tNghi viec rieng khong huong luong\tLam them ngay nghi le\tLam them ban dem ngay nghi le\tLam them ngay thuong ban dem\tLam them ngay nghi tuan ban dem\tLam them ca dem',
      'NV01\t2\t3\t4\t5\t1.5\t2.5',
    ].join('\n');

    const resVn = parseTimekeepingSheet(vn, { month: '2026-08' });
    expect(resVn.errors).toEqual([]);
    expect(resVn.warnings).toEqual([]);
    expect(resVn.rows[0]).toMatchObject({
      unpaidLeaveDays: '2',
      personalPaidDays: '0',
      nightHours: '0',
      totalOvertimeHours: '16',
      overtime: [
        { dayKind: 'holiday', night: false, hours: '3' },
        { dayKind: 'normal_day', night: true, hours: '5' },
        { dayKind: 'weekly_rest_day', night: true, hours: '1.5' },
        { dayKind: 'holiday', night: true, hours: '4' },
        { dayKind: 'normal_day', night: true, hours: '2.5' },
      ],
    });

    const en = 'Ma NV\tNghi khong huong luong\tNight OT holiday\nNV02\t1\t3\n';
    const resEn = parseTimekeepingSheet(en, { month: '2026-08' });
    expect(resEn.errors).toEqual([]);
    expect(resEn.rows[0]).toMatchObject({
      unpaidLeaveDays: '1',
      overtime: [{ dayKind: 'holiday', night: true, hours: '3' }],
    });
  });

  it('prevents duplicate specific headers from spilling into general columns and reports unclosed CSV quotes and spaced numbers', () => {
    const dupHeader = 'Ma NV\tOT dem ngay thuong\tOT dem ngay thuong\nNV01\t2\t2\n';
    const dupRes = parseTimekeepingSheet(dupHeader, { month: '2026-08' });
    expect(dupRes.errors).toEqual([]);
    expect(dupRes.columns.normalDayNightOtHours).toBe(1);
    expect(dupRes.columns.nightOtHours).toBeNull();
    expect(dupRes.warnings).toMatchObject([{ code: 'duplicate_header_column', column: 'normalDayNightOtHours', header: 'OT dem ngay thuong' }]);
    expect(dupRes.rows[0]?.totalOvertimeHours).toBe('2');

    const unclosed = 'Ma NV,Ho ten,Unpaid leave\nNV01,"Nguyen, Van A,1\nNV02,"Tran B",2\n';
    const quoteRes = parseTimekeepingSheet(unclosed, { month: '2026-08' });
    expect(quoteRes.rows).toEqual([]);
    expect(quoteRes.errors.map((e) => [e.code, e.rowNumber])).toEqual([['unclosed_quote', 2]]);

    const unclosedAtEof = 'Ma NV,Ho ten,Unpaid leave\nNV01,"Nguyen, Van A,1\nNV02,Tran B,2\n';
    const eofRes = parseTimekeepingSheet(unclosedAtEof, { month: '2026-08' });
    expect(eofRes.rows).toEqual([]);
    expect(eofRes.errors.map((e) => [e.code, e.rowNumber])).toEqual([['unclosed_quote', 2]]);

    const spaced = 'STT\tHo ten\tUnpaid leave\n1\tCong\t1\n2\tAn\t1 2\nTong cong\t\t13\n';
    const spacedRes = parseTimekeepingSheet(spaced, { month: '2026-08' });
    expect(spacedRes.rows.map((r) => r.displayName)).toEqual(['Cong']);
    expect(spacedRes.errors.map((e) => [e.code, e.rowNumber, e.column])).toEqual([['invalid_number', 3, 'unpaidLeaveDays']]);

    // Valid TSV whose notes cell contains many commas must fall back to tab rather than failing on comma-mode quote errors.
    const tsvManyCommas = 'Ma NV\tNghi khong luong\tGhi chu\nNV01\t1\t"a,b,c,d,e,f"\n';
    const commaTsvRes = parseTimekeepingSheet(tsvManyCommas, { month: '2026-08' });
    expect(commaTsvRes.delimiter).toBe('\t');
    expect(commaTsvRes.errors).toEqual([]);
    expect(commaTsvRes.rows[0]?.unpaidLeaveDays).toBe('1');

    // CSV preceded by a semicolon-heavy preamble note falls back to comma cleanly.
    const csvWithSemiPreamble = 'Ghi chu: a; b; c; d; e; f\nMa NV,Ho ten,Unpaid leave\nNV01,"Pham, Minh",1\n';
    const csvFallbackRes = parseTimekeepingSheet(csvWithSemiPreamble, { month: '2026-08' });
    expect(csvFallbackRes.delimiter).toBe(',');
    expect(csvFallbackRes.errors).toEqual([]);
    expect(csvFallbackRes.rows[0]).toMatchObject({ employeeCode: 'NV01', displayName: 'Pham, Minh', unpaidLeaveDays: '1' });

    // Non-empty trailing cells beyond the header columns raise an extra_columns error, while empty trailing cells are tolerated.
    const extraColRes = parseTimekeepingSheet('Ma NV,Unpaid leave\nNV01,1,5\n', { month: '2026-08' });
    expect(extraColRes.rows).toEqual([]);
    expect(extraColRes.errors.map((err) => err.code)).toContain('extra_columns');

    const emptyTrailingRes = parseTimekeepingSheet('Ma NV,Unpaid leave,\nNV01,1,\n', { month: '2026-08' });
    expect(emptyTrailingRes.errors).toEqual([]);
    expect(emptyTrailingRes.rows[0]).toMatchObject({ employeeCode: 'NV01', unpaidLeaveDays: '1' });

    // Unquoted TSV containing commas in both a header label and a notes column selects tab via structural alignment.
    const unquotedTsvWithCommas = 'Employee code, ID\tUnpaid leave\tNotes\nE01\t2\ta,b,c,d,e,f,g,h\n';
    const tsvAlignedRes = parseTimekeepingSheet(unquotedTsvWithCommas, { month: '2026-08' });
    expect(tsvAlignedRes.delimiter).toBe('\t');
    expect(tsvAlignedRes.errors).toEqual([]);
    expect(tsvAlignedRes.rows[0]).toMatchObject({ employeeCode: 'E01', unpaidLeaveDays: '2' });

    // Balance, remaining, and carryover leave columns do not shadow monthly leave taken columns.
    const balanceBeforeTaken = parseTimekeepingSheet(
      'Employee Code\tAnnual leave balance\tAnnual leave\tUnpaid leave balance\tUnpaid leave\tSo du phep nam\nNV01\t10\t2\t5\t1\t8\n',
      { month: '2026-08' },
    );
    expect(balanceBeforeTaken.errors).toEqual([]);
    expect(balanceBeforeTaken.warnings).toEqual([]);
    expect(balanceBeforeTaken.rows[0]).toMatchObject({
      employeeCode: 'NV01',
      annualLeaveDays: '2',
      unpaidLeaveDays: '1',
    });

    const balanceOnly = parseTimekeepingSheet('Employee Code\tAnnual leave balance\tPhep nam con lai\nNV01\t10\t8\n', {
      month: '2026-08',
    });
    expect(balanceOnly.rows).toEqual([]);
    expect(balanceOnly.errors.map((err) => err.code)).toContain('missing_timekeeping_columns');

    // TSV rows with trailing empty cells preserve structural column alignment against commas inside header/notes.
    const tsvTrailingBlank = parseTimekeepingSheet('Employee code, ID\tUnpaid leave\tNotes\tAnnual leave\nE01\t2\ta,3\t\n', {
      month: '2026-08',
    });
    expect(tsvTrailingBlank.delimiter).toBe('\t');
    expect(tsvTrailingBlank.errors).toEqual([]);
    expect(tsvTrailingBlank.rows[0]).toMatchObject({
      employeeCode: 'E01',
      unpaidLeaveDays: '2',
      annualLeaveDays: '0',
    });

    // Total summary columns (e.g. "Total night OT hours") are ignored so they do not double-count detailed OT columns.
    const totalNightOt = parseTimekeepingSheet(
      'Employee Code\tNormal day night OT hours\tHoliday night OT hours\tTotal night OT hours\nNV01\t5\t3\t8\n',
      { month: '2026-08' },
    );
    expect(totalNightOt.errors).toEqual([]);
    expect(totalNightOt.rows[0]?.totalOvertimeHours).toBe('8');
    expect(totalNightOt.rows[0]?.overtime).toEqual([
      { dayKind: 'normal_day', night: true, hours: '5' },
      { dayKind: 'holiday', night: true, hours: '3' },
    ]);

    // A delimiter that collapses data rows into a single cell loses to tab and preserves extra_columns diagnostics.
    const tsvExtraWithCommaHeader = parseTimekeepingSheet('Employee code, ID\tUnpaid leave\nE01\t2\t5\n', {
      month: '2026-08',
    });
    expect(tsvExtraWithCommaHeader.delimiter).toBe('\t');
    expect(tsvExtraWithCommaHeader.rows).toEqual([]);
    expect(tsvExtraWithCommaHeader.errors.map((err) => err.code)).toContain('extra_columns');

    // Standalone monthly total columns ("Tong ngay nghi khong luong", "Total Normal Day OT Hours", standalone
    // "Total night OT hours") are preserved when detailed breakdown columns are absent, while non-total columns win when present.
    const vnTotals = parseTimekeepingSheet(
      'Ma NV\tNghi phep nam\tTong ngay nghi khong luong\tTong gio lam them ngay thuong\nNV01\t1\t2\t6\n',
      { month: '2026-08' },
    );
    expect(vnTotals.errors).toEqual([]);
    expect(vnTotals.warnings).toEqual([]);
    expect(vnTotals.rows[0]).toMatchObject({
      employeeCode: 'NV01',
      annualLeaveDays: '1',
      unpaidLeaveDays: '2',
      overtime: [{ dayKind: 'normal_day', night: false, hours: '6' }],
      totalOvertimeHours: '6',
    });

    const enTotals = parseTimekeepingSheet(
      'Employee Code\tAnnual Leave\tTotal Unpaid Leave Days\tTotal Normal Day OT Hours\tTotal night OT hours\nNV01\t1\t2\t6\t3\n',
      { month: '2026-08' },
    );
    expect(enTotals.errors).toEqual([]);
    expect(enTotals.rows[0]).toMatchObject({
      employeeCode: 'NV01',
      annualLeaveDays: '1',
      unpaidLeaveDays: '2',
      totalOvertimeHours: '9',
    });

    // Reject hour-unit leave columns and day-unit OT/night columns rather than misapplying numeric magnitudes.
    const hourLeave = parseTimekeepingSheet('Employee Code\tUnpaid leave hours\tNormal day OT hours\nNV01\t8\t4\n', {
      month: '2026-08',
    });
    expect(hourLeave.rows).toEqual([]);
    expect(hourLeave.columns.unpaidLeaveDays).toBeNull();
    expect(hourLeave.errors.map((e) => [e.code, e.column])).toEqual([['incompatible_column_unit', 'unpaidLeaveDays']]);

    const vnHourLeave = parseTimekeepingSheet('Ma NV\tGiờ nghỉ không lương\nNV01\t8\n', { month: '2026-08' });
    expect(vnHourLeave.rows).toEqual([]);
    expect(vnHourLeave.errors.map((e) => [e.code, e.column])).toEqual([['incompatible_column_unit', 'unpaidLeaveDays']]);

    const dayOt = parseTimekeepingSheet('Ma NV\tNormal day OT days\tNight work (days)\nNV01\t1\t2\n', {
      month: '2026-08',
    });
    expect(dayOt.rows).toEqual([]);
    expect(dayOt.errors.map((e) => [e.code, e.column])).toEqual([
      ['incompatible_column_unit', 'normalDayOtHours'],
      ['incompatible_column_unit', 'nightHours'],
    ]);

    // Delimiter selection rejects a candidate that leaves another delimiter embedded inside recognized header/data cells.
    const mixedCommaTsv = parseTimekeepingSheet(
      'Notes,a,b,c,d,e,f\nEmployee code, ID\tUnpaid leave, days\tNotes\nE01\t2\ta,3,c\n',
      { month: '2026-08' },
    );
    expect(mixedCommaTsv.delimiter).toBe('\t');
    expect(mixedCommaTsv.errors).toEqual([]);
    expect(mixedCommaTsv.rows[0]).toMatchObject({
      employeeCode: 'E01',
      unpaidLeaveDays: '2',
    });

    // Rate, multiplier, and monetary OT/leave columns do not shadow or duplicate hour/day quantity columns.
    const rateAndPay = parseTimekeepingSheet(
      'Employee Code\tNormal day OT rate\tHe so OT ngay thuong\tTien OT ngay thuong\tNormal day OT hours\tLam them ngay cuoi tuan\nNV01\t1.5\t1.5\t1800000\t8\t4\n',
      { month: '2026-08' },
    );
    expect(rateAndPay.errors).toEqual([]);
    expect(rateAndPay.warnings).toEqual([]);
    expect(rateAndPay.columns.normalDayOtHours).toBe(4);
    expect(rateAndPay.rows[0]?.overtime).toEqual([
      { dayKind: 'normal_day', night: false, hours: '8' },
      { dayKind: 'weekly_rest_day', night: false, hours: '4' },
    ]);

    const rateOnly = parseTimekeepingSheet('Employee Code\tNormal day OT rate\nNV01\t1.5\n', { month: '2026-08' });
    expect(rateOnly.rows).toEqual([]);
    expect(rateOnly.errors.map((e) => e.code)).toContain('missing_timekeeping_columns');

    // Percentage rate headers ("OT ngày thường (%)") are ignored, while tier-annotated hours headers ("OT 150%") remain usable.
    const percentRate = parseTimekeepingSheet(
      'Ma NV\tOT ngày thường (%)\tGiờ làm thêm ngày thường\nNV01\t150\t8\n',
      { month: '2026-08' },
    );
    expect(percentRate.errors).toEqual([]);
    expect(percentRate.warnings).toEqual([]);
    expect(percentRate.columns.normalDayOtHours).toBe(2);
    expect(percentRate.rows[0]?.overtime).toEqual([{ dayKind: 'normal_day', night: false, hours: '8' }]);

    // Reject minute/second unit columns instead of misinterpreting minutes as hours or days.
    const minuteColumns = parseTimekeepingSheet(
      'Employee Code\tNormal day OT (minutes)\tUnpaid leave (minutes)\tNghỉ không lương (phút)\nNV01\t120\t120\t60\n',
      { month: '2026-08' },
    );
    expect(minuteColumns.rows).toEqual([]);
    expect(minuteColumns.errors.map((e) => [e.code, e.column])).toEqual([
      ['incompatible_column_unit', 'normalDayOtHours'],
      ['incompatible_column_unit', 'unpaidLeaveDays'],
      ['incompatible_column_unit', 'unpaidLeaveDays'],
    ]);

    // Delimiter scoring penalizes residual tabs in recognized cells before overflowCount so structural TSV errors surface.
    const tsvExtraWithNotesComma = parseTimekeepingSheet('Employee code, ID\tUnpaid leave\nE01\t2\tNotes,3\n', {
      month: '2026-08',
    });
    expect(tsvExtraWithNotesComma.delimiter).toBe('\t');
    expect(tsvExtraWithNotesComma.rows).toEqual([]);
    expect(tsvExtraWithNotesComma.errors.map((e) => e.code)).toEqual(['extra_columns']);
  });
});
