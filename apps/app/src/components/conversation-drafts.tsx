// SPDX-License-Identifier: AGPL-3.0-only
// The sales and customer-care coworker's reply drafts and the saved replies in the conversation screens (CV8, #2310, plan docs/plan/conversations.md section 5.6). The draft is
// tainted text a model wrote from a customer's message: the screen says so, shows it beside the reply box, and a person takes it into the box,
// edits it and sends it. Nothing is sent by the coworker. Without a model, or when it gave none, the reply box works as it always did and says nothing
// alarming. The saved replies are the org's own text, matched to the customer's words and offered next to the draft.
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import {
  fillNamePlaceholder,
  SAVED_REPLY_BODY_MAX,
  SAVED_REPLY_NAME_PLACEHOLDER,
  SAVED_REPLY_KEYWORDS_MAX,
  SAVED_REPLY_TITLE_MAX,
  type ConversationDetail,
  type ConversationDraftView,
  type SavedReplyView,
} from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText, Spinner } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';

// The name a saved reply's `{tên}` is filled with (#3102): the linked contact's name when a person linked one, else the name the platform gave. Null when
// the thread has neither (only a short tail of an id), and then the placeholder is dropped, never shown.
export function contactNameOf(contact: Pick<ConversationDetail['conversation']['contact'], 'partyName' | 'displayName'>): string | null {
  return contact.partyName?.trim() || contact.displayName?.trim() || null;
}

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
      {draft?.state === 'requested' && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="conversation-draft-writing">
          <Spinner /> {t('draft.writing')}
        </p>
      )}
      {draft?.state === 'live' && draft.body !== null && (
        <section className="space-y-2 rounded-md border border-border bg-muted/50 p-3" aria-label={t('draft.title')} data-testid="conversation-draft">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" data-testid="conversation-draft-tainted">
              {t('draft.badge')}
            </Badge>
            <span className="text-xs text-muted-foreground">{t('draft.hint')}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground" data-testid="conversation-draft-text">
            {draft.body}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" data-testid="conversation-draft-use" onClick={() => onUse(draft)}>
              {t('draft.use')}
            </Button>
            <Button type="button" size="sm" variant="ghost" loading={discard.isPending} data-testid="conversation-draft-discard" onClick={() => discard.mutate(draft.id)}>
              {t('draft.discard')}
            </Button>
          </div>
          {discard.error && <ErrorText>{errorMessage(discard.error)}</ErrorText>}
        </section>
      )}
      {showAsk && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" loading={ask.isPending} data-testid="conversation-draft-ask" onClick={() => ask.mutate()}>
            {t('draft.ask')}
          </Button>
          {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
        </div>
      )}
      {detail.suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label={t('draft.suggestions')} data-testid="conversation-suggestions">
          <span className="text-xs text-muted-foreground">{t('draft.suggestions')}</span>
          {detail.suggestions.map((s) => (
            <Button key={s.id} type="button" size="sm" variant="outline" title={s.body} data-testid="conversation-suggestion" onClick={() => onUseSaved(s)}>
              {s.title}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// The org's saved replies: a list with an edit form. Every member reads them; owners, admins and members write them.
export function SavedRepliesManager({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('conversations');
  const list = useQuery(orpc.conversations.savedReplies.queryOptions({ input: {} }));
  const [editing, setEditing] = useState<{ id: string | null; title: string; body: string; keywords: string } | null>(null);
  const reload = () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.savedReplies.key() });
  const save = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      const keywords = editing.keywords.split(',').map((k) => k.trim()).filter((k) => k !== '');
      const input = { title: editing.title.trim(), body: editing.body.trim(), keywords };
      if (editing.id) await client.conversations.updateSavedReply({ id: editing.id, ...input });
      else await client.conversations.createSavedReply(input);
    },
    onSuccess: () => {
      setEditing(null);
      reload();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => client.conversations.deleteSavedReply({ id }), onSuccess: reload });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (editing && editing.title.trim() !== '' && editing.body.trim() !== '') save.mutate();
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
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing({ id: r.id, title: r.title, body: r.body, keywords: r.keywords.join(', ') })}>
                  {t('saved.edit')}
                </Button>
                <Button type="button" size="sm" variant="ghost" loading={remove.isPending && remove.variables === r.id} onClick={() => remove.mutate(r.id)}>
                  {t('saved.delete')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      {canWrite && !editing && (
        <Button type="button" size="sm" variant="outline" data-testid="saved-reply-add" onClick={() => setEditing({ id: null, title: '', body: '', keywords: '' })}>
          {t('saved.add')}
        </Button>
      )}
      {canWrite && editing && (
        <form onSubmit={submit} className="space-y-2 rounded-md border border-border p-3" data-testid="saved-reply-form">
          <Label htmlFor="saved-title">{t('saved.titleLabel')}</Label>
          <Input id="saved-title" maxLength={SAVED_REPLY_TITLE_MAX} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
          <Label htmlFor="saved-body">{t('saved.bodyLabel')}</Label>
          <Textarea id="saved-body" rows={3} maxLength={SAVED_REPLY_BODY_MAX} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          <Label htmlFor="saved-keywords">{t('saved.keywordsLabel')}</Label>
          <Input id="saved-keywords" value={editing.keywords} placeholder={t('saved.keywordsPlaceholder')} onChange={(e) => setEditing({ ...editing, keywords: e.target.value })} />
          <p className="text-xs text-subtle-foreground">{t('saved.keywordsHint', { max: String(SAVED_REPLY_KEYWORDS_MAX) })}</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={save.isPending} disabled={editing.title.trim() === '' || editing.body.trim() === ''} data-testid="saved-reply-save">
              {t('saved.save')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t('cancel')}
            </Button>
          </div>
          {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        </form>
      )}
    </section>
  );
}

// Whether the coworker drafts when a new conversation arrives: every member sees the switch, owners and admins change it. A customer's message goes to the
// deployment's AI endpoint for a draft, which the hint says.
export function AutoDraftSetting({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('conversations');
  const current = useQuery(orpc.conversations.autoDraft.queryOptions({ input: {} }));
  const set = useMutation({
    mutationFn: (autoDraft: boolean) => client.conversations.setAutoDraft({ autoDraft }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.autoDraft.key() }),
  });
  if (!getConfig().aiEnabled || !current.data) return null;
  return (
    <section className="space-y-1 text-sm" aria-label={t('autoDraft.label')} data-testid="auto-draft">
      <label className="flex items-center gap-2">
        <Checkbox checked={current.data.autoDraft} disabled={!isAdmin || set.isPending} data-testid="auto-draft-toggle" aria-label={t('autoDraft.label')} onCheckedChange={(on) => set.mutate(on === true)} />
        <span className="font-medium text-foreground">{t('autoDraft.label')}</span>
      </label>
      <p className="text-xs text-subtle-foreground">{t('autoDraft.hint')}</p>
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </section>
  );
}
