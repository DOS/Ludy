// SPDX-License-Identifier: AGPL-3.0-only
// The intent of a conversation in the Inbox (CV3, #2306, plan docs/plan/conversations.md section 13): the label a person applied, and the AI coworker's
// suggestion beside it. A suggestion is read on the side (a model reads the customer's words, through the AI budget) and is never stored or applied: it has
// the proposal hue and says it is a suggestion, and only a click turns it into the label. With the model off, spent or failing there is simply no
// suggestion, and no error: the Inbox works as it did. Nothing is routed, assigned, resolved or hidden by an intent (a spam suggestion only shows a hint
// beside the Hide button of a comment, #3808: a person clicks).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { CONVERSATION_INTENT_BATCH_MAX, CONVERSATION_INTENTS, type ConversationIntent, type ConversationSummary } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { NativeSelect } from '@ludy/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { shownIntent } from '../lib/conversation-intent.ts';
import { TOUCH_BUTTON } from '../lib/conversation-touch.ts';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
// A suggestion is read again only for a new message (the server keeps what the model said for an hour), so the screen's poll costs nothing. An answer
// that is not an answer yet (the member's AI calls were busy, or the call failed) is not kept: it is asked again soon, a few times.
const SUGGEST_STALE_MS = 10 * 60_000;
const SUGGEST_RETRY_MS = 4_000;
const answered = (data: { ai: string } | undefined) => data !== undefined && data.ai !== 'busy' && data.ai !== 'failed';
const suggestOptions = {
  staleTime: (query: { state: { data: { ai: string } | undefined } }) => (answered(query.state.data) ? SUGGEST_STALE_MS : 0),
  refetchInterval: (query: { state: { data: { ai: string } | undefined; dataUpdateCount: number } }) => (query.state.data?.ai === 'busy' && query.state.dataUpdateCount < 6 ? SUGGEST_RETRY_MS : false),
  retry: false,
  refetchOnWindowFocus: false,
} as const;

export function applyIntentSuggestionBatch(
  previous: ReadonlyMap<string, ConversationIntent | null>,
  data: { ai?: string | null; suggestions?: readonly { conversationId: string; intent: ConversationIntent | null }[] } | undefined,
): ReadonlyMap<string, ConversationIntent | null> {
  if (!data) return previous;
  if (data.ai === 'off') return previous.size === 0 ? previous : new Map();
  const next = new Map(previous);
  for (const s of data.suggestions ?? []) next.set(s.conversationId, s.intent);
  return next;
}

const EMPTY_INTENTS: ReadonlyMap<string, ConversationIntent | null> = new Map();

export type CustomerAiState = 'on' | 'off' | 'pending';

// Observes the org's customer-AI switch (#3673) from one screen/thread root, distinguishing loading ('pending') from 'on'/'off'
// so AI-only calls wait until settings settle while cross-session toggles refresh on focus or new activity when AI is off.
export function useCustomerAiState(enabled = false, refreshKey: string | number | null = null): CustomerAiState {
  const systemAiOn = getConfig().aiEnabled === true;
  const active = enabled && systemAiOn;
  const opts = orpc.conversations?.autoDraft?.queryOptions?.({ input: {} });
  const current = useQuery({
    ...(opts ?? { queryKey: ['conversations', 'autoDraft'] as const, queryFn: () => Promise.resolve(undefined as { autoDraft: boolean } | undefined) }),
    enabled: active,
    staleTime: 30_000,
    refetchOnWindowFocus: active ? 'always' : false,
  });
  const aiState: CustomerAiState = !systemAiOn || current.data?.autoDraft === false
    ? 'off'
    : active && current.data === undefined
      ? 'pending'
      : 'on';
  const { refetch } = current;
  const checkedKeyRef = useRef<string | number | null | undefined>(undefined);
  useEffect(() => {
    if (!active || (aiState !== 'off' && !(aiState === 'pending' && current.isError)) || refreshKey === null || refreshKey === '') {
      checkedKeyRef.current = refreshKey;
      return;
    }
    if (checkedKeyRef.current === undefined) {
      checkedKeyRef.current = refreshKey;
      return;
    }
    if (checkedKeyRef.current === refreshKey) return;
    checkedKeyRef.current = refreshKey;
    void refetch({ cancelRefetch: false });
  }, [active, aiState, current.isError, refreshKey, refetch]);
  return aiState;
}

// The suggestions for the top of a list: the threads with no label yet, at most one call's worth, for a member who may write them. The answers of earlier
// pages stay, so a thread that slides down the list keeps its suggestion. `ai` says why there is none, for the one case worth a line (the budget).
export function useIntentSuggestions(
  items: readonly ConversationSummary[],
  enabled: boolean,
  trackAiOff = false,
): { suggested: ReadonlyMap<string, ConversationIntent | null>; ai: string | null } {
  const asked = items.filter((c) => c.intent === null).slice(0, CONVERSATION_INTENT_BATCH_MAX);
  const key = asked.map((c) => `${c.id}:${c.lastSeq}`).join(',');
  const aiState = useCustomerAiState(trackAiOff, enabled && asked.length > 0 ? key : null);
  const aiOff = aiState === 'off';
  const result = useQuery({
    queryKey: ['conversation-intents', key],
    queryFn: () => client.conversations.suggestIntents({ conversationIds: asked.map((c) => c.id) }),
    enabled: enabled && aiState === 'on' && asked.length > 0,
    ...suggestOptions,
  });
  const [known, setKnown] = useState<ReadonlyMap<string, ConversationIntent | null>>(new Map());
  useEffect(() => {
    if (aiOff) {
      setKnown((previous) => (previous.size === 0 ? previous : new Map()));
      return;
    }
    if (!result.data) return;
    setKnown((previous) => applyIntentSuggestionBatch(previous, result.data));
  }, [aiOff, result.data]);
  if (aiOff) return { suggested: EMPTY_INTENTS, ai: 'off' };
  if (aiState !== 'on') return { suggested: EMPTY_INTENTS, ai: null };
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

// The one query of a thread's own suggestion, shared by the header (which enables it) and the hide hint (which never does), so both observe one cache entry
// with one real function: a refetch of the whole cache (an invalidation) can never run a stand-in.
const threadSuggestionOptions = (c: ConversationSummary) => ({
  queryKey: ['conversation-intents', `${c.id}:${c.lastSeq}`],
  queryFn: () => client.conversations.suggestIntents({ conversationIds: [c.id] }),
  ...suggestOptions,
});

// Whether the AI coworker suggested "spam" for this thread (#3808), read from what the header's query already holds: this observer is never enabled, so a
// hide hint costs no model call, and with the model off, spent or failing there is no suggestion and so no hint. Only a hint: a person clicks Hide.
export function useSpamSuggested(c: ConversationSummary): boolean {
  const cached = useQuery({ ...threadSuggestionOptions(c), enabled: false });
  const data = cached.data as { suggestions: { conversationId: string; intent: ConversationIntent | null }[] } | undefined;
  return c.intent === null && data?.suggestions.find((s) => s.conversationId === c.id)?.intent === 'spam';
}

// In the thread's header, for a member who may write it: the label a person applied (changed or cleared from the list), or the suggestion with one click
// to apply it. The thread's own suggestion is read for this thread alone (the server answers from what it said a moment ago when the list asked).
export function IntentBar({ conversation: c, paused = false, aiOff = false }: { conversation: ConversationSummary; paused?: boolean; aiOff?: boolean }) {
  const t = useTranslations('conversations.intent');
  const suggestion = useQuery({
    ...threadSuggestionOptions(c),
    // Only a thread waiting for an answer (New) is read by the model: clicking through the other tabs costs nothing, and opening Settings pauses new suggestions behind the drawer.
    enabled: !paused && !aiOff && c.intent === null && c.status === 'new',
  });
  const set = useMutation({ mutationFn: (intent: ConversationIntent | null) => client.conversations.setIntent({ conversationId: c.id, intent }), onSuccess: refresh });
  const suggested = paused || aiOff ? null : (suggestion.data?.suggestions.find((s) => s.conversationId === c.id)?.intent ?? null);
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
          <Button type="button" size="sm" className={TOUCH_BUTTON} variant="outline" loading={set.isPending} data-testid="intent-apply" aria-label={t('applyLabel', { intent: t(`label.${shown.intent}`) })} onClick={() => set.mutate(shown.intent)}>
            {t('apply')}
          </Button>
        </>
      )}
      {!aiOff && suggestion.data?.ai === 'budget' && c.intent === null && (
        <span className="text-xs text-muted-foreground" role="status">
          {t('budget')}
        </span>
      )}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </div>
  );
}
