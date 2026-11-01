// SPDX-License-Identifier: AGPL-3.0-only
// The deals screen (#2225, docs/plan/crm.md step K1): every deal of the org as a list, with its party, stage, amount and
// expected close. A member adds, edits, moves (through the stage menu) and deletes deals; a viewer reads. The pipeline
// board with drag and drop is step K2. Amounts are decimal strings and are shown as the reader's language groups them.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { DEAL_LOST_REASON_MAX, DEAL_TITLE_MAX, zDealAmount, type Deal, type DealCursor, type PartyChoice, type PipelineStage } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { AmountInput } from '../components/amount-input.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { DataTable, Empty, ErrorText, Field, PageHeader, TableSkeleton, focusFirstInvalid, useFieldErrors } from '../components/ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';
import { normalizeAmount } from '../lib/vouchers.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.crm.deals.list.key() });

interface Member {
  userId: string;
  displayName: string | null;
  email: string;
}

type FormField = 'title' | 'party' | 'amount';

// Picks a party by typing part of its name or tax code.
function PartyPicker({ value, onPick, invalid, describedBy }: { value: PartyChoice | null; onPick: (party: PartyChoice | null) => void; invalid: boolean; describedBy?: string | undefined }) {
  const t = useTranslations('deals');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const found = useQuery({ ...orpc.crm.parties.search.queryOptions({ input: { q: q.trim(), limit: 8 } }), enabled: open, placeholderData: keepPreviousData });
  if (value && !open) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-foreground">{value.name}</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {t('form.changeParty')}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Input
        type="search"
        placeholder={t('form.partySearch')}
        aria-label={t('form.party')}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        maxLength={100}
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
      />
      {open && (
        <ul className="max-h-48 overflow-auto rounded-md border border-border text-sm" aria-label={t('form.partyResults')}>
          {found.data?.length === 0 && <li className="px-3 py-2 text-muted-foreground">{t('form.partyNone')}</li>}
          {found.data?.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted"
                onClick={() => {
                  onPick(p);
                  setOpen(false);
                  setQ('');
                }}
              >
                <span>{p.name}</span>
                {p.taxCode && <span className="text-xs text-muted-foreground">{p.taxCode}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DealForm({ deal, members, onDone }: { deal: Deal | null; members: readonly Member[]; onDone: () => void }) {
  const t = useTranslations('deals');
  const [title, setTitle] = useState(deal?.title ?? '');
  const [party, setParty] = useState<PartyChoice | null>(deal ? { id: deal.partyId, name: deal.partyName, kind: 'organization', taxCode: null } : null);
  const [amount, setAmount] = useState(deal ? deal.amount.replace(/\.00$/, '') : '');
  const [expectedClose, setExpectedClose] = useState(deal?.expectedClose ?? '');
  const [ownerUserId, setOwnerUserId] = useState(deal ? (deal.ownerUserId ?? '') : 'me');
  const done = () => {
    void refresh();
    onDone();
  };
  const create = useMutation(orpc.crm.deals.create.mutationOptions({ onSuccess: done }));
  // A refused edit (someone saved first) reloads the list; the form is keyed by the deal's version, so it reopens on the new one.
  const update = useMutation(orpc.crm.deals.update.mutationOptions({ onSuccess: done, onError: () => void refresh() }));
  const pending = create.isPending || update.isPending;
  const fields = useFieldErrors<FormField>((field) => {
    if (field === 'title') return title.trim() ? null : t('form.titleRequired');
    if (field === 'party') return party ? null : t('form.partyRequired');
    return zDealAmount.safeParse(normalizeAmount(amount || '0')).success ? null : t('form.amountInvalid');
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!fields.checkAll(['title', 'party', 'amount']) || !party) {
      focusFirstInvalid(e.currentTarget);
      return;
    }
    const base = { partyId: party.id, title: title.trim(), amount: normalizeAmount(amount || '0'), expectedClose: expectedClose || null };
    if (deal) update.mutate({ ...base, dealId: deal.id, version: deal.version, ownerUserId: ownerUserId || null });
    else create.mutate({ ...base, ...(ownerUserId === 'me' ? {} : { ownerUserId: ownerUserId || null }) });
  };
  const error = create.error ?? update.error;
  return (
    <form onSubmit={submit} noValidate className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2" aria-label={deal ? t('form.editTitle') : t('form.newTitle')}>
      <Field label={t('form.title')} error={fields.of('title')} className="sm:col-span-2">
        {(c) => <Input {...c} maxLength={DEAL_TITLE_MAX} value={title} onChange={(e) => (setTitle(e.target.value), fields.edit('title'))} />}
      </Field>
      <Field label={t('form.party')} error={fields.of('party')}>
        {(c) => <PartyPicker value={party} invalid={Boolean(fields.of('party'))} describedBy={c['aria-describedby']} onPick={(p) => (setParty(p), fields.edit('party'))} />}
      </Field>
      <Field label={t('form.amount')} hint={t('form.amountHint')} error={fields.of('amount')}>
        {(c) => <AmountInput {...c} value={amount} onChange={(v) => (setAmount(v), fields.edit('amount'))} />}
      </Field>
      <Field label={t('form.expectedClose')}>{(c) => <Input {...c} type="date" value={expectedClose} onChange={(e) => setExpectedClose(e.target.value)} />}</Field>
      <Field label={t('form.owner')}>
        {(c) => (
          <NativeSelect {...c} className="w-full" value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
            {!deal && <option value="me">{t('form.ownerMe')}</option>}
            <option value="">{t('form.ownerNone')}</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName ?? m.email}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {error && (
        <div className="sm:col-span-2">
          <ErrorText>{errorMessage(error)}</ErrorText>
        </div>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" loading={pending}>
          {deal ? t('form.save') : t('form.create')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('form.cancel')}
        </Button>
      </div>
    </form>
  );
}

function DealRow({ deal, stages, members, canEdit, canDelete, columns }: { deal: Deal; stages: readonly PipelineStage[]; members: readonly Member[]; canEdit: boolean; canDelete: boolean; columns: number }) {
  const t = useTranslations('deals');
  const { locale } = useLocaleSetting();
  const [editing, setEditing] = useState(false);
  // A move into a lost stage asks for an optional reason first.
  const [losing, setLosing] = useState<PipelineStage | null>(null);
  const [reason, setReason] = useState('');
  const move = useMutation(
    orpc.crm.deals.move.mutationOptions({
      onSuccess: () => {
        setLosing(null);
        setReason('');
        void refresh();
      },
    }),
  );
  const remove = useMutation(orpc.crm.deals.delete.mutationOptions({ onSuccess: () => void refresh() }));
  const owner = members.find((m) => m.userId === deal.ownerUserId);
  const overdue = deal.stageKind === 'open' && deal.expectedClose !== null && deal.expectedClose < new Date().toISOString().slice(0, 10);
  const pick = (stageId: string) => {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage || stage.id === deal.stageId) return;
    if (stage.kind === 'lost') setLosing(stage);
    else move.mutate({ dealId: deal.id, version: deal.version, stageId: stage.id });
  };
  return (
    <>
      <TableRow data-testid="deal-row">
        <TableCell className="px-4 text-sm">
          <p className="font-medium text-foreground">{deal.title}</p>
          {deal.lostReason && <p className="text-xs text-muted-foreground">{t('lostReason', { reason: deal.lostReason })}</p>}
        </TableCell>
        <TableCell className="px-4 text-sm">{deal.partyName}</TableCell>
        <TableCell className="px-4 text-sm">
          {canEdit ? (
            <NativeSelect size="sm" aria-label={t('stageOf', { title: deal.title })} value={deal.stageId} disabled={move.isPending} onChange={(e) => pick(e.target.value)}>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Badge variant="outline">{stages.find((s) => s.id === deal.stageId)?.name ?? ''}</Badge>
          )}
        </TableCell>
        <TableCell className="px-4 text-right text-sm tabular-nums">{formatMoney(deal.amount, locale, deal.currency)}</TableCell>
        <TableCell className={`px-4 text-sm ${overdue ? 'text-destructive' : ''}`}>{deal.expectedClose ?? ''}</TableCell>
        <TableCell className="px-4 text-sm">{owner ? (owner.displayName ?? owner.email) : ''}</TableCell>
        {canEdit && (
          <TableCell className="px-4">
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
                {t('edit')}
              </Button>
              {canDelete && (
                <ConfirmDialog
                  render={
                    <Button size="sm" variant="outline">
                      {t('delete')}
                    </Button>
                  }
                  title={t('deleteTitle')}
                  description={t('deleteDescription', { title: deal.title })}
                  confirm={t('deleteYes')}
                  destructive
                  onConfirm={() => remove.mutate({ dealId: deal.id })}
                >
                  {t('delete')}
                </ConfirmDialog>
              )}
            </div>
          </TableCell>
        )}
      </TableRow>
      {(losing || move.error || remove.error) && (
        <TableRow>
          <TableCell colSpan={columns} className="px-4 py-3">
            {losing && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  move.mutate({ dealId: deal.id, version: deal.version, stageId: losing.id, lostReason: reason.trim() || null });
                }}
              >
                <Field label={t('lostReasonLabel')} className="min-w-64">
                  {(c) => <Input {...c} maxLength={DEAL_LOST_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />}
                </Field>
                <Button type="submit" size="sm" loading={move.isPending}>
                  {t('markLost')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setLosing(null)}>
                  {t('form.cancel')}
                </Button>
              </form>
            )}
            {(move.error || remove.error) && <ErrorText>{errorMessage(move.error ?? remove.error)}</ErrorText>}
          </TableCell>
        </TableRow>
      )}
      {editing && (
        <TableRow>
          <TableCell colSpan={columns} className="px-4 py-3">
            <DealForm key={deal.version} deal={deal} members={members} onDone={() => setEditing(false)} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function DealsPage() {
  const t = useTranslations('deals');
  const org = useQuery(orpc.org.get.queryOptions());
  const role = org.data?.role;
  const canEdit = role === 'owner' || role === 'admin' || role === 'member';
  const members = org.data?.members ?? [];
  const [adding, setAdding] = useState(false);
  const stages = useQuery(orpc.crm.pipeline.stages.queryOptions({ input: {} }));
  // The first member to open the screen in an org with no pipeline gets the default stages.
  const setup = useMutation(orpc.crm.pipeline.setup.mutationOptions({ onSuccess: (data) => queryClient.setQueryData(orpc.crm.pipeline.stages.queryKey({ input: {} }), data) }));
  const { mutate: setupStages } = setup;
  const needsSetup = canEdit && stages.data?.length === 0;
  useEffect(() => {
    if (needsSetup) setupStages({});
  }, [needsSetup, setupStages]);
  const deals = useInfiniteQuery({
    ...orpc.crm.deals.list.infiniteOptions({
      input: (cursor: DealCursor | undefined) => (cursor ? { cursor } : {}),
      initialPageParam: undefined as DealCursor | undefined,
      getNextPageParam: (page) => page.next ?? undefined,
      placeholderData: keepPreviousData,
    }),
  });
  const rows = deals.data?.pages.flatMap((p) => p.items) ?? [];
  const head = [t('columns.title'), t('columns.party'), t('columns.stage'), t('columns.amount'), t('columns.expectedClose'), t('columns.owner'), ...(canEdit ? [''] : [])];
  const stageList = stages.data ?? [];

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canEdit ? (
            <Button onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
              {t('add')}
            </Button>
          ) : undefined
        }
      />
      {adding && (
        <div className="mb-4">
          <DealForm deal={null} members={members} onDone={() => setAdding(false)} />
        </div>
      )}
      {deals.isPending || stages.isPending ? (
        <TableSkeleton columns={6} />
      ) : (deals.error || stages.error) && rows.length === 0 ? (
        <ErrorText>{errorMessage(deals.error ?? stages.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={t('empty')} hint={canEdit ? t('emptyHint') : undefined} />
      ) : (
        <>
          <DataTable head={head} numeric={[3]}>
            {rows.map((d) => (
              <DealRow key={d.id} deal={d} stages={stageList} members={members} canEdit={canEdit} canDelete={d.canDelete} columns={head.length} />
            ))}
          </DataTable>
          {deals.hasNextPage && (
            <div className="mt-3">
              <Button variant="outline" size="sm" disabled={deals.isFetchingNextPage} onClick={() => void deals.fetchNextPage()}>
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
