// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's draft of the follow-up message for a "Cần theo dõi" step (#3101, docs/plan/crm.md 4.4a and docs/plan/crm-quotes.md section 7). A person asks ("Soạn tin nhắc") on a
// step of the deals screen or on the customer's conversation. The server builds the facts (the contact's name, the quote's number, its total, its link, the days quiet) and the coworker writes
// only a lead-in and a closing; with no model, a spent budget or words that fail the checks, the fixed Vietnamese words stand with the same facts. The text lands in a box the person edits, or in
// the reply box of the conversation (the person presses Send), or in their own mail program. Nothing is sent from here, and the core works with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { FollowupDrafted, NextStep } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { REPLY_INSERT_EVENT, refreshQuoteQueries, type ReplyInsert } from './quote-send.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';

const REASON = { no_activity: 'noActivity', past_close: 'pastClose', quote_unanswered: 'quoteUnanswered', quote_expiring: 'quoteExpiring' } as const;

// The mail program's own draft: the contact's address, the subject and the text, as the person has edited it. Nothing is sent by the page.
export const mailtoOf = (draft: Pick<FollowupDrafted, 'email' | 'subject'>, text: string): string =>
  `mailto:${draft.email ? encodeURIComponent(draft.email).replace(/%40/g, '@') : ''}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(text)}`;

// On a step of the deals screen: the button, and under it the draft in a box the person edits, with copy and "open email".
export function FollowupDraftAction({ stepId, dealTitle }: { stepId: string; dealTitle: string }) {
  const t = useTranslations('deals.nextSteps.followup');
  const [draft, setDraft] = useState<FollowupDrafted | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const ask = useMutation({
    mutationFn: () => client.crm.nextSteps.draft({ nextStepId: stepId }),
    onSuccess: (done) => {
      setDraft(done);
      setText(done.text);
      setCopied(false);
      // The link just made shows in the quote's list of links.
      refreshQuoteQueries();
    },
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="basis-full space-y-2" data-testid="followup-action">
      <Button type="button" size="sm" variant="outline" loading={ask.isPending} disabled={ask.isPending} aria-label={t('askOne', { title: dealTitle })} onClick={() => ask.mutate()} data-testid="followup-ask">
        {t('ask')}
      </Button>
      {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
      {draft !== null && (
        <div className="space-y-2 rounded-lg border border-dashed border-proposal/60 p-3" data-testid="followup-draft">
          <p className="text-xs text-foreground" role="status" data-testid="followup-state" data-state={draft.ai}>
            {t(`state.${draft.ai}`)}
          </p>
          <label className="block space-y-1 text-sm font-medium text-foreground">
            {t('textLabel')}
            <Textarea rows={9} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} data-testid="followup-text" />
          </label>
          {draft.hasLink && <p className="text-xs text-muted-foreground">{t('linkMade')}</p>}
          {draft.quoteId !== null && !draft.hasLink && <p className="text-xs text-muted-foreground">{t('noLink')}</p>}
          <p className="text-xs text-muted-foreground">{t('sendHint')}</p>
          {draft.email === null && <p className="text-xs text-muted-foreground">{t('noEmail')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void copy()} disabled={text.trim() === ''} data-testid="followup-copy">
              {copied ? t('copied') : t('copy')}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={text.trim() === ''} onClick={() => window.location.assign(mailtoOf(draft, text))} data-testid="followup-mail">
              {t('email')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t('close')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// In the conversation's contact panel: the open follow-up steps of the customer's deals, each with a button that puts the draft into the reply box for the person to read, edit and send.
// Where the conversation cannot be answered from here (the platform's window is closed), the email way of the deals screen is the offer.
export function FollowupReplyInsert({ conversationId, partyId, canReply }: { conversationId: string; partyId: string; canReply: boolean }) {
  const t = useTranslations('deals.nextSteps.followup');
  const list = useQuery(orpc.crm.nextSteps.list.queryOptions({ input: { scope: 'all', partyId, limit: 5 } }));
  const insert = useMutation({
    mutationFn: async (step: NextStep) => {
      const done = await client.crm.nextSteps.draft({ nextStepId: step.id });
      window.dispatchEvent(new CustomEvent<ReplyInsert>(REPLY_INSERT_EVENT, { detail: { conversationId, text: done.text } }));
      return done;
    },
    onSuccess: refreshQuoteQueries,
  });
  const steps = list.data?.items ?? [];
  if (steps.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="followup-reply-insert">
      <h3 className="text-sm font-semibold text-foreground">{t('replyTitle')}</h3>
      {!canReply && <p className="text-xs text-muted-foreground">{t('replyClosed')}</p>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {steps.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="min-w-0 text-xs text-muted-foreground">
              <span className="block truncate text-foreground">{s.dealTitle}</span>
              {t(`reason.${REASON[s.reason]}`)}
            </span>
            <Button type="button" size="sm" variant="outline" disabled={!canReply} loading={insert.isPending && insert.variables?.id === s.id} onClick={() => insert.mutate(s)} aria-label={t('insertOne', { title: s.dealTitle })}>
              {t('replyInsert')}
            </Button>
          </li>
        ))}
      </ul>
      {insert.data && (
        <p className="text-xs text-foreground" role="status" data-testid="followup-reply-state" data-state={insert.data.ai}>
          {t(`state.${insert.data.ai}`)}
        </p>
      )}
      {insert.error && <ErrorText>{errorMessage(insert.error)}</ErrorText>}
    </div>
  );
}
