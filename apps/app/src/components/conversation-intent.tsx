// SPDX-License-Identifier: AGPL-3.0-only
// The intent of a conversation in the Inbox (CV3, #2306, plan docs/plan/conversations.md section 13): the label a person applied, and the AI coworker's
// suggestion beside it. A suggestion is read on the side (a model reads the customer's words, through the AI budget) and is never stored or applied: it has
// the proposal hue and says it is a suggestion, and only a click turns it into the label. With the model off, spent or failing there is simply no
// suggestion, and no error: the Inbox works as it did. Nothing is routed, assigned, resolved or hidden by an intent.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { CONVERSATION_INTENT_BATCH_MAX, CONVERSATION_INTENTS, type ConversationIntent, type ConversationSummary } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { NativeSelect } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { shownIntent } from '../lib/conversation-intent.ts';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
// A suggestion is read again only for a new message (the server keeps what the model said for an hour), so the screen's poll costs nothing.
const SUGGEST_STALE_MS = 10 * 60_000;

// The suggestions for the top of a list: the threads with no label yet, at most one call's worth, for a member who may write them. The answers of earlier
// pages stay, so a thread that slides down the list keeps its suggestion. `ai` says why there is none, for the one case worth a line (the budget).
export function useIntentSuggestions(items: readonly ConversationSummary[], enabled: boolean): { suggested: ReadonlyMap<string, ConversationIntent | null>; ai: string | null } {
  const asked = items.filter((c) => c.intent === null).slice(0, CONVERSATION_INTENT_BATCH_MAX);
  const key = asked.map((c) => `${c.id}:${c.lastSeq}`).join(',');
  const result = useQuery({
    queryKey: ['conversation-intents', key],
    queryFn: () => client.conversations.suggestIntents({ conversationIds: asked.map((c) => c.id) }),
    enabled: enabled && asked.length > 0,
    staleTime: SUGGEST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [known, setKnown] = useState<ReadonlyMap<string, ConversationIntent | null>>(new Map());
  useEffect(() => {
    if (!result.data) return;
    setKnown((previous) => {
      const next = new Map(previous);
      for (const s of result.data?.suggestions ?? []) next.set(s.conversationId, s.intent);
      return next;
    });
  }, [result.data]);
  return { suggested: known, ai: result.data?.ai ?? null };
}

// A label on a row or in a thread's header: a person's label, or the suggestion (in the proposal hue, worded as one).
export function IntentBadge({ intent, applied }: { intent: ConversationIntent; applied: boolean }) {
  const t = useTranslations('conversations.intent');
  return (
    <Badge variant={applied ? 'brand' : 'proposal'} data-testid={applied ? 'intent-applied' : 'intent-suggested'}>
      {applied ? t(`label.${intent}`) : t('suggestedShort', { intent: t(`label.${intent}`) })}
    </Badge>
  );
}

// In the thread's header, for a member who may write it: the label a person applied (changed or cleared from the list), or the suggestion with one click
// to apply it. The thread's own suggestion is read for this thread alone (the server answers from what it said a moment ago when the list asked).
export function IntentBar({ conversation: c }: { conversation: ConversationSummary }) {
  const t = useTranslations('conversations.intent');
  const suggestion = useQuery({
    queryKey: ['conversation-intents', `${c.id}:${c.lastSeq}`],
    queryFn: () => client.conversations.suggestIntents({ conversationIds: [c.id] }),
    enabled: c.intent === null,
    staleTime: SUGGEST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const set = useMutation({ mutationFn: (intent: ConversationIntent | null) => client.conversations.setIntent({ conversationId: c.id, intent }), onSuccess: refresh });
  const suggested = suggestion.data?.suggestions.find((s) => s.conversationId === c.id)?.intent ?? null;
  const shown = shownIntent({ id: c.id, intent: c.intent }, new Map([[c.id, suggested]]));
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="intent-bar">
      <NativeSelect size="sm" aria-label={t('applied')} value={c.intent ?? ''} disabled={set.isPending} data-testid="intent-select" onChange={(e) => set.mutate(e.target.value === '' ? null : (e.target.value as ConversationIntent))}>
        <option value="">{t('none')}</option>
        {CONVERSATION_INTENTS.map((intent) => (
          <option key={intent} value={intent}>
            {t(`label.${intent}`)}
          </option>
        ))}
      </NativeSelect>
      {shown && !shown.applied && (
        <>
          <IntentBadge intent={shown.intent} applied={false} />
          <Button type="button" size="sm" variant="outline" loading={set.isPending} data-testid="intent-apply" onClick={() => set.mutate(shown.intent)}>
            {t('apply')}
          </Button>
        </>
      )}
      {suggestion.data?.ai === 'budget' && c.intent === null && (
        <span className="text-xs text-muted-foreground" role="status">
          {t('budget')}
        </span>
      )}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </div>
  );
}
