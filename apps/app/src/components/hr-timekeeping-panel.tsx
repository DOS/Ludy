// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { HrLineView } from '@ludy/kernel-contract';
import type { TimekeepingIssue } from '@ludy/l10n-vn';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { Textarea } from '@ludy/ui/components/textarea';
import { DataTable, ErrorText } from './ui.tsx';
import { client, errorMessage } from '../lib/api.ts';
import { HR_TIMEKEEPING_MAX_ROWS, buildTimekeepingPreview, type TimekeepingMatchStatus } from '../lib/hr-timekeeping.ts';

const STATUS_VARIANT: Record<TimekeepingMatchStatus, 'success' | 'secondary' | 'warning' | 'destructive'> = {
  matched: 'success',
  unmatched: 'secondary',
  ambiguous: 'warning',
  duplicate_target: 'destructive',
  invalid_values: 'destructive',
};

const NUM = 'text-right tabular-nums';

function issueText(t: ReturnType<typeof useTranslations<'hrPayroll'>>, issue: TimekeepingIssue): string {
  const row = String(issue.rowNumber ?? 0);
  const column = issue.header ?? issue.column ?? '';
  const value = issue.value ?? '';
  const employee = issue.employeeKey ?? issue.value ?? '';
  switch (issue.code) {
    case 'empty_input':
      return t('timekeeping.issues.empty_input');
    case 'unclosed_quote':
      return t('timekeeping.issues.unclosed_quote', { row });
    case 'malformed_quote':
      return t('timekeeping.issues.malformed_quote', { row });
    case 'missing_header':
      return t('timekeeping.issues.missing_header');
    case 'missing_employee_column':
      return t('timekeeping.issues.missing_employee_column');
    case 'missing_timekeeping_columns':
      return t('timekeeping.issues.missing_timekeeping_columns');
    case 'missing_employee_key':
      return t('timekeeping.issues.missing_employee_key', { row });
    case 'invalid_number':
      return t('timekeeping.issues.invalid_number', { row, column, value });
    case 'negative_number':
      return t('timekeeping.issues.negative_number', { row, column, value });
    case 'extra_columns':
      return t('timekeeping.issues.extra_columns', { row, value });
    case 'duplicate_employee':
      return t('timekeeping.issues.duplicate_employee', { row, employee });
    case 'duplicate_header_column':
      return t('timekeeping.issues.duplicate_header_column', { column });
    case 'incompatible_column_unit':
      return t('timekeeping.issues.incompatible_column_unit', { row, column });
    case 'overtime_cap_exceeded':
      return t('timekeeping.issues.overtime_cap_exceeded', { row, employee, actual: value, limit: issue.limit ?? '40' });
  }
}

export function TimekeepingImportPanel({
  runId,
  month,
  lines,
  initialText = '',
  onImported,
  onClose,
}: {
  runId: string;
  month: string;
  lines: readonly HrLineView[];
  initialText?: string;
  onImported: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations('hrPayroll');
  const [raw, setRaw] = useState(initialText);
  const revRef = useRef(0);
  const preview = raw.trim() === '' ? null : buildTimekeepingPreview(raw, month, lines);

  const apply = useMutation({
    mutationFn: () => {
      if (!preview || !preview.canApply) throw new Error('no valid timekeeping rows');
      return client.hr.payroll.runs.importTimekeeping({ runId, rows: preview.validRows });
    },
    onSuccess: async () => {
      await onImported();
      revRef.current += 1;
      setRaw('');
      onClose();
    },
  });

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const rev = ++revRef.current;
    const text = await file.text();
    if (revRef.current === rev) setRaw(text);
  };

  return (
    <Card className="mb-6 block p-4" aria-label={t('timekeeping.title')} data-testid="hr-timekeeping-import">
      <h3 className="text-base font-semibold">{t('timekeeping.title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('timekeeping.hint')}</p>
      <div className="mt-3 space-y-3">
        <div className="space-y-1">
          <Label htmlFor="hr-timekeeping-file">{t('timekeeping.fileLabel')}</Label>
          <Input
            id="hr-timekeeping-file"
            type="file"
            className="max-w-md"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              void pickFile(file);
            }}
            data-testid="hr-timekeeping-file"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-timekeeping-text">{t('timekeeping.textLabel')}</Label>
          <Textarea
            id="hr-timekeeping-text"
            rows={5}
            value={raw}
            placeholder={t('timekeeping.placeholder')}
            onChange={(e) => {
              revRef.current += 1;
              setRaw(e.target.value);
            }}
            data-testid="hr-timekeeping-text"
          />
        </div>
      </div>

      {preview && (
        <div className="mt-4 space-y-3" data-testid="hr-timekeeping-preview">
          <p className="text-xs text-muted-foreground">
            {t('timekeeping.summary', {
              matched: String(preview.matchedCount),
              unmatched: String(preview.unmatchedCount),
              ambiguous: String(preview.ambiguousCount),
              duplicate: String(preview.duplicateTargetCount),
              invalid: String(preview.invalidValueCount),
            })}
          </p>
          {preview.tooManyRows && <ErrorText>{t('timekeeping.tooMany', { max: String(HR_TIMEKEEPING_MAX_ROWS) })}</ErrorText>}
          {preview.ambiguousCount > 0 && <ErrorText>{t('timekeeping.ambiguousError')}</ErrorText>}
          {preview.duplicateTargetCount > 0 && <ErrorText>{t('timekeeping.duplicateTargetError')}</ErrorText>}
          {preview.invalidValueCount > 0 && <ErrorText>{t('timekeeping.invalidValuesError')}</ErrorText>}
          {preview.errors.map((issue, idx) => (
            <ErrorText key={`${issue.code}-${idx}`}>{issueText(t, issue)}</ErrorText>
          ))}
          {preview.warnings.map((issue, idx) => (
            <p key={`${issue.code}-${idx}`} className="text-xs text-warning" data-testid="hr-timekeeping-warning">
              {issueText(t, issue)}
            </p>
          ))}
          {preview.rows.length > 0 && (
            <DataTable
              head={[
                t('timekeeping.colRow'),
                t('timekeeping.colSource'),
                t('timekeeping.colMatch'),
                t('timekeeping.colUnpaidLeave'),
                t('timekeeping.colDaysNotEmployed'),
                t('timekeeping.colOvertime'),
                t('timekeeping.colNightHours'),
                t('timekeeping.colStatus'),
              ]}
              numeric={[0, 3, 4, 5, 6]}
            >
              {preview.rows.map((entry) => (
                <TableRow key={`${entry.row.rowNumber}-${entry.row.employeeKey}`} data-testid="hr-timekeeping-preview-row">
                  <TableCell className={NUM}>{entry.row.rowNumber}</TableCell>
                  <TableCell>
                    {entry.row.employeeCode && entry.row.displayName
                      ? `${entry.row.employeeCode} (${entry.row.displayName})`
                      : (entry.row.displayName ?? entry.row.employeeCode ?? entry.row.employeeKey)}
                  </TableCell>
                  <TableCell>{entry.matchedName ?? '-'}</TableCell>
                  <TableCell className={NUM}>{entry.row.unpaidLeaveDays}</TableCell>
                  <TableCell className={NUM}>{entry.row.daysNotEmployed}</TableCell>
                  <TableCell className={NUM}>
                    {entry.row.totalOvertimeHours}
                    {entry.row.overtimeCapExceeded && (
                      <Badge variant="warning" className="ml-2">
                        {t('timekeeping.overtimeWarningBadge')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className={NUM}>{entry.row.nightHours}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[entry.status]}>{t(`timekeeping.status.${entry.status}`)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          )}
        </div>
      )}

      {apply.error && <ErrorText>{errorMessage(apply.error)}</ErrorText>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          loading={apply.isPending}
          disabled={!preview || !preview.canApply}
          onClick={() => apply.mutate()}
          data-testid="hr-timekeeping-apply"
        >
          {t('timekeeping.apply', { count: String(preview?.validRows.length ?? 0) })}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('timekeeping.cancel')}
        </Button>
      </div>
    </Card>
  );
}
