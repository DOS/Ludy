// SPDX-License-Identifier: AGPL-3.0-only
// The right pane of the Inbox (CV3, #2306, plan docs/plan/conversations.md sections 5.4 and 11): who the customer is. The contact (the party, when a person
// linked one: a contact is never made by itself, because a comment is not consent to be in a CRM), the name the platform gave, the customer's other
// threads that the reader may read, and the way to link the thread to a contact or to create one. Linking is for those who may reply. What the reader may
// read of other threads is the database's decision: a thread they may not read is simply not listed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { ErrorText } from './ui.tsx';
import { PaneError, PanelSkeleton } from './conversation-states.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { channelKindLabel } from '../lib/conversation-labels.ts';
import { dismissContactMatch, dismissedContactMatches } from '../lib/conversation-dismissed.ts';
import { installedModules } from '../lib/org-modules.ts';
import { canInsertQuoteLink } from '../lib/quote-reply.ts';
import { useDebounced } from '../lib/use-debounced.ts';
import { TOUCH_BUTTON } from '../lib/conversation-touch.ts';
import { ContactDeals } from './contact-deals.tsx';
import { ConversationTasks } from './conversation-tasks.tsx';
import { RoadmapSignalModal } from './roadmap-signal-modal.tsx';
import { PersonalDataSection } from './conversation-erase.tsx';
import { isConversationAccessDenied, OfflineVerifyNotice, POLL_MS, useContactName, useMe, usePreserveParentScroll, useVerifyUnpauseState, verifySharedRefetch } from './conversation-inbox.tsx';
import { useCustomerAiState } from './conversation-intent.tsx';
import { FollowupReplyInsert } from './followup-draft.tsx';
import { QuoteReplyInsert } from './quote-send.tsx';

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.contacts.conversations.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.conversations.key() });
};
const SEARCH_PAUSE_MS = 300;
const MATCHES_STALE_MS = 5 * 60_000;

// The contacts the customer may be (CV3, #2306): the contact with the phone number the customer wrote first, then those with a similar name, ranked by the
// AI coworker when it is on. They are suggestions, shown only while the thread is not linked; nothing is linked until a person clicks. With the model off,
// spent or failing the names still come in their own order, with no error.
export function ContactSuggestions({ conversationId, lastSeq, enabled = true }: { conversationId: string; lastSeq: number; enabled?: boolean }) {
  const t = useTranslations('conversations.contact');
  const aiState = useCustomerAiState(enabled, `${conversationId}:${lastSeq}`);
  const aiOff = aiState === 'off';
  const matches = useQuery({
    queryKey: ['conversation-contact-matches', conversationId, lastSeq, aiOff ? 'off' : 'on'],
    queryFn: () => client.conversations.contactMatches({ conversationId }),
    enabled: enabled && aiState !== 'pending',
    // An answer that is not one yet (busy) is asked again soon, a few times.
    staleTime: (query) => (query.state.data?.ai === 'busy' ? 0 : MATCHES_STALE_MS),
    refetchInterval: (query) => (query.state.data?.ai === 'busy' && query.state.dataUpdateCount < 6 ? 4_000 : false),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const link = useMutation({ mutationFn: (partyId: string) => client.conversations.linkContact({ conversationId, partyId }), onSuccess: refresh });
  // The ones a person skipped for this thread stay skipped (#3637); a name-only match asks once more before it links, since a similar name is the weakest evidence.
  const [skipped, setSkipped] = useState<string[]>(() => dismissedContactMatches(conversationId));
  const [confirming, setConfirming] = useState<string | null>(null);
  const candidates = enabled && aiState !== 'pending' ? (matches.data?.candidates ?? []).filter((c) => !skipped.includes(c.partyId)) : [];
  if (candidates.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="contact-suggestions">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{t('suggested')}</h3>
        {/* The coworker is named as the ranker whenever the server response says a model ranked them. */}
        {matches.data?.ai === 'used' && (
          <Badge variant="proposal" data-testid="contact-ranked-by">
            {t('rankedBy')}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('suggestedHint')}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {candidates.map((c) => (
          <li key={c.partyId} className="space-y-1.5 px-2 py-1.5">
            <div className="space-y-1.5">
              <span className="block min-w-0">
                <span className="block break-words text-foreground">{c.name}</span>
                <Badge variant="outline">{t(`reason.${c.reason}`)}</Badge>
              </span>
              {/* On their own row, wrapping: the panel is 16rem wide and a long company name must not push the buttons out of it. */}
              <span className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={`h-auto min-h-8 max-w-full whitespace-normal break-words text-left ${TOUCH_BUTTON}`}
                  loading={link.isPending && link.variables === c.partyId}
                  data-testid="contact-suggestion-link"
                  aria-describedby={confirming === c.partyId ? `name-only-${c.partyId}` : undefined}
                  onClick={() => (c.reason === 'name' && confirming !== c.partyId ? setConfirming(c.partyId) : link.mutate(c.partyId))}
                >
                  {confirming === c.partyId ? t('nameOnlyConfirm', { name: c.name }) : t('linkThis', { name: c.name })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className={TOUCH_BUTTON}
                  variant="ghost"
                  aria-label={t('dismissLabel', { name: c.name })}
                  data-testid="contact-suggestion-dismiss"
                  onClick={() => {
                    // Added to what is on screen, not replaced by what storage returns: with storage blocked the earlier skips would come back.
                    dismissContactMatch(conversationId, c.partyId);
                    setSkipped((now) => [...new Set([...now, c.partyId])]);
                    setConfirming(null);
                  }}
                >
                  {t('dismiss')}
                </Button>
              </span>
            </div>
            {confirming === c.partyId && (
              <p id={`name-only-${c.partyId}`} role="status" className="text-xs text-muted-foreground" data-testid="contact-name-only-warn">
                {t('nameOnlyWarn', { name: c.name })}
              </p>
            )}
          </li>
        ))}
      </ul>
      {link.error && <ErrorText>{errorMessage(link.error)}</ErrorText>}
    </div>
  );
}

function LinkContact({ conversationId, defaultName, hasParty, paused = false, masked = false }: { conversationId: string; defaultName: string; hasParty: boolean; paused?: boolean; masked?: boolean }) {
  const t = useTranslations('conversations.contact');
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(defaultName);
  const term = useDebounced(text.trim(), SEARCH_PAUSE_MS);
  const found = useQuery({ ...orpc.search.query.queryOptions({ input: { q: term } }), enabled: !paused && !masked && term.length >= 2 });
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
  if (masked) return null;
  const parties = found.data?.parties ?? [];
  return (
    <div className="space-y-2" data-testid="contact-link">
      {hasParty && (
        <Button type="button" size="sm" className={TOUCH_BUTTON} variant="outline" loading={link.isPending} onClick={() => link.mutate(null)}>
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
            <Button type="submit" size="sm" className={TOUCH_BUTTON} loading={create.isPending} disabled={name.trim() === ''}>
              {t('createSave')}
            </Button>
            <Button type="button" size="sm" className={TOUCH_BUTTON} variant="ghost" onClick={() => setCreating(false)}>
              {t('cancel')}
            </Button>
          </div>
          {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
        </form>
      ) : (
        <Button type="button" size="sm" className={TOUCH_BUTTON} variant="outline" onClick={() => setCreating(true)}>
          {t('create')}
        </Button>
      )}
    </div>
  );
}

// `onErased`: the thread is gone once its customer is erased, so the screen leaves it.
export function ContactPanel({
  conversationId,
  paused = false,
  verifyOnMount = false,
  onOpen,
  onErased,
}: {
  conversationId: string;
  paused?: boolean;
  verifyOnMount?: boolean;
  onOpen: (id: string) => void;
  onErased: () => void;
}) {
  const t = useTranslations('conversations.contact');
  const tc = useTranslations('conversations');
  const tRoadmap = useTranslations('projects.roadmap.admin');
  const f = useFormat();
  const contactName = useContactName();
  const { canWrite, isAdmin } = useMe();
  const [roadmapSignalOpen, setRoadmapSignalOpen] = useState(false);
  const detailOptions = orpc.conversations.get.queryOptions({ input: { conversationId } });
  const [denied, setDenied] = useState<{ id: string; error: Error } | null>(null);
  const currentDenied = denied?.id === conversationId ? denied.error : null;
  const detail = useQuery({
    ...detailOptions,
    enabled: !paused && !currentDenied,
    refetchInterval: paused || currentDenied ? false : POLL_MS,
    refetchOnWindowFocus: !paused && !currentDenied,
    refetchOnReconnect: !paused && !currentDenied,
  });
  // Hide stale contact/task data behind PanelSkeleton while verifying or PaneError while retaining tasks/NewTask state across transient errors,
  // sharing a single fresh post-unpause verification request with ConversationThread.
  const { verifying: verifyingAccess, offline: verifyingOffline } = useVerifyUnpauseState(
    paused || Boolean(currentDenied),
    (cancelExisting) => verifySharedRefetch(detailOptions.queryKey, () => detail.refetch({ cancelRefetch: false }), cancelExisting),
    true,
    verifyOnMount,
    detailOptions.queryKey,
    undefined,
    detail.data !== undefined,
  );
  const effectiveError = detail.error ?? (detail.data ? null : currentDenied);
  const accessDenied = isConversationAccessDenied(effectiveError);
  useEffect(() => {
    if (!detail.error && detail.data && currentDenied) {
      setDenied(null);
      return;
    }
    if (currentDenied) {
      if (detail.data !== undefined || isConversationAccessDenied(detail.error)) {
        queryClient.removeQueries({ queryKey: detailOptions.queryKey, exact: true });
      }
      return;
    }
    if (detail.error && isConversationAccessDenied(detail.error)) {
      setDenied({ id: conversationId, error: detail.error });
    }
  }, [conversationId, detail.data, currentDenied, detail.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const hidePanelContent = paused || verifyingAccess || Boolean(effectiveError);
  const panelRef = useRef<HTMLElement>(null);
  usePreserveParentScroll(panelRef, hidePanelContent, detail.data !== undefined && !accessDenied, false);
  if (hidePanelContent && roadmapSignalOpen) setRoadmapSignalOpen(false);
  if (!accessDenied && (detail.isPending || ((paused || verifyingAccess) && !detail.data))) {
    return !paused && verifyingOffline ? <OfflineVerifyNotice testId="panel-offline" /> : <PanelSkeleton />;
  }
  if (!detail.data || accessDenied) {
    return (
      <PaneError
        message={errorMessage(effectiveError)}
        onRetry={() => {
          if (currentDenied) setDenied(null);
          else void detail.refetch();
        }}
        testId="panel-error"
      />
    );
  }
  const { conversation: c, others } = detail.data;
  const showPrivatePanel = !effectiveError;
  return (
    <>
      {(paused || verifyingAccess) && (verifyingAccess && !paused && verifyingOffline ? <OfflineVerifyNotice testId="panel-offline" /> : <PanelSkeleton />)}
      {!paused && !verifyingAccess && Boolean(effectiveError) && <PaneError message={errorMessage(effectiveError)} onRetry={() => void detail.refetch()} testId="panel-error" />}
      <aside ref={panelRef} aria-label={t('title')} className={hidePanelContent ? 'hidden' : 'space-y-4 text-sm'} data-testid="contact-panel">
      {showPrivatePanel && (
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
            {channelKindLabel(c.channel.displayName, tc(`kind.${c.kind}`))}
          </p>
        </div>
      )}
      {showPrivatePanel && canWrite && c.contact.partyId === null && <ContactSuggestions conversationId={conversationId} lastSeq={c.lastSeq} enabled={!paused && !hidePanelContent} />}
      {canWrite && <LinkContact key={`${conversationId}:${c.contact.partyId ?? ''}`} conversationId={conversationId} defaultName={c.contact.displayName ?? ''} hasParty={c.contact.partyId !== null} paused={hidePanelContent} masked={Boolean(effectiveError)} />}
      {/* The customer's open deals and "Thêm cơ hội" (#3648): where the chat turns into a sale. Everyone who can read the thread reads the deals; only those who may write add one. */}
      {showPrivatePanel && !hidePanelContent && c.contact.partyId !== null && installedModules().includes('crm') && (
        <ContactDeals key={`deals:${c.contact.partyId}`} contact={{ id: c.contact.partyId, name: c.contact.partyName ?? contactName(c.contact), kind: 'person', taxCode: null }} canEdit={canWrite} openOnly />
      )}
      {canWrite && c.contact.partyId !== null && canInsertQuoteLink(c.kind) && <QuoteReplyInsert conversationId={conversationId} partyId={c.contact.partyId} canReply={detail.data.reply.allowed} paused={hidePanelContent} />}
      {canWrite && c.contact.partyId !== null && canInsertQuoteLink(c.kind) && <FollowupReplyInsert conversationId={conversationId} partyId={c.contact.partyId} canReply={detail.data.reply.allowed} paused={hidePanelContent} />}
      <ConversationTasks key={`tasks:${conversationId}`} conversationId={conversationId} channelName={c.channel.displayName} canWrite={canWrite} paused={paused || hidePanelContent} />
      {showPrivatePanel && canWrite && installedModules().includes('projects') && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={TOUCH_BUTTON}
            onClick={() => setRoadmapSignalOpen(true)}
            data-testid="conversation-link-roadmap"
          >
            {tRoadmap('linkToRoadmapBtn')}
          </Button>
          {!hidePanelContent && (
            <RoadmapSignalModal
              open={roadmapSignalOpen}
              onOpenChange={setRoadmapSignalOpen}
              prefillSource={{
                sourceType: 'kernel.conversation',
                sourceId: conversationId,
                accountLabel: c.contact.partyName ?? c.contact.displayName ?? null,
                quoteExcerpt:
                  [...detail.data.messages].reverse().find((m) => m.direction === 'in' && m.body.trim().length > 0)?.body.slice(0, 1000) ?? null,
              }}
            />
          )}
        </div>
      )}
      {showPrivatePanel && (
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
      )}
      {showPrivatePanel && isAdmin && !hidePanelContent && <PersonalDataSection detail={detail.data} contactName={contactName(c.contact)} onErased={onErased} />}
      </aside>
    </>
  );
}
