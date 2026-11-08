// SPDX-License-Identifier: AGPL-3.0-only
// The filter bar of the Deals screen (CRM K3, #2227): search, stage, status, owner, expected close, an amount range and the
// sort, as the controls of a Filter AST of the `crm.deal` scope (lib/deal-filter.ts). One bar for the list and the board; a
// stored view's other conditions show as chips that can be removed.
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { PipelineStage, SavedViewSort } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import {
  DEAL_SORT_OPTIONS,
  EMPTY_DEAL_FILTER,
  dealConditionLabel,
  dealFilterToAst,
  dealSortOfValue,
  dealSortValue,
  isAmount,
  type DealCloseFilter,
  type DealFilterState,
  type DealStatusFilter,
} from '../lib/deal-filter.ts';
import { normalizeAmount } from '../lib/vouchers.ts';

// The words of each sort option, by its `field:dir` value.
const SORT_LABELS: Record<string, 'sort.created_asc' | 'sort.created_desc' | 'sort.name_asc' | 'sort.name_desc' | 'sort.amount_asc' | 'sort.amount_desc' | 'sort.expected_close_asc' | 'sort.expected_close_desc' | 'sort.updated_asc' | 'sort.updated_desc'> = {
  'created:asc': 'sort.created_asc',
  'created:desc': 'sort.created_desc',
  'name:asc': 'sort.name_asc',
  'name:desc': 'sort.name_desc',
  'amount:asc': 'sort.amount_asc',
  'amount:desc': 'sort.amount_desc',
  'expected_close:asc': 'sort.expected_close_asc',
  'expected_close:desc': 'sort.expected_close_desc',
  'updated:asc': 'sort.updated_asc',
  'updated:desc': 'sort.updated_desc',
};

// The filter bar and the view tabs above the deals (list, and the board next): one bar for every way of looking at them.
export function DealFilterBar({
  bar,
  setBar,
  sort,
  setSort,
  stages,
  members,
}: {
  bar: DealFilterState;
  setBar: (next: DealFilterState) => void;
  sort: SavedViewSort | null;
  setSort: (next: SavedViewSort | null) => void;
  stages: readonly PipelineStage[];
  members: readonly { userId: string; email: string; displayName?: string | null }[];
}) {
  const t = useTranslations('deals');
  const filtered = dealFilterToAst(bar).all.length > 0;
  const select = (id: string, label: string, value: string, onChange: (value: string) => void, options: ReactNode) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-subtle-foreground">
        {label}
      </Label>
      <NativeSelect id={id} size="sm" value={value} onChange={(e) => onChange(e.target.value)}>
        {options}
      </NativeSelect>
    </div>
  );
  const amount = (key: 'amountMin' | 'amountMax', label: string) => {
    const invalid = bar[key].trim() !== '' && !isAmount(normalizeAmount(bar[key]));
    return (
      <div className="flex w-36 flex-col gap-1">
        <Label htmlFor={`deal-${key}`} className="text-xs text-subtle-foreground">
          {label}
        </Label>
        <Input id={`deal-${key}`} inputMode="decimal" value={bar[key]} maxLength={19} aria-invalid={invalid} aria-describedby={invalid ? `deal-${key}-hint` : undefined} onChange={(e) => setBar({ ...bar, [key]: e.target.value })} />
        {invalid && (
          <p id={`deal-${key}-hint`} className="text-xs text-destructive">
            {t('filters.amountInvalid')}
          </p>
        )}
      </div>
    );
  };
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label={t('filters.label')}>
        <div className="flex min-w-56 max-w-sm flex-1 flex-col gap-1">
          <Label htmlFor="deal-search" className="text-xs text-subtle-foreground">
            {t('filters.search')}
          </Label>
          <Input id="deal-search" type="search" placeholder={t('filters.searchPlaceholder')} maxLength={100} value={bar.search} onChange={(e) => setBar({ ...bar, search: e.target.value })} />
        </div>
        {select(
          'deal-stage',
          t('columns.stage'),
          bar.stage,
          (stage) => setBar({ ...bar, stage }),
          <>
            <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
            {stages.map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.name}
              </NativeSelectOption>
            ))}
            {bar.stage !== '' && !stages.some((s) => s.id === bar.stage) && <NativeSelectOption value={bar.stage}>{t('filters.removed')}</NativeSelectOption>}
          </>,
        )}
        {select(
          'deal-status',
          t('filters.status'),
          bar.status,
          (status) => setBar({ ...bar, status: (['open', 'won', 'lost'] as const).find((s) => s === status) ?? ('' satisfies DealStatusFilter) }),
          <>
            <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
            <NativeSelectOption value="open">{t('filters.statusOpen')}</NativeSelectOption>
            <NativeSelectOption value="won">{t('filters.statusWon')}</NativeSelectOption>
            <NativeSelectOption value="lost">{t('filters.statusLost')}</NativeSelectOption>
          </>,
        )}
        {select(
          'deal-owner',
          t('columns.owner'),
          bar.owner,
          (owner) => setBar({ ...bar, owner }),
          <>
            <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
            <NativeSelectOption value="me">{t('filters.ownerMe')}</NativeSelectOption>
            <NativeSelectOption value="none">{t('filters.ownerNone')}</NativeSelectOption>
            {members.map((m) => (
              <NativeSelectOption key={m.userId} value={m.userId}>
                {m.displayName ?? m.email}
              </NativeSelectOption>
            ))}
            {bar.owner !== '' && bar.owner !== 'me' && bar.owner !== 'none' && !members.some((m) => m.userId === bar.owner) && <NativeSelectOption value={bar.owner}>{t('filters.removed')}</NativeSelectOption>}
          </>,
        )}
        {select(
          'deal-close',
          t('columns.expectedClose'),
          bar.close,
          (close) => setBar({ ...bar, close: (['overdue', 'soon', 'empty'] as const).find((c) => c === close) ?? ('' satisfies DealCloseFilter) }),
          <>
            <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
            <NativeSelectOption value="overdue">{t('filters.closeOverdue')}</NativeSelectOption>
            <NativeSelectOption value="soon">{t('filters.closeSoon')}</NativeSelectOption>
            <NativeSelectOption value="empty">{t('filters.closeEmpty')}</NativeSelectOption>
          </>,
        )}
        {amount('amountMin', t('filters.amountMin'))}
        {amount('amountMax', t('filters.amountMax'))}
        {select(
          'deal-sort',
          t('filters.sort'),
          dealSortValue(sort),
          (value) => setSort(dealSortOfValue(value)),
          <>
            <NativeSelectOption value="">{t('sort.default')}</NativeSelectOption>
            {DEAL_SORT_OPTIONS.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {t(SORT_LABELS[value] ?? 'sort.default')}
              </NativeSelectOption>
            ))}
          </>,
        )}
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => setBar(EMPTY_DEAL_FILTER)}>
            {t('filters.clear')}
          </Button>
        )}
      </div>
      {bar.rest.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2" aria-label={t('filters.other')}>
          {bar.rest.map((c, i) => (
            <li key={`${c.field}:${c.op}:${i}`} className="flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-muted-foreground">
              {dealConditionLabel(c)}
              <Button variant="ghost" size="sm" aria-label={t('filters.remove', { condition: dealConditionLabel(c) })} onClick={() => setBar({ ...bar, rest: bar.rest.filter((_, j) => j !== i) })}>
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
