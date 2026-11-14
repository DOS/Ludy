// SPDX-License-Identifier: AGPL-3.0-only
// The live pane of a meeting being recorded (L4a-2, #3110, ADR-0052): the recorder's own Vy transcribes the pieces uploaded while recording and the page shows
// them as a draft that the full transcript replaces. Shown only to the recorder of a meeting that opted into live notes. One ticker copies finished windows and
// starts the next; it never overlaps itself. Whatever happens here (no AI, no budget, an error) the recording itself is not affected.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import type { LiveAssembleState, LiveStatus } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { assembleLivePieces, errorMessage, orpc, queryClient } from '../lib/api.ts';

// The cadence of the status poll and of the tick, in milliseconds, and of the running notes (ADR-0052: every five minutes, or on the recorder's click).
export const LIVE_POLL_MS = 10_000;
export const LIVE_NOTES_MS = 5 * 60_000;

// What the pane says about the state: a message key under `meetings.live` and the code, when the server stopped it.
export type LiveNotice = { key: 'notEnabled' | 'budget' | 'aiStopped' | 'otherStopped'; code: string | null } | null;

export function liveNotice(status: Pick<LiveStatus, 'enabled' | 'state' | 'errorCode'>): LiveNotice {
  if (!status.enabled) return { key: 'notEnabled', code: null };
  if (status.errorCode === 'AI_BUDGET_EXHAUSTED') return { key: 'budget', code: null };
  if (status.errorCode === 'AI_STOPPED') return { key: 'aiStopped', code: null };
  // The recorder's own stop is not a failure.
  if (status.errorCode === 'RUN_CANCELLED') return null;
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

// What the recording-not-uploaded box shows: nothing while the final recording may still arrive (during and after the meeting, until the longest recording time has passed),
// nothing when there are no pieces or the recording exists (an expired meeting that kept its recording has no pieces left); the offer when the pieces can be joined; the reason
// when they cannot: no first piece, or the audio period ended while pieces were still kept.
export type AssembleView = 'none' | 'offer' | 'first_piece_missing' | 'expired';
export function assembleView(state: LiveAssembleState): AssembleView {
  if (state.available) return 'offer';
  if ((state.reason === 'first_piece_missing' || state.reason === 'expired') && state.pieces > 0) return state.reason;
  return 'none';
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
    mutationFn: () => gate.run(() => orpc.meetings.liveTick.call({ meetingId })),
    onSuccess: refresh,
  });
  // The running notes are a call of their own, one at a time like the tick: the draft they write shows in the meeting's results, so those are refetched too.
  const notesGate = useRef(createTickGate()).current;
  const notes = useMutation({
    mutationFn: () => notesGate.run(() => orpc.meetings.liveNotes.call({ meetingId })),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.get.key() });
    },
  });
  // The recorder's click joins the live pieces into the recording (#3126): the page then shows the recording, and the pane the result.
  const assemble = useMutation({
    mutationFn: () => assembleLivePieces(meetingId),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
    },
  });
  const start = useMutation({ mutationFn: () => orpc.meetings.liveStart.call({ meetingId }), onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => orpc.meetings.liveStop.call({ meetingId }), onSuccess: refresh });

  const data = status.data;
  const active = data ? liveActive(data) : false;
  const tickRef = useRef(tick.mutate);
  tickRef.current = tick.mutate;
  const notesRef = useRef(notes.mutate);
  notesRef.current = notes.mutate;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tickRef.current(), LIVE_POLL_MS);
    const notesId = setInterval(() => notesRef.current(), LIVE_NOTES_MS);
    return () => {
      clearInterval(id);
      clearInterval(notesId);
    };
  }, [active]);

  if (!data) return null;
  const notice = liveNotice(data);
  const error = status.error ?? tick.error ?? start.error ?? stop.error ?? notes.error ?? assemble.error;
  const view = assembleView(data.assemble);
  const gaps = (missing: number[]) => ({ count: String(missing.length), list: missing.slice(0, 20).join(', ') + (missing.length > 20 ? ', ...' : '') });
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
        {data.enabled && <p className="text-xs text-muted-foreground" data-testid="live-page-open">{t('pageOpen')}</p>}
        {data.enabled && (
          <div className="flex flex-wrap gap-2">
            {(data.state === 'off' || data.state === 'stopped') && (
              <Button size="sm" loading={start.isPending} onClick={() => start.mutate()}>
                {t('start')}
              </Button>
            )}
            {active && (
              <>
                <Button size="sm" variant="outline" loading={notes.isPending} onClick={() => notes.mutate()}>
                  {t('notesNow')}
                </Button>
                <Button size="sm" variant="outline" loading={stop.isPending} onClick={() => stop.mutate()}>
                  {t('stop')}
                </Button>
              </>
            )}
          </div>
        )}
        {(view !== 'none' || assemble.data) && (
          <div role="status" className="space-y-2 rounded-md border p-3" data-testid="live-assemble">
            <p className="font-medium">{t('assemble.title')}</p>
            {assemble.data ? (
              <>
                <p>{t('assemble.done', { pieces: String(assemble.data.pieces), length: clock(assemble.data.lengthSeconds) })}</p>
                {assemble.data.missing.length > 0 && <p data-testid="live-assemble-gaps">{t('assemble.doneGaps', gaps(assemble.data.missing))}</p>}
              </>
            ) : view === 'offer' ? (
              <>
                <p>{t('assemble.offer', { pieces: String(data.assemble.pieces) })}</p>
                {data.assemble.missing.length > 0 && <p data-testid="live-assemble-gaps">{t('assemble.gaps', gaps(data.assemble.missing))}</p>}
                <p className="text-xs text-muted-foreground">{t('assemble.lateUpload')}</p>
                <Button size="sm" loading={assemble.isPending} onClick={() => assemble.mutate()}>
                  {t('assemble.button')}
                </Button>
              </>
            ) : (
              view !== 'none' && <p className="text-xs text-muted-foreground">{t(`assemble.reasons.${view}`)}</p>
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
