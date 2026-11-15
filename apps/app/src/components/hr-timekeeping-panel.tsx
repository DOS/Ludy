// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { HrLineView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Textarea } from '@crove/ui/components/textarea';
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

const NUM = 'px-4 py-3 text-right tabular-nums';

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
  const preview = raw.trim() === '' ? null : buildTimekeepingPreview(raw, month, lines);

  const apply = useMutation({
    mutationFn: () => {
      if (!preview || !preview.canApply) throw new Error('no valid timekeeping rows');
      return client.hr.payroll.runs.importTimekeeping({ runId, rows: preview.validRows });
    },
    onSuccess: async () => {
      await onImported();
      setRaw('');
      onClose();
    },
  });

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setRaw(await file.text());
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
            onChange={(e) => setRaw(e.target.value)}
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
          {preview.duplicateTargetCount > 0 && <ErrorText>{t('timekeeping.duplicateTargetError')}</ErrorText>}
          {preview.invalidValueCount > 0 && <ErrorText>{t('timekeeping.invalidValuesError')}</ErrorText>}
          {preview.errors.map((issue, idx) => (
            <ErrorText key={`${issue.code}-${idx}`}>{issue.message}</ErrorText>
          ))}
          {preview.warnings.map((issue, idx) => (
            <p key={`${issue.code}-${idx}`} className="text-xs text-warning" data-testid="hr-timekeeping-warning">
              {issue.message}
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
                  <TableCell className="px-4 py-3">
                    {entry.row.employeeCode && entry.row.displayName
                      ? `${entry.row.employeeCode} (${entry.row.displayName})`
                      : (entry.row.displayName ?? entry.row.employeeCode ?? entry.row.employeeKey)}
                  </TableCell>
                  <TableCell className="px-4 py-3">{entry.matchedName ?? '-'}</TableCell>
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
                  <TableCell className="px-4 py-3">
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
