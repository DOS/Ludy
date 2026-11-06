// SPDX-License-Identifier: AGPL-3.0-only
// "Nhân viên", the first screen of the HR app (#2530, payroll plan 6.1): the people payroll is run for, each with the terms in force (contract type, region, base wage), their
// dependents and, for the one person opened, the identity number and the bank account number, which are sealed under the person's own key and opened only here. Owners and admins
// only: the server, the database's policies and the menu all say so. Every read of this data is a sensitive query that leaves an audit row first, so the screen asks once and
// never refetches by itself (no refetch on focus, no polling).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { HR_CONTRACT_TYPES, HR_REGIONS, HR_RELATIONS, vietnamToday, type HrContractType, type HrEmployeeSummary, type HrRegion, type HrRelation } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });
// A sensitive read leaves an audit row each time: the screen reads once and again only after its own change.
const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const NUM = 'px-4 py-3 text-right tabular-nums';

interface TermsState {
  effectiveFrom: string;
  contractType: HrContractType;
  region: HrRegion;
  baseWage: string;
}
const blankTerms = (): TermsState => ({ effectiveFrom: vietnamToday(), contractType: 'indefinite', region: 'I', baseWage: '' });

function TermsFields({ id, value, onChange }: { id: string; value: TermsState; onChange: (patch: Partial<TermsState>) => void }) {
  const t = useTranslations('hrEmployees');
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${id}-from`}>{t('effectiveFrom')}</Label>
        <Input id={`${id}-from`} type="date" value={value.effectiveFrom} onChange={(e) => onChange({ effectiveFrom: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-contract`}>{t('contractType')}</Label>
        <NativeSelect id={`${id}-contract`} value={value.contractType} onChange={(e) => onChange({ contractType: e.target.value as HrContractType })}>
          {HR_CONTRACT_TYPES.map((k) => (
            <NativeSelectOption key={k} value={k}>
              {t(`contracts.${k}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-region`}>{t('region')}</Label>
        <NativeSelect id={`${id}-region`} value={value.region} onChange={(e) => onChange({ region: e.target.value as HrRegion })}>
          {HR_REGIONS.map((k) => (
            <NativeSelectOption key={k} value={k}>
              {t('regionOption', { region: k })}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-wage`}>{t('baseWage')}</Label>
        <Input id={`${id}-wage`} value={value.baseWage} inputMode="numeric" maxLength={19} onChange={(e) => onChange({ baseWage: e.target.value.replace(/[^\d.]/g, '') })} />
      </div>
    </>
  );
}

const wageOk = (v: string) => /^\d{1,16}(\.\d{1,2})?$/.test(v);

function AddForm({ onClose }: { onClose: () => void }) {
  const t = useTranslations('hrEmployees');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [identity, setIdentity] = useState('');
  const [account, setAccount] = useState('');
  const [terms, setTerms] = useState(blankTerms);
  const save = useMutation({
    mutationFn: () =>
      client.hr.payroll.employees.add({
        displayName: name.trim(),
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(identity.trim() ? { identityNumber: identity.trim() } : {}),
        ...(account.trim() ? { accountNumber: account.trim() } : {}),
        employment: terms,
      }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const id = 'hr-add';
  return (
    <Card className="mb-6 block p-4" aria-label={t('newTitle')} data-testid="hr-employee-form">
      <h2 className="text-base font-medium text-foreground">{t('newTitle')}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-name`}>{t('name')}</Label>
          <Input id={`${id}-name`} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-address`}>{t('address')}</Label>
          <Input id={`${id}-address`} value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-identity`}>{t('identityNumber')}</Label>
          <Input id={`${id}-identity`} value={identity} maxLength={30} autoComplete="off" onChange={(e) => setIdentity(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-account`}>{t('accountNumber')}</Label>
          <Input id={`${id}-account`} value={account} maxLength={34} autoComplete="off" onChange={(e) => setAccount(e.target.value)} />
        </div>
        <TermsFields id={id} value={terms} onChange={(patch) => setTerms((s) => ({ ...s, ...patch }))} />
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">{t('sealedHint')}</p>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button loading={save.isPending} disabled={name.trim() === '' || !wageOk(terms.baseWage)} onClick={() => save.mutate()} data-testid="hr-employee-save">
          {t('save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </Card>
  );
}

function Detail({ employeeId, owner, onClose }: { employeeId: string; owner: boolean; onClose: () => void }) {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  const q = useQuery({ ...orpc.hr.payroll.employees.get.queryOptions({ input: { employeeId } }), ...ONCE });
  const [terms, setTerms] = useState(blankTerms);
  const [dep, setDep] = useState<{ name: string; relation: HrRelation; registeredOn: string }>({ name: '', relation: 'child', registeredOn: vietnamToday() });
  const [endedOn, setEndedOn] = useState(vietnamToday());
  const [edit, setEdit] = useState<{ name: string; address: string; identity: string; account: string } | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);
  const run = <V,>(fn: (v: V) => Promise<unknown>, after?: () => void) => ({
    mutationFn: fn,
    onSuccess: async () => {
      await refresh();
      after?.();
    },
  });
  const addTerms = useMutation(run(() => client.hr.payroll.employments.add({ employeeId, ...terms }), () => setTerms(blankTerms())));
  const addDependent = useMutation(
    run(
      () => client.hr.payroll.dependents.add({ employeeId, displayName: dep.name.trim(), relation: dep.relation, registeredOn: dep.registeredOn }),
      () => setDep((s) => ({ ...s, name: '' })),
    ),
  );
  const endDependent = useMutation(run((dependentId: string) => client.hr.payroll.dependents.end({ dependentId, endedOn: vietnamToday() })));
  const endEmployee = useMutation(run(() => client.hr.payroll.employees.end({ employeeId, endedOn })));
  const saveEdit = useMutation(
    run(
      () =>
        client.hr.payroll.employees.edit({
          employeeId,
          ...(edit && edit.name.trim() ? { displayName: edit.name.trim() } : {}),
          ...(edit && edit.address.trim() ? { address: edit.address.trim() } : {}),
          ...(edit && edit.identity.trim() ? { identityNumber: edit.identity.trim() } : {}),
          ...(edit && edit.account.trim() ? { accountNumber: edit.account.trim() } : {}),
        }),
      () => setEdit(null),
    ),
  );
  const erase = useMutation(run(() => client.hr.payroll.employees.erase({ employeeId }), () => setConfirmErase(false)));
  if (q.isPending) return <TableSkeleton columns={3} />;
  if (q.error) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const e = q.data;
  const active = e.status === 'active' && !e.erased;
  const none = <span className="text-subtle-foreground">{t('none')}</span>;
  return (
    <Card className="mb-6 block p-4" data-testid="hr-employee-detail">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium text-foreground">{t('detailTitle', { name: e.displayName })}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      {e.erased ? (
        <p className="mt-2 text-sm text-subtle-foreground" data-testid="hr-employee-erased">
          {t('erasedNote')}
        </p>
      ) : (
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-subtle-foreground">{t('address')}</dt>
            <dd>{e.address ?? none}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('identityNumber')}</dt>
            <dd data-testid="hr-employee-identity">{e.identityNumber ?? none}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('accountNumber')}</dt>
            <dd data-testid="hr-employee-account">{e.accountNumber ?? none}</dd>
          </div>
          {e.endedOn && (
            <div>
              <dt className="text-subtle-foreground">{t('endedOn')}</dt>
              <dd>{f.date(e.endedOn)}</dd>
            </div>
          )}
        </dl>
      )}

      {active && (
        <div className="mt-3">
          {edit === null ? (
            <Button variant="ghost" size="sm" onClick={() => setEdit({ name: '', address: '', identity: '', account: '' })}>
              {t('edit')}
            </Button>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="hr-edit-name">{t('name')}</Label>
                <Input id="hr-edit-name" value={edit.name} maxLength={200} placeholder={e.displayName} onChange={(ev) => setEdit({ ...edit, name: ev.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="hr-edit-address">{t('address')}</Label>
                <Input id="hr-edit-address" value={edit.address} maxLength={500} onChange={(ev) => setEdit({ ...edit, address: ev.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="hr-edit-identity">{t('identityNumber')}</Label>
                <Input id="hr-edit-identity" value={edit.identity} maxLength={30} autoComplete="off" onChange={(ev) => setEdit({ ...edit, identity: ev.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="hr-edit-account">{t('accountNumber')}</Label>
                <Input id="hr-edit-account" value={edit.account} maxLength={34} autoComplete="off" onChange={(ev) => setEdit({ ...edit, account: ev.target.value })} />
              </div>
              <p className="text-xs text-subtle-foreground sm:col-span-2">{t('editHint')}</p>
              <div className="flex gap-2 sm:col-span-2">
                <Button loading={saveEdit.isPending} disabled={!(edit.name.trim() || edit.address.trim() || edit.identity.trim() || edit.account.trim())} onClick={() => saveEdit.mutate()}>
                  {t('save')}
                </Button>
                <Button variant="ghost" onClick={() => setEdit(null)}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          )}
          {saveEdit.error && <ErrorText>{errorMessage(saveEdit.error)}</ErrorText>}
        </div>
      )}

      <h3 className="mt-5 text-sm font-medium text-foreground">{t('termsTitle')}</h3>
      <DataTable head={[t('effectiveFrom'), t('contractType'), t('region'), t('baseWage')]} numeric={[3]}>
        {e.employments.map((row) => (
          <TableRow key={row.id} data-testid="hr-terms-row">
            <TableCell className="px-4 py-3">{f.date(row.effectiveFrom)}</TableCell>
            <TableCell className="px-4 py-3">{t(`contracts.${row.contractType}`)}</TableCell>
            <TableCell className="px-4 py-3">{t('regionOption', { region: row.region })}</TableCell>
            <TableCell className={NUM}>{f.money(row.baseWage, 'VND')}</TableCell>
          </TableRow>
        ))}
      </DataTable>
      {active && (
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <TermsFields id="hr-terms" value={terms} onChange={(patch) => setTerms((s) => ({ ...s, ...patch }))} />
          <div className="sm:col-span-4">
            <Button loading={addTerms.isPending} disabled={!wageOk(terms.baseWage)} onClick={() => addTerms.mutate()} data-testid="hr-terms-add">
              {t('addTerms')}
            </Button>
            <span className="ml-2 text-xs text-subtle-foreground">{t('termsHint')}</span>
          </div>
        </div>
      )}
      {addTerms.error && <ErrorText>{errorMessage(addTerms.error)}</ErrorText>}

      <h3 className="mt-5 text-sm font-medium text-foreground">{t('dependentsTitle')}</h3>
      {e.dependents.length === 0 ? (
        <p className="mt-1 text-sm text-subtle-foreground">{t('dependentsEmpty')}</p>
      ) : (
        <DataTable head={[t('name'), t('relation'), t('registeredOn'), '']}>
          {e.dependents.map((d) => (
            <TableRow key={d.id} data-testid="hr-dependent-row">
              <TableCell className="px-4 py-3">{d.displayName}</TableCell>
              <TableCell className="px-4 py-3">{t(`relations.${d.relation}`)}</TableCell>
              <TableCell className="px-4 py-3">
                {f.date(d.registeredOn)}
                {d.endedOn && (
                  <Badge className="ml-2" variant="secondary">
                    {t('dependentEnded', { date: f.date(d.endedOn) })}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="px-4 py-3 text-right">
                {active && d.endedOn === null && (
                  <Button variant="ghost" size="sm" loading={endDependent.isPending && endDependent.variables === d.id} onClick={() => endDependent.mutate(d.id)}>
                    {t('endDependent')}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
      {active && (
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="hr-dep-name">{t('name')}</Label>
            <Input id="hr-dep-name" value={dep.name} maxLength={200} onChange={(ev) => setDep({ ...dep, name: ev.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-dep-relation">{t('relation')}</Label>
            <NativeSelect id="hr-dep-relation" value={dep.relation} onChange={(ev) => setDep({ ...dep, relation: ev.target.value as HrRelation })}>
              {HR_RELATIONS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`relations.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-dep-from">{t('registeredOn')}</Label>
            <Input id="hr-dep-from" type="date" value={dep.registeredOn} onChange={(ev) => setDep({ ...dep, registeredOn: ev.target.value })} />
          </div>
          <div className="flex items-end">
            <Button loading={addDependent.isPending} disabled={dep.name.trim() === ''} onClick={() => addDependent.mutate()} data-testid="hr-dependent-add">
              {t('addDependent')}
            </Button>
          </div>
        </div>
      )}
      {(addDependent.error || endDependent.error) && <ErrorText>{errorMessage(addDependent.error ?? endDependent.error)}</ErrorText>}

      {active && (
        <div className="mt-5 flex flex-wrap items-end gap-3 border-t pt-4">
          <div className="space-y-1">
            <Label htmlFor="hr-end-date">{t('endedOn')}</Label>
            <Input id="hr-end-date" type="date" value={endedOn} onChange={(ev) => setEndedOn(ev.target.value)} />
          </div>
          <Button variant="outline" loading={endEmployee.isPending} onClick={() => endEmployee.mutate()} data-testid="hr-employee-end">
            {t('endEmployee')}
          </Button>
        </div>
      )}
      {endEmployee.error && <ErrorText>{errorMessage(endEmployee.error)}</ErrorText>}

      {owner && e.status === 'ended' && !e.erased && (
        <div className="mt-5 border-t pt-4">
          <p className="text-xs text-subtle-foreground">{t('eraseHint')}</p>
          {confirmErase ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="destructive" loading={erase.isPending} onClick={() => erase.mutate()} data-testid="hr-employee-erase-confirm">
                {t('eraseConfirm')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmErase(false)}>
                {t('cancel')}
              </Button>
            </div>
          ) : (
            <Button className="mt-2" variant="outline" onClick={() => setConfirmErase(true)} data-testid="hr-employee-erase">
              {t('erase')}
            </Button>
          )}
          {erase.error && <ErrorText>{errorMessage(erase.error)}</ErrorText>}
        </div>
      )}
    </Card>
  );
}

export function HrEmployeesPage() {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  const org = useQuery(orpc.org.get.queryOptions());
  const owner = org.data?.role === 'owner';
  const [showEnded, setShowEnded] = useState(false);
  const list = useQuery({ ...orpc.hr.payroll.employees.list.queryOptions({ input: { status: showEnded ? 'all' : 'active', limit: 200 } }), ...ONCE });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows: readonly HrEmployeeSummary[] = list.data ?? [];
  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button disabled={adding} onClick={() => setAdding(true)} data-testid="hr-employee-new">
            {t('new')}
          </Button>
        }
      />
      {adding && <AddForm onClose={() => setAdding(false)} />}
      {open && <Detail key={open} employeeId={open} owner={owner} onClose={() => setOpen(null)} />}
      <div className="mb-2 flex items-center justify-end">
        <label className="flex items-center gap-1 text-xs text-subtle-foreground">
          <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
          {t('showEnded')}
        </label>
      </div>
      {list.isPending ? (
        <TableSkeleton columns={5} />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <DataTable head={[t('name'), t('contractType'), t('region'), t('baseWage'), '']} numeric={[3]}>
          {rows.map((r) => (
            <TableRow key={r.id} data-testid="hr-employee-row">
              <TableCell className="px-4 py-3">
                {r.displayName}
                {r.status === 'ended' && (
                  <Badge className="ml-2" variant="secondary">
                    {t('ended')}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="px-4 py-3">{r.current ? t(`contracts.${r.current.contractType}`) : '-'}</TableCell>
              <TableCell className="px-4 py-3">{r.current ? t('regionOption', { region: r.current.region }) : '-'}</TableCell>
              <TableCell className={NUM}>{r.current ? f.money(r.current.baseWage, 'VND') : '-'}</TableCell>
              <TableCell className="px-4 py-3 text-right">
                <Button variant="ghost" size="sm" onClick={() => setOpen(r.id)} data-testid="hr-employee-open">
                  {t('open')}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
