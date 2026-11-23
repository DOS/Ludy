// SPDX-License-Identifier: AGPL-3.0-only
// Contacts (CRM plan 6, step K4, #2228): the people and companies of the org, which are its parties, as two lists (#2438: Người liên hệ and Công ty, the same
// screen with the kind fixed) to search, filter and save views of; a person shows the company they work at and a company its people and open deals. Search ignores Vietnamese marks and finds a phone number written any way ("nguyen" finds
// "Nguyễn"); the tabs above the filter bar open the member's own views and the org's shared ones. Owners, admins and
// members add a contact in a side panel (components/add-contact-panel.tsx) and edit one on its row (a tax code can be added, never changed); viewers read. A row opens a panel with the
// contact's details, its notes (with the notes module) and its timeline.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { Contact, FilterAst, SavedViewSort } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { AddContactPanel } from '../components/add-contact-panel.tsx';
import { CompanyPeople, PersonCompany } from '../components/company-link.tsx';
import { ContactDeals } from '../components/contact-deals.tsx';
import { LinkedMeetings, meetingsInstalled } from '../components/linked-meetings.tsx';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { EditParty } from '../components/party-edit.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { ConditionChips } from '../components/condition-chips.tsx';
import { ViewTabs, type ViewState } from '../components/view-tabs.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { useDebounced } from '../lib/use-debounced.ts';
import {
  CONTACT_SORT_OPTIONS,
  EMPTY_CONTACT_FILTER,
  astToContactFilter,
  contactFilterToAst,
  sortOfValue,
  sortValue,
  type ContactFilterState,
  type Tri,
} from '../lib/contact-filter.ts';
import { AiWrittenBadge } from '../components/ai-written-badge.tsx';

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

// The conversations linked to this contact (#2333): the channel, kind, status and last message time, with a link to the
// Inbox thread. Message bodies stay in the Inbox and are never read or copied here.
function ContactConversations({ partyId }: { partyId: string }) {
  const t = useTranslations('contacts');
  const tc = useTranslations('conversations');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const conversations = useQuery(orpc.crm.contacts.conversations.queryOptions({ input: { partyId } }));
  return (
    <div data-testid="contact-conversations" className="mt-3">
      <p className="mb-2 text-sm font-medium text-muted-foreground">{t('conversations.title')}</p>
      {conversations.isLoading ? (
        <p className="text-sm text-subtle-foreground">{t('loading')}</p>
      ) : conversations.error ? (
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

// A contact's own timeline: what happened to it, oldest first, in fixed words, plus the conversations linked to it (#2333).
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
              <AiWrittenBadge actorOrigin={e.actorOrigin} />
            </li>
          ))}
        </ol>
      )}
      <ContactConversations partyId={partyId} />
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
          <EditParty party={contact} ns="contacts" kind={contact.kind} onDone={() => setEditing(false)} />
        ) : (
          <>
            <AiWrittenBadge actorOrigin={contact.actorOrigin} tainted={contact.tainted} showHint />
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {(['address', 'email', 'phone', 'taxCode'] as const).map((key) => (
                <div key={key} className="flex gap-2">
                  <dt className="text-subtle-foreground">{t(`fields.${key}`)}</dt>
                  <dd className="text-foreground">{contact[key] ?? t('none')}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        {canEdit && !editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} aria-label={t('editOf', { name: contact.name })}>
            {t('edit')}
          </Button>
        )}
        {contact.kind === 'person' ? <PersonCompany person={contact} canEdit={canEdit} /> : <CompanyPeople company={contact} canEdit={canEdit} />}
        <ContactDeals contact={contact} canEdit={canEdit} />
        {meetingsInstalled() && <LinkedMeetings kind="party" targetId={contact.id} />}
        {notesInstalled() && <RecordNotesPanel slug={slug} target={{ targetType: 'kernel.party', targetId: contact.id }} headingId={`notes-${contact.id}`} label={tn('panel.toggleOf', { name: contact.name })} />}
        <ContactTimeline partyId={contact.id} />
      </TableCell>
    </TableRow>
  );
}

const TRI: Tri[] = ['', 'yes', 'no'];

// mode: the people (the default) or the companies (#2438): the kind of party the list holds, set by the screen and not by the filter bar.
export function ContactsPage({ mode = 'people' }: { mode?: 'people' | 'companies' }) {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const kind = mode === 'companies' ? ('organization' as const) : ('person' as const);
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
  // What is asked of the server: the bar's conditions and the screen's kind, which a picked view cannot change.
  const asked: FilterAst = { ...applied, all: [...applied.all, { field: 'kind', op: 'is', value: kind }] };
  const contacts = useInfiniteQuery(
    orpc.crm.contacts.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ filters: asked, ...(sort ? { sort } : {}), ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.next ?? undefined,
    }),
  );
  const rows = contacts.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = filters.all.length > 0;
  // The name is the open control (#3649), so there is no column of "Mở" buttons; a person's row also says how many deals are open.
  const head = mode === 'companies' ? [t('columns.name'), t('columns.taxCode'), t('columns.people'), t('columns.openDeals')] : [t('columns.name'), t('columns.company'), t('columns.phone'), t('columns.email'), t('columns.openDeals')];
  // The list narrowed to one contact, which opens: the one just added, or the one an add found already there.
  const reveal = (id: string, search: string) => {
    // The search takes at most 100 characters.
    setBar({ ...EMPTY_CONTACT_FILTER, search: search.slice(0, 100) });
    setSort(null);
    setOpenId(id);
  };
  const saved = (added: { partyId: string; name: string }, another: boolean) => {
    if (another) return;
    setAdding(false);
    reveal(added.partyId, added.name);
  };
  const showContact = (hit: { id: string; name: string }) => {
    setAdding(false);
    reveal(hit.id, hit.name);
  };
  const apply = ({ filters: next, sort: nextSort }: ViewState) => {
    // A view saved on the other screen may carry a kind: the screen's own kind stays.
    // Nor does it keep a condition whose control this screen does not show (a company has no email filter, a person no tax code one), which would filter with nothing to say so (#3649).
    const applied = astToContactFilter(next);
    setBar({ ...applied, kind: '', ...(mode === 'companies' ? { email: '', phone: '' } : { taxCode: '' }) });
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
        title={mode === 'companies' ? t('companiesTitle') : t('title')}
        subtitle={mode === 'companies' ? t('companiesSubtitle') : t('subtitle')}
        actions={
          canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={() => setAdding(true)}>
                {mode === 'companies' ? t('addCompany') : t('add')}
              </Button>
              <Link to="/o/$slug/contacts/import" params={{ slug }} className="text-sm text-link underline">
                {t('importFile')}
              </Link>
            </div>
          ) : undefined
        }
      />
      {canEdit && <AddContactPanel kind={kind} open={adding} onOpenChange={setAdding} onSaved={saved} onOpenExisting={showContact} />}
      <ViewTabs scope={SCOPE} filters={filters} sort={sort} onApply={apply} />
      <div className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label={t('filters.label')}>
        <div className="flex min-w-56 max-w-sm flex-1 flex-col gap-1">
          <Label htmlFor="contact-search" className="text-xs text-subtle-foreground">
            {t('filters.search')}
          </Label>
          <Input id="contact-search" type="search" placeholder={t('search')} maxLength={100} value={bar.search} onChange={(e) => setBar({ ...bar, search: e.target.value })} />
        </div>
        {/* Only the filters that fit the kind: a company has a tax code, a person has an email and a phone (#3649). */}
        {mode === 'people' && triSelect('email', t('filters.hasEmail'))}
        {mode === 'people' && triSelect('phone', t('filters.hasPhone'))}
        {mode === 'companies' && triSelect('taxCode', t('filters.hasTaxCode'))}
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
      <ConditionChips scope="party" rest={bar.rest} onChange={(rest) => setBar({ ...bar, rest })} listLabel={t('filters.other')} removeLabel={(condition) => t('filters.remove', { condition })} />
      {contacts.isPending ? (
        <TableSkeleton columns={head.length} />
      ) : contacts.error && rows.length === 0 ? (
        <ErrorText>{errorMessage(contacts.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={filtered ? (mode === 'companies' ? t('companiesNoMatch') : t('noMatch')) : mode === 'companies' ? t('companiesEmpty') : t('empty')} hint={filtered ? undefined : mode === 'companies' ? t('companiesEmptyHint') : t('emptyHint')} />
      ) : (
        <>
          <DataTable head={head} stacked>
            {rows.map((c) => (
              <ContactRows key={c.id} mode={mode} contact={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} canEdit={canEdit} columns={head.length} />
            ))}
          </DataTable>
          {contacts.error && (
            <div className="mt-3">
              <ErrorText>{errorMessage(contacts.error)}</ErrorText>
            </div>
          )}
          {contacts.hasNextPage && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-xs text-muted-foreground">{t(mode === 'companies' ? 'companiesMore' : 'more', { count: rows.length })}</p>
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

// The Companies screen (#2438): the same list with the kind fixed to the companies.
export function CompaniesPage() {
  return <ContactsPage mode="companies" />;
}

export function ContactRows({ mode, contact, open, onToggle, canEdit, columns }: { mode: 'people' | 'companies'; contact: Contact; open: boolean; onToggle: () => void; canEdit: boolean; columns: number }) {
  const t = useTranslations('contacts');
  const f = useFormat();
  return (
    <>
      <TableRow>
        <TableCell className="min-w-48 px-4 py-3">
          {/* The name opens the contact (#3649); its panel is the row below. */}
          <button type="button" onClick={onToggle} aria-expanded={open} aria-label={t('openOf', { name: contact.name })} className="rounded-sm text-left font-medium text-foreground outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
            {contact.name}
          </button>{' '}
          <AiWrittenBadge actorOrigin={contact.actorOrigin} tainted={contact.tainted} />
        </TableCell>
        {mode === 'companies' ? (
          <>
            <TableCell data-label={t('columns.taxCode')} className="px-4 py-3 font-mono text-xs text-muted-foreground">
              {contact.taxCode ?? ''}
            </TableCell>
            <TableCell data-label={t('columns.people')} className="px-4 py-3 text-muted-foreground tabular-nums">
              {f.number(contact.peopleCount)}
            </TableCell>
            <TableCell data-label={t('columns.openDeals')} className="px-4 py-3 text-muted-foreground tabular-nums">
              {f.number(contact.openDeals)}
            </TableCell>
          </>
        ) : (
          <>
            <TableCell data-label={t('columns.company')} className="px-4 py-3 text-muted-foreground">
              {contact.company?.name ?? ''}
            </TableCell>
            <TableCell className="px-4 py-3 text-muted-foreground">
              {contact.phone && (
                <a href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`} className="text-link underline-offset-4 hover:underline">
                  {contact.phone}
                </a>
              )}
            </TableCell>
            <TableCell className="px-4 py-3 text-muted-foreground">
              {contact.email && (
                <a href={`mailto:${contact.email}`} className="break-all text-link underline-offset-4 hover:underline">
                  {contact.email}
                </a>
              )}
            </TableCell>
            <TableCell data-label={t('columns.openDeals')} className="px-4 py-3 text-muted-foreground tabular-nums">
              {f.number(contact.openDeals)}
            </TableCell>
          </>
        )}
      </TableRow>
      {open && <ContactPanel contact={contact} canEdit={canEdit} columns={columns} />}
    </>
  );
}

