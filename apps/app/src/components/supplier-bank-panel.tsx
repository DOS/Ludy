// SPDX-License-Identifier: AGPL-3.0-only
// A supplier's bank accounts (#3113 S1), for owners and admins: each account by its bank and last four digits (the full number is sealed on the server and never shown), the history of changes, and
// the changes themselves. Every change needs a fresh second factor (the StepUpPrompt repeats the refused request); only an owner may erase a supplier's bank data.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { SupplierBankAccount } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { StepUpPrompt } from './two-factor.tsx';
import { ErrorText } from './ui.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.supplierBank.key() });
const day = (value: string): string => value.slice(0, 10);

type Form = { bankName: string; accountHolder: string; accountNumber: string };
const EMPTY: Form = { bankName: '', accountHolder: '', accountNumber: '' };

// The three fields of an account: the bank, the holder and the number a person types (digits, spaces and dashes are fine).
function AccountFields({ idPrefix, form, onChange }: { idPrefix: string; form: Form; onChange: (next: Form) => void }) {
  const t = useTranslations('vendors.bank');
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-bank`}>{t('bankName')}</Label>
        <Input id={`${idPrefix}-bank`} value={form.bankName} maxLength={100} onChange={(e) => onChange({ ...form, bankName: e.target.value })} data-testid="supplier-bank-name" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-holder`}>{t('accountHolder')}</Label>
        <Input id={`${idPrefix}-holder`} value={form.accountHolder} maxLength={200} onChange={(e) => onChange({ ...form, accountHolder: e.target.value })} data-testid="supplier-bank-holder" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-number`}>{t('accountNumber')}</Label>
        <Input id={`${idPrefix}-number`} inputMode="numeric" autoComplete="off" value={form.accountNumber} maxLength={40} onChange={(e) => onChange({ ...form, accountNumber: e.target.value })} data-testid="supplier-bank-number" />
      </div>
    </div>
  );
}

const complete = (form: Form): boolean => form.bankName.trim() !== '' && form.accountHolder.trim() !== '' && form.accountNumber.trim().length >= 6;

// One account: its bank, "••••" and the last four digits, the day it was added (and retired), with "Đổi" and "Ngừng dùng" while it is active.
function AccountRow({ account }: { account: SupplierBankAccount }) {
  const t = useTranslations('vendors.bank');
  const id = useId();
  const [changing, setChanging] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [retiring, setRetiring] = useState(false);
  const replace = useMutation(
    orpc.supplierBank.replace.mutationOptions({
      onSuccess: async () => {
        setChanging(false);
        setForm(EMPTY);
        await refresh();
      },
    }),
  );
  const retire = useMutation(
    orpc.supplierBank.retire.mutationOptions({
      onSuccess: async () => {
        setRetiring(false);
        await refresh();
      },
    }),
  );
  return (
    <li className="rounded-md border border-border p-3" data-testid="supplier-bank-account">
      <p className="text-sm font-medium">
        {account.bankName} <span className="font-mono text-muted-foreground">{account.last4 === '****' ? '••••' : `••••${account.last4}`}</span>
      </p>
      <p className="text-xs text-subtle-foreground">{account.status === 'active' ? t('activeSince', { date: day(account.createdAt) }) : t('retiredOn', { date: day(account.retiredAt ?? account.createdAt) })}</p>
      {account.status === 'active' && !changing && !retiring && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setChanging(true)} data-testid="supplier-bank-change">
            {t('change')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRetiring(true)} data-testid="supplier-bank-retire">
            {t('retire')}
          </Button>
        </div>
      )}
      {changing && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-subtle-foreground">{t('changeHint')}</p>
          <AccountFields idPrefix={id} form={form} onChange={setForm} />
          <div className="flex gap-2">
            <Button size="sm" loading={replace.isPending} disabled={!complete(form)} onClick={() => replace.mutate({ accountId: account.id, ...form })} data-testid="supplier-bank-change-save">
              {t('saveChange')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setChanging(false)}>
              {t('cancel')}
            </Button>
          </div>
          {replace.error && (isStepUpRequired(replace.error) ? <StepUpPrompt enroll={false} action={t('stepUp')} onVerified={() => replace.variables && replace.mutate(replace.variables)} /> : <ErrorText>{errorMessage(replace.error)}</ErrorText>)}
        </div>
      )}
      {retiring && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-subtle-foreground">{t('retireHint')}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" loading={retire.isPending} onClick={() => retire.mutate({ accountId: account.id })} data-testid="supplier-bank-retire-confirm">
              {t('retireConfirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRetiring(false)}>
              {t('cancel')}
            </Button>
          </div>
          {retire.error && (isStepUpRequired(retire.error) ? <StepUpPrompt enroll={false} action={t('stepUp')} onVerified={() => retire.variables && retire.mutate(retire.variables)} /> : <ErrorText>{errorMessage(retire.error)}</ErrorText>)}
        </div>
      )}
    </li>
  );
}

export function SupplierBankPanel({ partyId, canErase }: { partyId: string; canErase: boolean }) {
  const t = useTranslations('vendors.bank');
  const id = useId();
  const list = useQuery(orpc.supplierBank.list.queryOptions({ input: { partyId } }));
  const [form, setForm] = useState<Form>(EMPTY);
  const [erasing, setErasing] = useState(false);
  const add = useMutation(
    orpc.supplierBank.add.mutationOptions({
      onSuccess: async () => {
        setForm(EMPTY);
        await refresh();
      },
    }),
  );
  const erase = useMutation(
    orpc.supplierBank.erase.mutationOptions({
      onSuccess: async () => {
        setErasing(false);
        await refresh();
      },
    }),
  );
  return (
    <div className="space-y-3" data-testid="supplier-bank-panel">
      <p className="text-xs text-subtle-foreground">{t('intro')}</p>
      {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data &&
        (list.data.accounts.length === 0 ? (
          <p className="text-sm text-subtle-foreground">{t('none')}</p>
        ) : (
          <ul className="space-y-2">
            {list.data.accounts.map((a) => (
              <AccountRow key={a.id} account={a} />
            ))}
          </ul>
        ))}
      <div className="space-y-2 border-t pt-3">
        <p className="text-sm font-medium">{t('addTitle')}</p>
        <AccountFields idPrefix={`${id}-add`} form={form} onChange={setForm} />
        <Button size="sm" loading={add.isPending} disabled={!complete(form)} onClick={() => add.mutate({ partyId, ...form })} data-testid="supplier-bank-add">
          {t('add')}
        </Button>
        {add.error && (isStepUpRequired(add.error) ? <StepUpPrompt enroll={false} action={t('stepUp')} onVerified={() => add.variables && add.mutate(add.variables)} /> : <ErrorText>{errorMessage(add.error)}</ErrorText>)}
      </div>
      {list.data && list.data.changes.length > 0 && (
        <div className="border-t pt-3">
          <p className="text-sm font-medium">{t('history')}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-subtle-foreground" data-testid="supplier-bank-history">
            {list.data.changes.map((c) => (
              <li key={c.id}>
                {day(c.changedAt)}: {c.kind === 'added' ? t('kindAdded') : c.kind === 'replaced' ? t('kindReplaced') : t('kindRetired')}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canErase && (
        <div className="border-t pt-3">
          {!erasing ? (
            <Button size="sm" variant="ghost" onClick={() => setErasing(true)} data-testid="supplier-bank-erase">
              {t('erase')}
            </Button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-subtle-foreground">{t('eraseHint')}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" loading={erase.isPending} onClick={() => erase.mutate({ partyId })} data-testid="supplier-bank-erase-confirm">
                  {t('eraseConfirm')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setErasing(false)}>
                  {t('cancel')}
                </Button>
              </div>
              {erase.error && (isStepUpRequired(erase.error) ? <StepUpPrompt enroll={false} action={t('stepUpErase')} onVerified={() => erase.variables && erase.mutate(erase.variables)} /> : <ErrorText>{errorMessage(erase.error)}</ErrorText>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
