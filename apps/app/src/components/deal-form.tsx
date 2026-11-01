// SPDX-License-Identifier: AGPL-3.0-only
// The deal form and its party picker (#2225, #2226): one form for adding a deal and editing one, used by the list and by
// the board. Amounts are decimal strings; the form keeps what was typed and sends the normalized digits.
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { DEAL_TITLE_MAX, zDealAmount, type Deal, type PartyChoice } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { AmountInput } from './amount-input.tsx';
import { ErrorText, Field, focusFirstInvalid, useFieldErrors } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { normalizeAmount } from '../lib/vouchers.ts';

export const refreshDeals = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.board.key() });
};

export interface Member {
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

export function DealForm({ deal, members, onDone }: { deal: Deal | null; members: readonly Member[]; onDone: () => void }) {
  const t = useTranslations('deals');
  const [title, setTitle] = useState(deal?.title ?? '');
  const [party, setParty] = useState<PartyChoice | null>(deal ? { id: deal.partyId, name: deal.partyName, kind: 'organization', taxCode: null } : null);
  const [amount, setAmount] = useState(deal ? deal.amount.replace(/\.00$/, '') : '');
  const [expectedClose, setExpectedClose] = useState(deal?.expectedClose ?? '');
  const [ownerUserId, setOwnerUserId] = useState(deal ? (deal.ownerUserId ?? '') : 'me');
  const done = () => {
    refreshDeals();
    onDone();
  };
  const create = useMutation(orpc.crm.deals.create.mutationOptions({ onSuccess: done }));
  // A refused edit (someone saved first) reloads the list; the form is keyed by the deal's version, so it reopens on the new one.
  const update = useMutation(orpc.crm.deals.update.mutationOptions({ onSuccess: done, onError: refreshDeals }));
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
