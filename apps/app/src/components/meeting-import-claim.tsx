// SPDX-License-Identifier: AGPL-3.0-only
// The receiving end of an import (meetings integrations C1, #3173): when Ludy's worker has copied a platform recording's audio and the row is "staged", the member's own request claims it
// through the media route an upload uses (the server seals it with the meeting key, which only a member's request can); a transcript-only recording (C2, #3174) is claimed through its own route. Mounted on every Meetings page, so the member's next visit to any of
// them claims it. Each row is claimed once per page mount (never in a loop); a refusal is shown once and the server's status drives the rest, a row nobody claims within 55 minutes fails
// "not_claimed" and is imported again. Nothing here calls a model or starts a recording.
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { ErrorText } from './ui.tsx';
import { claimImportedMedia, claimImportedTranscript, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { isBenignClaimRefusal, rowsToClaim } from '../lib/meeting-platform.ts';
import { useMeetingPlatformRecordings } from './meeting-recordings.tsx';
import { meetingsInstalled } from './linked-meetings.tsx';

export function ImportAutoClaim() {
  const t = useTranslations('meetings.platform.claim');
  const on = meetingsInstalled();
  const recordings = useMeetingPlatformRecordings(on);
  // The rows this page already tried, so a refusal is never retried in a loop.
  const tried = useRef<Set<string>>(new Set());
  const [claiming, setClaiming] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  // Bumped by "Thử lại": the effect runs again for the rows this page already tried.
  const [again, setAgain] = useState(0);
  const rows = recordings.data;
  useEffect(() => {
    for (const { id, meetingId, transcript } of rowsToClaim(rows, tried.current)) {
      tried.current.add(id);
      setClaiming((now) => [...now, id]);
      // A transcript-only recording (C2, #3174) is claimed by its own route: the staged file is the platform's lines, not audio.
      void (transcript ? claimImportedTranscript(meetingId, id) : claimImportedMedia(meetingId, id))
        .then(() => setFailure(null))
        // The row moved on (another tab claimed it): the list tells the rest, no message.
        .catch((error: unknown) => setFailure(isBenignClaimRefusal(error) ? null : error))
        .finally(async () => {
          // Wait for the new list before the row stops counting as "being claimed", so the "waiting" line does not flash between the two.
          await Promise.all([queryClient.invalidateQueries({ queryKey: orpc.meetingPlatform.recordings.key() }), queryClient.invalidateQueries({ queryKey: orpc.meetings.key() })]);
          setClaiming((now) => now.filter((x) => x !== id));
        });
    }
  }, [rows, again]);
  if (!on) return null;
  const waiting = failure === null && (rows ?? []).some((r) => r.status === 'staged' && !claiming.includes(r.id));
  if (claiming.length === 0 && !waiting && failure === null) return null;
  return (
    <div className="space-y-2" data-testid="meeting-import-claim">
      {claiming.length > 0 && (
        <p className="text-sm text-muted-foreground" role="status" data-testid="meeting-import-claiming">
          {t('working')}
        </p>
      )}
      {claiming.length === 0 && waiting && (
        <p className="text-sm text-muted-foreground" role="status" data-testid="meeting-import-waiting">
          {t('waiting')}
        </p>
      )}
      {failure !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <ErrorText>{errorMessage(failure)}</ErrorText>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="meeting-import-claim-retry"
            onClick={() => {
              setFailure(null);
              tried.current.clear();
              setAgain((n) => n + 1);
            }}
          >
            {t('retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
