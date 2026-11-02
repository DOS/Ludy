// SPDX-License-Identifier: AGPL-3.0-only
// The right pane of the Inbox (CV3, #2306, plan docs/plan/conversations.md sections 5.4 and 11): who the customer is. The contact (the party, when a person
// linked one: a contact is never made by itself, because a comment is not consent to be in a CRM), the name the platform gave, the customer's other
// threads that the reader may read, and the way to link the thread to a contact or to create one. Linking is for those who may reply. What the reader may
// read of other threads is the database's decision: a thread they may not read is simply not listed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { useDebounced } from '../lib/use-debounced.ts';
import { POLL_MS, useContactName, useMe } from './conversation-inbox.tsx';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
const SEARCH_PAUSE_MS = 300;
const MATCHES_STALE_MS = 5 * 60_000;

// The contacts the customer may be (CV3, #2306): the contact with the phone number the customer wrote first, then those with a similar name, ranked by the
// AI coworker when it is on. They are suggestions, shown only while the thread is not linked; nothing is linked until a person clicks. With the model off,
// spent or failing the names still come in their own order, with no error.
function ContactSuggestions({ conversationId, lastSeq }: { conversationId: string; lastSeq: number }) {
  const t = useTranslations('conversations.contact');
  const matches = useQuery({
    queryKey: ['conversation-contact-matches', conversationId, lastSeq],
    queryFn: () => client.conversations.contactMatches({ conversationId }),
    staleTime: MATCHES_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const link = useMutation({ mutationFn: (partyId: string) => client.conversations.linkContact({ conversationId, partyId }), onSuccess: refresh });
  const candidates = matches.data?.candidates ?? [];
  if (candidates.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="contact-suggestions">
      <h3 className="text-sm font-semibold text-foreground">{t('suggested')}</h3>
      <ul className="divide-y divide-border rounded-md border border-border">
        {candidates.map((c) => (
          <li key={c.partyId} className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="min-w-0">
              <span className="block truncate text-foreground">{c.name}</span>
              <Badge variant="proposal">{t(`reason.${c.reason}`)}</Badge>
            </span>
            <Button type="button" size="sm" variant="outline" loading={link.isPending && link.variables === c.partyId} onClick={() => link.mutate(c.partyId)}>
              {t('linkThis')}
            </Button>
          </li>
        ))}
      </ul>
      {link.error && <ErrorText>{errorMessage(link.error)}</ErrorText>}
    </div>
  );
}

function LinkContact({ conversationId, defaultName, hasParty }: { conversationId: string; defaultName: string; hasParty: boolean }) {
  const t = useTranslations('conversations.contact');
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(defaultName);
  const term = useDebounced(text.trim(), SEARCH_PAUSE_MS);
  const found = useQuery({ ...orpc.search.query.queryOptions({ input: { q: term } }), enabled: term.length >= 2 });
  const link = useMutation({
    mutationFn: (partyId: string | null) => client.conversations.linkContact({ conversationId, partyId }),
    onSuccess: () => {
      setText('');
      setCreating(false);
      refresh();
    },
  });
  // A new contact is a person by default: the platform gave a name, not a company; a person can fix it in the contacts screen.
  const create = useMutation({
    mutationFn: async () => {
      const party = await client.parties.create({ kind: 'person', name: name.trim() });
      await client.conversations.linkContact({ conversationId, partyId: party.partyId });
    },
    onSuccess: () => {
      setCreating(false);
      refresh();
    },
  });
  const parties = found.data?.parties ?? [];
  return (
    <div className="space-y-2" data-testid="contact-link">
      {hasParty && (
        <Button type="button" size="sm" variant="outline" loading={link.isPending} onClick={() => link.mutate(null)}>
          {t('unlink')}
        </Button>
      )}
      <label className="block text-xs font-medium text-muted-foreground" htmlFor={`link-${conversationId}`}>
        {t(hasParty ? 'change' : 'link')}
      </label>
      <Input id={`link-${conversationId}`} type="search" value={text} placeholder={t('linkSearch')} maxLength={100} onChange={(e) => setText(e.target.value)} />
      {term.length >= 2 && !found.isPending && parties.length === 0 && <p className="text-xs text-muted-foreground">{t('noMatch')}</p>}
      {parties.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border" aria-label={t('results')}>
          {parties.slice(0, 5).map((p) => (
            <li key={p.id}>
              <button type="button" className="w-full px-2 py-1.5 text-left text-sm hover:bg-muted" disabled={link.isPending} onClick={() => link.mutate(p.id)}>
                {p.name}
                {p.taxCode ? <span className="ml-1 text-xs text-muted-foreground">{p.taxCode}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {link.error && <ErrorText>{errorMessage(link.error)}</ErrorText>}
      {creating ? (
        <form
          className="space-y-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <label className="block text-xs font-medium text-muted-foreground" htmlFor={`create-${conversationId}`}>
            {t('createName')}
          </label>
          <Input id={`create-${conversationId}`} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={create.isPending} disabled={name.trim() === ''}>
              {t('createSave')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
              {t('cancel')}
            </Button>
          </div>
          {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
        </form>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
          {t('create')}
        </Button>
      )}
    </div>
  );
}

export function ContactPanel({ conversationId, onOpen }: { conversationId: string; onOpen: (id: string) => void }) {
  const t = useTranslations('conversations.contact');
  const tc = useTranslations('conversations');
  const f = useFormat();
  const contactName = useContactName();
  const { canWrite } = useMe();
  const detail = useQuery({ ...orpc.conversations.get.queryOptions({ input: { conversationId } }), refetchInterval: POLL_MS });
  if (detail.isPending) return <Spinner />;
  if (detail.error || !detail.data) return <ErrorText>{errorMessage(detail.error)}</ErrorText>;
  const { conversation: c, others } = detail.data;
  return (
    <aside aria-label={t('title')} className="space-y-4 text-sm" data-testid="contact-panel">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="font-medium text-foreground" data-testid="contact-name">
          {contactName(c.contact)}
        </p>
        {c.contact.partyName ? (
          <p className="text-muted-foreground">
            {t('party')}: <span className="text-foreground">{c.contact.partyName}</span>
          </p>
        ) : (
          <p className="text-muted-foreground">{t('noParty')}</p>
        )}
        {c.contact.displayName && c.contact.partyName && c.contact.displayName !== c.contact.partyName && (
          <p className="text-xs text-muted-foreground">
            {t('identity')}: {c.contact.displayName}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {c.channel.displayName} · {tc(`kind.${c.kind}`)}
        </p>
      </div>
      {canWrite && c.contact.partyId === null && <ContactSuggestions conversationId={conversationId} lastSeq={c.lastSeq} />}
      {canWrite && <LinkContact key={`${conversationId}:${c.contact.partyId ?? ''}`} conversationId={conversationId} defaultName={c.contact.displayName ?? ''} hasParty={c.contact.partyId !== null} />}
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{t('others')}</h3>
        {others.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noOthers')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="contact-others">
            {others.map((o) => (
              <li key={o.id}>
                <button type="button" className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-muted" onClick={() => onOpen(o.id)}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-foreground">{o.channel.displayName}</span>
                    <Badge variant="outline">{tc(`status.${o.status}`)}</Badge>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tc(`kind.${o.kind}`)}
                    {o.lastMessageAt ? ` · ${f.dateTime(o.lastMessageAt)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
