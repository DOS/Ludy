// SPDX-License-Identifier: AGPL-3.0-only
// The machine translation of a meeting's transcript on its page (meetings integrations E2, #3185, plan section 7a). Any reader can ask for a translation of the lines they read, and the
// recorder for their own draft: "Dịch sang ..." starts a background run of the member's own Vy over chunks of the lines. One run takes a batch of chunks and keeps what it finished, so while
// this page is open it starts the next batch as each one ends, until the transcript is translated, a chunk is refused for the budget ("Chờ ngân sách AI"), the member stops it or a run
// fails; with the page closed the next click goes on from the parts already kept. The translation sits under each original line as "Bản dịch máy", never in its place, only the member who
// asked reads it, and it is never the source of a task, mail, post, webhook, search hit or export.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { TranscriptTranslationView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { ErrorText } from './ui.tsx';
import { translateBlocked } from './meeting-translation.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

type Part = TranscriptTranslationView['parts'][number];
const POLL_MS = 4000;
const KNOWN_CODES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'TRANSCRIBE_TIMEOUT', 'TRANSCRIBE_FAILED', 'TRANSCRIBE_INVALID_RESPONSE', 'TRANSCRIPT_EMPTY', 'TRANSCRIPT_TOO_LONG', 'RUN_ENDED', 'RUN_CANCELLED', 'TRANSLATE_RUNNING', 'TRANSLATION_DONE', 'TRANSLATION_STALE'] as const;
type KnownCode = (typeof KNOWN_CODES)[number];
const knownCode = (code: unknown): KnownCode | 'default' => ((KNOWN_CODES as readonly string[]).includes(code as string) ? (code as KnownCode) : 'default');

const refresh = () => queryClient.refetchQueries({ queryKey: orpc.meetings.translation.key() });

/** The member's own translated parts of the transcript, by the line they translate; empty until they asked. The read is audited, so it is not refetched on focus. */
export function useTranscriptParts(meetingId: string): { parts: ReadonlyMap<string, Part>; to: string } {
  const query = useQuery({ ...orpc.meetings.translation.transcriptGet.queryOptions({ input: { meetingId } }), staleTime: 5 * 60_000, refetchOnWindowFocus: false });
  return { parts: new Map((query.data?.parts ?? []).map((p) => [p.lineId, p])), to: query.data?.to ?? 'en' };
}

/** The second line under an original line: the translation with its label and marks, or the fixed word when the line could not be translated. */
export function TranslatedLine({ part, to }: { part: Part; to: string }) {
  const t = useTranslations('meetings.transcript.translation');
  return (
    <div className="border-l-2 border-muted pl-2 text-sm text-muted-foreground" lang={to} data-testid="transcript-translation-line">
      <Badge variant="outline" className="mr-1">
        {t('label')}
      </Badge>
      {part.state === 'refused' ? (
        <span className="text-xs">({t('refused')})</span>
      ) : (
        <>
          <span className="whitespace-pre-wrap">{part.text}</span>
          {part.codes.map((code) => (
            <Badge key={code} variant="outline" className="ml-1" data-testid="translation-mark">
              {t(`marks.${code as 'NUMBER_DROPPED' | 'NAME_ADDED'}`)}
            </Badge>
          ))}
        </>
      )}
      {part.stale && <span className="ml-1 text-xs text-warning">{t('staleLine')}</span>}
    </div>
  );
}

export function TranscriptTranslationPanel({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.transcript.translation');
  const f = useFormat();
  const status = useQuery({
    ...orpc.meetings.translation.transcriptStatus.queryOptions({ input: { meetingId } }),
    refetchOnWindowFocus: false,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? POLL_MS : false),
  });
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'meetings' } }), staleTime: 15_000 });
  // On while this page goes on from one batch to the next; off at the end, at a failure, at a refusal and at the member's stop.
  const [auto, setAuto] = useState(false);
  const askedRuns = useRef(new Set<string>());
  const lastRemaining = useRef<number | null>(null);
  const start = useMutation({
    mutationFn: () => orpc.meetings.translation.transcriptStart.call({ meetingId }),
    // The mutation stays pending until the status is read again, so the effect below never sees the status of the run that just ended.
    onSuccess: refresh,
    // A second start that races the first (a double click, another tab) is refused because a run is live: the loop goes on with the run that is.
    onError: (error) => {
      if ((error as { code?: unknown } | null)?.code !== 'TRANSLATE_RUNNING') setAuto(false);
    },
  });
  const stop = useMutation({
    mutationFn: () => orpc.meetings.translation.transcriptStop.call({ meetingId }),
    onSuccess: () => {
      setAuto(false);
      return refresh();
    },
  });
  const copy = useMutation({
    mutationFn: (runId: string) => orpc.meetings.translation.transcriptCopy.call({ meetingId, runId }),
    onSuccess: refresh,
    onError: () => setAuto(false),
  });
  const data = status.data;
  // A finished run's parts are kept by the member's own copy, once for each run.
  useEffect(() => {
    if (data?.needsCopy && data.runId && !askedRuns.current.has(data.runId)) {
      askedRuns.current.add(data.runId);
      copy.mutate(data.runId);
    }
  }, [data?.needsCopy, data?.runId, copy]);
  // The next batch, while a batch ended with parts kept and lines are left. A batch that kept nothing more ends the loop, so a model that keeps skipping lines costs one run, not many.
  useEffect(() => {
    if (!auto || !data || start.isPending || copy.isPending || stop.isPending) return;
    if (data.state === 'running' || data.needsCopy) return;
    if (data.state === 'failed' || data.remaining === 0 || (lastRemaining.current !== null && data.remaining >= lastRemaining.current)) {
      setAuto(false);
      return;
    }
    lastRemaining.current = data.remaining;
    start.mutate();
  }, [auto, data, start, copy.isPending, stop.isPending]);
  // Nothing to show before the server has answered; a deployment without Meetings has no status data, so no panel at all.
  if (!data) return null;
  const blocked = translateBlocked(data, meter.data);
  const running = data.state === 'running';
  const label = data.to === 'en' ? t('toEnglish') : t('toVietnamese');
  const begun = data.translated > 0 || data.stale > 0;
  const finished = begun && data.remaining === 0;
  const cost = data.estimate?.cost ?? null;
  const calls = data.estimate?.calls ?? 0;
  const failure = data.state === 'failed' ? knownCode(data.errorCode) : null;
  const error = start.error ?? copy.error ?? stop.error;
  const errorCode = (error as { code?: unknown } | null)?.code;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="transcript-translation" data-stage={data.stage ?? undefined}>
      {data.chunksTotal > 0 && begun && (
        <p className="text-sm" role="status" data-testid="transcript-translation-progress">
          {t('progress', { done: String(data.chunksDone), total: String(data.chunksTotal) })}
        </p>
      )}
      {data.stale > 0 && <p className="text-xs text-warning">{t('stale', { count: String(data.stale) })}</p>}
      {running ? (
        <div className="space-y-2">
          <p role="status" className="text-xs">
            {t('running')}
          </p>
          <p className="text-xs text-muted-foreground">{t('stopHint')}</p>
          <Button size="sm" variant="outline" loading={stop.isPending} onClick={() => stop.mutate()}>
            {t('stop')}
          </Button>
        </div>
      ) : finished ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t('done')}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={begun ? 'outline' : 'default'}
            loading={start.isPending}
            disabled={blocked !== null || start.isPending || copy.isPending}
            onClick={() => {
              stop.reset();
              copy.reset();
              lastRemaining.current = data.remaining;
              setAuto(true);
              start.mutate();
            }}
          >
            {begun ? t('continue') : label}
          </Button>
          {blocked !== null && (
            <span className="text-xs text-muted-foreground" role="status" data-testid="translation-blocked">
              {t(`blocked.${blocked}`)}
            </span>
          )}
          {blocked === null && data.estimate !== null && calls > 0 && (
            <span className="text-xs text-muted-foreground">{cost !== null ? t('estimate', { calls: String(calls), cost: f.aiAmount(cost) }) : t('estimateCalls', { calls: String(calls) })}</span>
          )}
        </div>
      )}
      {failure && !running && <ErrorText>{`${t('failed')} ${t(`codes.${failure}`)}`}</ErrorText>}
      {error && !running && <ErrorText>{(knownCode(errorCode) !== 'default' ? t(`codes.${knownCode(errorCode) as KnownCode}`) : errorMessage(error))}</ErrorText>}
      <p className="text-xs text-muted-foreground">{t('private')}</p>
    </div>
  );
}
