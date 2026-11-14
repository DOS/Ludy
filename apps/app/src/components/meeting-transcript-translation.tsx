// SPDX-License-Identifier: AGPL-3.0-only
// The machine translation of a meeting's transcript on its page (meetings integrations E2, #3185, plan section 7a). Any reader can ask for a translation of the lines they read, and the
// recorder for their own draft: "Dịch sang ..." asks the member's own Vy, in the member's own request, to translate the next batch of chunks of the lines and keep what it finished. While
// this page is open it asks again as each batch ends, until the transcript is translated, a chunk is refused for the budget ("Chờ ngân sách AI"), the member stops it or a request
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
const KNOWN_CODES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'TRANSLATE_TIMEOUT', 'TRANSLATE_FAILED', 'TRANSLATE_UNPARSABLE', 'TRANSLATE_EMPTY', 'TRANSLATE_TOO_LONG', 'TRANSLATION_TOO_LARGE', 'RUN_ENDED', 'RUN_CANCELLED', 'TRANSLATE_RUNNING', 'TRANSLATION_DONE', 'TRANSLATION_STALE'] as const;
type KnownCode = (typeof KNOWN_CODES)[number];
const knownCode = (code: unknown): KnownCode | 'default' => ((KNOWN_CODES as readonly string[]).includes(code as string) ? (code as KnownCode) : 'default');

// Only what the panel shows: the status and the member's parts (not the summary's own reads, which are audited).
const refresh = () => Promise.all([queryClient.refetchQueries({ queryKey: orpc.meetings.translation.transcriptStatus.key() }), queryClient.refetchQueries({ queryKey: orpc.meetings.translation.transcriptGet.key() })]);

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
  const status = useQuery({ ...orpc.meetings.translation.transcriptStatus.queryOptions({ input: { meetingId } }), refetchOnWindowFocus: false });
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'meetings' } }), staleTime: 15_000 });
  // On while this page goes on from one batch to the next; off at the end, at a failure, at a refusal and at the member's stop.
  const [auto, setAuto] = useState(false);
  const lastRemaining = useRef<number | null>(null);
  const translate = useMutation({
    mutationFn: () => orpc.meetings.translation.transcriptTranslate.call({ meetingId }),
    // The mutation stays pending until the status is read again, so the screen never shows the state before the batch that just ended.
    onSuccess: refresh,
    // A refusal ends the loop and the status is read again (a run of the member's that is live shows as running there, and the panel waits for it through the status).
    onError: () => {
      setAuto(false);
      void refresh();
    },
  });
  const stop = useMutation({
    mutationFn: () => orpc.meetings.translation.transcriptStop.call({ meetingId }),
    onSuccess: () => {
      setAuto(false);
      return refresh();
    },
  });
  const data = status.data;
  const last = translate.data;
  // The next batch, while the one before it kept parts and lines are left. A batch that kept nothing more ends the loop, so a model that keeps skipping lines costs one request, not many.
  useEffect(() => {
    if (!auto || translate.isPending || stop.isPending || !last) return;
    if (last.state === 'failed' || last.remaining === 0 || (lastRemaining.current !== null && last.remaining >= lastRemaining.current)) {
      setAuto(false);
      return;
    }
    lastRemaining.current = last.remaining;
    translate.mutate();
  }, [auto, translate, stop.isPending, last]);
  // Nothing to show before the server has answered; a deployment without Meetings has no status data, so no panel at all.
  if (!data) return null;
  const blocked = translateBlocked(data, meter.data);
  const running = translate.isPending || auto || data.state === 'running';
  const label = data.to === 'en' ? t('toEnglish') : t('toVietnamese');
  const begun = data.translated > 0 || data.stale > 0;
  const finished = begun && data.remaining === 0;
  const cost = data.estimate?.cost ?? null;
  const calls = data.estimate?.calls ?? 0;
  const failureCode = last?.state === 'failed' ? last.errorCode : data.state === 'failed' ? data.errorCode : null;
  const failure = failureCode !== null && !running ? knownCode(failureCode) : null;
  const error = translate.error ?? stop.error;
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
          <Button
            size="sm"
            variant="outline"
            loading={stop.isPending}
            onClick={() => {
              setAuto(false);
              stop.mutate();
            }}
          >
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
            loading={translate.isPending}
            disabled={blocked !== null || translate.isPending}
            onClick={() => {
              stop.reset();
              translate.reset();
              lastRemaining.current = data.remaining;
              setAuto(true);
              translate.mutate();
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
      {failure && <ErrorText>{`${t('failed')} ${t(`codes.${failure}`)}`}</ErrorText>}
      {error && !running && <ErrorText>{knownCode(errorCode) !== 'default' ? t(`codes.${knownCode(errorCode) as KnownCode}`) : errorMessage(error)}</ErrorText>}
      <p className="text-xs text-muted-foreground">{t('private')}</p>
    </div>
  );
}
