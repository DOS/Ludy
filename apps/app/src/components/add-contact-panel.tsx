// SPDX-License-Identifier: AGPL-3.0-only
// "Thêm liên hệ" and "Thêm công ty" (docs/plan/crm.md, K4): a person or a company by hand, in a panel at the right edge that opens over the
// list (DESIGN.md 4.5), full screen on a phone. A person takes Email, Tên, Điện thoại and the Công ty they work at (an existing one, or a
// new one typed here, linked with kernel.party.set_company); no tax code, which a private person does not have. A company takes Tên,
// Mã số thuế, Email and Điện thoại. The address of either sits in a folded "Thông tin thêm" section; the rest of a person stays on their row, which opens after saving.
// While the email (or a company's tax code) is typed, the contacts search is asked for it, and a contact that already has it is shown under the
// field with a way to open it; saving then needs an explicit "Vẫn thêm". The AI part is the sales coworker's suggestion of the company from
// the email's domain (company-link.tsx), which the opened person shows; nothing in this panel calls a model. kernel.party.create checks
// again on the server and names the contact that already holds a tax code.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { normalizeTaxCode, type Contact, type FilterAst } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@ludy/ui/components/sheet';
import { refreshParties } from './party-edit.tsx';
import { TaxCodeFieldRow, TaxLookupCard, usePartyTaxLookup } from './tax-lookup-card.tsx';
import { ErrorText, FieldError, fieldControl, focusFirstInvalid, isEmailAddress, useFieldErrors } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { SEARCH_VALUE_MAX, duplicateKey, duplicateSearch, findDuplicate, type DuplicateHit, type DuplicateKey } from '../lib/contact-duplicate.ts';
import { useDebounced } from '../lib/use-debounced.ts';

// The search waits for a pause in typing, so one request goes out per word and not per key.
const PAUSE_MS = 300;
// The companies shown under the company field, and the contacts the duplicate check reads.
const COMPANY_CHOICES = 5;
// The search is by a part of a word, so a whole email also finds the longer ones that contain it: the exact one is looked for on every page read.
const DUPLICATE_READ = 50;
// Pages of matches read on before saying there is none.
const MAX_PAGES = 4;

export type AddedContact = { partyId: string; name: string };
type Kind = 'person' | 'organization';
type Field = 'name' | 'taxCode' | 'email';

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

// The first contact of a search that `match` accepts, reading on through the next pages (the list is by name, so the exact one need not be on the first).
async function findAcross(filters: FilterAst, match: (contact: Contact) => boolean): Promise<Contact | null> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await client.crm.contacts.list({ filters, limit: DUPLICATE_READ, ...(cursor ? { cursor } : {}) });
    const hit = read.items.find(match);
    if (hit) return hit;
    if (!read.next) return null;
    cursor = read.next;
  }
  return null;
}

// The query of the duplicate check, under the contacts' own key so a save anywhere refreshes it; the panel reads it while the value is typed and again on saving.
const duplicateQuery = (key: DuplicateKey) => ({
  queryKey: [...orpc.crm.contacts.key(), 'duplicate', key.field, key.value] as const,
  queryFn: () => findAcross(duplicateSearch(key), (c) => findDuplicate(key, [c]) !== null),
});

// The contact that already has this email or tax code: read while it is typed, shown under the field.
function useDuplicate(key: DuplicateKey | null): DuplicateHit | null {
  const found = useQuery({ ...duplicateQuery(key ?? { field: 'email', value: '' }), enabled: key !== null });
  return key ? (found.data ?? null) : null;
}

// The companies matching what is typed in the company field (none while one is picked or nothing is typed).
function useCompanyChoices(text: string, picked: boolean): { choices: Contact[]; pending: boolean } {
  const term = useDebounced(text.trim(), PAUSE_MS);
  const filters: FilterAst = { v: 1, all: [{ field: 'kind', op: 'is', value: 'organization' }, ...(term ? [{ field: 'search', op: 'contains' as const, value: term }] : [])] };
  const found = useQuery({ ...orpc.crm.contacts.list.queryOptions({ input: { filters, limit: COMPANY_CHOICES } }), enabled: !picked && term !== '' && term.length <= SEARCH_VALUE_MAX });
  return { choices: !picked && term !== '' ? (found.data?.items ?? []) : [], pending: term !== text.trim() || found.isPending };
}

// The company field of a person: type to search the companies, pick one, or leave the typed name to make a new company on saving.
function CompanyField({ text, picked, choices, searching, onText, onPick }: { text: string; picked: { id: string; name: string } | null; choices: Contact[]; searching: boolean; onText: (value: string) => void; onPick: (company: { id: string; name: string } | null) => void }) {
  const t = useTranslations('contacts');
  const exact = choices.some((c) => same(c.name, text));
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="add-contact-company">{t('company.label')}</Label>
      {picked ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5" data-testid="add-contact-company-picked">
          <span className="min-w-0 truncate text-foreground">{picked.name}</span>
          <Button type="button" variant="ghost" size="sm" aria-label={t('panel.companyClear', { name: picked.name })} onClick={() => onPick(null)}>
            {t('company.clear')}
          </Button>
        </div>
      ) : (
        <>
          <Input {...fieldControl('add-contact-company', { hint: true, error: false })} value={text} maxLength={300} placeholder={t('panel.companyPlaceholder')} autoComplete="off" onChange={(e) => onText(e.target.value)} />
          {/* The choices change as the person types: a polite live region lets a screen reader hear them. */}
          <div aria-live="polite">
            {choices.length > 0 && (
              <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                {choices.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted focus-visible:bg-muted" aria-label={t('company.pick', { name: c.name })} onClick={() => onPick({ id: c.id, name: c.name })}>
                      <span className="min-w-0 truncate text-foreground">{c.name}</span>
                      {c.taxCode && <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.taxCode}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {text.trim() !== '' && !exact && !searching && <p className="mt-1 text-xs text-muted-foreground">{t('panel.companyNew', { name: text.trim() })}</p>}
          </div>
        </>
      )}
      <p id="add-contact-company-hint" className="text-xs text-muted-foreground">
        {t('company.addHint')}
      </p>
    </div>
  );
}

// The notice under a field when the contact already exists: who it is, a way to open it, and the explicit way on.
function DuplicateNotice({ field, hit, kind, confirmed, onConfirm, onOpen }: { field: 'email' | 'taxCode'; hit: DuplicateHit; kind: Kind; confirmed: boolean; onConfirm: () => void; onOpen: (hit: DuplicateHit) => void }) {
  const t = useTranslations('contacts');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const onThisScreen = hit.kind === kind;
  return (
    <div role="status" className="mt-1 space-y-2 rounded-md border border-border bg-muted/50 p-2 text-sm" data-testid={`add-contact-duplicate-${field}`}>
      <p className="text-foreground">{t(field === 'email' ? 'panel.duplicate.email' : 'panel.duplicate.taxCode')}</p>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-foreground">{hit.name}</span>
        <span className="text-xs text-muted-foreground">{[hit.kind === 'person' ? t('kind.person') : t('kind.organization'), hit.email, hit.taxCode].filter(Boolean).join(' · ')}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {onThisScreen ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onOpen(hit)}>
            {t('panel.duplicate.open', { name: hit.name })}
          </Button>
        ) : (
          <Link to={hit.kind === 'person' ? '/o/$slug/contacts' : '/o/$slug/companies'} params={{ slug }} className="text-sm text-link underline">
            {t('panel.duplicate.openOther', { screen: hit.kind === 'person' ? t('title') : t('companiesTitle') })}
          </Link>
        )}
        {confirmed ? (
          <span className="text-xs text-muted-foreground">{t('panel.duplicate.continued')}</span>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={onConfirm}>
            {t('panel.duplicate.continue')}
          </Button>
        )}
      </div>
    </div>
  );
}

function AddContactForm({ kind, onSaved, onOpenExisting, onCancel }: { kind: Kind; onSaved: (added: AddedContact, another: boolean) => void; onOpenExisting: (hit: DuplicateHit) => void; onCancel: () => void }) {
  const t = useTranslations('contacts');
  const tc = useTranslations('common');
  const person = kind === 'person';
  const [form, setForm] = useState({ name: '', taxCode: '', address: '', email: '', phone: '' });
  const [companyText, setCompanyText] = useState('');
  const [company, setCompany] = useState<{ id: string; name: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The person is saved but the company could not be linked: said here, with a way to the saved person.
  const [saved, setSaved] = useState<{ added: AddedContact; reason: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The less used fields (the address) sit in a section that starts folded, as in Apollo and HubSpot.
  const [more, setMore] = useState(false);
  // The value of the duplicate the person chose to go on with, so a different email asks again.
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const root = useRef<HTMLFormElement>(null);
  // The panel may be closed while a save is on its way: the save still finishes, but it no longer moves the list to the new contact.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const dupField = person ? 'email' : 'taxCode';
  const taxLookup = usePartyTaxLookup(form.taxCode, !person);
  const key = duplicateKey(dupField, form[dupField], isEmailAddress);
  const paused = useDebounced(form[dupField], PAUSE_MS);
  const settled = duplicateKey(dupField, paused, isEmailAddress);
  const companySearch = useCompanyChoices(companyText, company !== null);
  const duplicate = useDuplicate(settled);
  // A hit for an earlier value of the field is not shown for the one typed now.
  const shown = key && settled && key.value === settled.value ? duplicate : null;
  const blocked = shown !== null && key !== null && confirmed !== key.value;

  const fields = useFieldErrors<Field>((field) => {
    if (field === 'name') return form.name.trim() ? null : t('nameRequired');
    if (field === 'taxCode') return !form.taxCode.trim() || normalizeTaxCode(form.taxCode) ? null : t('taxCodeInvalid');
    return !form.email.trim() || isEmailAddress(form.email) ? null : t('emailInvalid');
  });
  const set = (name: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [name]: value }));
    if (name === 'name' || name === 'taxCode' || name === 'email') fields.edit(name);
    setNote(null);
    setError(null);
  };
  const text = (name: keyof typeof form, props: { type?: string; maxLength: number; required?: boolean; placeholder?: string; autoComplete?: string }) => {
    const id = `add-contact-${name}`;
    const checked = name === 'name' || name === 'taxCode' || name === 'email' ? name : null;
    const error = checked ? fields.of(checked) : undefined;
    const renderInput = (className: string | undefined) => (
      <Input
        {...fieldControl(id, { hint: false, error: Boolean(error) })}
        className={className}
        value={form[name]}
        onChange={(e) => set(name, e.target.value)}
        onBlur={(e) => {
          if (checked) fields.blur(checked, e.target.value);
          if (name === 'taxCode' && !person) taxLookup.triggerOnBlur(e.target.value);
        }}
        {...props}
      />
    );
    return (
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{t(`fields.${name}`)}</Label>
        {name === 'taxCode' && !person ? <TaxCodeFieldRow lookup={taxLookup}>{renderInput}</TaxCodeFieldRow> : renderInput(undefined)}
        <FieldError id={id}>{error}</FieldError>
        {name === dupField && shown && key && <DuplicateNotice field={dupField} hit={shown} kind={kind} confirmed={confirmed === key.value} onConfirm={() => setConfirmed(key.value)} onOpen={onOpenExisting} />}
        {name === 'taxCode' && !person && taxLookup.deployed && (
          <TaxLookupCard
            lookup={taxLookup}
            currentName={form.name}
            currentAddress={form.address}
            className="mt-1"
            onFillName={(nextName) => {
              setForm((cur) => (cur.name.trim() === '' ? { ...cur, name: nextName } : cur));
              fields.edit('name');
              setError(null);
            }}
            onFillAddress={(nextAddress) => {
              setForm((cur) => (cur.address.trim() === '' ? { ...cur, address: nextAddress } : cur));
              setMore(true);
              setError(null);
            }}
          />
        )}
      </div>
    );
  };

  // The company of a person: the one picked; or one with the typed name already (exactly), or a new one made first.
  const companyOf = async (): Promise<string | null> => {
    if (!person) return null;
    if (company) return company.id;
    const typed = companyText.trim();
    if (typed === '') return null;
    // A fresh read of the companies with this name, not the choices shown (which may be for an earlier word or cut at a few): a company that exists is never made twice.
    // A name over the search's limit is not looked up.
    if (typed.length <= SEARCH_VALUE_MAX) {
      const filters: FilterAst = { v: 1, all: [{ field: 'kind', op: 'is', value: 'organization' }, { field: 'search', op: 'contains', value: typed }] };
      const have = await findAcross(filters, (c) => same(c.name, typed));
      if (have) return have.id;
    }
    const made = await client.parties.create({ kind: 'organization', name: typed, taxCode: null, address: null, email: null, phone: null });
    // The company exists now: a retry after a failure further on links it and does not make a second one.
    setCompany({ id: made.partyId, name: typed });
    return made.partyId;
  };
  const save = async (another: boolean) => {
    if (pending) return;
    if (!fields.checkAll(['name', 'taxCode', 'email'])) {
      if (root.current) focusFirstInvalid(root.current);
      return;
    }
    setError(null);
    setPending(true);
    try {
      // The check again at the moment of saving, in case it was pressed before the pause in typing ended.
      const now = duplicateKey(dupField, form[dupField], isEmailAddress);
      if (now && confirmed !== now.value) {
        const taken = await queryClient.fetchQuery({ ...duplicateQuery(now), staleTime: 0 });
        if (taken) {
          // Pressed before the pause in typing ended: the notice comes with the next read, so the field is named and focused at once.
          setError(t(dupField === 'email' ? 'panel.duplicate.email' : 'panel.duplicate.taxCode'));
          root.current?.querySelector<HTMLInputElement>(`#add-contact-${dupField}`)?.focus();
          return;
        }
      }
      const companyId = await companyOf();
      const created = await client.parties.create({ kind, name: form.name.trim(), taxCode: person ? null : orNull(form.taxCode), address: orNull(form.address), email: orNull(form.email), phone: orNull(form.phone) });
      const added = { partyId: created.partyId, name: form.name.trim() };
      if (companyId) {
        try {
          await client.parties.setCompany({ partyId: created.partyId, companyId, version: created.version });
        } catch (e) {
          refreshParties();
          setSaved({ added, reason: errorMessage(e) });
          return;
        }
      }
      refreshParties();
      if (another) {
        setForm({ name: '', taxCode: '', address: '', email: '', phone: '' });
        setCompanyText('');
        setCompany(null);
        setConfirmed(null);
        fields.reset();
        taxLookup.reset();
        setNote(t('panel.saved', { name: added.name }));
        root.current?.querySelector<HTMLInputElement>('input')?.focus();
      }
      if (alive.current) onSaved(added, another);
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setPending(false);
    }
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void save(false);
  };

  return (
    <form ref={root} className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={submit}>
      <SheetBody className="space-y-4">
        {person ? (
          <>
            {text('email', { type: 'email', maxLength: 254, placeholder: t('panel.emailPlaceholder'), autoComplete: 'off' })}
            {text('name', { maxLength: 300, required: true, placeholder: t('panel.placeholder.personName'), autoComplete: 'off' })}
            {text('phone', { type: 'tel', maxLength: 30, placeholder: t('panel.placeholder.phone'), autoComplete: 'off' })}
            <CompanyField text={companyText} picked={company} choices={companySearch.choices} searching={companySearch.pending} onText={setCompanyText} onPick={(picked) => {
                setCompany(picked);
                // Removing the company empties the field too, so what was typed to find it does not make a company on saving.
                if (picked === null) setCompanyText('');
              }} />
          </>
        ) : (
          <>
            {text('name', { maxLength: 300, required: true, placeholder: t('panel.placeholder.companyName'), autoComplete: 'off' })}
            {text('taxCode', { maxLength: 20, placeholder: t('panel.placeholder.taxCode'), autoComplete: 'off' })}
            {text('email', { type: 'email', maxLength: 254, placeholder: t('panel.emailPlaceholder'), autoComplete: 'off' })}
            {text('phone', { type: 'tel', maxLength: 30, placeholder: t('panel.placeholder.phone'), autoComplete: 'off' })}
          </>
        )}
        <div className="border-t border-border pt-3">
          <button type="button" className="flex w-full items-center justify-between gap-2 py-1 text-left text-sm font-medium text-link" aria-expanded={more} aria-controls="add-contact-more" onClick={() => setMore(!more)}>
            {t('panel.more')}
            <svg aria-hidden="true" viewBox="0 0 16 16" className={more ? 'size-4 rotate-180' : 'size-4'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          {more && (
            <div id="add-contact-more" className="mt-3 space-y-4">
              {text('address', { maxLength: 500, placeholder: t('panel.placeholder.address'), autoComplete: 'off' })}
            </div>
          )}
        </div>
        {note && (
          <p role="status" className="text-sm text-muted-foreground" data-testid="add-contact-note">
            {note}
          </p>
        )}
        {saved && (
          <div role="alert" className="space-y-2 rounded-md border border-border p-2 text-sm" data-testid="add-contact-link-failed">
            <ErrorText>{t('panel.linkFailed', { name: saved.added.name, reason: saved.reason })}</ErrorText>
            <Button type="button" variant="outline" size="sm" onClick={() => onSaved(saved.added, false)}>
              {t('panel.openSaved', { name: saved.added.name })}
            </Button>
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </SheetBody>
      <SheetFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {tc('cancel')}
        </Button>
        <Button type="button" variant="outline" disabled={blocked || pending || saved !== null} onClick={() => void save(true)}>
          {t(person ? 'panel.saveAnotherPerson' : 'panel.saveAnotherCompany')}
        </Button>
        <Button type="submit" loading={pending} disabled={blocked || saved !== null}>
          {t('save')}
        </Button>
      </SheetFooter>
    </form>
  );
}

// The panel: closed unless `open`; its fields start empty each time it opens.
export function AddContactPanel({ kind, open, onOpenChange, onSaved, onOpenExisting }: { kind: Kind; open: boolean; onOpenChange: (open: boolean) => void; onSaved: (added: AddedContact, another: boolean) => void; onOpenExisting: (hit: DuplicateHit) => void }) {
  const t = useTranslations('contacts');
  const tc = useTranslations('common');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={tc('close')} data-testid="add-contact-panel">
        <SheetHeader>
          <SheetTitle>{kind === 'person' ? t('add') : t('addCompany')}</SheetTitle>
          <SheetDescription>{kind === 'person' ? t('panel.personHint') : t('panel.companyIntro')}</SheetDescription>
        </SheetHeader>
        <AddContactForm kind={kind} onSaved={onSaved} onOpenExisting={onOpenExisting} onCancel={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
