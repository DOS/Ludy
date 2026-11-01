// SPDX-License-Identifier: AGPL-3.0-only
// Contacts (CRM plan 6, step K4, #2228): the people and companies of the org, which are its parties, as a list to search,
// filter and save views of. Search ignores Vietnamese marks and finds a phone number written any way ("nguyen" finds
// "Nguyễn"); the tabs above the filter bar open the member's own views and the org's shared ones. Owners, admins and
// members add a contact and edit one (a tax code can be added, never changed); viewers read. A row opens a panel with the
// contact's details, its notes (with the notes module) and its timeline.
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { normalizeTaxCode, type Contact, type FilterAst, type SavedViewSort } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { EditParty, refreshParties } from '../components/party-edit.tsx';
import { DataTable, Empty, ErrorText, FieldError, PageHeader, TableSkeleton, fieldControl, focusFirstInvalid, isEmailAddress, useFieldErrors } from '../components/ui.tsx';
import { ViewTabs, type ViewState } from '../components/view-tabs.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';
import { useDebounced } from '../lib/use-debounced.ts';
import {
  CONTACT_SORT_OPTIONS,
  EMPTY_CONTACT_FILTER,
  astToContactFilter,
  conditionLabel,
  contactFilterToAst,
  sortOfValue,
  sortValue,
  type ContactFilterState,
  type ContactKind,
  type Tri,
} from '../lib/contact-filter.ts';

const SCOPE = 'crm.party';
// The search waits for a pause in typing, so one request goes out per word and not per key.
const SEARCH_PAUSE_MS = 300;
// The words of each sort option, by its `field:dir` value.
const SORT_LABELS: Record<string, 'sort.name_asc' | 'sort.name_desc' | 'sort.created_asc' | 'sort.created_desc' | 'sort.updated_asc' | 'sort.updated_desc'> = {
  'name:asc': 'sort.name_asc',
  'name:desc': 'sort.name_desc',
  'created:asc': 'sort.created_asc',
  'created:desc': 'sort.created_desc',
  'updated:asc': 'sort.updated_asc',
  'updated:desc': 'sort.updated_desc',
};

// A contact's own timeline: what happened to it, oldest first, in fixed words.
function ContactTimeline({ partyId }: { partyId: string }) {
  const t = useTranslations('contacts');
  const f = useFormat();
  const timeline = useQuery(orpc.parties.timeline.queryOptions({ input: { partyId } }));
  return (
    <div data-testid="contact-timeline">
      <p className="mb-2 text-sm font-medium text-muted-foreground">{t('timeline')}</p>
      {timeline.isLoading ? (
        <p className="text-sm text-subtle-foreground">{t('loading')}</p>
      ) : timeline.error ? (
        <ErrorText>{errorMessage(timeline.error)}</ErrorText>
      ) : (timeline.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-subtle-foreground">{t('timelineEmpty')}</p>
      ) : (
        <ol className="space-y-1 text-sm">
          {timeline.data?.items.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-2">
              <time dateTime={e.at} className="text-xs text-subtle-foreground">
                {f.dateTime(e.at)}
              </time>
              <span className="text-foreground">{e.summary}</span>
              {e.actorName && <span className="text-xs text-subtle-foreground">{e.actorName}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// The contact's deals (K1's crm.party.deals): the title, the stage it sits in, the amount and the expected close date, and a
// way to the deals screen, where a deal is added and moved.
function ContactDeals({ partyId }: { partyId: string }) {
  const t = useTranslations('contacts');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { locale } = useLocaleSetting();
  const deals = useQuery(orpc.crm.deals.byParty.queryOptions({ input: { partyId } }));
  const stages = useQuery(orpc.crm.pipeline.stages.queryOptions({ input: {} }));
  return (
    <div data-testid="contact-deals">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{t('deals.title')}</p>
        <Link to="/o/$slug/deals" params={{ slug }} className="text-sm text-link underline">
          {t('deals.open')}
        </Link>
      </div>
      {deals.isLoading ? (
        <p className="text-sm text-subtle-foreground">{t('loading')}</p>
      ) : deals.error ? (
        <ErrorText>{errorMessage(deals.error)}</ErrorText>
      ) : (deals.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-subtle-foreground">{t('deals.empty')}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {deals.data?.map((d) => (
            <li key={d.id} className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-medium text-foreground">{d.title}</span>
              <span className="text-xs text-muted-foreground">{stages.data?.find((s) => s.id === d.stageId)?.name ?? t(`deals.kind.${d.stageKind}`)}</span>
              <span className="tabular-nums text-muted-foreground">{formatMoney(d.amount, locale, d.currency)}</span>
              {d.expectedClose && <span className="text-xs text-subtle-foreground">{t('deals.close', { date: d.expectedClose })}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The panel under a row: details, edit, deals, notes and timeline.
function ContactPanel({ contact, canEdit, columns }: { contact: Contact; canEdit: boolean; columns: number }) {
  const t = useTranslations('contacts');
  const tn = useTranslations('notes');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [editing, setEditing] = useState(false);
  return (
    <TableRow>
      <TableCell colSpan={columns} className="space-y-4 px-4 py-4">
        {editing ? (
          <EditParty party={contact} ns="contacts" onDone={() => setEditing(false)} />
        ) : (
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {(['address', 'email', 'phone', 'taxCode'] as const).map((key) => (
              <div key={key} className="flex gap-2">
                <dt className="text-subtle-foreground">{t(`fields.${key}`)}</dt>
                <dd className="text-foreground">{contact[key] ?? t('none')}</dd>
              </div>
            ))}
          </dl>
        )}
        {canEdit && !editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} aria-label={t('editOf', { name: contact.name })}>
            {t('edit')}
          </Button>
        )}
        <ContactDeals partyId={contact.id} />
        {notesInstalled() && <RecordNotesPanel slug={slug} target={{ targetType: 'kernel.party', targetId: contact.id }} headingId={`notes-${contact.id}`} label={tn('panel.toggleOf', { name: contact.name })} />}
        <ContactTimeline partyId={contact.id} />
      </TableCell>
    </TableRow>
  );
}

// "Thêm liên hệ": a person or a company by hand. The server checks again and names the contact that already has a tax code.
function AddContact({ onDone }: { onDone: () => void }) {
  const t = useTranslations('contacts');
  const tc = useTranslations('common');
  const [form, setForm] = useState({ kind: 'person' as 'person' | 'organization', name: '', taxCode: '', address: '', email: '', phone: '' });
  const create = useMutation(
    orpc.parties.create.mutationOptions({
      onSuccess: () => {
        refreshParties();
        onDone();
      },
    }),
  );
  const fields = useFieldErrors<'name' | 'taxCode' | 'email'>((key) => {
    if (key === 'name') return form.name.trim() ? null : t('nameRequired');
    if (key === 'taxCode') return !form.taxCode.trim() || normalizeTaxCode(form.taxCode) ? null : t('taxCodeInvalid');
    return !form.email.trim() || isEmailAddress(form.email) ? null : t('emailInvalid');
  });
  const orNull = (value: string) => (value.trim() === '' ? null : value);
  const text = (key: 'name' | 'taxCode' | 'address' | 'email' | 'phone', props: { type?: string; maxLength: number; required?: boolean }) => {
    const id = `add-contact-${key}`;
    const checked = key === 'name' || key === 'taxCode' || key === 'email' ? key : null;
    const error = checked ? fields.of(checked) : undefined;
    return (
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{t(`fields.${key}`)}</Label>
        <Input
          {...fieldControl(id, { hint: false, error: Boolean(error) })}
          value={form[key]}
          onChange={(e) => {
            setForm({ ...form, [key]: e.target.value });
            if (checked) fields.edit(checked);
          }}
          onBlur={(e) => checked && fields.blur(checked, e.target.value)}
          {...props}
        />
        <FieldError id={id}>{error}</FieldError>
      </div>
    );
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!fields.checkAll(['name', 'taxCode', 'email'])) {
      focusFirstInvalid(e.currentTarget);
      return;
    }
    create.mutate({ kind: form.kind, name: form.name, taxCode: orNull(form.taxCode), address: orNull(form.address), email: orNull(form.email), phone: orNull(form.phone) });
  };
  return (
    <form className="mb-4 grid gap-3 rounded-xl border p-4 sm:grid-cols-2" noValidate aria-label={t('add')} onSubmit={submit}>
      <div className="flex flex-col gap-1">
        <Label htmlFor="add-contact-kind">{t('fields.kind')}</Label>
        <NativeSelect id="add-contact-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value === 'organization' ? 'organization' : 'person' })}>
          <NativeSelectOption value="person">{t('kind.person')}</NativeSelectOption>
          <NativeSelectOption value="organization">{t('kind.organization')}</NativeSelectOption>
        </NativeSelect>
      </div>
      {text('name', { maxLength: 300, required: true })}
      {text('taxCode', { maxLength: 20 })}
      {text('address', { maxLength: 500 })}
      {text('email', { type: 'email', maxLength: 254 })}
      {text('phone', { type: 'tel', maxLength: 30 })}
      <div className="flex items-end gap-2">
        <Button type="submit" size="sm" disabled={create.isPending}>
          {t('addSubmit')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {tc('cancel')}
        </Button>
      </div>
      {create.error && (
        <div className="sm:col-span-2">
          <ErrorText>{errorMessage(create.error)}</ErrorText>
        </div>
      )}
    </form>
  );
}

const TRI: Tri[] = ['', 'yes', 'no'];

export function ContactsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('contacts');
  const org = useQuery(orpc.org.get.queryOptions());
  const canEdit = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  // The screen's filter and sort: what the bar shows, and what a picked view sets. The server answers for the filter below.
  const [bar, setBar] = useState<ContactFilterState>(EMPTY_CONTACT_FILTER);
  const [sort, setSort] = useState<SavedViewSort | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const filters: FilterAst = contactFilterToAst(bar);
  // The search waits for a pause in typing; the rest of the bar applies at once.
  const searchTerm = useDebounced(bar.search.trim(), SEARCH_PAUSE_MS);
  const applied: FilterAst = contactFilterToAst({ ...bar, search: searchTerm });
  const contacts = useInfiniteQuery(
    orpc.crm.contacts.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ filters: applied, ...(sort ? { sort } : {}), ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.next ?? undefined,
    }),
  );
  const rows = contacts.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = filters.all.length > 0;
  const head = [t('columns.name'), t('columns.taxCode'), t('columns.email'), t('columns.phone'), ''];
  const apply = ({ filters: next, sort: nextSort }: ViewState) => {
    setBar(astToContactFilter(next));
    setSort(nextSort);
    setOpenId(null);
  };
  const triSelect = (key: 'email' | 'phone' | 'taxCode', label: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`contact-has-${key}`} className="text-xs text-subtle-foreground">
        {label}
      </Label>
      <NativeSelect id={`contact-has-${key}`} size="sm" value={bar[key]} onChange={(e) => setBar({ ...bar, [key]: TRI.find((v) => v === e.target.value) ?? '' })}>
        <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
        <NativeSelectOption value="yes">{t('filters.yes')}</NativeSelectOption>
        <NativeSelectOption value="no">{t('filters.no')}</NativeSelectOption>
      </NativeSelect>
    </div>
  );

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canEdit && !adding ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={() => setAdding(true)}>
                {t('add')}
              </Button>
              <Link to="/o/$slug/contacts/import" params={{ slug }} className="text-sm text-link underline">
                {t('importFile')}
              </Link>
            </div>
          ) : undefined
        }
      />
      {adding && <AddContact onDone={() => setAdding(false)} />}
      <ViewTabs scope={SCOPE} filters={filters} sort={sort} onApply={apply} />
      <div className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label={t('filters.label')}>
        <div className="flex min-w-56 max-w-sm flex-1 flex-col gap-1">
          <Label htmlFor="contact-search" className="text-xs text-subtle-foreground">
            {t('filters.search')}
          </Label>
          <Input id="contact-search" type="search" placeholder={t('search')} maxLength={100} value={bar.search} onChange={(e) => setBar({ ...bar, search: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="contact-kind" className="text-xs text-subtle-foreground">
            {t('fields.kind')}
          </Label>
          <NativeSelect id="contact-kind" size="sm" value={bar.kind} onChange={(e) => setBar({ ...bar, kind: (['organization', 'person'] as const).find((k) => k === e.target.value) ?? '' })}>
            <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
            <NativeSelectOption value="organization">{t('kind.organization')}</NativeSelectOption>
            <NativeSelectOption value="person">{t('kind.person')}</NativeSelectOption>
          </NativeSelect>
        </div>
        {triSelect('email', t('filters.hasEmail'))}
        {triSelect('phone', t('filters.hasPhone'))}
        {triSelect('taxCode', t('filters.hasTaxCode'))}
        <div className="flex flex-col gap-1">
          <Label htmlFor="contact-sort" className="text-xs text-subtle-foreground">
            {t('filters.sort')}
          </Label>
          <NativeSelect id="contact-sort" size="sm" value={sortValue(sort)} onChange={(e) => setSort(sortOfValue(e.target.value))}>
            <NativeSelectOption value="">{t('sort.default')}</NativeSelectOption>
            {CONTACT_SORT_OPTIONS.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {t(SORT_LABELS[value] ?? 'sort.default')}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => setBar(EMPTY_CONTACT_FILTER)}>
            {t('filters.clear')}
          </Button>
        )}
      </div>
      {bar.rest.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2" aria-label={t('filters.other')}>
          {bar.rest.map((c, i) => (
            <li key={`${c.field}:${c.op}:${i}`} className="flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-muted-foreground">
              {conditionLabel(c)}
              <Button variant="ghost" size="sm" aria-label={t('filters.remove', { condition: conditionLabel(c) })} onClick={() => setBar({ ...bar, rest: bar.rest.filter((_, j) => j !== i) })}>
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
      {contacts.isPending ? (
        <TableSkeleton columns={head.length} />
      ) : contacts.error && rows.length === 0 ? (
        <ErrorText>{errorMessage(contacts.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={filtered ? t('noMatch') : t('empty')} hint={filtered ? undefined : t('emptyHint')} />
      ) : (
        <>
          <DataTable head={head}>
            {rows.map((c) => (
              <ContactRows key={c.id} contact={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} canEdit={canEdit} columns={head.length} />
            ))}
          </DataTable>
          {contacts.error && (
            <div className="mt-3">
              <ErrorText>{errorMessage(contacts.error)}</ErrorText>
            </div>
          )}
          {contacts.hasNextPage && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-xs text-muted-foreground">{t('more', { count: rows.length })}</p>
              <Button variant="outline" size="sm" disabled={contacts.isFetchingNextPage} onClick={() => void contacts.fetchNextPage()}>
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function ContactRows({ contact, open, onToggle, canEdit, columns }: { contact: Contact; open: boolean; onToggle: () => void; canEdit: boolean; columns: number }) {
  const t = useTranslations('contacts');
  const kind: ContactKind = contact.kind;
  return (
    <>
      <TableRow>
        <TableCell className="min-w-48 px-4 py-3">
          <p className="font-medium text-foreground">{contact.name}</p>
          <p className="text-xs text-subtle-foreground">{t(`kind.${kind}`)}</p>
        </TableCell>
        <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{contact.taxCode ?? ''}</TableCell>
        <TableCell className="px-4 py-3 text-muted-foreground">{contact.email ?? ''}</TableCell>
        <TableCell className="px-4 py-3 text-muted-foreground">{contact.phone ?? ''}</TableCell>
        <TableCell className="px-4 py-3 text-right">
          <Button variant="ghost" size="sm" onClick={onToggle} aria-expanded={open} aria-label={t('openOf', { name: contact.name })}>
            {open ? t('close') : t('open')}
          </Button>
        </TableCell>
      </TableRow>
      {open && <ContactPanel contact={contact} canEdit={canEdit} columns={columns} />}
    </>
  );
}

