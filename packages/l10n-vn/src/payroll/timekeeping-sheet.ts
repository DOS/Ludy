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

// Classification helpers use whole-word / phrase matching in priority order (holiday before weekly rest day,
// unpaid personal leave before paid personal leave, night OT before ordinary night work, specific compound OT
// before generic night OT) and classify every column once so duplicates never fall back into another bucket.
interface HeaderMatch {
  field: TimekeepingColumn;
  specificity: 'phrase' | 'exact';
}

interface HeaderClassification {
  field: TimekeepingColumn;
  specificity: 'phrase' | 'exact';
  isSummaryTotal: boolean;
  unitMismatch: 'days' | 'hours' | null;
}

function hasPhrase(key: string, phrase: string): boolean {
  return key === phrase || key.includes(phrase);
}

function hasAnyPhrase(key: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => hasPhrase(key, p));
}

function hasWord(key: string, word: string): boolean {
  return ` ${key} `.includes(` ${word} `);
}

const TOTAL_SUMMARY_LABELS = new Set(['tong cong', 'tong so', 'tong', 'total', 'subtotal', 'grand total']);
const SUMMARY_TOTAL_WORDS = ['total', 'subtotal', 'sum', 'tong'] as const;
const HOUR_UNIT_WORDS = ['gio', 'hour', 'hours', 'hrs', 'hr', 'h'] as const;
const DAY_UNIT_WORDS = ['ngay', 'day', 'days'] as const;
const DAY_KIND_PHRASES = [
  'weekly rest day',
  'weekend day',
  'holiday day',
  'regular day',
  'normal day',
  'rest day',
  'weekday',
  'ngay nghi hang tuan',
  'ngay nghi cuoi tuan',
  'ngay nghi tuan',
  'ngay nghi le',
  'ngay cuoi tuan',
  'ngay binh thuong',
  'ngay nghi',
  'ngay thuong',
  'ngay le',
  'ngay tet',
] as const;
const DAY_UNIT_COLUMNS = new Set<TimekeepingColumn>([
  'unpaidLeaveDays',
  'annualLeaveDays',
  'personalPaidDays',
  'daysNotEmployed',
]);
const RATE_OR_MONEY_WORDS = [
  'rate',
  'multiplier',
  'factor',
  'ratio',
  'percent',
  'percentage',
  'amount',
  'amt',
  'pay',
  'payment',
  'wage',
  'wages',
  'salary',
  'cost',
  'price',
  'allowance',
  'bonus',
  'deduction',
  'money',
  'cash',
  'vnd',
  'usd',
  'tien',
  'gia',
] as const;
const RATE_OR_MONEY_PHRASES = [
  'he so',
  'ty le',
  'ti le',
  'phan tram',
  'don gia',
  'thanh tien',
  'tien luong',
  'muc luong',
  'tru luong',
  'phu cap',
  'tro cap',
  'khau tru',
  'giam tru',
  'chi phi',
  'tien thuong',
] as const;
const BALANCE_OR_QUOTA_WORDS = [
  'balance',
  'remaining',
  'carryover',
  'opening',
  'closing',
  'accrued',
  'entitlement',
  'entitled',
  'quota',
  'limit',
] as const;
const BALANCE_OR_QUOTA_PHRASES = [
  'so du',
  'du phep',
  'con lai',
  'phep ton',
  'ton phep',
  'ton dau',
  'ton cuoi',
  'dau ky',
  'cuoi ky',
  'chuyen ky',
  'chuyen sang',
  'tich luy',
  'dinh muc',
  'duoc huong',
  'quy phep',
  'han muc',
  'nam truoc',
  'ky truoc',
  'carry over',
  'carried over',
  'carried forward',
  'brought forward',
  'prior year',
  'previous year',
  'last year',
  'days left',
  'leave left',
  'hours left',
  'annual left',
  'ot cap',
  'overtime cap',
  'leave cap',
] as const;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LATEST_DATE_SENTINEL = '9999-12-31';
const CAMEL_BOUNDARY = new RegExp('([a-z0-9])([A-Z])', 'g');
const NON_NEGATIVE_DECIMAL = new RegExp('^\\d+(?:\\.\\d+)?$');
const NEGATIVE_DECIMAL = new RegExp('^-\\d+(?:\\.\\d+)?$');

export type TimekeepingIssueCode =
  | 'empty_input'
  | 'unclosed_quote'
  | 'malformed_quote'
  | 'missing_header'
  | 'missing_employee_column'
  | 'missing_timekeeping_columns'
  | 'missing_employee_key'
  | 'invalid_number'
  | 'negative_number'
  | 'extra_columns'
  | 'duplicate_employee'
  | 'duplicate_header_column'
  | 'incompatible_column_unit'
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
   * `overtime`, and does not count toward the monthly overtime cap. Numeric values use canonical decimal strings from
   * `toMoney()` (callers writing to `hr.payroll.line.inputs.set` should keep day entries within `zHrDays` and hours
   * within `zHours`).
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

interface DelimitedParseResult {
  rows: ParsedGridRow[];
  quoteError: { code: 'unclosed_quote' | 'malformed_quote'; rowNumber: number } | null;
}

function parseDelimitedRows(body: string, delimiter: TimekeepingDelimiter): DelimitedParseResult {
  const rows: ParsedGridRow[] = [];
  let cells: string[] = [];
  let value = '';
  let quoted = false;
  let justClosedQuote = false;
  let quoteStartRow: number | null = null;
  let rowNo = 1;
  const endCell = () => {
    cells.push(value);
    value = '';
    justClosedQuote = false;
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
        justClosedQuote = true;
      } else {
        value += ch;
      }
    } else if (justClosedQuote) {
      if (ch === delimiter) {
        endCell();
      } else if (ch === '\n') {
        endRow();
      } else if (ch === '\r') {
        // CR precedes LF; ignore until newline or EOF.
      } else if (ch === ' ') {
        // Tolerate trailing space after closing quote before delimiter/newline.
      } else {
        return { rows, quoteError: { code: 'unclosed_quote', rowNumber: quoteStartRow ?? rowNo } };
      }
    } else if (ch === '"' && value === '') {
      quoted = true;
      quoteStartRow = rowNo;
    } else if (ch === '"') {
      return { rows, quoteError: { code: 'malformed_quote', rowNumber: rowNo } };
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      value += ch;
    }
  }
  if (quoted) {
    return { rows, quoteError: { code: 'unclosed_quote', rowNumber: quoteStartRow ?? rowNo } };
  }
  if (value !== '' || cells.length > 0) endRow();
  return { rows, quoteError: null };
}

function emptyColumns(): Record<TimekeepingColumn, number | null> {
  return Object.fromEntries(TIMEKEEPING_COLUMNS.map((c) => [c, null])) as Record<TimekeepingColumn, number | null>;
}

function isBalanceOrQuotaHeader(key: string): boolean {
  return BALANCE_OR_QUOTA_WORDS.some((w) => hasWord(key, w)) || hasAnyPhrase(key, BALANCE_OR_QUOTA_PHRASES);
}

function isRateOrMoneyHeader(key: string): boolean {
  return RATE_OR_MONEY_WORDS.some((w) => hasWord(key, w)) || hasAnyPhrase(key, RATE_OR_MONEY_PHRASES);
}

function hasUnitMismatch(field: TimekeepingColumn, key: string): 'days' | 'hours' | null {
  if (!NUMERIC_COLUMNS.includes(field)) return null;
  if (DAY_UNIT_COLUMNS.has(field)) {
    return HOUR_UNIT_WORDS.some((w) => hasWord(key, w)) ? 'days' : null;
  }
  let stripped = key;
  for (const phrase of DAY_KIND_PHRASES) {
    stripped = stripped.replaceAll(phrase, ' ');
  }
  stripped = stripped.trim().replace(/\s+/g, ' ');
  return DAY_UNIT_WORDS.some((w) => hasWord(stripped, w)) ? 'hours' : null;
}

function matchHeaderField(key: string): HeaderMatch | null {
  if (hasAnyPhrase(key, ['ma nhan vien', 'ma nv', 'employee code', 'staff code', 'emp code', 'employee id', 'staff id'])) {
    return { field: 'employeeCode', specificity: 'phrase' };
  }
  if (key === 'code' || key === 'ma' || key === 'nv') {
    return { field: 'employeeCode', specificity: 'exact' };
  }

  if (hasAnyPhrase(key, ['ho va ten', 'ho ten', 'ten nhan vien', 'ten nv', 'employee name', 'staff name', 'display name', 'full name'])) {
    return { field: 'displayName', specificity: 'phrase' };
  }
  if (key === 'nhan vien' || key === 'name' || key === 'ten') {
    return { field: 'displayName', specificity: 'exact' };
  }

  // Ignore balance/quota headers and multiplier/rate/monetary columns (e.g. "Normal day OT rate",
  // "Tien lam them", "He so OT") so rates or amounts are never parsed as hours or leave days.
  if (isBalanceOrQuotaHeader(key) || isRateOrMoneyHeader(key)) {
    return null;
  }

  // Unpaid leave (including unpaid personal leave "Nghi viec rieng khong huong luong") takes priority over paid personal leave.
  if (hasAnyPhrase(key, ['khong huong luong', 'khong luong', 'unpaid'])) {
    return { field: 'unpaidLeaveDays', specificity: 'phrase' };
  }
  if (key === 'nkl') {
    return { field: 'unpaidLeaveDays', specificity: 'exact' };
  }

  if (hasAnyPhrase(key, ['viec rieng', 'personal paid', 'personal leave'])) {
    return { field: 'personalPaidDays', specificity: 'phrase' };
  }
  if (key === 'nvr') {
    return { field: 'personalPaidDays', specificity: 'exact' };
  }

  if (hasAnyPhrase(key, ['ngay chua lam', 'ngay khong lam viec', 'ngay sau nghi', 'not employed'])) {
    return { field: 'daysNotEmployed', specificity: 'phrase' };
  }

  const isOt = hasAnyPhrase(key, ['lam them', 'tang ca', 'tang gio', 'overtime']) || hasWord(key, 'ot');

  if (!isOt) {
    if (hasAnyPhrase(key, ['phep nam', 'nghi phep', 'annual leave'])) {
      return { field: 'annualLeaveDays', specificity: 'phrase' };
    }
    if (key === 'phep' || key === 'annual') {
      return { field: 'annualLeaveDays', specificity: 'exact' };
    }
    if (hasAnyPhrase(key, ['gio lam ban dem', 'gio lam dem', 'lam viec ban dem', 'lam ban dem', 'ca dem', 'night work', 'night hours', 'night shift'])) {
      return { field: 'nightHours', specificity: 'phrase' };
    }
    if (key === 'dem' || key === 'night') {
      return { field: 'nightHours', specificity: 'exact' };
    }
    return null;
  }

  const hasNight = hasAnyPhrase(key, ['ban dem', 'ca dem']) || hasWord(key, 'dem') || hasWord(key, 'night');
  // Check public holidays ("ngay nghi le", "ngay le", "tet") before generic "ngay nghi" weekly rest day.
  const hasHoliday = hasWord(key, 'le') || hasWord(key, 'tet') || hasAnyPhrase(key, ['nghi le', 'ngay le', 'nghi tet', 'ngay tet', 'holiday']);
  if (hasHoliday) {
    return { field: hasNight ? 'holidayNightOtHours' : 'holidayOtHours', specificity: 'phrase' };
  }

  const hasRestDay = hasAnyPhrase(key, ['ngay nghi', 'hang tuan', 'cuoi tuan', 'rest day', 'weekly rest', 'weekend']);
  if (hasRestDay) {
    return { field: hasNight ? 'weeklyRestDayNightOtHours' : 'weeklyRestDayOtHours', specificity: 'phrase' };
  }

  const hasNormalDay = hasAnyPhrase(key, ['ngay thuong', 'binh thuong', 'normal day', 'weekday', 'regular day']) || hasWord(key, 'normal');
  if (hasNormalDay) {
    return { field: hasNight ? 'normalDayNightOtHours' : 'normalDayOtHours', specificity: 'phrase' };
  }

  if (hasNight) {
    return { field: 'nightOtHours', specificity: 'phrase' };
  }

  return null;
}

function classifyHeader(key: string): HeaderClassification | null {
  const matched = matchHeaderField(key);
  if (matched === null) return null;
  return {
    field: matched.field,
    specificity: matched.specificity,
    isSummaryTotal: SUMMARY_TOTAL_WORDS.some((w) => hasWord(key, w)),
    unitMismatch: hasUnitMismatch(matched.field, key),
  };
}

interface UnitMismatchColumn {
  col: number;
  column: TimekeepingColumn;
  header: string;
  expectedUnit: 'days' | 'hours';
}

interface HeaderDetection {
  rowIndex: number;
  rowNumber: number;
  columns: Record<TimekeepingColumn, number | null>;
  duplicates: Array<{ column: TimekeepingColumn; header: string }>;
  unitMismatches: UnitMismatchColumn[];
}

function detectHeader(rows: readonly ParsedGridRow[]): HeaderDetection | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row === undefined) continue;
    const byField = new Map<
      TimekeepingColumn,
      Array<{ col: number; raw: string; specificity: 'phrase' | 'exact'; isSummaryTotal: boolean }>
    >();
    const unitMismatches: UnitMismatchColumn[] = [];
    for (let col = 0; col < row.cells.length; col++) {
      const raw = (row.cells[col] ?? '').trim();
      const key = timekeepingHeaderKey(raw);
      if (!key) continue;
      const classified = classifyHeader(key);
      if (classified === null) continue;
      if (classified.unitMismatch !== null) {
        unitMismatches.push({
          col,
          column: classified.field,
          header: raw,
          expectedUnit: classified.unitMismatch,
        });
        continue;
      }
      const bucket = byField.get(classified.field) ?? [];
      bucket.push({
        col,
        raw,
        specificity: classified.specificity,
        isSummaryTotal: classified.isSummaryTotal,
      });
      byField.set(classified.field, bucket);
    }

    const hasSpecificNightOt =
      byField.has('normalDayNightOtHours') ||
      byField.has('weeklyRestDayNightOtHours') ||
      byField.has('holidayNightOtHours');
    const columns = emptyColumns();
    const duplicates: Array<{ column: TimekeepingColumn; header: string }> = [];
    for (const [field, hits] of byField) {
      // Ignore derived total columns (e.g. "Total night OT hours") when detailed breakdowns exist,
      // while preserving standalone monthly summary columns ("Tong ngay nghi khong luong").
      const withoutShadowedTotal =
        field === 'nightOtHours' && hasSpecificNightOt ? hits.filter((h) => !h.isSummaryTotal) : hits;
      if (withoutShadowedTotal.length === 0) continue;
      const effectiveHits = withoutShadowedTotal.some((h) => !h.isSummaryTotal)
        ? withoutShadowedTotal.filter((h) => !h.isSummaryTotal)
        : withoutShadowedTotal;
      const ordered = [...effectiveHits].sort((a, b) => {
        if (a.specificity !== b.specificity) return a.specificity === 'phrase' ? -1 : 1;
        return a.col - b.col;
      });
      const primary = ordered[0];
      if (primary === undefined) continue;
      columns[field] = primary.col;
      for (const extra of ordered.slice(1)) {
        duplicates.push({ column: field, header: extra.raw });
      }
    }

    const hasEmployee = columns.employeeCode !== null || columns.displayName !== null;
    const hasMetric = NUMERIC_COLUMNS.some((c) => columns[c] !== null);
    if (hasEmployee && (hasMetric || unitMismatches.length > 0)) {
      return { rowIndex, rowNumber: row.rowNumber, columns, duplicates, unitMismatches };
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

function isSummaryRow(code: string | null, name: string | null, cells: readonly string[]): boolean {
  const codeKey = code ? timekeepingHeaderKey(code) : '';
  const nameKey = name ? timekeepingHeaderKey(name) : '';
  const codeIsTotal = codeKey !== '' && TOTAL_SUMMARY_LABELS.has(codeKey);
  const nameIsTotal = nameKey !== '' && TOTAL_SUMMARY_LABELS.has(nameKey);
  if (codeIsTotal && (nameKey === '' || nameIsTotal)) return true;
  if (nameIsTotal && codeKey === '') return true;
  if (codeKey === '' && nameKey === '') {
    return cells.some((c) => TOTAL_SUMMARY_LABELS.has(timekeepingHeaderKey(c)));
  }
  return false;
}

function trimmedCellCount(cells: readonly string[]): number {
  let len = cells.length;
  while (len > 0 && (cells[len - 1] ?? '').trim() === '') {
    len -= 1;
  }
  return len;
}

function scoreDelimiterAttempt(
  rows: readonly ParsedGridRow[],
  header: HeaderDetection | null,
  delimiter: TimekeepingDelimiter,
): { unsplitCount: number; overflowCount: number; residualCount: number; alignedCount: number; recognizedCount: number } {
  if (header === null) {
    return {
      unsplitCount: Number.MAX_SAFE_INTEGER,
      overflowCount: Number.MAX_SAFE_INTEGER,
      residualCount: Number.MAX_SAFE_INTEGER,
      alignedCount: 0,
      recognizedCount: 0,
    };
  }
  const headerCells = rows[header.rowIndex]?.cells ?? [];
  const headerRawLen = headerCells.length;
  const headerTrimLen = trimmedCellCount(headerCells);
  const allRecognizedCols = [
    ...Object.values(header.columns).filter((v): v is number => v !== null),
    ...header.unitMismatches.map((m) => m.col),
  ];
  const strictValueCols = [
    ...(header.columns.employeeCode !== null ? [header.columns.employeeCode] : []),
    ...NUMERIC_COLUMNS.map((c) => header.columns[c]).filter((v): v is number => v !== null),
  ];
  const otherDelimiters = TIMEKEEPING_DELIMITERS.filter((d) => d !== delimiter);
  const recognizedCount = allRecognizedCols.length;
  let unsplitCount = 0;
  let overflowCount = 0;
  let residualCount = 0;
  let alignedCount = 0;

  if (delimiter !== '\t') {
    for (const colIdx of allRecognizedCols) {
      if ((headerCells[colIdx] ?? '').includes('\t')) {
        residualCount += 1;
      }
    }
  }

  for (let i = header.rowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    const rowTrimLen = trimmedCellCount(row.cells);
    if (rowTrimLen === 0) continue;
    if (headerRawLen > 1 && row.cells.length <= 1) {
      unsplitCount += 1;
    }
    if (rowTrimLen > headerTrimLen) {
      overflowCount += 1;
    } else if (row.cells.length === headerRawLen) {
      alignedCount += 1;
    }
    if (delimiter !== '\t') {
      for (const colIdx of allRecognizedCols) {
        if ((row.cells[colIdx] ?? '').includes('\t')) {
          residualCount += 1;
        }
      }
    }
    for (const colIdx of strictValueCols) {
      const cell = (row.cells[colIdx] ?? '').trim();
      if (cell !== '' && otherDelimiters.some((other) => cell.includes(other))) {
        residualCount += 1;
      }
    }
  }
  return { unsplitCount, overflowCount, residualCount, alignedCount, recognizedCount };
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

  const attempts = candidates.map((c) => {
    const attemptParsed = parseDelimitedRows(body, c.d);
    const attemptHeader = detectHeader(attemptParsed.rows);
    const score = scoreDelimiterAttempt(attemptParsed.rows, attemptHeader, c.d);
    return { delimiter: c.d, count: c.n, parsed: attemptParsed, header: attemptHeader, score };
  });

  const compareScored = (a: (typeof attempts)[number], b: (typeof attempts)[number]): number =>
    a.score.unsplitCount - b.score.unsplitCount ||
    a.score.overflowCount - b.score.overflowCount ||
    a.score.residualCount - b.score.residualCount ||
    b.score.alignedCount - a.score.alignedCount ||
    b.score.recognizedCount - a.score.recognizedCount ||
    TIMEKEEPING_DELIMITERS.indexOf(a.delimiter) - TIMEKEEPING_DELIMITERS.indexOf(b.delimiter);

  const cleanHeaders = attempts.filter((a) => a.parsed.quoteError === null && a.header !== null).sort(compareScored);
  const brokenHeaders = attempts.filter((a) => a.parsed.quoteError !== null && a.header !== null).sort(compareScored);

  const selected =
    cleanHeaders[0] ??
    brokenHeaders[0] ??
    attempts.find((a) => a.parsed.quoteError === null && a.count > 0) ??
    attempts.find((a) => a.parsed.quoteError === null) ??
    attempts[0];

  const chosenDelimiter: TimekeepingDelimiter = selected?.delimiter ?? '\t';
  const parsed: DelimitedParseResult = selected?.parsed ?? { rows: [], quoteError: null };
  const header: HeaderDetection | null = selected?.header ?? null;

  if (parsed.quoteError !== null) {
    const quoteMsg =
      parsed.quoteError.code === 'unclosed_quote'
        ? `Row ${parsed.quoteError.rowNumber}: unclosed quoted cell`
        : `Row ${parsed.quoteError.rowNumber}: unexpected quote inside unquoted cell`;
    return {
      delimiter: chosenDelimiter,
      headerRow: header?.rowNumber ?? null,
      columns: header?.columns ?? emptyColumns(),
      rows: [],
      errors: [makeIssue('error', parsed.quoteError.code, quoteMsg, { rowNumber: parsed.quoteError.rowNumber })],
      warnings: [],
      rulesUsed,
    };
  }

  const parsedRows = parsed.rows;
  if (header === null) {
    const hasEmployeeAny = parsedRows.some((row) =>
      row.cells.some((c) => {
        const col = classifyHeader(timekeepingHeaderKey(c))?.field ?? null;
        return col === 'employeeCode' || col === 'displayName';
      }),
    );
    const hasMetricAny = parsedRows.some((row) =>
      row.cells.some((c) => {
        const col = classifyHeader(timekeepingHeaderKey(c))?.field ?? null;
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
  const effectiveHeaderLength = trimmedCellCount(headerCells);
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

  if (header.unitMismatches.length > 0) {
    for (const mismatch of header.unitMismatches) {
      errors.push(
        makeIssue(
          'error',
          'incompatible_column_unit',
          `Row ${header.rowNumber}, column "${mismatch.header}": ${mismatch.column} expects values in ${mismatch.expectedUnit}`,
          {
            rowNumber: header.rowNumber,
            column: mismatch.column,
            header: mismatch.header,
          },
        ),
      );
    }
    return {
      delimiter: chosenDelimiter,
      headerRow: header.rowNumber,
      columns: header.columns,
      rows: [],
      errors,
      warnings,
      rulesUsed,
    };
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

    if (isSummaryRow(employeeCode, displayName, gridRow.cells)) continue;

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
    if (gridRow.cells.length > effectiveHeaderLength) {
      const extraNonEmpty = gridRow.cells.slice(effectiveHeaderLength).find((c) => c.trim() !== '');
      if (extraNonEmpty !== undefined) {
        rowValid = false;
        errors.push(
          makeIssue(
            'error',
            'extra_columns',
            `Row ${gridRow.rowNumber}: extra column value "${extraNonEmpty.trim()}" beyond ${effectiveHeaderLength} header column(s)`,
            {
              rowNumber: gridRow.rowNumber,
              employeeKey: displayKey,
              value: extraNonEmpty.trim(),
            },
          ),
        );
      }
    }
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
      if (NEGATIVE_DECIMAL.test(rawCell)) {
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
      if (!NON_NEGATIVE_DECIMAL.test(rawCell)) {
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
      values.set(col, money(rawCell));
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
