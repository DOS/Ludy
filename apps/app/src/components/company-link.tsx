// SPDX-License-Identifier: AGPL-3.0-only
// The company a person works at (#2438, CRM-Q5), set, changed and cleared from either side with one command (kernel.party.set_company):
// a person's panel shows the company and a picker to link or change it; a company's panel lists its people, each with a way to remove
// them, and a picker to add one. The pickers search the same list the screens show (search without Vietnamese marks, through the phone
// key), by kind; the server decides every rule (a person works at one company, never a merged one) and its reason shows here.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { Contact, FilterAst } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { ErrorText } from './ui.tsx';
import { refreshParties } from './party-edit.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { useDebounced } from '../lib/use-debounced.ts';

// The most results a picker shows: a person types more to narrow them.
const PICK_LIMIT = 8;
const SEARCH_PAUSE_MS = 300;
// The most people a company's panel lists; the line under it says when there are more.
const PEOPLE_LIMIT = 50;

// The picker unmounts when it closes, so focus would fall to the page: it goes back to the button that opened it.
function useFocusBackOnClose(open: boolean) {
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return trigger;
}

// A search over the parties of one kind: the people (not the ones the company already has) or the companies.
function PartyPicker({ kind, label, exclude, onPick, onCancel }: { kind: 'person' | 'organization'; label: string; exclude?: (c: Contact) => boolean; onPick: (c: Contact) => void; onCancel: () => void }) {
  const t = useTranslations('contacts.company');
  const [text, setText] = useState('');
  const term = useDebounced(text.trim(), SEARCH_PAUSE_MS);
  const filters: FilterAst = { v: 1, all: [{ field: 'kind', op: 'is', value: kind }, ...(term ? [{ field: 'search', op: 'contains' as const, value: term }] : [])] };
  const found = useQuery(orpc.crm.contacts.list.queryOptions({ input: { filters, limit: PICK_LIMIT } }));
  const items = (found.data?.items ?? []).filter((c) => !exclude?.(c));
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="search" aria-label={label} placeholder={label} maxLength={100} value={text} onChange={(e) => setText(e.target.value)} className="max-w-sm" autoFocus />
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
      {/* The results change as the person types: a polite live region lets a screen reader hear them (or that there are none). */}
      <div aria-live="polite">
        {found.error ? (
          <ErrorText>{errorMessage(found.error)}</ErrorText>
        ) : found.isPending ? null : items.length === 0 ? (
          <p className="text-sm text-subtle-foreground">{t('noMatch')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {items.map((c) => (
              <li key={c.id}>
                <Button type="button" variant="outline" size="sm" aria-label={t('pick', { name: c.name })} onClick={() => onPick(c)}>
                  {c.name}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// A person's company: the name, and (for owners, admins and members) a way to link, change or clear it.
export function PersonCompany({ person, canEdit }: { person: Contact; canEdit: boolean }) {
  const t = useTranslations('contacts.company');
  const [picking, setPicking] = useState(false);
  const trigger = useFocusBackOnClose(picking);
  const set = useMutation(orpc.parties.setCompany.mutationOptions({ onSuccess: () => { setPicking(false); refreshParties(); } }));
  const link = (companyId: string | null) => set.mutate({ partyId: person.id, companyId, version: person.version });
  return (
    <div className="space-y-2" data-testid="person-company">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-subtle-foreground">{t('label')}</span>
        <span className="text-foreground">{person.company?.name ?? t('none')}</span>
        {canEdit && !picking && (
          <>
            <Button ref={trigger} type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
              {person.company ? t('change') : t('set')}
            </Button>
            {person.company && (
              <Button type="button" variant="ghost" size="sm" disabled={set.isPending} onClick={() => link(null)}>
                {t('clear')}
              </Button>
            )}
          </>
        )}
      </div>
      {picking && <PartyPicker kind="organization" label={t('search')} exclude={(c) => c.id === person.company?.id} onPick={(c) => link(c.id)} onCancel={() => setPicking(false)} />}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </div>
  );
}

// A company's people: who works here, each removable, and a picker to add a person (who leaves their earlier company, a person has one).
export function CompanyPeople({ company, canEdit }: { company: Contact; canEdit: boolean }) {
  const t = useTranslations('contacts.company');
  const [adding, setAdding] = useState(false);
  const trigger = useFocusBackOnClose(adding);
  const people = useQuery(orpc.crm.contacts.list.queryOptions({ input: { filters: { v: 1, all: [{ field: 'company', op: 'is', value: company.id }] }, limit: PEOPLE_LIMIT } }));
  const set = useMutation(orpc.parties.setCompany.mutationOptions({ onSuccess: () => { setAdding(false); refreshParties(); } }));
  const items = people.data?.items ?? [];
  return (
    <div className="space-y-2" data-testid="company-people">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{t('people')}</p>
        {canEdit && !adding && (
          <Button ref={trigger} type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            {t('addPerson')}
          </Button>
        )}
      </div>
      {people.error ? (
        <ErrorText>{errorMessage(people.error)}</ErrorText>
      ) : items.length === 0 ? (
        <p className="text-sm text-subtle-foreground">{people.isPending ? '' : t('peopleNone')}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3">
              <span className="font-medium text-foreground">{p.name}</span>
              {p.phone && <span className="text-xs text-muted-foreground">{p.phone}</span>}
              {canEdit && (
                <Button type="button" variant="ghost" size="sm" disabled={set.isPending} aria-label={t('unlink', { name: p.name })} onClick={() => set.mutate({ partyId: p.id, companyId: null, version: p.version })}>
                  {t('clear')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {company.peopleCount > items.length && items.length >= PEOPLE_LIMIT && <p className="text-xs text-muted-foreground">{t('peopleMore', { shown: items.length, total: company.peopleCount })}</p>}
      {adding && <PartyPicker kind="person" label={t('searchPerson')} exclude={(c) => items.some((p) => p.id === c.id)} onPick={(p) => set.mutate({ partyId: p.id, companyId: company.id, version: p.version })} onCancel={() => setAdding(false)} />}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </div>
  );
}
