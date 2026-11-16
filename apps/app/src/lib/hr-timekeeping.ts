// SPDX-License-Identifier: AGPL-3.0-only
import { parseTimekeepingSheet, type TimekeepingIssue, type TimekeepingRow } from '@crove/l10n-vn';
import { zHrDays, zHrHours, type HrLineView, type HrRunImportTimekeeping } from '@crove/kernel-contract';

export type TimekeepingMatchStatus = 'matched' | 'unmatched' | 'ambiguous' | 'duplicate_target' | 'invalid_values';

export type TimekeepingImportPayloadRow = HrRunImportTimekeeping['rows'][number];

export interface TimekeepingPreviewRow {
  row: TimekeepingRow;
  status: TimekeepingMatchStatus;
  matchedLineId: string | null;
  matchedEmployeeId: string | null;
  matchedName: string | null;
  payload: TimekeepingImportPayloadRow | null;
}

export interface TimekeepingPreview {
  rows: TimekeepingPreviewRow[];
  validRows: TimekeepingImportPayloadRow[];
  errors: TimekeepingIssue[];
  warnings: TimekeepingIssue[];
  matchedCount: number;
  unmatchedCount: number;
  ambiguousCount: number;
  duplicateTargetCount: number;
  invalidValueCount: number;
  tooManyRows: boolean;
  canApply: boolean;
}

export const HR_TIMEKEEPING_MAX_ROWS = 200;

export function normalizeEmployeeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function validRowValues(row: TimekeepingRow): boolean {
  const { unpaidLeaveDays, daysNotEmployed, nightHours, overtime } = row.payrollInputs;
  return (
    zHrDays.safeParse(unpaidLeaveDays).success &&
    zHrDays.safeParse(daysNotEmployed).success &&
    zHrHours.safeParse(nightHours).success &&
    overtime.length <= 30 &&
    overtime.every((entry) => zHrHours.safeParse(entry.hours).success)
  );
}

type CandidateMatch =
  | { kind: 'line'; line: HrLineView }
  | { kind: 'ambiguous' }
  | { kind: 'unmatched' };

/**
 * Matches parsed timekeeping rows against draft pay lines deterministically:
 * `employeeCode === line.employeeId` first, else exact normalized `displayName`
 * when unique among pay lines; never guesses on duplicates or mismatches.
 */
export function buildTimekeepingPreview(text: string, month: string, lines: readonly HrLineView[]): TimekeepingPreview {
  const sheet = parseTimekeepingSheet(text, { month });
  const payLines = lines.filter((line) => line.kind === 'pay');
  const byEmployeeId = new Map<string, HrLineView>();
  const byNormalizedName = new Map<string, HrLineView[]>();
  for (const line of payLines) {
    byEmployeeId.set(line.employeeId, line);
    const key = normalizeEmployeeName(line.employeeName);
    if (key !== '') {
      const existing = byNormalizedName.get(key) ?? [];
      existing.push(line);
      byNormalizedName.set(key, existing);
    }
  }

  const resolved: CandidateMatch[] = sheet.rows.map((row) => {
    const code = row.employeeCode?.trim() ?? '';
    if (code !== '') {
      const direct = byEmployeeId.get(code);
      if (direct) return { kind: 'line', line: direct };
    }
    const name = row.displayName?.trim() ?? '';
    if (name !== '') {
      const candidates = byNormalizedName.get(normalizeEmployeeName(name)) ?? [];
      if (candidates.length === 1) return { kind: 'line', line: candidates[0] as HrLineView };
      if (candidates.length > 1) return { kind: 'ambiguous' };
    }
    return { kind: 'unmatched' };
  });

  const targetCounts = new Map<string, number>();
  for (const match of resolved) {
    if (match.kind === 'line') {
      targetCounts.set(match.line.id, (targetCounts.get(match.line.id) ?? 0) + 1);
    }
  }

  const rows: TimekeepingPreviewRow[] = [];
  const validRows: TimekeepingImportPayloadRow[] = [];
  let matchedCount = 0;
  let unmatchedCount = 0;
  let ambiguousCount = 0;
  let duplicateTargetCount = 0;
  let invalidValueCount = 0;

  sheet.rows.forEach((row, index) => {
    const match = resolved[index]!;
    if (match.kind === 'ambiguous') {
      ambiguousCount += 1;
      rows.push({ row, status: 'ambiguous', matchedLineId: null, matchedEmployeeId: null, matchedName: null, payload: null });
      return;
    }
    if (match.kind === 'unmatched') {
      unmatchedCount += 1;
      rows.push({ row, status: 'unmatched', matchedLineId: null, matchedEmployeeId: null, matchedName: null, payload: null });
      return;
    }
    const { line } = match;
    if ((targetCounts.get(line.id) ?? 0) > 1) {
      duplicateTargetCount += 1;
      rows.push({ row, status: 'duplicate_target', matchedLineId: line.id, matchedEmployeeId: line.employeeId, matchedName: line.employeeName, payload: null });
      return;
    }
    if (!validRowValues(row)) {
      invalidValueCount += 1;
      rows.push({ row, status: 'invalid_values', matchedLineId: line.id, matchedEmployeeId: line.employeeId, matchedName: line.employeeName, payload: null });
      return;
    }
    const payload: TimekeepingImportPayloadRow = {
      lineId: line.id,
      unpaidLeaveDays: row.payrollInputs.unpaidLeaveDays,
      daysNotEmployed: row.payrollInputs.daysNotEmployed,
      nightHours: row.payrollInputs.nightHours,
      overtime: row.payrollInputs.overtime,
    };
    matchedCount += 1;
    validRows.push(payload);
    rows.push({ row, status: 'matched', matchedLineId: line.id, matchedEmployeeId: line.employeeId, matchedName: line.employeeName, payload });
  });

  const tooManyRows = validRows.length > HR_TIMEKEEPING_MAX_ROWS;
  const canApply = validRows.length > 0 && !tooManyRows && sheet.errors.length === 0 && ambiguousCount === 0 && duplicateTargetCount === 0 && invalidValueCount === 0;

  return {
    rows,
    validRows,
    errors: sheet.errors,
    warnings: sheet.warnings,
    matchedCount,
    unmatchedCount,
    ambiguousCount,
    duplicateTargetCount,
    invalidValueCount,
    tooManyRows,
    canApply,
  };
}
