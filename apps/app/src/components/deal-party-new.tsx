// SPDX-License-Identifier: AGPL-3.0-only
// "Thêm liên hệ mới" inside the deal form (#3292, docs/plan/crm.md section 6): when the search finds no customer, a small group of
// fields (name, kind, phone, email and, for a company, the tax code) runs the party create command and hands the new party to the
// picker, so a seller adds a deal for a customer who is not yet a contact without leaving the form. It is the contacts screen's own
// command (kernel.party.create), so a tax code that already belongs to a contact is refused there, naming that contact, and the
// refusal shows here. The deal form is a <form>: this is a group with its own button, not a nested form, and Enter in a field adds
// the contact and never submits the deal.
import { useMutation } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import { normalizeTaxCode, type PartyChoice } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { refreshParties } from './party-edit.tsx';
import { ErrorText, Field, isEmailAddress, useFieldErrors } from './ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

type NewField = 'name' | 'taxCode' | 'email';
type Kind = PartyChoice['kind'];

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

export function NewPartyGroup({ initialName, onCreated, onCancel }: { initialName: string; onCreated: (party: PartyChoice) => void; onCancel: () => void }) {
  const t = useTranslations('deals');
  const tc = useTranslations('contacts');
  const [kind, setKind] = useState<Kind>('person');
  const [name, setName] = useState(initialName.trim());
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [taxCode, setTaxCode] = useState('');
  const create = useMutation(orpc.parties.create.mutationOptions());
  const fields = useFieldErrors<NewField>((field) => {
    if (field === 'name') return name.trim() ? null : tc('nameRequired');
    if (field === 'taxCode') return kind === 'person' || !taxCode.trim() || normalizeTaxCode(taxCode) ? null : tc('taxCodeInvalid');
    return !email.trim() || isEmailAddress(email) ? null : tc('emailInvalid');
  });
  const submit = () => {
    if (create.isPending) return;
    if (!fields.checkAll(['name', 'taxCode', 'email'])) return;
    const tax = kind === 'organization' ? orNull(taxCode) : null;
    create.mutate(
      { kind, name: name.trim(), taxCode: tax, email: orNull(email), phone: orNull(phone) },
      {
        onSuccess: ({ partyId }) => {
          refreshParties();
          onCreated({ id: partyId, name: name.trim(), kind, taxCode: tax });
        },
      },
    );
  };
  // Enter adds the contact; the deal form around this group is not submitted by it.
  const onEnter = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    submit();
  };
  return (
    <div role="group" aria-label={t('form.newParty.title')} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2" data-testid="deal-new-party" onKeyDown={onEnter}>
      <p className="text-sm font-medium text-foreground sm:col-span-2">{t('form.newParty.title')}</p>
      <Field label={tc('fields.name')} error={fields.of('name')} className="sm:col-span-2">
        {(c) => <Input {...c} maxLength={300} autoFocus value={name} onChange={(e) => (setName(e.target.value), fields.edit('name'))} onBlur={(e) => fields.blur('name', e.target.value)} />}
      </Field>
      <Field label={tc('fields.kind')}>
        {(c) => (
          <NativeSelect {...c} className="w-full" value={kind} onChange={(e) => setKind(e.target.value === 'organization' ? 'organization' : 'person')}>
            <option value="person">{tc('kind.person')}</option>
            <option value="organization">{tc('kind.organization')}</option>
          </NativeSelect>
        )}
      </Field>
      <Field label={tc('fields.phone')}>{(c) => <Input {...c} type="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
      <Field label={tc('fields.email')} error={fields.of('email')}>
        {(c) => <Input {...c} type="email" maxLength={254} value={email} onChange={(e) => (setEmail(e.target.value), fields.edit('email'))} onBlur={(e) => fields.blur('email', e.target.value)} />}
      </Field>
      {kind === 'organization' && (
        <Field label={tc('fields.taxCode')} error={fields.of('taxCode')}>
          {(c) => <Input {...c} maxLength={20} value={taxCode} onChange={(e) => (setTaxCode(e.target.value), fields.edit('taxCode'))} onBlur={(e) => fields.blur('taxCode', e.target.value)} />}
        </Field>
      )}
      {create.error && (
        <div className="sm:col-span-2">
          <ErrorText>{errorMessage(create.error)}</ErrorText>
        </div>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="button" size="sm" loading={create.isPending} onClick={submit}>
          {t('form.newParty.submit')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('form.newParty.cancel')}
        </Button>
      </div>
    </div>
  );
}
