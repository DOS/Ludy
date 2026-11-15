// SPDX-License-Identifier: AGPL-3.0-only
// The receiving end of an import (meetings integrations C1, #3173): when Ludy's worker has copied a platform recording's audio and the row is "staged", the member's own request claims it
// through the media route an upload uses (the server seals it with the meeting key, which only a member's request can). Mounted on every Meetings page, so the member's next visit to any of
// them claims it. Each row is claimed once per page mount (never in a loop); a refusal is shown once and the server's status drives the rest, a row nobody claims within 55 minutes fails
// "not_claimed" and is imported again. Nothing here calls a model or starts a recording.
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { ErrorText } from './ui.tsx';
import { claimImportedMedia, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { rowsToClaim } from '../lib/meeting-platform.ts';
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
  const rows = recordings.data;
  useEffect(() => {
    for (const { id, meetingId } of rowsToClaim(rows, tried.current)) {
      tried.current.add(id);
      setClaiming((now) => [...now, id]);
      void claimImportedMedia(meetingId, id)
        .catch((error: unknown) => setFailure(error))
        .finally(() => {
          setClaiming((now) => now.filter((x) => x !== id));
          void queryClient.invalidateQueries({ queryKey: orpc.meetingPlatform.recordings.key() });
          void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
        });
    }
  }, [rows]);
  if (!on) return null;
  const waiting = (rows ?? []).some((r) => r.status === 'staged' && !claiming.includes(r.id));
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
      {failure !== null && <ErrorText>{errorMessage(failure)}</ErrorText>}
    </div>
  );
}
