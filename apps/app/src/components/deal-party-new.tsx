// SPDX-License-Identifier: AGPL-3.0-only
// "Thêm liên hệ mới" inside the deal form (#3292, docs/plan/crm.md section 6): when the search finds no customer, a small group of
// fields (name, kind, phone, email and, for a company, the tax code) runs the party create command and hands the new party to the
// picker, so a seller adds a deal for a customer who is not yet a contact without leaving the form. It is the contacts screen's own
// command (kernel.party.create), so a tax code that already belongs to a contact is refused there, naming that contact, and the
// refusal shows here. The command does not refuse a phone number, so a number already on a contact is checked first (lib/new-party.ts,
// a read of the contacts search) and that contact is offered with "Chọn liên hệ này". The deal form is a <form>: this is a group with its own button, not a nested form, and Enter in a field adds
// the contact and never submits the deal.
import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import { normalizeTaxCode, type PartyChoice } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect } from '@ludy/ui/components/native-select';
import { refreshParties } from './party-edit.tsx';
import { TaxCodeFieldRow, TaxLookupCard, usePartyTaxLookup } from './tax-lookup-card.tsx';
import { ErrorText, Field, focusFirstInvalid, isEmailAddress, useFieldErrors } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { resolveNewParty, type PhoneHit } from '../lib/new-party.ts';

type NewField = 'name' | 'taxCode' | 'email';
type Kind = PartyChoice['kind'];

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

export function NewPartyGroup({ initialName, onCreated, onCancel }: { initialName: string; onCreated: (party: PartyChoice) => void; onCancel: () => void }) {
  const t = useTranslations('deals');
  const tc = useTranslations('contacts');
  // A search that is a tax code becomes the tax code of a company, not the name of a person.
  const searchedTaxCode = normalizeTaxCode(initialName) ? initialName.trim() : '';
  const [kind, setKind] = useState<Kind>(searchedTaxCode ? 'organization' : 'person');
  const [name, setName] = useState(searchedTaxCode ? '' : initialName.trim());
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [taxCode, setTaxCode] = useState(searchedTaxCode);
  const [address, setAddress] = useState('');
  const taxLookup = usePartyTaxLookup(taxCode, kind === 'organization');
  // The lists refresh when the contact exists, even if this group was closed before the answer came.
  const root = useRef<HTMLDivElement>(null);
  const create = useMutation(orpc.parties.create.mutationOptions({ onSuccess: refreshParties }));
  const fields = useFieldErrors<NewField>((field) => {
    if (field === 'name') return name.trim() ? null : tc('nameRequired');
    if (field === 'taxCode') return kind === 'person' || !taxCode.trim() || normalizeTaxCode(taxCode) ? null : tc('taxCodeInvalid');
    return !email.trim() || isEmailAddress(email) ? null : tc('emailInvalid');
  });
  // The contact that already has the typed number: offered in place of a second one (the party command does not refuse a phone).
  const [existing, setExisting] = useState<PhoneHit | null>(null);
  const [checking, setChecking] = useState(false);
  const busy = create.isPending || checking;
  const submit = async () => {
    if (busy) return;
    if (!fields.checkAll(['name', 'taxCode', 'email'])) {
      if (root.current) focusFirstInvalid(root.current);
      return;
    }
    const tax = kind === 'organization' ? orNull(taxCode) : null;
    setExisting(null);
    setChecking(true);
    try {
      const result = await resolveNewParty({
        phone: orNull(phone),
        search: async (filters) => (await queryClient.fetchQuery({ ...orpc.crm.contacts.list.queryOptions({ input: { filters } }), staleTime: 0 })).items,
        create: () =>
          create.mutateAsync({
            kind,
            name: name.trim(),
            taxCode: tax,
            address: kind === 'organization' ? orNull(address) : null,
            email: orNull(email),
            phone: orNull(phone),
          }),
      });
      if (result.status === 'existing') setExisting(result.party);
      else onCreated({ id: result.value.partyId, name: name.trim(), kind, taxCode: tax });
    } catch {
      // The refusal shows under the fields (create.error); nothing was created.
    } finally {
      setChecking(false);
    }
  };
  // Enter adds the contact; the deal form around this group is not submitted by it.
  const onEnter = (e: KeyboardEvent<HTMLElement>) => {
    // Enter that ends a Vietnamese input method's syllable is not a request to add the contact.
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || (e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    void submit();
  };
  return (
    <div ref={root} role="group" aria-label={t('form.newParty.title')} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2" data-testid="deal-new-party" onKeyDown={onEnter}>
      <p className="text-sm font-medium text-foreground sm:col-span-2">{t('form.newParty.title')}</p>
      <Field label={tc('fields.name')} error={fields.of('name')} className="sm:col-span-2">
        {(c) => <Input {...c} maxLength={300} autoFocus value={name} onChange={(e) => (setName(e.target.value), fields.edit('name'))} onBlur={(e) => fields.blur('name', e.target.value)} />}
      </Field>
      <Field label={tc('fields.kind')}>
        {(c) => (
          <NativeSelect
            {...c}
            className="w-full"
            value={kind}
            onChange={(e) => {
              const nextKind = e.target.value === 'organization' ? 'organization' : 'person';
              setKind(nextKind);
              if (nextKind === 'person') taxLookup.reset();
            }}
          >
            <option value="person">{tc('kind.person')}</option>
            <option value="organization">{tc('kind.organization')}</option>
          </NativeSelect>
        )}
      </Field>
      <Field label={tc('fields.phone')}>{(c) => <Input {...c} type="tel" maxLength={30} value={phone} onChange={(e) => (setPhone(e.target.value), setExisting(null))} />}</Field>
      <Field label={tc('fields.email')} error={fields.of('email')}>
        {(c) => <Input {...c} type="email" maxLength={254} value={email} onChange={(e) => (setEmail(e.target.value), fields.edit('email'))} onBlur={(e) => fields.blur('email', e.target.value)} />}
      </Field>
      {kind === 'organization' && (
        <>
          <Field label={tc('fields.taxCode')} error={fields.of('taxCode')} className="sm:col-span-2">
            {(c) => (
              <TaxCodeFieldRow lookup={taxLookup}>
                {(className) => (
                  <Input
                    {...c}
                    className={className}
                    maxLength={20}
                    value={taxCode}
                    onChange={(e) => (setTaxCode(e.target.value), fields.edit('taxCode'))}
                    onBlur={(e) => {
                      fields.blur('taxCode', e.target.value);
                      taxLookup.triggerOnBlur(e.target.value);
                    }}
                  />
                )}
              </TaxCodeFieldRow>
            )}
          </Field>
          {taxLookup.deployed && (
            <TaxLookupCard
              lookup={taxLookup}
              currentName={name}
              currentAddress={address}
              className="sm:col-span-2"
              onFillName={(nextName) => {
                setName((cur) => (cur.trim() === '' ? nextName : cur));
                fields.edit('name');
              }}
              onFillAddress={(nextAddress) => {
                setAddress((cur) => (cur.trim() === '' ? nextAddress : cur));
              }}
            />
          )}
          <Field label={tc('fields.address')} className="sm:col-span-2">
            {(c) => (
              <Input
                {...c}
                maxLength={500}
                placeholder={tc('panel.placeholder.address')}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            )}
          </Field>
        </>
      )}
      {existing && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-sm sm:col-span-2" data-testid="deal-new-party-existing">
          <span className="text-foreground">{t('form.newParty.phoneTaken', { name: existing.name })}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => onCreated({ id: existing.id, name: existing.name, kind: existing.kind, taxCode: existing.taxCode })}>
            {t('form.newParty.useExisting')}
          </Button>
        </div>
      )}
      {create.error && (
        <div className="sm:col-span-2">
          <ErrorText>{errorMessage(create.error)}</ErrorText>
        </div>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="button" size="sm" loading={busy} onClick={() => void submit()}>
          {t('form.newParty.submit')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('form.newParty.cancel')}
        </Button>
      </div>
    </div>
  );
}
