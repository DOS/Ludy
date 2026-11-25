// SPDX-License-Identifier: AGPL-3.0-only
// Sales call insights for a meeting linked to an open deal (#4920, L26): shown only to the recorder when the meeting is linked to an open deal and has a transcript.
// One click runs the recorder's own Vy once to extract customer concerns, buying signals, and agreed next steps with owners, each backed by clickable line citations
// jumping to the transcript line, plus code-computed customer talk-time share from mapped speakers. Nothing is saved or written back to the deal.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { SalesInsightAnswer, SalesInsightCitation, SalesInsightItem, SalesInsightNextStep, SalesInsightStatus } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const RUN_CODES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'SUMMARY_OFF', 'SALES_INSIGHT_TIMEOUT', 'SALES_INSIGHT_FAILED', 'SALES_INSIGHT_TOO_LONG', 'SALES_INSIGHT_NO_TRANSCRIPT', 'SALES_INSIGHT_BUSY'] as const;
export const salesInsightRunCodeOf = (code: string | null): (typeof RUN_CODES)[number] | 'default' => RUN_CODES.find((c) => c === code) ?? 'default';

const STATUS_DISABLED_REASONS = ['off', 'paused', 'budget', 'forbidden'] as const;
type DisabledStatusReason = (typeof STATUS_DISABLED_REASONS)[number];
const isDisabledStatusReason = (reason: SalesInsightStatus['reason']): reason is DisabledStatusReason =>
  reason !== null && (STATUS_DISABLED_REASONS as readonly string[]).includes(reason);

export function MeetingSalesInsight({ meetingId, isRecorder, hasTranscript, onJump }: { meetingId: string; isRecorder: boolean; hasTranscript: boolean; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.salesInsight');
  const status = useQuery({ ...orpc.meetings.salesInsight.status.queryOptions({ input: { meetingId } }), enabled: isRecorder && hasTranscript });
  const run = useMutation({ mutationFn: () => orpc.meetings.salesInsight.analyze.call({ meetingId }) });

  if (!isRecorder || !hasTranscript || !status.data?.available) return null;

  const deal = status.data.deal;
  const answer = run.data;
  const disabledReason = !status.data.enabled && isDisabledStatusReason(status.data.reason) ? status.data.reason : null;

  return (
    <Card data-testid="meeting-sales-insight" aria-labelledby="sales-insight-heading">
      <CardHeader>
        <CardTitle id="sales-insight-heading" role="heading" aria-level={2} className="text-base font-medium">
          {t('title')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          {deal ? t('descDeal', { deal: deal.title, stage: deal.stage || t('stageFallback') }) : t('desc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={answer ? 'outline' : 'default'}
            className="min-h-11"
            loading={run.isPending}
            disabled={run.isPending || !status.data.enabled}
            aria-label={answer ? t('restart') : t('button')}
            onClick={() => run.mutate()}
            data-testid="sales-insight-run"
          >
            {answer ? t('restart') : t('button')}
          </Button>
        </div>

        {disabledReason && (
          <p className="text-xs text-muted-foreground" role="note" data-testid="sales-insight-disabled-reason">
            {t(`statusReasons.${disabledReason}`)}
          </p>
        )}

        <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
          {run.isPending && <p className="text-xs">{t('running')}</p>}
          {answer?.state === 'ready' && !run.isPending && (
            <p className="sr-only">
              {t('found', { concerns: answer.concerns.length, signals: answer.buyingSignals.length, steps: answer.nextSteps.length })}
            </p>
          )}
          {answer?.state === 'none' && !run.isPending && <p className="sr-only">{t('none')}</p>}
        </div>

        {run.error && <ErrorText>{errorMessage(run.error)}</ErrorText>}
        {answer && !run.isPending && <SalesInsightResult answer={answer} onJump={onJump} />}
      </CardContent>
    </Card>
  );
}

export function SalesInsightResult({ answer, onJump }: { answer: SalesInsightAnswer; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.salesInsight');
  if (answer.state === 'off' || answer.state === 'paused' || answer.state === 'budget' || answer.state === 'failed') {
    return (
      <div data-testid="sales-insight-failed">
        <ErrorText>{`${t('failed')} ${t(`codes.${salesInsightRunCodeOf(answer.errorCode)}`)}`}</ErrorText>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3" data-testid="sales-insight-answer">
      <div className="rounded bg-muted/50 px-2.5 py-2 text-xs" data-testid="sales-insight-talk-share">
        {answer.customerTalkShare ? (
          <p>
            <span className="font-medium text-foreground">
              {t('talkShareMapped', {
                customer: String(answer.customerTalkShare.customerPercent),
                internal: String(answer.customerTalkShare.internalPercent),
              })}
            </span>{' '}
            <span className="text-muted-foreground">
              {t('talkShareSpeakers', {
                speakers: answer.customerTalkShare.customerSpeakers.join(', '),
                duration: clock(answer.customerTalkShare.customerSeconds),
                total: clock(answer.customerTalkShare.totalSeconds),
              })}
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground">{t('talkShareUnmapped')}</p>
        )}
      </div>

      {answer.state === 'none' ? (
        <p className="text-sm text-muted-foreground" data-testid="sales-insight-none">
          {t('none')}
        </p>
      ) : (
        <div className="space-y-3">
          <InsightSection sectionKey="concerns" items={answer.concerns} onJump={onJump} />
          <InsightSection sectionKey="buyingSignals" items={answer.buyingSignals} onJump={onJump} />
          <NextStepsSection items={answer.nextSteps} onJump={onJump} />
        </div>
      )}

      {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{t('dropped', { count: String(answer.dropped) })}</p>}
      <p className="text-xs text-muted-foreground">{t('private')}</p>
    </div>
  );
}

export function CitationChipButton({
  lineId,
  seconds,
  timeLabel,
  jumpLabel,
  onJump,
}: {
  lineId: string;
  seconds: number;
  timeLabel: string;
  jumpLabel: string;
  onJump: (seconds: number) => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-border bg-background px-2 font-mono text-xs text-link underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={jumpLabel}
      aria-label={jumpLabel}
      onClick={() => onJump(seconds)}
      data-testid="sales-insight-citation"
      data-line-id={lineId}
    >
      {timeLabel}
    </button>
  );
}

function CitationChips({ citations, onJump }: { citations: readonly SalesInsightCitation[]; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.salesInsight');
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {citations.map((c) => {
        const label = clock(c.seconds);
        return <CitationChipButton key={c.lineId} lineId={c.lineId} seconds={c.seconds} timeLabel={label} jumpLabel={t('open', { time: label })} onJump={onJump} />;
      })}
    </span>
  );
}

function InsightSection({ sectionKey, items, onJump }: { sectionKey: 'concerns' | 'buyingSignals'; items: readonly SalesInsightItem[]; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.salesInsight');
  if (items.length === 0) return null;
  return (
    <section className="space-y-1.5" aria-labelledby={`sales-insight-${sectionKey}`} data-testid={`sales-insight-${sectionKey}`}>
      <h3 id={`sales-insight-${sectionKey}`} className="text-sm font-semibold">
        {t(`sections.${sectionKey}`)}
      </h3>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={`${sectionKey}-${index}`} className="flex flex-wrap items-center gap-2 text-sm" data-testid="sales-insight-item">
            <span>{item.text}</span>
            <CitationChips citations={item.citations} onJump={onJump} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextStepsSection({ items, onJump }: { items: readonly SalesInsightNextStep[]; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.salesInsight');
  if (items.length === 0) return null;
  return (
    <section className="space-y-1.5" aria-labelledby="sales-insight-nextSteps" data-testid="sales-insight-nextSteps">
      <h3 id="sales-insight-nextSteps" className="text-sm font-semibold">
        {t('sections.nextSteps')}
      </h3>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={`nextSteps-${index}`} className="flex flex-wrap items-center gap-2 text-sm" data-testid="sales-insight-item">
            <span>{item.text}</span>
            {item.owner && (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground" data-testid="sales-insight-owner">
                {t('ownerLabel', { owner: item.owner })}
              </span>
            )}
            <CitationChips citations={item.citations} onJump={onJump} />
          </li>
        ))}
      </ul>
    </section>
  );
}
