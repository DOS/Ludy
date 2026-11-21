// SPDX-License-Identifier: AGPL-3.0-only
// "Cuộc họp đã bàn đủ chưa?" (#3959): after a meeting with a transcript, the recorder sees the agenda it was meant to follow (the open items of the previous meeting of its series, which code reads and which work with
// AI off, plus up to eight lines the recorder types here) and may click once to have their own Vy compare it with the transcript. For each agenda line the answer is "covered", with the transcript lines (their time and
// words) that show it, or "not heard". Code checked every claim before it got here: a "covered" line cites transcript lines that exist, and one without such a line was already turned into "not heard". There is no
// score and nothing about a person; the answer lives only in this component's state and is never stored. A cited line opens the transcript at its time.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { ADHERENCE_LINE_CHARS, ADHERENCE_TYPED_MAX, type AdherenceAnswer, type AdherenceStatus } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { askBlocked } from './meeting-ask.tsx';
import { clock } from './meeting-transcript.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

// Reading the agenda is a sensitive read that leaves an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
const KNOWN_FAILURES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'ADHERENCE_TIMEOUT', 'ADHERENCE_FAILED', 'ADHERENCE_UNPARSABLE', 'ADHERENCE_TOO_LONG', 'ADHERENCE_NOTHING', 'ADHERENCE_BUSY'] as const;

// How a fixed code of a failed answer reads: the codes this screen knows, else the general words.
export function adherenceFailureKey(code: string | null): (typeof KNOWN_FAILURES)[number] | 'default' {
  return (KNOWN_FAILURES as readonly string[]).includes(code ?? '') ? (code as (typeof KNOWN_FAILURES)[number]) : 'default';
}

const nonEmptyLines = (text: string): string[] =>
  text
    .split(/\r?\n/u)
    .map((line) => Array.from(line.trim()).slice(0, ADHERENCE_LINE_CHARS).join(''))
    .filter((line) => line !== '');

/** The lines the recorder typed, as they are sent: one per line, trimmed, empty ones dropped, each cut at the limit, at most eight. */
export function typedLines(text: string): string[] {
  return nonEmptyLines(text).slice(0, ADHERENCE_TYPED_MAX);
}

/** Whether more lines were typed than are sent (the ninth and the rest are left out), so the box can say so. */
export const typedOverflow = (text: string): boolean => nonEmptyLines(text).length > ADHERENCE_TYPED_MAX;

// The server's reason with the recorder's own one folded into "off" (only the recorder is shown this card), in the shape the shared blocked text knows.
const asAsk = (status: AdherenceStatus) => ({ enabled: status.enabled, reason: status.reason === 'not_recorder' ? ('off' as const) : status.reason });

export function MeetingAdherence({ meetingId, isRecorder, onJump }: { meetingId: string; isRecorder: boolean; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.adherence');
  const [text, setText] = useState('');
  const agenda = useQuery({ ...orpc.meetings.adherence.agenda.queryOptions({ input: { meetingId } }), ...READ_ONCE, enabled: isRecorder });
  const data = agenda.data;
  // No card for a reader, and none while there is no transcript to check against.
  if (!isRecorder || !data || data.transcriptLines === 0) return null;
  const typed = typedLines(text);
  const lines = typed.length + data.items.length;
  return (
    <Card data-testid="meeting-adherence">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">{t('title')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('intro')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.items.length > 0 && (
          <div className="space-y-1" data-testid="adherence-open-items">
            <p className="text-sm font-medium">{data.previous ? t('fromPrevious', { title: data.previous.title }) : t('fromSeries')}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {data.items.map((item, index) => (
                <li key={index}>{item.text}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-1">
          <label htmlFor="adherence-typed" className="text-sm font-medium">
            {t('typedLabel', { max: String(ADHERENCE_TYPED_MAX) })}
          </label>
          <Textarea id="adherence-typed" value={text} onChange={(event) => setText(event.target.value)} rows={3} placeholder={t('typedPlaceholder')} aria-describedby="adherence-typed-hint" data-testid="adherence-typed" />
          <p id="adherence-typed-hint" className="text-xs text-muted-foreground">{t('typedHint', { chars: String(ADHERENCE_LINE_CHARS) })}</p>
          {/* Always in the page, filled when more than eight lines are typed: a status inserted with its text is often not announced (WCAG 4.1.3). */}
          <p className="text-xs text-muted-foreground empty:hidden" role="status" data-testid="adherence-typed-overflow-status">
            {typedOverflow(text) ? t('typedOverflow', { max: String(ADHERENCE_TYPED_MAX) }) : ''}
          </p>
        </div>
        {lines === 0 && <p className="text-xs text-muted-foreground" data-testid="adherence-no-agenda">{t('noAgenda')}</p>}
        {!data.transcriptFits && <p className="text-xs text-muted-foreground" data-testid="adherence-too-long">{t('transcriptTooLong')}</p>}
        {/* Keyed by the typed lines: an answer to other lines is gone as soon as they change, so the page never shows an answer beside a box it does not match. */}
        <Vy key={typed.join('\n')} meetingId={meetingId} typed={typed} ready={lines > 0 && data.transcriptFits} onJump={onJump} />
      </CardContent>
    </Card>
  );
}

// The click: absent when AI is off (no model, the deployment's switch, no right to work with Vy), so the agenda above is the whole card.
function Vy({ meetingId, typed, ready, onJump }: { meetingId: string; typed: string[]; ready: boolean; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.adherence');
  const ask = useTranslations('meetings.ask');
  const f = useFormat();
  const status = useQuery({ ...orpc.meetings.adherence.status.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'meetings' } }), staleTime: 15_000 });
  const check = useMutation({ mutationFn: (): Promise<AdherenceAnswer> => orpc.meetings.adherence.check.call({ meetingId, typed }) });
  if (!status.data) return null;
  const blocked = askBlocked(asAsk(status.data), meter.data);
  if (blocked === 'off' || blocked === 'noModel') return null;
  const cost = status.data.estimate?.cost ?? null;
  const tokens = status.data.estimate ? status.data.estimate.inputTokens + status.data.estimate.outputTokens : null;
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="adherence-vy">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" loading={check.isPending} disabled={!ready || blocked !== null || check.isPending} onClick={() => check.mutate()} data-testid="adherence-check">
          {t('submit')}
        </Button>
        {blocked !== null && (
          <span className="text-xs text-muted-foreground" role="status" data-testid="adherence-blocked">
            {ask(`blocked.${blocked}`)}
          </span>
        )}
        {blocked === null && cost !== null && <span className="text-xs text-muted-foreground">{t('estimate', { cost: f.aiAmount(cost) })}</span>}
        {blocked === null && cost === null && tokens !== null && <span className="text-xs text-muted-foreground">{t('estimateTokens', { tokens: f.number(tokens) })}</span>}
      </div>
      <div aria-live="polite" className="space-y-2">
        {check.isPending && <p className="text-xs">{t('running')}</p>}
        {check.error && <ErrorText>{errorMessage(check.error)}</ErrorText>}
        {check.data && <AdherenceResult answer={check.data} onJump={onJump} />}
      </div>
    </div>
  );
}

// The answer from the server's answer alone: each agenda line as it was given with "covered" and the transcript lines it cites, or "not heard"; or "nothing to check", or the fixed words of a failure.
export function AdherenceResult({ answer, onJump }: { answer: AdherenceAnswer; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.adherence');
  if (answer.state === 'checked') {
    return (
      <div className="space-y-3 rounded-lg border border-border bg-card p-3" data-testid="adherence-answer">
        <p className="text-sm font-semibold">{t('answerTitle')}</p>
        <ol className="space-y-3">
          {answer.items.map((item) => (
            <li key={item.n} className="space-y-1" data-testid="adherence-item">
              <p className="flex flex-wrap items-baseline gap-2 text-sm">
                <Badge variant={item.covered ? 'secondary' : 'outline'} data-testid={item.covered ? 'adherence-covered' : 'adherence-not-heard'}>
                  {item.covered ? t('covered') : t('notHeard')}
                </Badge>
                <span>{item.text}</span>
              </p>
              {item.cites.length > 0 && (
                <ul className="space-y-1 pl-2">
                  {item.cites.map((cite) => (
                    <li key={cite.n}>
                      <button type="button" className="flex w-full items-baseline gap-3 rounded px-1 py-1 text-left hover:bg-muted" title={t('jump')} onClick={() => onJump(cite.startSeconds)}>
                        <span className="font-mono text-xs text-muted-foreground">{clock(cite.startSeconds)}</span>
                        <span className="text-xs">{cite.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
        {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{t('dropped', { count: String(answer.dropped) })}</p>}
        <p className="text-xs text-muted-foreground">{t('private')}</p>
      </div>
    );
  }
  if (answer.state === 'failed') {
    return (
      <div data-testid="adherence-failed">
        <ErrorText>{`${t('failed')} ${t(`codes.${adherenceFailureKey(answer.errorCode)}`)}`}</ErrorText>
      </div>
    );
  }
  return (
    <p className="text-sm text-muted-foreground" data-testid="adherence-none">
      {t(`nothing.${answer.reason ?? 'no_agenda'}`)}
    </p>
  );
}
