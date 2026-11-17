// SPDX-License-Identifier: AGPL-3.0-only
// Erasing a customer's conversation data (#3635, Engage audit IN-1). It is a personal-data action, not a working one: it lives in its own
// "Dữ liệu cá nhân" section at the foot of the contact panel (and under the thread where there is no panel), never beside Resolve, and the
// confirmation is a modal dialog that names the person, says what is lost and what stays, and gives the counts the screen already holds.
// Owners and admins only; the command, its step-up and its idempotency key are unchanged (kernel.conversation.erase_contact, R3).
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { CONVERSATION_OTHERS_MAX, type ConversationDetail } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { StepUpPrompt } from './two-factor.tsx';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

// The newest messages the thread read returns (the kernel's CONVERSATION_MESSAGES_MAX): a thread that shows this many may hold more.
const MESSAGES_SHOWN_MAX = 500;

export interface EraseTarget {
  // The customer: the thread's own, or (messageId) the author of one message in a comment thread.
  name: string;
  address: string | null;
  messageId?: string;
  // What the screen holds of them. `*More` means the figure is a floor (the read is capped).
  threads: number | null;
  threadsMore: boolean;
  messages: number;
  messagesMore: boolean;
  notes: number;
  // Comment threads are in play: a reply is stored with its thread, so erasing a thread's customer takes the others' replies in it too.
  inComments: boolean;
}

// Who can be erased from this thread: its own customer, and in a comment thread every other customer who commented in it (they have
// no thread of their own to erase from, so their message names them). Pure: the test reads it without a screen.
export function eraseTargets(detail: ConversationDetail, contactName: string, anonymous: (tail: string) => string): EraseTarget[] {
  const c = detail.conversation;
  const messagesMore = detail.messages.length >= MESSAGES_SHOWN_MAX;
  const own: EraseTarget = {
    name: contactName,
    address: c.contact.address ?? null,
    threads: 1 + detail.others.length,
    threadsMore: detail.others.length >= CONVERSATION_OTHERS_MAX,
    messages: detail.messages.length,
    messagesMore,
    notes: detail.notes.length,
    inComments: c.kind === 'comment_thread' || detail.others.some((o) => o.kind === 'comment_thread'),
  };
  const targets = [own];
  if (c.kind !== 'comment_thread') return targets;
  const seen = new Set<string>();
  for (const m of detail.messages) {
    if (m.direction !== 'in' || m.authorTail === null || seen.has(m.authorTail)) continue;
    seen.add(m.authorTail);
    // The thread's own customer is the first target: the same person is not listed twice.
    if (m.authorTail === c.contact.idTail) continue;
    targets.push({
      name: m.authorName ?? anonymous(m.authorTail),
      address: null,
      messageId: m.id,
      threads: null,
      threadsMore: false,
      messages: detail.messages.filter((x) => x.authorTail === m.authorTail).length,
      messagesMore,
      notes: 0,
      inComments: false,
    });
  }
  return targets;
}

function EraseCustomer({ conversation, target, kind, onErased }: { conversation: { id: string; channelName: string }; target: EraseTarget; kind: 'contact' | 'author'; onErased: () => void }) {
  const t = useTranslations('conversations.erase');
  const [open, setOpen] = useState(false);
  // One key per confirmed attempt, kept across the step-up retry, so a lost answer is retried to the same result.
  const [attempt] = useState(() => crypto.randomUUID());
  const erase = useMutation({
    mutationFn: () => client.conversations.eraseContact({ conversationId: conversation.id, ...(target.messageId ? { messageId: target.messageId } : {}), confirm: true, idempotencyKey: attempt }),
    onSuccess: (done) => {
      toast(t('done', { threads: done.threads, messages: done.messages, name: target.name }));
      // The thread's own customer going takes the thread with them; another commenter going leaves it, shorter, and the refresh below redraws it.
      if (kind === 'contact') onErased();
      void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
    },
  });
  const stepUp = isStepUpRequired(erase.error);
  const more = (flag: boolean) => (flag ? 'yes' : 'no');
  const values = {
    name: target.name,
    channel: conversation.channelName,
    at: target.address ? ` (${target.address})` : '',
    threads: target.threads ?? 0,
    threadsMore: more(target.threadsMore),
    messages: target.messages,
    messagesMore: more(target.messagesMore),
    notes: target.notes,
  };
  const body = `${t(kind === 'contact' ? 'warnContact' : 'warnAuthor', values)}${target.inComments ? ` ${t('warnComments')}` : ''} ${t('stays')} ${t('irreversible')}`;
  return (
    <div className="space-y-2">
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        destructive
        title={t('title', { name: target.name })}
        description={body}
        confirm={kind === 'contact' ? t('confirmContact', values) : t('confirmAuthor', { name: target.name })}
        cancel={t('keep')}
        onConfirm={() => erase.mutate()}
        render={<Button type="button" size="sm" variant="outline" disabled={erase.isPending} className="h-auto min-h-8 w-full justify-start whitespace-normal text-left text-destructive" data-testid={kind === 'contact' ? 'conversation-erase-open' : 'conversation-message-erase-open'} />}
      >
        {kind === 'contact' ? t('open') : t('openAuthor', { name: target.name })}
      </ConfirmDialog>
      {stepUp && <StepUpPrompt action={t('stepUp')} onVerified={() => erase.mutate()} onCancel={() => erase.reset()} />}
      {erase.error && !stepUp && <ErrorText>{errorMessage(erase.error)}</ErrorText>}
    </div>
  );
}

// The section itself. The caller shows it to owners and admins only (the server decides anyway).
export function PersonalDataSection({ detail, contactName, onErased }: { detail: ConversationDetail; contactName: string; onErased: () => void }) {
  const t = useTranslations('conversations.erase');
  const ta = useTranslations('conversations');
  const c = detail.conversation;
  const [own, ...commenters] = eraseTargets(detail, contactName, (tail) => ta('anonymous', { tail }));
  if (!own) return null;
  const conversation = { id: c.id, channelName: c.channel.displayName };
  return (
    <section className="space-y-2 border-t border-border pt-3" aria-labelledby={`personal-data-${c.id}`} data-testid="conversation-personal-data">
      <h3 id={`personal-data-${c.id}`} className="text-sm font-semibold text-foreground">
        {t('heading')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <EraseCustomer conversation={conversation} target={own} kind="contact" onErased={onErased} />
      {commenters.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t('commenters')}</p>
          {commenters.map((target) => (
            <EraseCustomer key={target.messageId} conversation={conversation} target={target} kind="author" onErased={onErased} />
          ))}
        </div>
      )}
    </section>
  );
}
