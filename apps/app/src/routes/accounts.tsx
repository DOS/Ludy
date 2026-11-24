// The org's chart of accounts in Settings (issue #319): the TT133 accounts are shared and read-only; owners and admins
// add sub-accounts under them (a bank account per bank, a cost center), rename them, and stop or resume using them.
// A sub-account is never deleted, so every posted entry keeps its account. The server enforces every rule; the screen
// only offers what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { normalizeAccountCode } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { FormDialog } from '../components/form-dialog.tsx';
import { DuplicateHint } from '../components/form-panel.tsx';
import { ErrorText, Field, RowsSkeleton } from '../components/ui.tsx';
import { accountLabel, parentChoices, subAccounts, type ChartAccount } from '../lib/accounts.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { duplicateAccountCode } from '../lib/duplicates.ts';

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.accounts.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.parties.list.key() });
};

export function AddSubAccountDialog({ accounts, onClose }: { accounts: readonly ChartAccount[]; onClose: () => void }) {
  const t = useTranslations('accounts');
  const parents = parentChoices(accounts);
  const [parentCode, setParentCode] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const create = useMutation(
    orpc.accounts.create.mutationOptions({
      onSuccess: () => {
        refresh();
        onClose();
      },
    }),
  );
  // A code that exists is flagged while it is typed (the server refuses it too).
  const repeated = duplicateAccountCode(accounts, code);
  const pickParent = (value: string) => {
    setParentCode(value);
    // Start the code with the parent's, the part every sub-account code shares.
    if (value && !code.startsWith(value)) setCode(value);
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!parentCode || !name.trim() || !code.trim() || repeated) return;
    create.mutate({ parentCode, code: normalizeAccountCode(code), name: name.trim() });
  }
  return (
    <FormDialog
      title={t('addTitle')}
      description={t('addHint')}
      busy={create.isPending}
      dirty={name.trim() !== '' || parentCode !== '' || code.trim() !== ''}
      submitLabel={t('add')}
      submitDisabled={!parentCode || !name.trim() || !code.trim() || repeated !== null}
      onClose={onClose}
      onSubmit={submit}
    >
      {/* The name first: it is what the owner knows ("Vietcombank"); the parent and the code follow from it. */}
      <Field label={t('name')}>
        {(control) => <Input {...control} required maxLength={200} placeholder={t('namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label={t('parent')}>
        {(control) => (
          <NativeSelect {...control} value={parentCode} required onChange={(e) => pickParent(e.target.value)}>
            <NativeSelectOption value="">{t('pickParent')}</NativeSelectOption>
            {parents.map((a) => (
              <NativeSelectOption key={a.code} value={a.code}>
                {accountLabel(a)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label={t('code')}>
        {(control) => <Input {...control} className="font-mono" required maxLength={31} placeholder={t('codePlaceholder')} value={code} onChange={(e) => setCode(e.target.value)} />}
      </Field>
      <DuplicateHint testId="account-code-duplicate">{repeated ? t('duplicate', { code: repeated.code, name: repeated.name }) : null}</DuplicateHint>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </FormDialog>
  );
}

function SubAccountRow({ account, canManage }: { account: ChartAccount; canManage: boolean }) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(account.name);
  const update = useMutation(
    orpc.accounts.update.mutationOptions({
      onSuccess: () => {
        setRenaming(false);
        refresh();
      },
    }),
  );
  const label = accountLabel(account);
  return (
    <li className="py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ code: account.code, name: name.trim() });
            }}
          >
            <span className="shrink-0 py-1.5 font-mono text-foreground">{account.code}</span>
            <Input required maxLength={200} aria-label={t('renameOf', { code: account.code })} value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="outline" size="sm" loading={update.isPending}>
              {t('save')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(false)}>
              {tc('cancel')}
            </Button>
          </form>
        ) : (
          <div className="min-w-0">
            <p className="truncate text-foreground">
              <span className="font-mono">{account.code}</span> · {account.name}
            </p>
            <p className="text-xs text-subtle-foreground">{t('under', { parent: account.parentCode ?? '', root: account.rootCode })}</p>
          </div>
        )}
        {!renaming && (
          <div className="flex shrink-0 items-center gap-2">
            {!account.active && <Badge variant="secondary">{t('inactive')}</Badge>}
            {canManage && (
              <>
                <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => setRenaming(true)} aria-label={t('renameOf', { code: account.code })}>
                  {t('rename')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={update.isPending && update.variables?.active !== undefined}
                  disabled={update.isPending}
                  onClick={() => update.mutate({ code: account.code, active: !account.active })}
                  aria-label={account.active ? t('deactivateOf', { account: label }) : t('reactivateOf', { account: label })}
                >
                  {account.active ? t('deactivate') : t('reactivate')}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {update.error && <ErrorText>{errorMessage(update.error)}</ErrorText>}
    </li>
  );
}

export function ChartOfAccountsCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('accounts');
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const own = subAccounts(accounts.data ?? []);
  const [adding, setAdding] = useState(false);
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {accounts.isLoading ? (
        <RowsSkeleton />
      ) : accounts.error ? (
        <ErrorText>{errorMessage(accounts.error)}</ErrorText>
      ) : (
        <>
          {own.length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('empty')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {own.map((a) => (
                <SubAccountRow key={a.code} account={a} canManage={canManage} />
              ))}
            </ul>
          )}
          {canManage && (
            <div className="mt-4">
              <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
                {t('addTitle')}
              </Button>
            </div>
          )}
          {adding && <AddSubAccountDialog accounts={accounts.data ?? []} onClose={() => setAdding(false)} />}
        </>
      )}
    </Card>
  );
}
