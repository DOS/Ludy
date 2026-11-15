// SPDX-License-Identifier: AGPL-3.0-only
import { headerKey } from '../bank-statement-sheet.ts';
import { money, sum, toMoney } from '../money.ts';
import { PayrollRefusedError, type OvertimeDayKind, type OvertimeEntry, type RuleRef } from './calculator.ts';
import { PAYROLL_RULES } from './rules/index.ts';
import { ruleInForce, type PayrollRule } from './rule-types.ts';

type Decimal = ReturnType<typeof money>;

// Pure deterministic monthly timekeeping sheet parser (issue #3348, #2540 slice 1a): parses pasted TSV/CSV
// spreadsheets with Vietnamese (accented and ASCII) and English headers, validates non-negative decimals,
// flags duplicate employees and monthly overtime exceeding the dated Labor Code Art. 107 cap (40h), and produces
// OvertimeEntry[] and leave/night-work inputs ready for `hr.payroll.line.inputs.set`. Works 100% with AI off.

export const TIMEKEEPING_DELIMITERS = ['\t', ',', ';'] as const;
export type TimekeepingDelimiter = (typeof TIMEKEEPING_DELIMITERS)[number];

export const TIMEKEEPING_COLUMNS = [
  'employeeCode',
  'displayName',
  'unpaidLeaveDays',
  'annualLeaveDays',
  'personalPaidDays',
  'daysNotEmployed',
  'normalDayNightOtHours',
  'weeklyRestDayNightOtHours',
  'holidayNightOtHours',
  'nightOtHours',
  'normalDayOtHours',
  'weeklyRestDayOtHours',
  'holidayOtHours',
  'nightHours',
] as const;
export type TimekeepingColumn = (typeof TIMEKEEPING_COLUMNS)[number];

const NUMERIC_COLUMNS: readonly TimekeepingColumn[] = [
  'unpaidLeaveDays',
  'annualLeaveDays',
  'personalPaidDays',
  'daysNotEmployed',
  'normalDayNightOtHours',
  'weeklyRestDayNightOtHours',
  'holidayNightOtHours',
  'nightOtHours',
  'normalDayOtHours',
  'weeklyRestDayOtHours',
  'holidayOtHours',
  'nightHours',
];

// Claim order: specific compound headers (unpaid/personal leave before generic leave; day-kind night OT before
// generic night OT; night OT before ordinary night work; employee code before name) take precedence.
const CLAIM_ORDER: readonly TimekeepingColumn[] = [
  'employeeCode',
  'displayName',
  'unpaidLeaveDays',
  'personalPaidDays',
  'annualLeaveDays',
  'daysNotEmployed',
  'normalDayNightOtHours',
  'weeklyRestDayNightOtHours',
  'holidayNightOtHours',
  'nightOtHours',
  'normalDayOtHours',
  'weeklyRestDayOtHours',
  'holidayOtHours',
  'nightHours',
];

const HEADER_WORDS: Record<TimekeepingColumn, { contains: readonly string[]; exact?: readonly string[] }> = {
  employeeCode: {
    contains: ['ma nhan vien', 'ma nv', 'employee code', 'staff code', 'emp code'],
    exact: ['code', 'ma', 'nv'],
  },
  displayName: {
    contains: ['ho va ten', 'ho ten', 'ten nhan vien', 'ten nv', 'employee name', 'staff name', 'display name', 'full name'],
    exact: ['nhan vien', 'name', 'ten'],
  },
  unpaidLeaveDays: {
    contains: ['ngay nghi khong luong', 'nghi phep khong luong', 'nghi khong luong', 'khong luong', 'unpaid leave days', 'unpaid leave', 'unpaid days'],
    exact: ['unpaid', 'nkl'],
  },
  personalPaidDays: {
    contains: ['ngay nghi viec rieng', 'nghi phep viec rieng', 'nghi viec rieng', 'viec rieng huong luong', 'viec rieng', 'personal paid days', 'personal paid leave', 'personal paid', 'personal leave'],
    exact: ['nvr'],
  },
  annualLeaveDays: {
    contains: ['ngay nghi phep nam', 'nghi phep nam', 'ngay phep nam', 'phep nam', 'nghi phep', 'annual leave days', 'annual leave'],
    exact: ['phep', 'annual'],
  },
  daysNotEmployed: {
    contains: ['ngay chua lam viec', 'ngay khong lam viec', 'ngay chua lam', 'ngay sau nghi', 'days not employed', 'not employed days'],
    exact: ['not employed'],
  },
  normalDayNightOtHours: {
    contains: ['lam them ban dem ngay thuong', 'lam them dem ngay thuong', 'ot ban dem ngay thuong', 'ot dem ngay thuong', 'tang ca dem ngay thuong', 'normal day night ot', 'normal night ot'],
  },
  weeklyRestDayNightOtHours: {
    contains: ['lam them ban dem ngay nghi', 'lam them dem ngay nghi', 'ot ban dem ngay nghi', 'ot dem ngay nghi', 'tang ca dem ngay nghi', 'weekly rest day night ot', 'rest day night ot'],
  },
  holidayNightOtHours: {
    contains: ['lam them ban dem ngay le', 'lam them dem ngay le', 'ot ban dem ngay le', 'ot dem ngay le', 'tang ca dem ngay le', 'holiday night ot'],
  },
  nightOtHours: {
    contains: ['lam them ban dem', 'lam them dem', 'tang ca ban dem', 'tang ca dem', 'ot ban dem', 'ot dem', 'overtime night', 'night ot hours', 'night overtime hours', 'night overtime', 'night ot'],
  },
  normalDayOtHours: {
    contains: ['lam them ngay thuong', 'tang ca ngay thuong', 'ot ngay thuong', 'normal day ot hours', 'normal day overtime', 'normal day ot'],
  },
  weeklyRestDayOtHours: {
    contains: ['lam them ngay nghi hang tuan', 'lam them ngay nghi tuan', 'lam them ngay nghi', 'tang ca ngay nghi', 'ot ngay nghi', 'weekly rest day ot hours', 'weekly rest day overtime', 'weekly rest day ot', 'rest day ot'],
  },
  holidayOtHours: {
    contains: ['lam them ngay le', 'lam them ngay tet', 'tang ca ngay le', 'ot ngay le', 'holiday ot hours', 'holiday overtime', 'holiday ot'],
  },
  nightHours: {
    contains: ['gio lam ban dem', 'gio lam dem', 'lam viec ban dem', 'lam ban dem', 'ca dem', 'night work hours', 'night hours'],
  },
};

const TOTAL_SUMMARY_LABELS = new Set(['tong cong', 'tong', 'cong', 'total']);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LATEST_DATE_SENTINEL = '9999-12-31';
const CAMEL_BOUNDARY = new RegExp('([a-z0-9])([A-Z])', 'g');

export type TimekeepingIssueCode =
  | 'empty_input'
  | 'missing_header'
  | 'missing_employee_column'
  | 'missing_timekeeping_columns'
  | 'missing_employee_key'
  | 'invalid_number'
  | 'negative_number'
  | 'duplicate_employee'
  | 'duplicate_header_column'
  | 'overtime_cap_exceeded';

export interface TimekeepingIssue {
  severity: 'error' | 'warning';
  code: TimekeepingIssueCode;
  /** 1-based row number in the pasted sheet, or null for sheet-level errors. */
  rowNumber: number | null;
  column: TimekeepingColumn | null;
  header: string | null;
  employeeKey: string | null;
  value: string | null;
  limit: string | null;
  ruleId: string | null;
  message: string;
}

export interface TimekeepingPayrollInputs {
  unpaidLeaveDays: string;
  daysNotEmployed: string;
  /**
   * Normalized overtime entries (`OvertimeEntry[]`):
   * - `normalDayOtHours` -> `{ dayKind: 'normal_day', night: false, hours }`
   * - `weeklyRestDayOtHours` -> `{ dayKind: 'weekly_rest_day', night: false, hours }`
   * - `holidayOtHours` -> `{ dayKind: 'holiday', night: false, hours }`
   * - `nightOtHours` -> `{ dayKind: options.nightOtDayKind ?? 'normal_day', night: true, hours }` (or explicit
   *   `normalDayNightOtHours` / `weeklyRestDayNightOtHours` / `holidayNightOtHours` columns when present)
   *
   * Ordinary `nightHours` (regular hours worked 22:00-06:00, not overtime) maps to `nightHours` below, never into
   * `overtime`, and does not count toward the monthly overtime cap.
   */
  overtime: OvertimeEntry[];
  /** Ordinary night work hours (22:00-06:00 within regular working hours; +30% premium). */
  nightHours: string;
}

export interface TimekeepingRow {
  rowNumber: number;
  employeeKey: string;
  employeeCode: string | null;
  displayName: string | null;
  unpaidLeaveDays: string;
  annualLeaveDays: string;
  personalPaidDays: string;
  daysNotEmployed: string;
  overtime: OvertimeEntry[];
  nightHours: string;
  /** Sum of all overtime entry hours (excludes ordinary `nightHours`). */
  totalOvertimeHours: string;
  overtimeCapExceeded: boolean;
  /** Subset normalized directly for `hr.payroll.line.inputs.set`. */
  payrollInputs: TimekeepingPayrollInputs;
}

export interface TimekeepingSheetOptions {
  /** Pay month YYYY-MM used to look up the dated `overtime_caps` rule. */
  month?: string;
  /** Dated rule set; defaults to `PAYROLL_RULES`. */
  rules?: readonly PayrollRule[];
  /** Day kind assigned to a generic `nightOtHours` ("Lam them ban dem") column; defaults to `'normal_day'`. */
  nightOtDayKind?: OvertimeDayKind;
}

export interface TimekeepingSheetResult {
  delimiter: TimekeepingDelimiter;
  headerRow: number | null;
  columns: Record<TimekeepingColumn, number | null>;
  rows: TimekeepingRow[];
  errors: TimekeepingIssue[];
  warnings: TimekeepingIssue[];
  rulesUsed: RuleRef[];
}

/** Splits camelCase boundaries before normalizing accents and whitespace so both `unpaidLeaveDays` and `Ngày nghỉ không lương` match. */
export function timekeepingHeaderKey(text: string): string {
  return headerKey(text.replace(CAMEL_BOUNDARY, '$1 $2'));
}

function countOutsideQuotes(text: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') i++;
      else if (ch === '"') quoted = false;
      atStart = false;
    } else if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (ch === delimiter) {
      count++;
      atStart = true;
    } else if (ch === '\n') {
      atStart = true;
    } else if (ch !== '\r') {
      atStart = false;
    }
  }
  return count;
}

interface ParsedGridRow {
  rowNumber: number;
  cells: string[];
}

function parseDelimitedRows(body: string, delimiter: TimekeepingDelimiter): ParsedGridRow[] {
  const rows: ParsedGridRow[] = [];
  let cells: string[] = [];
  let value = '';
  let quoted = false;
  let rowNo = 1;
  const endCell = () => {
    cells.push(value);
    value = '';
  };
  const endRow = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) rows.push({ rowNumber: rowNo, cells });
    rowNo++;
    cells = [];
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        value += ch;
      }
    } else if (ch === '"' && value === '') {
      quoted = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      value += ch;
    }
  }
  if (value !== '' || cells.length > 0) endRow();
  return rows;
}

function emptyColumns(): Record<TimekeepingColumn, number | null> {
  return Object.fromEntries(TIMEKEEPING_COLUMNS.map((c) => [c, null])) as Record<TimekeepingColumn, number | null>;
}

function matchColumn(key: string): TimekeepingColumn | null {
  for (const field of CLAIM_ORDER) {
    const spec = HEADER_WORDS[field];
    if (spec.contains.some((w) => key === w || key.includes(w))) return field;
    if (spec.exact?.includes(key)) return field;
  }
  return null;
}

interface HeaderDetection {
  rowIndex: number;
  rowNumber: number;
  columns: Record<TimekeepingColumn, number | null>;
  duplicates: Array<{ column: TimekeepingColumn; header: string }>;
}

function detectHeader(rows: readonly ParsedGridRow[]): HeaderDetection | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row === undefined) continue;
    const headers = new Map<number, { raw: string; key: string }>();
    for (let col = 0; col < row.cells.length; col++) {
      const raw = (row.cells[col] ?? '').trim();
      const key = timekeepingHeaderKey(raw);
      if (key) headers.set(col, { raw, key });
    }
    const columns = emptyColumns();
    const taken = new Set<number>();
    for (const field of CLAIM_ORDER) {
      const spec = HEADER_WORDS[field];
      for (const word of spec.contains) {
        const hit = [...headers].find(([col, h]) => !taken.has(col) && (h.key === word || h.key.includes(word)));
        if (hit) {
          columns[field] = hit[0];
          taken.add(hit[0]);
          break;
        }
      }
      if (columns[field] === null && spec.exact) {
        const hit = [...headers].find(([col, h]) => !taken.has(col) && spec.exact?.includes(h.key));
        if (hit) {
          columns[field] = hit[0];
          taken.add(hit[0]);
        }
      }
    }
    const hasEmployee = columns.employeeCode !== null || columns.displayName !== null;
    const hasMetric = NUMERIC_COLUMNS.some((c) => columns[c] !== null);
    if (hasEmployee && hasMetric) {
      const duplicates: Array<{ column: TimekeepingColumn; header: string }> = [];
      for (const [col, h] of headers) {
        if (taken.has(col)) continue;
        const matched = matchColumn(h.key);
        if (matched !== null && columns[matched] !== null) {
          duplicates.push({ column: matched, header: h.raw });
        }
      }
      return { rowIndex, rowNumber: row.rowNumber, columns, duplicates };
    }
  }
  return null;
}

function makeIssue(
  severity: 'error' | 'warning',
  code: TimekeepingIssueCode,
  message: string,
  extra: Partial<Omit<TimekeepingIssue, 'severity' | 'code' | 'message'>> = {},
): TimekeepingIssue {
  return {
    severity,
    code,
    rowNumber: extra.rowNumber ?? null,
    column: extra.column ?? null,
    header: extra.header ?? null,
    employeeKey: extra.employeeKey ?? null,
    value: extra.value ?? null,
    limit: extra.limit ?? null,
    ruleId: extra.ruleId ?? null,
    message,
  };
}

function isSummaryRow(code: string | null, name: string | null): boolean {
  const codeKey = code ? timekeepingHeaderKey(code) : '';
  const nameKey = name ? timekeepingHeaderKey(name) : '';
  const codeIsTotal = codeKey !== '' && TOTAL_SUMMARY_LABELS.has(codeKey);
  const nameIsTotal = nameKey !== '' && TOTAL_SUMMARY_LABELS.has(nameKey);
  if (codeIsTotal && (nameKey === '' || nameIsTotal)) return true;
  if (nameIsTotal && codeKey === '') return true;
  return false;
}

/**
 * Pure deterministic parser for monthly timekeeping TSV/CSV exports.
 * Maps Vietnamese and English columns into leave counts, `OvertimeEntry[]`, and `payrollInputs`
 * ready for `hr.payroll.line.inputs.set`, while flagging malformed numbers, negative values,
 * duplicate employees, and monthly overtime totals exceeding the dated `overtime_caps` rule.
 */
export function parseTimekeepingSheet(text: string, options?: TimekeepingSheetOptions): TimekeepingSheetResult {
  const rules = options?.rules ?? PAYROLL_RULES;
  const nightOtDayKind: OvertimeDayKind = options?.nightOtDayKind ?? 'normal_day';
  if (options?.month !== undefined && !MONTH.test(options.month)) {
    throw new PayrollRefusedError('invalid_input', 'invalid timekeeping month: must be YYYY-MM');
  }
  const onDate = options?.month !== undefined ? `${options.month}-01` : LATEST_DATE_SENTINEL;
  const capRule = ruleInForce(rules, 'overtime_caps', 'default', onDate);
  if (capRule === undefined) {
    throw new PayrollRefusedError('no_rule_in_force', `no overtime_caps rule for default in force on ${onDate}`);
  }
  const rulesUsed: RuleRef[] = [
    { id: capRule.id, kind: capRule.kind, key: capRule.key, effectiveFrom: capRule.effectiveFrom, status: capRule.status },
  ];
  const monthlyCap = money(capRule.value.monthlyHours);

  const body = text.replace(/^\uFEFF/, '');
  if (body.trim() === '') {
    return {
      delimiter: '\t',
      headerRow: null,
      columns: emptyColumns(),
      rows: [],
      errors: [makeIssue('error', 'empty_input', 'Timekeeping sheet is empty')],
      warnings: [],
      rulesUsed,
    };
  }

  const candidates = [...TIMEKEEPING_DELIMITERS]
    .map((d) => ({ d, n: countOutsideQuotes(body, d) }))
    .sort((a, b) => b.n - a.n);

  let chosenDelimiter: TimekeepingDelimiter = candidates[0]?.d ?? '\t';
  let parsedRows = parseDelimitedRows(body, chosenDelimiter);
  let header = detectHeader(parsedRows);

  if (header === null) {
    for (const candidate of candidates) {
      const attemptRows = parseDelimitedRows(body, candidate.d);
      const attemptHeader = detectHeader(attemptRows);
      if (attemptHeader !== null) {
        chosenDelimiter = candidate.d;
        parsedRows = attemptRows;
        header = attemptHeader;
        break;
      }
    }
  }

  if (header === null) {
    const hasEmployeeAny = parsedRows.some((row) =>
      row.cells.some((c) => {
        const col = matchColumn(timekeepingHeaderKey(c));
        return col === 'employeeCode' || col === 'displayName';
      }),
    );
    const hasMetricAny = parsedRows.some((row) =>
      row.cells.some((c) => {
        const col = matchColumn(timekeepingHeaderKey(c));
        return col !== null && NUMERIC_COLUMNS.includes(col);
      }),
    );
    const code: TimekeepingIssueCode = hasEmployeeAny && !hasMetricAny
      ? 'missing_timekeeping_columns'
      : !hasEmployeeAny && hasMetricAny
        ? 'missing_employee_column'
        : 'missing_header';
    const message = code === 'missing_timekeeping_columns'
      ? 'No timekeeping leave or overtime columns were recognized in the header row'
      : code === 'missing_employee_column'
        ? 'No employee code or name column was recognized in the header row'
        : 'No valid timekeeping header row was found';
    return {
      delimiter: chosenDelimiter,
      headerRow: null,
      columns: emptyColumns(),
      rows: [],
      errors: [makeIssue('error', code, message)],
      warnings: [],
      rulesUsed,
    };
  }

  const headerCells = parsedRows[header.rowIndex]?.cells ?? [];
  const errors: TimekeepingIssue[] = [];
  const warnings: TimekeepingIssue[] = [];

  for (const dup of header.duplicates) {
    warnings.push(
      makeIssue('warning', 'duplicate_header_column', `Duplicate column "${dup.header}" ignored for ${dup.column}`, {
        rowNumber: header.rowNumber,
        column: dup.column,
        header: dup.header,
      }),
    );
  }

  const rows: TimekeepingRow[] = [];
  const seenKeys = new Map<string, number>();

  for (let i = header.rowIndex + 1; i < parsedRows.length; i++) {
    const gridRow = parsedRows[i];
    if (gridRow === undefined) continue;
    const rawCode = header.columns.employeeCode !== null ? (gridRow.cells[header.columns.employeeCode] ?? '').trim() : '';
    const rawName = header.columns.displayName !== null ? (gridRow.cells[header.columns.displayName] ?? '').trim() : '';
    const employeeCode = rawCode === '' ? null : rawCode;
    const displayName = rawName === '' ? null : rawName;

    if (isSummaryRow(employeeCode, displayName)) continue;

    let rowValid = true;
    let employeeKey = '';
    if (employeeCode !== null) {
      employeeKey = `code:${employeeCode.toLowerCase()}`;
    } else if (displayName !== null) {
      employeeKey = `name:${timekeepingHeaderKey(displayName) || displayName.toLowerCase()}`;
    } else {
      rowValid = false;
      errors.push(
        makeIssue('error', 'missing_employee_key', `Row ${gridRow.rowNumber}: missing employee code or name`, {
          rowNumber: gridRow.rowNumber,
          column: header.columns.employeeCode !== null ? 'employeeCode' : 'displayName',
        }),
      );
    }

    const displayKey = employeeCode ?? displayName;
    if (employeeKey !== '') {
      const priorRow = seenKeys.get(employeeKey);
      if (priorRow !== undefined) {
        rowValid = false;
        errors.push(
          makeIssue('error', 'duplicate_employee', `Row ${gridRow.rowNumber}: duplicate employee "${displayKey}" (first seen on row ${priorRow})`, {
            rowNumber: gridRow.rowNumber,
            column: employeeCode !== null ? 'employeeCode' : 'displayName',
            employeeKey: displayKey,
            value: displayKey,
          }),
        );
      } else {
        seenKeys.set(employeeKey, gridRow.rowNumber);
      }
    }

    const values = new Map<TimekeepingColumn, Decimal>();
    const zero = money(0);
    for (const col of NUMERIC_COLUMNS) {
      const colIdx = header.columns[col];
      if (colIdx === null) {
        values.set(col, zero);
        continue;
      }
      const rawCell = (gridRow.cells[colIdx] ?? '').trim();
      if (rawCell === '') {
        values.set(col, zero);
        continue;
      }
      let parsed: Decimal;
      try {
        parsed = money(rawCell);
      } catch {
        rowValid = false;
        errors.push(
          makeIssue('error', 'invalid_number', `Row ${gridRow.rowNumber}, column ${col}: invalid decimal value "${rawCell}"`, {
            rowNumber: gridRow.rowNumber,
            column: col,
            header: (headerCells[colIdx] ?? '').trim() || null,
            employeeKey: displayKey,
            value: rawCell,
          }),
        );
        values.set(col, zero);
        continue;
      }
      if (parsed.isNegative()) {
        rowValid = false;
        errors.push(
          makeIssue('error', 'negative_number', `Row ${gridRow.rowNumber}, column ${col}: negative value "${rawCell}" is not allowed`, {
            rowNumber: gridRow.rowNumber,
            column: col,
            header: (headerCells[colIdx] ?? '').trim() || null,
            employeeKey: displayKey,
            value: rawCell,
          }),
        );
        values.set(col, zero);
        continue;
      }
      values.set(col, parsed);
    }

    const getDec = (col: TimekeepingColumn): Decimal => values.get(col) ?? zero;
    const overtime: OvertimeEntry[] = [];
    const pushOt = (dayKind: OvertimeDayKind, night: boolean, hours: Decimal) => {
      if (hours.greaterThan(0)) overtime.push({ dayKind, night, hours: toMoney(hours) });
    };
    pushOt('normal_day', false, getDec('normalDayOtHours'));
    pushOt('weekly_rest_day', false, getDec('weeklyRestDayOtHours'));
    pushOt('holiday', false, getDec('holidayOtHours'));
    pushOt('normal_day', true, getDec('normalDayNightOtHours'));
    pushOt('weekly_rest_day', true, getDec('weeklyRestDayNightOtHours'));
    pushOt('holiday', true, getDec('holidayNightOtHours'));
    pushOt(nightOtDayKind, true, getDec('nightOtHours'));

    const totalOt = sum(overtime.map((o) => o.hours));
    const overtimeCapExceeded = totalOt.greaterThan(monthlyCap);

    if (!rowValid) continue;

    if (overtimeCapExceeded) {
      warnings.push(
        makeIssue(
          'warning',
          'overtime_cap_exceeded',
          `Row ${gridRow.rowNumber} (${displayKey}): monthly overtime ${toMoney(totalOt)}h exceeds ${capRule.value.monthlyHours}h cap (${capRule.id})`,
          {
            rowNumber: gridRow.rowNumber,
            employeeKey: displayKey,
            value: toMoney(totalOt),
            limit: capRule.value.monthlyHours,
            ruleId: capRule.id,
          },
        ),
      );
    }

    const unpaidLeaveDays = toMoney(getDec('unpaidLeaveDays'));
    const annualLeaveDays = toMoney(getDec('annualLeaveDays'));
    const personalPaidDays = toMoney(getDec('personalPaidDays'));
    const daysNotEmployed = toMoney(getDec('daysNotEmployed'));
    const nightHours = toMoney(getDec('nightHours'));

    rows.push({
      rowNumber: gridRow.rowNumber,
      employeeKey: displayKey ?? '',
      employeeCode,
      displayName,
      unpaidLeaveDays,
      annualLeaveDays,
      personalPaidDays,
      daysNotEmployed,
      overtime,
      nightHours,
      totalOvertimeHours: toMoney(totalOt),
      overtimeCapExceeded,
      payrollInputs: {
        unpaidLeaveDays,
        daysNotEmployed,
        overtime,
        nightHours,
      },
    });
  }

  return {
    delimiter: chosenDelimiter,
    headerRow: header.rowNumber,
    columns: header.columns,
    rows,
    errors,
    warnings,
    rulesUsed,
  };
}
