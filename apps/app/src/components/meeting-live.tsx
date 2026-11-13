// SPDX-License-Identifier: AGPL-3.0-only
// The live pane of a meeting being recorded (L4a-2, #3110, ADR-0052): the recorder's own Vy transcribes the pieces uploaded while recording and the page shows
// them as a draft that the full transcript replaces. Shown only to the recorder of a meeting that opted into live notes. One ticker copies finished windows and
// starts the next; it never overlaps itself. Whatever happens here (no AI, no budget, an error) the recording itself is not affected.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import type { LiveStatus } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// The cadence of the status poll and of the tick, in milliseconds.
export const LIVE_POLL_MS = 10_000;

// What the pane says about the state: a message key under `meetings.live` and the code, when the server stopped it.
export type LiveNotice = { key: 'notEnabled' | 'budget' | 'aiStopped' | 'otherStopped'; code: string | null } | null;

export function liveNotice(status: Pick<LiveStatus, 'enabled' | 'state' | 'errorCode'>): LiveNotice {
  if (!status.enabled) return { key: 'notEnabled', code: null };
  if (status.errorCode === 'AI_BUDGET_EXHAUSTED') return { key: 'budget', code: null };
  if (status.errorCode === 'AI_STOPPED') return { key: 'aiStopped', code: null };
  if (status.errorCode) return { key: 'otherStopped', code: status.errorCode };
  return null;
}

// Whether the pane polls and ticks: not before it started, and not once stopped.
export function liveActive(status: Pick<LiveStatus, 'enabled' | 'state'>): boolean {
  return status.enabled && (status.state === 'running' || status.state === 'waiting');
}

// One call at a time: a tick asked for while another is in flight is dropped (returns false), so two windows are never copied or started at once.
export function createTickGate(): { run(call: () => Promise<unknown>): Promise<boolean> } {
  let inFlight = false;
  return {
    async run(call) {
      if (inFlight) return false;
      inFlight = true;
      try {
        await call();
      } finally {
        inFlight = false;
      }
      return true;
    },
  };
}

export function MeetingLive({ meetingId, liveNotes, isRecorder }: { meetingId: string; liveNotes: boolean; isRecorder: boolean }) {
  if (!liveNotes || !isRecorder) return null;
  return <LivePane meetingId={meetingId} />;
}

function LivePane({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.live');
  const status = useQuery({
    ...orpc.meetings.liveStatus.queryOptions({ input: { meetingId } }),
    refetchInterval: (q) => (q.state.data && liveActive(q.state.data) ? LIVE_POLL_MS : false),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.meetings.liveStatus.key() });
  };
  const gate = useRef(createTickGate()).current;
  const tick = useMutation({
    mutationFn: (notesNow: boolean) => gate.run(() => orpc.meetings.liveTick.call({ meetingId, notesNow })),
    onSuccess: refresh,
  });
  const start = useMutation({ mutationFn: () => orpc.meetings.liveStart.call({ meetingId }), onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => orpc.meetings.liveStop.call({ meetingId }), onSuccess: refresh });

  const data = status.data;
  const active = data ? liveActive(data) : false;
  const tickRef = useRef(tick.mutate);
  tickRef.current = tick.mutate;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tickRef.current(false), LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [active]);

  if (!data) return null;
  const notice = liveNotice(data);
  const error = status.error ?? tick.error ?? start.error ?? stop.error;
  return (
    <Card data-testid="live-pane">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base font-medium">{t('title')}</CardTitle>
          {data.enabled && <Badge variant="outline">{t(`states.${data.state}`)}</Badge>}
        </div>
        <CardDescription className="text-xs text-muted-foreground">{t('draftNote')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {notice && (
          <div role="status" className="space-y-1" data-testid="live-notice">
            <p className="font-medium">{t(notice.key)}</p>
            {notice.code && <p className="font-mono text-xs text-muted-foreground">{t('code', { code: notice.code })}</p>}
            <p className="text-xs text-muted-foreground">{t('recordingContinues')}</p>
          </div>
        )}
        {error && <ErrorText>{errorMessage(error)}</ErrorText>}
        {data.enabled && (
          <div className="flex flex-wrap gap-2">
            {data.state === 'off' && (
              <Button size="sm" loading={start.isPending} onClick={() => start.mutate()}>
                {t('start')}
              </Button>
            )}
            {active && (
              <>
                <Button size="sm" variant="outline" loading={tick.isPending} onClick={() => tick.mutate(true)}>
                  {t('notesNow')}
                </Button>
                <Button size="sm" variant="outline" loading={stop.isPending} onClick={() => stop.mutate()}>
                  {t('stop')}
                </Button>
              </>
            )}
          </div>
        )}
        {data.enabled && data.lines.length === 0 && <p className="text-xs text-muted-foreground">{t('empty')}</p>}
        {data.enabled && data.lines.length > 0 && (
          <ul className="divide-y" data-testid="live-lines">
            {data.lines.map((line) => (
              <li key={line.id} className="space-y-1 py-2" data-testid="live-line">
                <span className="font-mono text-xs text-muted-foreground" title={t('lineTime', { start: clock(line.startSeconds), end: clock(line.endSeconds) })}>
                  {clock(line.startSeconds)}
                </span>
                <p>{line.text}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
