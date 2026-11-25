// SPDX-License-Identifier: AGPL-3.0-only
// "Lệnh đã nói với Vy" (#4807, plan docs/plan/meetings.md L19): when people said "Vy ơi, ghi lại ..." in the meeting, the recorder's own click finds those cues in the transcript (by code, no AI) and drafts one
// action item for each, marked "Nói với Vy" and citing the second it was said. Nothing is published or made a task from here; the recorder confirms each item as any other Vy item. Shown to the recorder
// when the meeting has a transcript.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { VoiceCueDrafted } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// The same query, with the same cache entry, as the transcript panel: a sensitive read that leaves one audit row, so no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;

/** What one click did, in words: the items added, then what was left out and why. */
export function useVoiceCueSummary() {
  const t = useTranslations('meetings.results.voiceCues');
  return (r: VoiceCueDrafted): string => {
    if (r.found === 0) return t('none');
    const parts = [r.created > 0 ? t('created', { count: r.created }) : t('nothingNew')];
    const left = [r.duplicate > 0 ? t('duplicate', { count: r.duplicate }) : '', r.empty > 0 ? t('empty', { count: r.empty }) : '', r.full > 0 ? t('full', { count: r.full }) : ''].filter((x) => x !== '');
    if (left.length > 0) parts.push(t('left', { list: left.join(', ') }));
    return parts.join(' ');
  };
}

export function MeetingVoiceCues({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.results.voiceCues');
  const summary = useVoiceCueSummary();
  const transcript = useQuery({ ...orpc.meetings.transcript.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const [done, setDone] = useState<VoiceCueDrafted | null>(null);
  const find = useMutation({
    mutationFn: () => orpc.meetings.voiceCue.draft.call({ meetingId }),
    onSuccess: (result) => {
      setDone(result);
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.key() });
    },
  });
  // Nothing to look in until the meeting has a transcript.
  if (transcript.error || (transcript.data?.segments.length ?? 0) === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="voice-cues">
      <p className="text-sm font-medium">{t('title')}</p>
      <p className="text-xs text-muted-foreground">{t('desc')}</p>
      <Button type="button" size="sm" variant="outline" loading={find.isPending} onClick={() => find.mutate()} data-testid="voice-cues-find">
        {t('find')}
      </Button>
      {done && (
        <p role="status" className="text-sm" data-testid="voice-cues-done">
          {summary(done)}
        </p>
      )}
      {find.error && <ErrorText>{errorMessage(find.error)}</ErrorText>}
    </div>
  );
}
