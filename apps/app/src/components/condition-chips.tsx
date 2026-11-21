// SPDX-License-Identifier: AGPL-3.0-only
// The chips of a saved view's conditions that the filter bar has no control for (CR-27, #3659): each reads in words and the
// person's formats, and the ones that cannot be said without a raw operator or id fold into one "Điều kiện khác (n)" chip.
// A chip can be removed, as before.
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import type { FilterCondition } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { conditionChips, type ChipTranslate, type ConditionScope } from '../lib/condition-label.ts';

export function ConditionChips({
  scope,
  rest,
  onChange,
  names,
  listLabel,
  removeLabel,
}: {
  scope: ConditionScope;
  rest: readonly FilterCondition[];
  onChange: (next: FilterCondition[]) => void;
  // The names of the ids the screen knows (stages, members), by id.
  names?: ReadonlyMap<string, string>;
  listLabel: string;
  // The accessible name of a chip's remove button, from the screen's own catalog.
  removeLabel: (condition: string) => string;
}) {
  const root = useTranslations();
  const f = useFormat();
  const chips = useMemo(() => conditionChips(scope, rest, { t: root as unknown as ChipTranslate, money: (v) => f.money(v), date: (v) => f.date(v), ...(names ? { names } : {}) }), [scope, rest, root, f, names]);
  if (chips.length === 0) return null;
  return (
    <ul className="mb-3 flex flex-wrap gap-2" aria-label={listLabel}>
      {chips.map((chip) => (
        <li key={chip.key} className="flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-muted-foreground">
          {chip.label}
          <Button
            variant="ghost"
            size="sm"
            aria-label={chip.key === 'other' ? root('filterChips.removeOther', { count: String(chip.indexes.length) }) : removeLabel(chip.label)}
            onClick={() => onChange(rest.filter((_, j) => !chip.indexes.includes(j)))}
          >
            ×
          </Button>
        </li>
      ))}
    </ul>
  );
}
