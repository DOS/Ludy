// SPDX-License-Identifier: AGPL-3.0-only
// The YouTube comments switch of a connected channel (issue #3134): owners and admins turn "also read and answer comments" on or off, and every member
// sees why replies may stop: the units this channel's polling used today against its budget, the units replies used, and when YouTube's own quota (shared by
// every channel of the Google project) or the budget resets. Nothing is read or stored until the switch is on.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { YOUTUBE_POLL_MAX_UNITS } from '@crove/kernel-contract';
import { Checkbox } from '@crove/ui/components/checkbox';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

export function YoutubeCommentsPanel({ connectionId, isAdmin }: { connectionId: string; isAdmin: boolean }) {
  const t = useTranslations('conversations');
  const f = useFormat();
  const list = useQuery(orpc.conversations.youtubeComments.queryOptions({ input: {}, refetchInterval: 60_000 }));
  const set = useMutation({
    mutationFn: (enabled: boolean) => client.conversations.setYoutubeComments({ connectionId, enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.youtubeComments.key() }),
  });
  const s = list.data?.find((row) => row.connectionId === connectionId);
  if (!s) return null;
  const blocked = s.blockedUntil !== null;
  const overBudget = s.pollUnitsUsed + YOUTUBE_POLL_MAX_UNITS > s.pollBudget;
  return (
    <section className="mt-2 space-y-1 text-xs" aria-label={t('youtubeComments.label')} data-testid="youtube-comments">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={s.enabled} disabled={!isAdmin || set.isPending || (!s.enabled && !s.scopeGranted)} data-testid="youtube-comments-toggle" aria-label={t('youtubeComments.label')} onCheckedChange={(on) => set.mutate(on === true)} />
        <span className="font-medium text-foreground">{t('youtubeComments.label')}</span>
      </label>
      {!s.enabled && <p className="text-subtle-foreground">{t(s.scopeGranted ? 'youtubeComments.hint' : 'youtubeComments.needsScope')}</p>}
      {s.enabled && (
        <div className="space-y-0.5 text-subtle-foreground" data-testid="youtube-quota">
          <p>{t('youtubeComments.units', { used: f.number(s.pollUnitsUsed), budget: f.number(s.pollBudget), replies: f.number(s.replyUnitsUsed) })}</p>
          {blocked && s.blockedUntil ? (
            <p className="text-destructive" role="status" data-testid="youtube-quota-blocked">{t('youtubeComments.blocked', { when: f.dateTime(s.blockedUntil) })}</p>
          ) : overBudget ? (
            <p role="status" data-testid="youtube-quota-budget">{t('youtubeComments.overBudget', { when: f.dateTime(s.resetAt) })}</p>
          ) : s.nextPollAt ? (
            <p>{t('youtubeComments.next', { when: f.dateTime(s.nextPollAt) })}</p>
          ) : null}
          {s.lastPolledAt && <p>{t('youtubeComments.last', { when: f.dateTime(s.lastPolledAt) })}</p>}
          <p>{t('youtubeComments.reset', { when: f.dateTime(s.resetAt) })}</p>
        </div>
      )}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </section>
  );
}
