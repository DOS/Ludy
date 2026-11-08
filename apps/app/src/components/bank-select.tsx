// SPDX-License-Identifier: AGPL-3.0-only
// A bank chosen from the list kept as data in @crove/l10n-vn (#2897): a search box that narrows the list (code, short name or full name, any case, no diacritics needed) and the select the person picks
// from. The value is the bank's code or '' for none. The bank already chosen stays in the select while the search hides it, so a search never changes the value by itself.
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { VN_BANKS, bankByCode, searchBanks, type VnBank } from '@crove/l10n-vn';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';

/** The text a bank shows in the select and in a record: its short name, then its full name. */
export const bankLabel = (bank: VnBank): string => (bank.shortName === bank.name ? bank.name : `${bank.shortName} - ${bank.name}`);

export function BankSelect({ id, value, disabled, onChange }: { id: string; value: string; disabled?: boolean; onChange: (code: string) => void }) {
  const t = useTranslations('hrEmployees');
  const [query, setQuery] = useState('');
  const hits = searchBanks(query);
  const chosen = value === '' ? undefined : (bankByCode(value) ?? undefined);
  const options: readonly VnBank[] = chosen && !hits.some((bank) => bank.code === chosen.code) ? [chosen, ...hits] : hits;
  return (
    <div className="space-y-1">
      <Label htmlFor={`${id}-search`} className="sr-only">
        {t('bankSearch')}
      </Label>
      <Input id={`${id}-search`} value={query} placeholder={t('bankSearch')} disabled={disabled} autoComplete="off" onChange={(e) => setQuery(e.target.value)} data-testid="hr-bank-search" />
      <NativeSelect id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} data-testid="hr-bank-select">
        <NativeSelectOption value="">{t('bankChoose')}</NativeSelectOption>
        {options.map((bank) => (
          <NativeSelectOption key={bank.code} value={bank.code}>
            {bankLabel(bank)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {options.length === 0 && query.trim() !== '' && <p className="text-xs text-subtle-foreground">{t('bankNone', { total: String(VN_BANKS.length) })}</p>}
    </div>
  );
}
