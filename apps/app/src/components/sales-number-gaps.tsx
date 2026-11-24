// SPDX-License-Identifier: AGPL-3.0-only
// The numbers missing in the org's own sales e-invoice series (#2140), as "missing or cancelled": on the VAT working of a
// period (the runs that may fall in it) and on the Overview (from a year on). Read-only; shows nothing while loading,
// and nothing when no series has a gap.
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { TableCell, TableRow } from '@ludy/ui/components/table';
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
  // Show nothing when the check fails, for a panel that is not the screen's purpose (the Overview).
  quiet?: boolean;
  // Compact banner mode for Overview, keeping the breakdown collapsed behind an optional details toggle (#4644).
  compact?: boolean;
  detailsLabel?: string;
  hideDetailsLabel?: string;
  // Shown under the table, for a link to where the numbers are checked.
  action?: ReactNode;
}

// "3", or "5-11" for a run.
export const gapRunLabel = (run: { from: string; to: string }) => (run.from === run.to ? run.from : `${run.from}-${run.to}`);

export function SalesNumberGaps({
  period,
  fromYear,
  legalEntityId,
  enabled = true,
  className,
  quiet = false,
  compact = false,
  detailsLabel,
  hideDetailsLabel,
  action,
}: SalesNumberGapsProps) {
  const t = useTranslations('salesGaps');
  const f = useFormat();
  const [expanded, setExpanded] = useState(false);
  const gaps = useQuery({
    ...orpc.vat.salesNumberGaps.queryOptions({ input: { ...(period ? { period } : {}), ...(fromYear !== undefined ? { fromYear } : {}), ...(legalEntityId ? { legalEntityId } : {}) } }),
    enabled,
  });
  if (gaps.error) return quiet ? null : <ErrorText>{errorMessage(gaps.error)}</ErrorText>;
  const data = gaps.data;
  if (!data || data.groups.length === 0) return null;

  const table = (
    <DataTable stacked fit={compact} numeric={[4]} head={[t('columns.series'), t('columns.year'), t('columns.missing'), t('columns.recorded'), t('columns.count')]}>
      {data.groups.map((group) => (
        <TableRow key={`${group.year}:${group.template ?? ''}:${group.series}`}>
          <TableCell data-label={t('columns.series')} className="font-mono text-xs text-foreground">{`${group.template ?? ''}${group.series}`}</TableCell>
          <TableCell data-label={t('columns.year')} className="text-muted-foreground tabular-nums">{group.year}</TableCell>
          <TableCell data-label={t('columns.missing')} className="font-mono text-xs text-foreground">
            {group.ranges.map(gapRunLabel).join(', ')}
            {group.truncated ? ` ${t('more')}` : ''}
          </TableCell>
          <TableCell data-label={t('columns.recorded')} className="text-xs text-muted-foreground">
            {t('recordedRange', { first: group.firstNumber, last: group.lastNumber, recorded: f.number(group.recorded) })}
          </TableCell>
          <TableCell data-label={t('columns.count')} className="text-right tabular-nums text-foreground">{f.number(group.missingCount)}</TableCell>
        </TableRow>
      ))}
    </DataTable>
  );

  if (compact) {
    const summary = data.groups
      .map((group) => `${group.template ?? ''}${group.series}: ${group.ranges.map(gapRunLabel).join(', ')}${group.truncated ? ` ${t('more')}` : ''}`)
      .join(' · ');
    return (
      <section className={className} aria-labelledby="sales-number-gaps" data-testid="sales-number-gaps-compact">
        <Card className="block p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h2 id="sales-number-gaps" className="text-sm font-semibold text-foreground">
                  {t('title', { count: f.number(data.missingCount) })}
                </h2>
                <span className="max-w-full truncate font-mono text-xs text-muted-foreground" title={summary}>
                  {summary}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-subtle-foreground">{period ? t('hintPeriod') : t('hint')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {detailsLabel && hideDetailsLabel && (
                <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? hideDetailsLabel : detailsLabel}
                </Button>
              )}
              {action}
            </div>
          </div>
        </Card>
        {expanded && <div className="mt-2">{table}</div>}
      </section>
    );
  }

  return (
    <section className={className} aria-labelledby="sales-number-gaps">
      <h2 id="sales-number-gaps" className="mb-1 text-base font-semibold text-foreground">
        {t('title', { count: f.number(data.missingCount) })}
      </h2>
      <p className="mb-2 text-xs text-subtle-foreground">{period ? t('hintPeriod') : t('hint')}</p>
      {table}
      {action && <p className="mt-2 text-sm">{action}</p>}
    </section>
  );
}
