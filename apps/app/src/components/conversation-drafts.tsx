// SPDX-License-Identifier: AGPL-3.0-only
// The sales and customer-care coworker's reply drafts and the saved replies in the conversation screens (CV8, #2310, plan docs/plan/conversations.md section 5.6). The draft is
// tainted text a model wrote from a customer's message: the screen says so, shows it beside the reply box, and a person takes it into the box,
// edits it and sends it. Nothing is sent by the coworker. Without a model, or when it gave none, the reply box works as it always did and says nothing
// alarming. The saved replies are the org's own text, matched to the customer's words and offered next to the draft.
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import {
  contactNameOf,
  fillNamePlaceholder,
  SAVED_REPLY_BODY_MAX,
  SAVED_REPLY_NAME_PLACEHOLDER,
  SAVED_REPLY_KEYWORDS_MAX,
  SAVED_REPLY_TITLE_MAX,
  type ConversationDetail,
  type ConversationDraftView,
  type SavedReplyView,
} from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { Textarea } from '@ludy/ui/components/textarea';
import { CoworkerAttribution, ProposalSurface } from './proposal-surface.tsx';
import { ErrorText, Spinner } from './ui.tsx';
import * as apiModule from '../lib/api.ts';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { TOUCH_BUTTON } from '../lib/conversation-touch.ts';

const activeOrg = () => (apiModule as { getCurrentOrg?: () => string | null }).getCurrentOrg?.() ?? null;

export { contactNameOf };

// The text a saved reply or a draft puts in the reply box: its words with the contact's name in place of `{tên}`, so the person reads the final text
// before pressing Send.
export const replyTextFor = (body: string, detail: ConversationDetail): string => fillNamePlaceholder(body, contactNameOf(detail.conversation.contact));

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });

// The draft beside the reply box, the button that asks for one, and the saved replies that answer the customer's words. `onUse` takes the draft's text
// into the box (the reply that is then sent names the draft, so its length and the size of the edit are recorded, never the text); `onUseSaved` takes
// a saved reply's.
export function DraftPanel({ detail, onUse, onUseSaved }: { detail: ConversationDetail; onUse: (draft: ConversationDraftView) => void; onUseSaved: (reply: SavedReplyView) => void }) {
  const t = useTranslations('conversations');
  const aiOn = getConfig().aiEnabled === true;
  const draft = detail.draft;
  const last = detail.messages.at(-1);
  const answerable = last !== undefined && last.direction === 'in' && !last.removed;
  const ask = useMutation({ mutationFn: () => client.conversations.draftRequest({ conversationId: detail.conversation.id }), onSuccess: refresh });
  const discard = useMutation({ mutationFn: (draftId: string) => client.conversations.draftDiscard({ draftId }), onSuccess: refresh });
  const showAsk = aiOn && !draft && answerable;
  if (!draft && !showAsk && detail.suggestions.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="conversation-draft-panel">
      {/* The first place the Inbox shows the sales coworker says what it is (DESIGN 1.1): a coworker that proposes, never one that sends. */}
      {aiOn && (draft || showAsk) && (
        <p className="text-xs text-muted-foreground" data-testid="conversation-dy-intro">
          {t('draft.intro')}
        </p>
      )}
      {draft?.state === 'requested' && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="conversation-draft-writing">
          <Spinner /> {t('draft.writing')}
        </p>
      )}
      {draft?.state === 'live' && draft.body !== null && (
        <ProposalSurface
          as="section"
          proposed
          className="space-y-2 rounded-lg p-3"
          aria-label={t('draft.title')}
          data-testid="conversation-draft"
        >
          <CoworkerAttribution
            coworker="sales"
            badgeLabel={t('draft.badge')}
            badgeTestId="conversation-draft-tainted"
            source={t('draft.hint')}
            tag="ai"
          />
          <p className="whitespace-pre-wrap break-words text-sm text-foreground" data-testid="conversation-draft-text">
            {draft.body}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className={TOUCH_BUTTON} variant="outline" data-testid="conversation-draft-use" onClick={() => onUse(draft)}>
              {t('draft.use')}
            </Button>
            <Button type="button" size="sm" className={TOUCH_BUTTON} variant="ghost" loading={discard.isPending} data-testid="conversation-draft-discard" onClick={() => discard.mutate(draft.id)}>
              {t('draft.discard')}
            </Button>
          </div>
          {discard.error && <ErrorText>{errorMessage(discard.error)}</ErrorText>}
        </ProposalSurface>
      )}
      {showAsk && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" className={TOUCH_BUTTON} variant="outline" loading={ask.isPending} data-testid="conversation-draft-ask" onClick={() => ask.mutate()}>
            {t('draft.ask')}
          </Button>
          {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
        </div>
      )}
      {detail.suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label={t('draft.suggestions')} data-testid="conversation-suggestions">
          <span className="text-xs text-muted-foreground">{t('draft.suggestions')}</span>
          {detail.suggestions.map((s) => (
            <Button key={s.id} type="button" size="sm" className={TOUCH_BUTTON} variant="outline" title={s.body} data-testid="conversation-suggestion" onClick={() => onUseSaved(s)}>
              {s.title}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export type SavedReplyDraft = { id: string | null; title: string; body: string; keywords: string };

// Holds the saved-reply draft and save/delete mutations so the Inbox page can keep them alive across settings drawer close/reopen.
export function useSavedRepliesState() {
  const [editing, setEditing] = useState<SavedReplyDraft | null>(null);
  const editSessionRef = useRef(0);
  const editingIdRef = useRef<string | null>(null);
  editingIdRef.current = editing?.id ?? null;
  const editingKindRef = useRef<'add' | 'edit' | null>(null);
  const returnReplyIdRef = useRef<string | null>(null);
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.conversations.savedReplies.key() });
    // Refresh open conversation details so DraftPanel suggestions reflect updated or deleted replies at once.
    void queryClient.invalidateQueries({ queryKey: orpc.conversations.get.key() });
  };
  type SaveArgs = { session: number; id: string | null; title: string; body: string; keywords: string[] };
  const save = useMutation({
    mutationFn: async ({ id, title, body, keywords }: SaveArgs) => {
      const input = { title, body, keywords };
      if (id) await client.conversations.updateSavedReply({ id, ...input });
      else await client.conversations.createSavedReply(input);
    },
    onSuccess: (_data, { session }) => {
      if (editSessionRef.current === session) setEditing(null);
      reload();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.conversations.deleteSavedReply({ id }),
    onSuccess: (_data, id) => {
      if (editingIdRef.current === id) {
        // The deleted row's Edit button is about to leave the DOM, so direct post-close focus straight to the Add button instead.
        editingKindRef.current = 'add';
        returnReplyIdRef.current = null;
        if (!save.isPending) save.reset();
        editSessionRef.current += 1;
        setEditing(null);
      }
      reload();
    },
  });
  return { editing, setEditing, editSessionRef, editingKindRef, returnReplyIdRef, save, remove };
}

export type SavedRepliesState = ReturnType<typeof useSavedRepliesState>;

export const IME_ESCAPE_GRACE_MS = 100;

export type SavedReplyEscapeAction = 'ignore_ime' | 'bubble_to_sheet' | 'cancel_form';

// Safari can dispatch compositionend right before the Escape keydown that dismissed the IME candidate window, with isComposing already false.
export function resolveSavedReplyEscape({
  isComposing,
  nowMs,
  lastCompositionEndMs,
  savePending,
}: {
  isComposing: boolean;
  nowMs: number;
  lastCompositionEndMs: number;
  savePending: boolean;
}): SavedReplyEscapeAction {
  if (isComposing || nowMs - lastCompositionEndMs < IME_ESCAPE_GRACE_MS) return 'ignore_ime';
  if (savePending) return 'bubble_to_sheet';
  return 'cancel_form';
}

// The org's saved replies: a list with an edit form. Every member reads them; owners, admins and members write them.
export function SavedRepliesPanel({ canWrite, state }: { canWrite: boolean; state: SavedRepliesState }) {
  const t = useTranslations('conversations');
  const list = useQuery(orpc.conversations.savedReplies.queryOptions({ input: {} }));
  const { editing, setEditing, editSessionRef, editingKindRef, returnReplyIdRef, save, remove } = state;
  const editingKey = editing ? (editing.id ?? '__new__') : null;
  const titleInputRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const compositionEndedAtRef = useRef(-Infinity);
  const wasEditingRef = useRef(false);
  const pendingReturnRef = useRef<{ kind: 'add' | 'edit' | null; replyId: string | null } | null>(null);
  // Restore focus synchronously on commit so FloatingFocusManager (restoreFocus: "popup") never sees activeElement === body
  // when the editing input unmounts, and keep the return target until the destination button is enabled (#3673).
  useLayoutEffect(() => {
    if (editingKey !== null) {
      wasEditingRef.current = true;
      pendingReturnRef.current = null;
      titleInputRef.current?.focus();
      return;
    }
    if (wasEditingRef.current) {
      wasEditingRef.current = false;
      pendingReturnRef.current = { kind: editingKindRef.current, replyId: returnReplyIdRef.current };
      editingKindRef.current = null;
      returnReplyIdRef.current = null;
    }
    const pending = pendingReturnRef.current;
    if (!pending) return;
    const target =
      pending.kind === 'add'
        ? addButtonRef.current
        : (pending.replyId ? editButtonRefs.current.get(pending.replyId) : null) ?? addButtonRef.current;
    if (!target?.isConnected || target.disabled) return;
    pendingReturnRef.current = null;
    target.focus();
  }, [editingKey, editingKindRef, returnReplyIdRef, save.isPending, remove.isPending, remove.variables]);
  const deletingCurrent = Boolean(editing?.id && remove.isPending && remove.variables === editing.id);
  const formLocked = save.isPending || deletingCurrent;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (formLocked || !editing) return;
    const title = editing.title.trim();
    const body = editing.body.trim();
    if (title === '' || body === '') return;
    const keywords = editing.keywords.split(',').map((k) => k.trim()).filter((k) => k !== '');
    save.mutate({ session: editSessionRef.current, id: editing.id, title, body, keywords });
  };
  const cancelEdit = () => {
    if (formLocked) return;
    save.reset();
    editSessionRef.current += 1;
    setEditing(null);
  };
  return (
    <section className="space-y-3" aria-label={t('saved.title')} data-testid="saved-replies">
      <div>
        <p className="text-sm font-medium text-foreground">{t('saved.title')}</p>
        <p className="text-xs text-subtle-foreground">{t('saved.hint')}</p>
        <p className="text-xs text-subtle-foreground" data-testid="saved-reply-name-hint">
          {t('saved.nameHint', { placeholder: SAVED_REPLY_NAME_PLACEHOLDER })}
        </p>
      </div>
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && list.data.replies.length === 0 && !editing && <p className="text-sm text-muted-foreground">{t('saved.empty')}</p>}
      <ul className="space-y-2">
        {list.data?.replies.map((r) => (
          <li key={r.id} className="space-y-1 rounded-md border border-border p-2 text-sm" data-testid="saved-reply">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">{r.title}</span>
              <span className="text-xs text-muted-foreground">{t('saved.used', { count: String(r.useCount) })}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{r.body}</p>
            {r.keywords.length > 0 && <p className="text-xs text-subtle-foreground">{t('saved.keywordsLine', { keywords: r.keywords.join(', ') })}</p>}
            {canWrite && (
              <div className="flex gap-2">
                <Button
                  ref={(el) => {
                    if (el) editButtonRefs.current.set(r.id, el);
                    else editButtonRefs.current.delete(r.id);
                  }}
                  type="button"
                  size="sm"
                  className={TOUCH_BUTTON}
                  variant="ghost"
                  disabled={save.isPending || (remove.isPending && remove.variables === r.id)}
                  onClick={() => {
                    if (save.isPending || (remove.isPending && remove.variables === r.id)) return;
                    save.reset();
                    editSessionRef.current += 1;
                    editingKindRef.current = 'edit';
                    returnReplyIdRef.current = r.id;
                    setEditing({ id: r.id, title: r.title, body: r.body, keywords: r.keywords.join(', ') });
                  }}
                >
                  {t('saved.edit')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className={TOUCH_BUTTON}
                  variant="ghost"
                  disabled={save.isPending || remove.isPending}
                  loading={remove.isPending && remove.variables === r.id}
                  onClick={() => {
                    if (!save.isPending && !remove.isPending) remove.mutate(r.id);
                  }}
                >
                  {t('saved.delete')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      {canWrite && !editing && (
        <Button
          ref={addButtonRef}
          type="button"
          size="sm"
          className={TOUCH_BUTTON}
          variant="outline"
          data-testid="saved-reply-add"
          disabled={save.isPending}
          onClick={() => {
            if (save.isPending) return;
            save.reset();
            editSessionRef.current += 1;
            editingKindRef.current = 'add';
            returnReplyIdRef.current = null;
            setEditing({ id: null, title: '', body: '', keywords: '' });
          }}
        >
          {t('saved.add')}
        </Button>
      )}
      {canWrite && editing && (
        <form
          onSubmit={submit}
          onCompositionStart={() => {
            compositionEndedAtRef.current = -Infinity;
          }}
          onCompositionEnd={() => {
            compositionEndedAtRef.current = Date.now();
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            const action = resolveSavedReplyEscape({
              isComposing: e.nativeEvent.isComposing,
              nowMs: Date.now(),
              lastCompositionEndMs: compositionEndedAtRef.current,
              savePending: formLocked,
            });
            if (action === 'ignore_ime') {
              compositionEndedAtRef.current = -Infinity;
              e.stopPropagation();
              e.nativeEvent.stopPropagation();
              return;
            }
            // When saving or deleting the active reply is pending, let Escape bubble to the Sheet so slow/offline requests never trap keyboard focus.
            if (action === 'bubble_to_sheet') return;
            e.preventDefault();
            e.stopPropagation();
            e.nativeEvent.stopPropagation();
            cancelEdit();
          }}
          className="space-y-2 rounded-md border border-border p-3"
          data-testid="saved-reply-form"
        >
          <Label htmlFor="saved-title">{t('saved.titleLabel')}</Label>
          <Input ref={titleInputRef} id="saved-title" readOnly={formLocked} maxLength={SAVED_REPLY_TITLE_MAX} value={editing.title} onChange={(e) => { if (!formLocked) setEditing({ ...editing, title: e.target.value }); }} />
          <Label htmlFor="saved-body">{t('saved.bodyLabel')}</Label>
          <Textarea id="saved-body" rows={3} readOnly={formLocked} maxLength={SAVED_REPLY_BODY_MAX} value={editing.body} onChange={(e) => { if (!formLocked) setEditing({ ...editing, body: e.target.value }); }} />
          <Label htmlFor="saved-keywords">{t('saved.keywordsLabel')}</Label>
          <Input id="saved-keywords" readOnly={formLocked} aria-describedby="saved-keywords-hint" value={editing.keywords} placeholder={t('saved.keywordsPlaceholder')} onChange={(e) => { if (!formLocked) setEditing({ ...editing, keywords: e.target.value }); }} />
          <p id="saved-keywords-hint" className="text-xs text-subtle-foreground">{t('saved.keywordsHint', { max: String(SAVED_REPLY_KEYWORDS_MAX) })}</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className={TOUCH_BUTTON} loading={save.isPending} disabled={formLocked || editing.title.trim() === '' || editing.body.trim() === ''} data-testid="saved-reply-save">
              {t('saved.save')}
            </Button>
            <Button type="button" size="sm" className={TOUCH_BUTTON} variant="ghost" disabled={formLocked} onClick={cancelEdit}>
              {t('cancel')}
            </Button>
          </div>
          {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        </form>
      )}
      {save.error && !editing && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </section>
  );
}

export function SavedRepliesManager({ canWrite }: { canWrite: boolean }) {
  const state = useSavedRepliesState();
  return <SavedRepliesPanel canWrite={canWrite} state={state} />;
}

export function useAutoDraftState() {
  return useMutation({
    mutationFn: async (autoDraft: boolean) => {
      const org = activeOrg();
      await client.conversations.setAutoDraft({ autoDraft });
      return { org, autoDraft };
    },
    onSuccess: async ({ org, autoDraft }) => {
      // Do not cancel or write org B's cache if the user switched orgs before org A's request resolved.
      if (activeOrg() !== org) return;
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['conversation-intents'] }),
        queryClient.cancelQueries({ queryKey: ['conversation-contact-matches'] }),
      ]);
      if (activeOrg() !== org) return;
      const autoDraftKey = orpc.conversations?.autoDraft?.queryOptions?.({ input: {} }).queryKey;
      if (autoDraftKey) queryClient.setQueryData(autoDraftKey, { autoDraft });
      if (!autoDraft) {
        // Purge cached AI intent and AI-ranked contact suggestions so stale AI order/badges vanish without waiting for another fetch.
        queryClient.removeQueries({ queryKey: ['conversation-intents'] });
        queryClient.removeQueries({ queryKey: ['conversation-contact-matches'] });
      } else {
        void queryClient.invalidateQueries({ queryKey: ['conversation-intents'] });
        void queryClient.invalidateQueries({ queryKey: ['conversation-contact-matches'] });
      }
      void queryClient.invalidateQueries({ queryKey: orpc.conversations.autoDraft.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.conversations.get.key() });
    },
  });
}

// Whether the coworker drafts when a new conversation arrives: every member sees the switch, owners and admins change it. A customer's message goes to the
// deployment's AI endpoint for a draft, which the hint says.
export function AutoDraftControl({ isAdmin, set }: { isAdmin: boolean; set: ReturnType<typeof useAutoDraftState> }) {
  const t = useTranslations('conversations');
  const aiOn = getConfig().aiEnabled === true;
  const current = useQuery({ ...orpc.conversations.autoDraft.queryOptions({ input: {} }), enabled: aiOn });
  if (!aiOn || !current.data) return null;
  return (
    <section className="space-y-1 text-sm" aria-label={t('autoDraft.label')} data-testid="auto-draft">
      <label className="flex min-h-6 max-md:min-h-11 pointer-coarse:min-h-11 items-center gap-2">
        <Checkbox checked={current.data.autoDraft} disabled={!isAdmin || set.isPending} data-testid="auto-draft-toggle" aria-label={t('autoDraft.label')} onCheckedChange={(on) => set.mutate(on === true)} />
        <span className="font-medium text-foreground">{t('autoDraft.label')}</span>
      </label>
      <p className="text-xs text-subtle-foreground">{t('autoDraft.hint')}</p>
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </section>
  );
}

export function AutoDraftSetting({ isAdmin }: { isAdmin: boolean }) {
  const set = useAutoDraftState();
  return <AutoDraftControl isAdmin={isAdmin} set={set} />;
}
