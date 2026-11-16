// SPDX-License-Identifier: AGPL-3.0-only
// The always-visible recording bar (Meetings A1, #3159, #3197): "Đang ghi 12:31" on every screen while this member records, in the
// app (the app-level recorder publishes it; the bar has a Stop button, the recording goes on while the member moves between
// screens) or with the extension (`meetings.meeting.recording_now`, derived from the meeting row). It disappears when the recording stops. It is not an AI surface and shows no meeting content, not even a title.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Button } from '@crove/ui/components/button';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { formatClock } from '@crove/meeting-recorder';
import { orpc } from '../lib/api.ts';
import { getRecorderSnapshot, subscribeRecorder } from '../lib/recording-controller.ts';
import { getLocalRecording, subscribeLocalRecording } from '../lib/recording-indicator.ts';

const POLL_MS = 15_000;

export function RecordingChip() {
  const t = useTranslations('meetings');
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const local = useSyncExternalStore(subscribeLocalRecording, getLocalRecording, getLocalRecording);
  const saving = useSyncExternalStore(subscribeRecorder, getRecorderSnapshot, getRecorderSnapshot).phase === 'uploading';
  // The extension's recording is read from the server; the app's own is known here, so no question is asked while it runs.
  // An org without the meetings module answers with an error: no chip, no retry storm.
  const remote = useQuery({
    ...orpc.meetings.recordingNow.queryOptions({ input: {} }),
    enabled: local === null && slug !== undefined,
    refetchInterval: (query) => (query.state.status === 'error' ? false : POLL_MS),
    retry: false,
    staleTime: 5_000,
  });
  const [, repaint] = useState(0);
  const active = local !== null || remote.data?.recording != null;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => repaint((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);

  // Stopped and being saved (the Stop button, the maximum length, a sign-out or an org switch): say so while the upload runs, wherever the member is.
  if (saving && local === null) {
    return (
      <div role="status" data-testid="recording-saving" className="fixed top-14 right-3 z-40 flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground shadow-sm md:top-3">
        <span className="inline-block size-2 animate-pulse rounded-full bg-muted-foreground" aria-hidden="true" />
        <span>{t('chip.saving')}</span>
      </div>
    );
  }
  if (local) {
    const orgSlug = local.slug ?? slug;
    if (!orgSlug) return null;
    return (
      <div
        data-testid="recording-chip"
        data-source="app"
        className="fixed top-14 right-3 z-40 flex items-center gap-2 rounded-full border border-destructive/40 bg-background py-1 pr-1 pl-3 text-xs font-medium text-foreground shadow-sm md:top-3"
      >
        <Link to="/o/$slug/meetings/record" params={{ slug: orgSlug }} className="flex items-center gap-2">
          <span className={`inline-block size-2 rounded-full ${local.paused ? 'bg-muted-foreground' : 'animate-pulse bg-destructive'}`} aria-hidden="true" />
          <span>{t(local.paused ? 'chip.paused' : 'chip.recording', { time: formatClock(local.elapsedMs()) })}</span>
        </Link>
        {local.stop && (
          <Button type="button" size="sm" variant="destructive" className="h-6 rounded-full px-3 text-xs" data-testid="recording-chip-stop" onClick={() => local.stop?.()}>
            {t('chip.stop')}
          </Button>
        )}
      </div>
    );
  }
  // The extension's recording is looked up per org: outside one there is nothing to ask.
  if (!slug) return null;
  const recording = remote.data?.recording;
  if (!recording) return null;
  return (
    <Link
      to="/o/$slug/meetings/$id"
      params={{ slug, id: recording.meetingId }}
      data-testid="recording-chip"
      data-source="extension"
      className="fixed top-14 right-3 z-40 flex items-center gap-2 rounded-full border border-destructive/40 bg-background px-3 py-1 text-xs font-medium text-foreground shadow-sm md:top-3"
    >
      <span className="inline-block size-2 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
      <span>{t('chip.recording', { time: formatClock(Date.now() - new Date(recording.startedAt).getTime()) })}</span>
    </Link>
  );
}
