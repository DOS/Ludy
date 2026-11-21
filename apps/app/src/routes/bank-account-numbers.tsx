// SPDX-License-Identifier: AGPL-3.0-only
// The numbers of the org's bank accounts, a card in Settings with the finance module (#2183, after #2142): owners and
// admins record the digits a bank statement names on a bank account (112 or a sub-account under it), so a statement that
// arrives by email or in the Inbox finds its account without a bank feed. Nothing is paid or posted here; a statement
// still waits for a member to import it. The server enforces every rule (digits only, one number per bank account of the
// org) and the screen shows its reason.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { BankAccountNumberView, LegalEntity } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { DuplicateHint } from '../components/form-panel.tsx';
import { FormDialog } from '../components/form-dialog.tsx';
import { ErrorText, Field, focusFirstInvalid, RowsSkeleton, useFieldErrors } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { accountLabel, type ChartAccount } from '../lib/accounts.ts';
import { bankAccountChoices } from '../lib/bank-feeds.ts';
import { duplicateBankNumber } from '../lib/duplicates.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.bankAccountNumbers.list.key() });

export function AddBankNumberDialog({
  bankAccounts,
  entities,
  numbers,
  onClose,
}: {
  bankAccounts: readonly ChartAccount[];
  entities: readonly LegalEntity[];
  numbers: readonly BankAccountNumberView[];
  onClose: () => void;
}) {
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
  // The number already recorded, flagged as it is typed: the module refuses a second one, so this saves a round trip.
  const repeated = duplicateBankNumber(numbers, number);
  const set = useMutation(
    orpc.bankAccountNumbers.set.mutationOptions({
      onSuccess: async () => {
        await refresh();
        onClose();
      },
    }),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fields.checkAll(['bankAccount', 'number'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    if (repeated) return;
    set.mutate({ bankAccount, accountNumber: number.trim(), ...(several && legalEntityId ? { legalEntityId } : {}), idempotencyKey: crypto.randomUUID() });
  };
  return (
    <FormDialog
      title={t('addTitle')}
      description={t('addHint')}
      label={t('form')}
      busy={set.isPending}
      dirty={number.trim() !== '' || bankAccount !== '' || legalEntityId !== (defaultEntity?.id ?? '')}
      submitLabel={t('add')}
      submitDisabled={repeated !== null}
      onClose={onClose}
      onSubmit={submit}
    >
      {/* The number first: it is what the owner has in front of them (the statement). */}
      <Field id={numberId} label={t('number')} error={fields.of('number')}>
        {(control) => (
          <Input
            {...control}
            autoFocus
            className="font-mono"
            inputMode="numeric"
            autoComplete="off"
            placeholder={t('numberPlaceholder')}
            value={number}
            onChange={(e) => {
              setNumber(e.target.value);
              fields.edit('number');
            }}
          />
        )}
      </Field>
      <DuplicateHint testId="bank-number-duplicate">{repeated ? t('duplicate', { account: repeated.bankAccount }) : null}</DuplicateHint>
      <Field id={bankId} label={t('bankAccount')} error={fields.of('bankAccount')}>
        {(control) => (
          <NativeSelect
            {...control}
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
        )}
      </Field>
      {several && (
        <Field label={t('legalEntity')}>
          {(control) => (
            <NativeSelect {...control} value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
              {entities.map((e) => (
                <NativeSelectOption key={e.id} value={e.id}>
                  {e.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>
      )}
      {choices.length === 0 && <p className="text-xs text-subtle-foreground">{t('noBankAccounts')}</p>}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </FormDialog>
  );
}

export function BankAccountNumbersCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('bankAccountNumbers');
  const numbers = useQuery({ ...orpc.bankAccountNumbers.list.queryOptions(), enabled: canManage });
  const chart = useQuery({ ...orpc.accounts.list.queryOptions(), enabled: canManage });
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: canManage });
  const clear = useMutation(orpc.bankAccountNumbers.clear.mutationOptions({ onSuccess: () => refresh() }));
  const [adding, setAdding] = useState(false);
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
          <div className="mt-4">
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
              {t('addTitle')}
            </Button>
          </div>
          {adding && <AddBankNumberDialog bankAccounts={chart.data ?? []} entities={entities.data ?? []} numbers={numbers.data ?? []} onClose={() => setAdding(false)} />}
        </>
      )}
    </Card>
  );
}
