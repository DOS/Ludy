// SPDX-License-Identifier: AGPL-3.0-only
// The numbers missing in the org's own sales e-invoice series (#2140), as "missing or cancelled": on the VAT working of a
// period (the runs that may fall in it) and on the Overview (from a year on). Read-only; shows nothing while loading,
// and nothing when no series has a gap.
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { DataTable, ErrorText } from './ui.tsx';

export interface SalesNumberGapsProps {
  // A VAT period (YYYY-MM or YYYY-Qn), or fromYear for the series of that year on.
  period?: string;
  fromYear?: number;
  legalEntityId?: string | undefined;
  enabled?: boolean;
  className?: string;
  // Shown under the table, for a link to where the numbers are checked.
  action?: ReactNode;
}

// "3", or "5-11" for a run.
export const gapRunLabel = (run: { from: string; to: string }) => (run.from === run.to ? run.from : `${run.from}-${run.to}`);

export function SalesNumberGaps({ period, fromYear, legalEntityId, enabled = true, className, action }: SalesNumberGapsProps) {
  const t = useTranslations('salesGaps');
  const f = useFormat();
  const gaps = useQuery({
    ...orpc.vat.salesNumberGaps.queryOptions({ input: { ...(period ? { period } : {}), ...(fromYear !== undefined ? { fromYear } : {}), ...(legalEntityId ? { legalEntityId } : {}) } }),
    enabled,
  });
  if (gaps.error) return <ErrorText>{errorMessage(gaps.error)}</ErrorText>;
  const data = gaps.data;
  if (!data || data.groups.length === 0) return null;
  return (
    <section className={className} aria-labelledby="sales-number-gaps">
      <h2 id="sales-number-gaps" className="mb-1 text-base font-semibold text-foreground">
        {t('title', { count: data.missingCount })}
      </h2>
      <p className="mb-2 text-xs text-subtle-foreground">{period ? t('hintPeriod') : t('hint')}</p>
      <DataTable numeric={[4]} head={[t('columns.series'), t('columns.year'), t('columns.missing'), t('columns.recorded'), t('columns.count')]}>
        {data.groups.map((group) => (
          <TableRow key={`${group.year}:${group.template ?? ''}:${group.series}`}>
            <TableCell className="px-4 py-3 font-mono text-xs text-foreground">{`${group.template ?? ''}${group.series}`}</TableCell>
            <TableCell className="px-4 py-3 text-muted-foreground">{group.year}</TableCell>
            <TableCell className="px-4 py-3 font-mono text-xs text-foreground">
              {group.ranges.map(gapRunLabel).join(', ')}
              {group.truncated ? ` ${t('more')}` : ''}
            </TableCell>
            <TableCell className="px-4 py-3 text-xs text-muted-foreground">
              {t('recordedRange', { first: group.firstNumber, last: group.lastNumber, recorded: group.recorded })}
            </TableCell>
            <TableCell className="px-4 py-3 text-right tabular-nums text-foreground">{f.number(group.missingCount)}</TableCell>
          </TableRow>
        ))}
      </DataTable>
      {action && <p className="mt-2 text-sm">{action}</p>}
    </section>
  );
}
