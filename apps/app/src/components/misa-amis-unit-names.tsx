// SPDX-License-Identifier: AGPL-3.0-only
// The units of the last check against the MISA ASP catalogue that have no match (#4125), under the preview, for an owner or admin: MISA ASP names a line's unit by id, and a unit of Ludy is matched to the catalogue by its
// exact name. For one the catalogue spells differently (or has twice) the person types the unit's name as MISA has it, once per unit; the next check matches that name exactly, and a unit it does not find stays a
// blocker. The names are shown as text, never as markup. The coworker has no part in it: no model reads a unit name and no agent path sets one.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MisaAmisUnitRow } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText } from './ui.tsx';

/** What the buttons offer for the name in the field: keep it (it is not the kept one), clear the kept one. */
export function unitNameOffer(typed: string, saved: string | null): { canSave: boolean; canClear: boolean } {
  const name = typed.trim();
  return { canSave: name.length > 0 && name !== saved, canClear: saved !== null };
}

export function MisaAmisUnitNames({ connectionId }: { connectionId: string }) {
  const t = useTranslations('misaAmisUnits');
  const units = useQuery(orpc.misaAmis.matches.units.queryOptions({ input: { connectionId } }));
  const keep = useMutation<unknown, Error, { unit: string; misaName: string | null }>({
    mutationFn: ({ unit, misaName }) => client.misaAmis.connections.setUnitAlias({ id: connectionId, unit, misaName }),
    onSuccess: async () => {
      await Promise.all([units.refetch(), queryClient.invalidateQueries({ queryKey: orpc.misaAmis.connections.list.key() })]);
    },
  });
  const list = units.data ?? [];
  // A member who may not set a name is refused and sees nothing; a load that failed is told, with nothing else to show.
  const status = (units.error as { status?: number } | null)?.status;
  if (units.isError && units.data === undefined && status !== 403) {
    return (
      <div className="mt-3" data-testid="misa-amis-units-load-error">
        <ErrorText>{errorMessage(units.error)}</ErrorText>
      </div>
    );
  }
  if (list.length === 0) return null;
  return (
    <section className="mt-3 rounded-md border border-border p-2" aria-labelledby="misa-amis-units-title" data-testid="misa-amis-units">
      <h4 id="misa-amis-units-title" className="font-medium text-foreground">
        {t('title')}
      </h4>
      <p className="mt-1 text-xs text-muted-foreground">{t('hint')}</p>
      <ul className="mt-2 divide-y divide-border">
        {list.map((row) => (
          <UnitRow key={row.unit} row={row} busy={keep.isPending} onKeep={(misaName) => keep.mutate({ unit: row.unit, misaName })} />
        ))}
      </ul>
      {keep.error && (
        <div className="mt-1" data-testid="misa-amis-units-error">
          <ErrorText>{errorMessage(keep.error)}</ErrorText>
        </div>
      )}
    </section>
  );
}

export function UnitRow({ row, busy, onKeep }: { row: MisaAmisUnitRow; busy: boolean; onKeep: (misaName: string | null) => void }) {
  const t = useTranslations('misaAmisUnits');
  const [typed, setTyped] = useState(row.alias ?? '');
  const offer = unitNameOffer(typed, row.alias);
  const id = `misa-amis-unit-${row.unit.replace(/[^a-z0-9]+/gi, '-')}`;
  return (
    <li className="flex flex-wrap items-center gap-2 py-2" data-testid="misa-amis-unit">
      <span className="min-w-0 flex-1 break-words text-foreground">{t(row.state === 'ambiguous' ? 'rowAmbiguous' : row.state === 'matched' ? 'rowMatched' : 'rowUnknown', { unit: row.unit })}</span>
      <label htmlFor={id} className="sr-only">
        {t('label', { unit: row.unit })}
      </label>
      <Input id={id} className="w-40" maxLength={64} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="misa-amis-unit-input" />
      <Button type="button" size="sm" variant="outline" disabled={busy || !offer.canSave} onClick={() => onKeep(typed.trim())} data-testid="misa-amis-unit-save">
        {t('save')}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy || !offer.canClear} onClick={() => onKeep(null)} data-testid="misa-amis-unit-clear">
        {t('clear')}
      </Button>
    </li>
  );
}
