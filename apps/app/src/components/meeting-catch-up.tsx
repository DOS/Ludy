// SPDX-License-Identifier: AGPL-3.0-only
// Catch-up box for a meeting reader who missed the meeting (#5130, L33):
//   - "Việc của bạn" (`yourItems`), built deterministically in code and shown even with AI off
//   - "Cập nhật nhanh cho tôi" (`write`), Vy's ephemeral cited lines over published minutes only, scrolling smoothly to cited decisions/items.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { CatchUpAnswer, CatchUpCitation, CatchUpStatus } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const CATCH_UP_RUN_CODES = [
  'CATCH_UP_UNPARSABLE',
  'CATCH_UP_TIMEOUT',
  'CATCH_UP_FAILED',
  'CATCH_UP_OFF',
  'CATCH_UP_BUSY',
  'CATCH_UP_NOT_PUBLISHED',
  'CATCH_UP_REDACTED',
  'AI_BUDGET_EXHAUSTED',
  'AI_STOPPED',
  'VY_NOT_ALLOWED',
  'VY_RUN_BUSY',
] as const;

export const catchUpRunCodeOf = (code: string | null): (typeof CATCH_UP_RUN_CODES)[number] | 'default' =>
  CATCH_UP_RUN_CODES.find((c) => c === code) ?? 'default';

function scrollToCatchUpTarget(elementId: string): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(elementId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (el instanceof HTMLElement) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }
}

export function catchUpAnchorId(cite: CatchUpCitation): string {
  return cite.kind === 'decision' ? `meeting-decision-${cite.index}` : `meeting-action-${cite.itemId}`;
}

export function CatchUpResult({ answer }: { answer: CatchUpAnswer }) {
  const t = useTranslations('meetings.catchUp');
  if (answer.state === 'failed') {
    return <ErrorText>{`${t('failed')} ${t(`codes.${catchUpRunCodeOf(answer.errorCode)}`)}`}</ErrorText>;
  }
  if (answer.state === 'none') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="catch-up-empty">
        {t('empty')}
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="catch-up-result">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{t('fromVy')}</Badge>
        <span>{t('taintedNote')}</span>
      </p>
      <ul className="space-y-2" data-testid="catch-up-lines">
        {answer.lines.map((line, idx) => (
          <li key={`${idx}-${line.cite.kind === 'decision' ? line.cite.index : line.cite.itemId}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{line.text}</span>
            <button
              type="button"
              data-testid="catch-up-cite"
              aria-label={`${t('citeJumpLabel')}: ${line.cite.kind === 'decision' ? t('citeDecision', { index: String(line.cite.index) }) : t('citeItem')}`}
              onClick={() => scrollToCatchUpTarget(catchUpAnchorId(line.cite))}
              className="inline-flex min-h-11 items-center rounded border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {line.cite.kind === 'decision' ? t('citeDecision', { index: String(line.cite.index) }) : t('citeItem')}
            </button>
          </li>
        ))}
      </ul>
      {answer.dropped > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="catch-up-dropped">
          {t('dropped', { count: answer.dropped })}
        </p>
      )}
    </div>
  );
}

/** Reader-only catch-up panel showing code-built "Việc của bạn" and Vy's cited summary. */
export function MeetingCatchUp({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.catchUp');
  const statusQuery = useQuery(orpc.meetings.catchUp.status.queryOptions({ input: { meetingId } }));
  const run = useMutation({ mutationFn: () => orpc.meetings.catchUp.write.call({ meetingId }) });
  const status: CatchUpStatus | undefined = statusQuery.data;
  if (!status) return null;
  if (status.reason === 'is_recorder') {
    return (
      <section className="space-y-2 rounded-lg border p-3" data-testid="meeting-catch-up" aria-label={t('title')}>
        <p className="text-xs text-muted-foreground" data-testid="catch-up-recorder-note">
          {t('recorderOnlyNote')}
        </p>
      </section>
    );
  }
  if (status.reason === 'not_published' || status.reason === 'redacted') return null;

  const hasYourItems = status.yourItems.length > 0;
  const showBlockedNote = !status.available && (status.reason === 'forbidden' || status.reason === 'paused' || status.reason === 'budget');
  if (!hasYourItems && !status.available && !showBlockedNote) return null;

  const answer = run.data;
  const totalEstimateTokens = status.estimate ? status.estimate.inputTokens + status.estimate.outputTokens : null;

  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid="meeting-catch-up" aria-label={t('title')}>
      <h3 className="text-sm font-medium">{t('title')}</h3>

      {hasYourItems && (
        <div className="space-y-2" data-testid="catch-up-your-items">
          <div className="space-y-0.5">
            <h4 className="text-xs font-medium text-muted-foreground">{t('yourItemsTitle')}</h4>
            <p className="text-xs text-muted-foreground">{t('yourItemsHint')}</p>
          </div>
          <ul className="divide-y">
            {status.yourItems.map((item) => (
              <li key={item.itemId} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                <button
                  type="button"
                  onClick={() => scrollToCatchUpTarget(`meeting-action-${item.itemId}`)}
                  className="inline-flex min-h-11 items-center text-left font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {item.title}
                </button>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {item.who && <span>{item.who}</span>}
                  {(item.whenDate ?? item.when) && <span>{item.whenDate ?? item.when}</span>}
                  <Badge variant={item.status === 'accepted' ? 'default' : 'secondary'}>
                    {t(item.status === 'accepted' ? 'itemAccepted' : 'itemSuggested')}
                  </Badge>
                  {item.matchedBy === 'name' && <Badge variant="outline">{t('matchedByName')}</Badge>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status.available && (
        <div className="space-y-2" data-testid="catch-up-vy">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={run.isPending}
              disabled={run.isPending}
              onClick={() => run.mutate()}
              data-testid="catch-up-button"
            >
              {answer ? t('restart') : t('button')}
            </Button>
            {status.estimate && totalEstimateTokens !== null && (
              <span className="text-xs text-muted-foreground" data-testid="catch-up-estimate">
                {status.estimate.cost !== null
                  ? t('estimateCost', { tokens: String(totalEstimateTokens), cost: status.estimate.cost })
                  : t('estimateTokens', { tokens: String(totalEstimateTokens) })}
              </span>
            )}
          </div>
          <div role="status" aria-live="polite" className="space-y-2 empty:mb-0" data-testid="catch-up-live">
            {run.isPending && <p className="text-xs text-muted-foreground">{t('running')}</p>}
            {run.error && <ErrorText>{errorMessage(run.error)}</ErrorText>}
            {answer && <CatchUpResult answer={answer} />}
          </div>
        </div>
      )}

      {showBlockedNote && (
        <p className="text-xs text-muted-foreground" data-testid="catch-up-blocked">
          {t(status.reason === 'forbidden' ? 'blockedForbidden' : status.reason === 'paused' ? 'blockedPaused' : 'blockedBudget')}
        </p>
      )}
    </section>
  );
}
