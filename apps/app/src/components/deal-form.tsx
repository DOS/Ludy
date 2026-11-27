// SPDX-License-Identifier: AGPL-3.0-only
// The deal form and its party picker (#2225, #2226): one form for adding a deal and editing one, used by the list and by
// the board. Amounts are decimal strings; the form keeps what was typed and sends the normalized digits.
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { DEAL_TITLE_MAX, zDealAmount, type Deal, type PartyChoice } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect } from '@ludy/ui/components/native-select';
import { AmountInput } from './amount-input.tsx';
import { DateInput, hasInvalidDate } from './date-input.tsx';
import { NewPartyGroup } from './deal-party-new.tsx';
import { ErrorText, Field, focusFirstInvalid, useFieldErrors } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { normalizeAmount } from '../lib/vouchers.ts';

export const refreshDeals = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.board.key() });
  // The deal read by id (the offers on the quotes tab, #3420) follows a move or an edit made from the board, the list or the form.
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.get.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.conversations.key() });
  // A deal added from a contact's panel shows in that panel, and the contact lists count their open deals.
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.byParty.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.contacts.key() });
  // An edit or a move closes the deal's next step, and a done or a snooze changes the badge: the next steps read again with the deals.
  void queryClient.invalidateQueries({ queryKey: orpc.crm.nextSteps.key() });
};

export interface Member {
  userId: string;
  displayName: string | null;
  email: string;
}

type FormField = 'title' | 'party' | 'amount';

// Picks a party by typing part of its name or tax code; when none matches, "Thêm liên hệ mới" adds one in place (#3292).
// locked: the deal is for this party and the picker only shows it (a deal added from the party's own panel).
function PartyPicker({ value, onPick, invalid, describedBy, locked }: { value: PartyChoice | null; onPick: (party: PartyChoice | null) => void; invalid: boolean; describedBy?: string | undefined; locked: boolean }) {
  const t = useTranslations('deals');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const found = useQuery({ ...orpc.crm.parties.search.queryOptions({ input: { q: q.trim(), limit: 8 } }), enabled: open, placeholderData: keepPreviousData });
  if (value && (locked || !open)) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-foreground">{value.name}</span>
        {!locked && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
            {t('form.changeParty')}
          </Button>
        )}
      </div>
    );
  }
  if (creating) {
    return (
      <NewPartyGroup
        initialName={q}
        onCancel={() => setCreating(false)}
        onCreated={(party) => {
          onPick(party);
          setCreating(false);
          setOpen(false);
          setQ('');
        }}
      />
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
          {found.data?.length === 0 && !found.isPlaceholderData && (
            <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-muted-foreground">
              <span>{t('form.partyNone')}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => {
                  // The deal is for the new contact: the customer chosen before is let go, so it cannot be saved with the old one meanwhile.
                  onPick(null);
                  setCreating(true);
                }}>
                {t('form.newParty.open')}
              </Button>
            </li>
          )}
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

// What the person has typed so far, by field. A field that is not here follows the deal; one that is here keeps what was typed (null is a real edit: the customer let go).
export interface DealFormEdits {
  title?: string;
  party?: PartyChoice | null;
  amount?: string;
  expectedClose?: string;
  ownerUserId?: string;
}

export interface DealFormValues {
  title: string;
  party: PartyChoice | null;
  amount: string;
  expectedClose: string;
  ownerUserId: string;
}

// The values the form shows: the deal as it is now, with the person's own edits on top (#5015). A deal that changes under an open form (a read that lands after the card's copy, a quote's offer, a move
// from another tab) updates the fields nobody touched and never throws away or resets what was typed, so a save sends the typed title with the newest version and not the stale one.
export function dealFormValues(deal: Deal | null, presetParty: PartyChoice | null, edits: DealFormEdits): DealFormValues {
  const base: DealFormValues = {
    title: deal?.title ?? '',
    party: deal ? { id: deal.partyId, name: deal.partyName, kind: 'organization', taxCode: null } : presetParty,
    amount: deal ? deal.amount.replace(/\.00$/, '') : '',
    expectedClose: deal?.expectedClose ?? '',
    ownerUserId: deal ? (deal.ownerUserId ?? '') : 'me',
  };
  return {
    title: edits.title ?? base.title,
    party: edits.party !== undefined ? edits.party : base.party,
    amount: edits.amount ?? base.amount,
    expectedClose: edits.expectedClose ?? base.expectedClose,
    ownerUserId: edits.ownerUserId ?? base.ownerUserId,
  };
}

// presetParty: a new deal for this party, chosen and not changeable (the contact panel's "Thêm cơ hội", #3292). plain: the form sits in a side sheet (#3648), which frames it: one column, no border of its own.
// The form is not keyed by the deal's version: a newer version keeps the typed edits (see dealFormValues) and the next save carries that version.
export function DealForm({ deal, members, onDone, presetParty = null, plain = false }: { deal: Deal | null; members: readonly Member[]; onDone: () => void; presetParty?: PartyChoice | null; plain?: boolean }) {
  const t = useTranslations('deals');
  const [edits, setEdits] = useState<DealFormEdits>({});
  const { title, party, amount, expectedClose, ownerUserId } = dealFormValues(deal, presetParty, edits);
  const setTitle = (v: string) => setEdits((e) => ({ ...e, title: v }));
  const setParty = (v: PartyChoice | null) => setEdits((e) => ({ ...e, party: v }));
  const setAmount = (v: string) => setEdits((e) => ({ ...e, amount: v }));
  const setExpectedClose = (v: string) => setEdits((e) => ({ ...e, expectedClose: v }));
  const setOwnerUserId = (v: string) => setEdits((e) => ({ ...e, ownerUserId: v }));
  const done = () => {
    refreshDeals();
    onDone();
  };
  const create = useMutation(orpc.crm.deals.create.mutationOptions({ onSuccess: done }));
  // A refused edit (someone saved first) reloads the deal: untouched fields show the new values, typed ones stay, and saving again sends the new version.
  const update = useMutation(orpc.crm.deals.update.mutationOptions({ onSuccess: done, onError: refreshDeals }));
  const pending = create.isPending || update.isPending;
  const fields = useFieldErrors<FormField>((field) => {
    if (field === 'title') return title.trim() ? null : t('form.titleRequired');
    if (field === 'party') return party ? null : t('form.partyRequired');
    return zDealAmount.safeParse(normalizeAmount(amount || '0')).success ? null : t('form.amountInvalid');
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (hasInvalidDate(e.currentTarget)) {
      e.currentTarget.reportValidity();
      return;
    }
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
    <form onSubmit={submit} noValidate className={plain ? 'grid gap-3' : 'grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2'} aria-label={deal ? t('form.editTitle') : t('form.newTitle')}>
      <Field label={t('form.title')} error={fields.of('title')} {...(plain ? {} : { className: 'sm:col-span-2' })}>
        {(c) => <Input {...c} maxLength={DEAL_TITLE_MAX} value={title} onChange={(e) => (setTitle(e.target.value), fields.edit('title'))} />}
      </Field>
      <Field label={t('form.party')} error={fields.of('party')}>
        {(c) => <PartyPicker value={party} locked={!deal && presetParty !== null} invalid={Boolean(fields.of('party'))} describedBy={c['aria-describedby']} onPick={(p) => (setParty(p), fields.edit('party'))} />}
      </Field>
      <Field label={t('form.amount')} hint={t('form.amountHint')} error={fields.of('amount')}>
        {(c) => <AmountInput {...c} value={amount} onChange={(v) => (setAmount(v), fields.edit('amount'))} />}
      </Field>
      <Field label={t('form.expectedClose')}>{(c) => <DateInput {...c} value={expectedClose} onChange={setExpectedClose} />}</Field>
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
        <div className={plain ? undefined : 'sm:col-span-2'}>
          <ErrorText>{errorMessage(error)}</ErrorText>
        </div>
      )}
      <div className={plain ? 'flex gap-2' : 'flex gap-2 sm:col-span-2'}>
        <Button type="submit" loading={pending}>
          {deal ? t('form.save') : t('form.create')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('form.cancel')}
        </Button>
      </div>
      {deal && (
        <div className={plain ? undefined : 'sm:col-span-2'}>
          <DealConversations dealId={deal.id} />
        </div>
      )}
    </form>
  );
}

// The hint of a deal whose customer was marked a duplicate (CRM-15, #3294): "Liên hệ này đã được đánh dấu trùng với <name>". An editor may move the
// deal to the party that was kept with one click (`crm.deal.update`, nothing moves by itself); a viewer only reads the hint. Nothing shows for a
// deal on a customer that is not a duplicate.
export function DealPartyDuplicate({ deal, canEdit }: { deal: Deal; canEdit: boolean }) {
  const t = useTranslations('deals');
  const move = useMutation(orpc.crm.deals.update.mutationOptions({ onSuccess: refreshDeals, onError: refreshDeals }));
  const keep = deal.partyDuplicateOf;
  if (!keep) return null;
  return (
    <div data-testid="deal-party-duplicate" className="mt-1 space-y-1 text-xs">
      <p className="text-muted-foreground">{t('duplicate.hint', { name: keep.name })}</p>
      {canEdit && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={move.isPending}
          onClick={() => move.mutate({ dealId: deal.id, version: deal.version, partyId: keep.id, title: deal.title, amount: deal.amount, expectedClose: deal.expectedClose, ownerUserId: deal.ownerUserId })}
        >
          {t('duplicate.move', { name: keep.name })}
        </Button>
      )}
      {move.error && <ErrorText>{errorMessage(move.error)}</ErrorText>}
    </div>
  );
}

// The conversations of a deal's customer since the deal opened (#2333): channel, kind, status and last message time, with a
// link into the Inbox thread. Message bodies stay in the Inbox and are never read or copied here.
export function DealConversations({ dealId }: { dealId: string }) {
  const t = useTranslations('deals');
  const tc = useTranslations('conversations');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const conversations = useQuery(orpc.crm.deals.conversations.queryOptions({ input: { dealId } }));
  return (
    <div data-testid="deal-conversations" className="border-t border-border pt-3">
      <p className="mb-2 text-sm font-medium text-muted-foreground">{t('conversations.title')}</p>
      {conversations.error ? (
        <ErrorText>{errorMessage(conversations.error)}</ErrorText>
      ) : (conversations.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-subtle-foreground">{t('conversations.empty')}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {conversations.data?.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-2">
              <Link to="/o/$slug/social/inbox" params={{ slug }} search={{ c: c.id }} className="font-medium text-link underline">
                {c.channel.displayName}
              </Link>
              <span className="text-xs text-muted-foreground">{tc(`kind.${c.kind}`)}</span>
              <Badge variant="outline">{tc(`status.${c.status}`)}</Badge>
              {c.lastMessageAt && (
                <time dateTime={c.lastMessageAt} className="text-xs text-subtle-foreground">
                  {f.dateTime(c.lastMessageAt)}
                </time>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
