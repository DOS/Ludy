// SPDX-License-Identifier: AGPL-3.0-only
// The numbers of the org's bank accounts, a card in Settings with the finance module (#2183, after #2142): owners and
// admins record the digits a bank statement names on a bank account (112 or a sub-account under it), so a statement that
// arrives by email or in the Inbox finds its account without a bank feed. Nothing is paid or posted here; a statement
// still waits for a member to import it. The server enforces every rule (digits only, one number per bank account of the
// org) and the screen shows its reason.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { LegalEntity } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, FieldError, fieldControl, focusFirstInvalid, RowsSkeleton, useFieldErrors } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { accountLabel, type ChartAccount } from '../lib/accounts.ts';
import { bankAccountChoices } from '../lib/bank-feeds.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.bankAccountNumbers.list.key() });

function AddForm({ bankAccounts, entities }: { bankAccounts: readonly ChartAccount[]; entities: readonly LegalEntity[] }) {
  const t = useTranslations('bankAccountNumbers');
  const defaultEntity = entities.find((e) => e.isDefault) ?? entities[0];
  const [bankAccount, setBankAccount] = useState('');
  const [number, setNumber] = useState('');
  const [legalEntityId, setLegalEntityId] = useState(defaultEntity?.id ?? '');
  const bankId = useId();
  const numberId = useId();
  const fields = useFieldErrors<'bankAccount' | 'number'>((name) => {
    if (name === 'bankAccount') return bankAccount ? null : t('bankAccountNeeded');
    return number.trim() ? null : t('numberNeeded');
  });
  const choices = bankAccountChoices(bankAccounts);
  const several = entities.length > 1;
  const set = useMutation(
    orpc.bankAccountNumbers.set.mutationOptions({
      onSuccess: async () => {
        setNumber('');
        await refresh();
      },
    }),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['bankAccount', 'number'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    set.mutate({ bankAccount, accountNumber: number.trim(), ...(several && legalEntityId ? { legalEntityId } : {}), idempotencyKey: crypto.randomUUID() });
  };
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} aria-label={t('form')} noValidate>
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          {...fieldControl(bankId, { error: Boolean(fields.of('bankAccount')) })}
          className="min-w-48 flex-1"
          aria-label={t('bankAccount')}
          value={bankAccount}
          onChange={(e) => {
            setBankAccount(e.target.value);
            fields.edit('bankAccount');
          }}
        >
          <NativeSelectOption value="">{t('chooseBankAccount')}</NativeSelectOption>
          {choices.map((a) => (
            <NativeSelectOption key={a.code} value={a.code}>
              {accountLabel(a)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {several && (
          <NativeSelect className="min-w-40" aria-label={t('legalEntity')} value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
            {entities.map((e) => (
              <NativeSelectOption key={e.id} value={e.id}>
                {e.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <Input
          {...fieldControl(numberId, { error: Boolean(fields.of('number')) })}
          className="min-w-48 flex-1 font-mono"
          inputMode="numeric"
          autoComplete="off"
          aria-label={t('number')}
          placeholder={t('numberPlaceholder')}
          value={number}
          onChange={(e) => {
            setNumber(e.target.value);
            fields.edit('number');
          }}
        />
        <Button loading={set.isPending} type="submit" variant="outline" size="sm" disabled={set.isPending}>
          {t('add')}
        </Button>
      </div>
      <FieldError id={bankId}>{fields.of('bankAccount')}</FieldError>
      <FieldError id={numberId}>{fields.of('number')}</FieldError>
      {choices.length === 0 && <p className="text-xs text-subtle-foreground">{t('noBankAccounts')}</p>}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </form>
  );
}

export function BankAccountNumbersCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('bankAccountNumbers');
  const numbers = useQuery({ ...orpc.bankAccountNumbers.list.queryOptions(), enabled: canManage });
  const chart = useQuery({ ...orpc.accounts.list.queryOptions(), enabled: canManage });
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: canManage });
  const clear = useMutation(orpc.bankAccountNumbers.clear.mutationOptions({ onSuccess: () => refresh() }));
  // Recording a number is the owners' and admins'; nobody else is told anything about it.
  if (!canManage) return null;
  // With several legal entities the same bank account code may carry numbers in each: the row says which entity.
  const entityNames = new Map((entities.data ?? []).map((e) => [e.id, e.name] as const));
  const loading = numbers.isLoading || chart.isLoading || entities.isLoading;
  const failure = numbers.error ?? chart.error ?? entities.error;
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {loading ? (
        <RowsSkeleton />
      ) : failure ? (
        <ErrorText>{errorMessage(failure)}</ErrorText>
      ) : (
        <>
          {(numbers.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('none')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {(numbers.data ?? []).map((n) => (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <p className="text-foreground">
                    <span className="font-mono">{n.accountNumber}</span> <span className="text-subtle-foreground">{t('on', { account: n.bankAccount })}</span>
                    {entityNames.size > 1 && <span className="text-subtle-foreground"> · {entityNames.get(n.legalEntityId) ?? ''}</span>}
                  </p>
                  <Button
                    loading={clear.isPending && clear.variables?.id === n.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => clear.mutate({ id: n.id, idempotencyKey: crypto.randomUUID() })}
                    aria-label={t('removeOf', { number: n.accountNumber })}
                  >
                    {t('remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {clear.error && <ErrorText>{errorMessage(clear.error)}</ErrorText>}
          <AddForm bankAccounts={chart.data ?? []} entities={entities.data ?? []} />
        </>
      )}
    </Card>
  );
}
