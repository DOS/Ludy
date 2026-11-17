// SPDX-License-Identifier: AGPL-3.0-only
// "Hỏi về các cuộc họp" (Meetings A3, #3161): a box above the meetings list. The member types a question; their own Vy answers from the transcript lines the member's own search finds (the
// meetings they read only, at most 40 lines from 8 meetings), and every sentence carries a chip that opens the transcript at the line it rests on. Code checked each sentence before it got
// here (a citation must be a line that was sent, a quote must be in its line, a figure must be written in it); this screen only shows what the server kept. The answer is the member's alone
// and is never stored: it lives in this component's state until the member clears it or leaves. With Vy unavailable (no model, paused, budget spent, no right to work with Vy) the same box
// searches the transcripts for the question's main words and shows the plain hit list, so the core works with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { ASK_QUESTION_MAX, ASK_QUESTION_MIN, askKeywords, type AskAnswer, type AskStatus, type MeetingSearchHit } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { SearchResults } from './meeting-search.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const READ_ONCE = { staleTime: 60_000, refetchOnWindowFocus: false } as const;
const KNOWN_FAILURES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'ASK_TIMEOUT', 'ASK_FAILED', 'ASK_UNPARSABLE', 'ASK_TOO_LONG', 'ASK_NOTHING', 'ASK_BUSY'] as const;
// The most of the AI budget that may be left before the box says it is running low.
const LOW_PERCENT_LEFT = 15;

// Why the question cannot go to Vy now, as a key under `meetings.ask.blocked`, or null when it can. The status is the server's (the switch, the member's right to work with Vy, a kill
// switch, a spent budget of the org or the meetings module); the meter is the org's own (aiOn false: no model on this system; state stop: a budget that covers meetings is spent).
export function askBlocked(status: Pick<AskStatus, 'enabled' | 'reason'> | undefined, meter: { aiOn: boolean; state: 'none' | 'ok' | 'warn' | 'stop' } | undefined): 'off' | 'forbidden' | 'paused' | 'budget' | 'noModel' | null {
  if (!status) return 'off';
  if (!status.enabled) return status.reason ?? 'off';
  if (meter && !meter.aiOn) return 'noModel';
  if (meter && meter.state === 'stop') return 'budget';
  return null;
}

// How a fixed code of a failed answer reads: the codes this screen knows, else the general words.
export function failureKey(code: string | null): (typeof KNOWN_FAILURES)[number] | 'default' {
  return (KNOWN_FAILURES as readonly string[]).includes(code ?? '') ? (code as (typeof KNOWN_FAILURES)[number]) : 'default';
}

// The chip under a sentence: the meeting, its date and the time of the line it rests on; it opens the transcript at that line.
function Chip({ slug, source }: { slug: string; source: MeetingSearchHit }) {
  const t = useTranslations('meetings.ask');
  const f = useFormat();
  return (
    <Link
      to="/o/$slug/meetings/$id"
      params={{ slug, id: source.meetingId }}
      search={{ seg: source.segmentId }}
      className="inline-flex max-w-full items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted/70 focus-visible:bg-muted/70"
      data-testid="meeting-ask-chip"
    >
      <span className="min-w-0 break-words">{t('chip', { title: source.meetingTitle, date: f.date(source.heldAt), time: clock(source.startSeconds) })}</span>
    </Link>
  );
}

function HitList({ slug, hits, typed }: { slug: string; hits: MeetingSearchHit[]; typed: string }) {
  return <SearchResults slug={slug} result={{ hits, hasMore: false, capped: false }} typed={typed} page={1} onPage={() => undefined} />;
}

// The answer, from the server's answer alone: the sentences with their chips, or "nothing found" with the plain hit list, or the fixed words of a failure with the same list.
export function AskResult({ slug, answer, typed }: { slug: string; answer: AskAnswer; typed: string }) {
  const t = useTranslations('meetings.ask');
  if (answer.state === 'answered') {
    return (
      <div className="space-y-3 rounded-lg border border-border bg-card p-3" data-testid="meeting-ask-answer">
        <p className="text-sm font-semibold">{t('answerTitle')}</p>
        <ol className="space-y-3">
          {answer.sentences.map((sentence, index) => (
            <li key={index} className="space-y-1" data-testid="meeting-ask-sentence">
              <p className="whitespace-pre-wrap text-sm">{sentence.text}</p>
              <div className="flex flex-wrap gap-1">
                {sentence.sources.map((place) => {
                  const source = answer.sources[place];
                  return source ? <Chip key={`${index}-${place}`} slug={slug} source={source} /> : null;
                })}
              </div>
            </li>
          ))}
        </ol>
        {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{t('dropped', { count: String(answer.dropped) })}</p>}
        <p className="text-xs text-muted-foreground">{t('private')}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid={answer.state === 'failed' ? 'meeting-ask-failed' : 'meeting-ask-none'}>
      {answer.state === 'failed' ? <ErrorText>{`${t('failed')} ${t(`codes.${failureKey(answer.errorCode)}`)}`}</ErrorText> : <p className="text-sm font-medium">{t('none')}</p>}
      {answer.hits.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">{t('noneHits')}</p>
          <HitList slug={slug} hits={answer.hits} typed={typed} />
        </>
      )}
    </div>
  );
}

export function MeetingAsk({ slug }: { slug: string }) {
  const t = useTranslations('meetings.ask');
  const f = useFormat();
  const status = useQuery({ ...orpc.meetings.ask.status.queryOptions({ input: {} }), ...READ_ONCE });
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'meetings' } }), staleTime: 15_000 });
  const [text, setText] = useState('');
  const [tooShort, setTooShort] = useState(false);
  // What was asked, for the highlight of the plain hit list and the plain search when Vy cannot be asked.
  const [asked, setAsked] = useState<string | null>(null);
  const [plain, setPlain] = useState<string | null>(null);
  const ask = useMutation({ mutationFn: (question: string): Promise<AskAnswer> => orpc.meetings.ask.ask.call({ question }) });
  const search = useQuery({
    ...orpc.meetings.search.queryOptions({ input: { q: plain ?? '-', limit: 20, offset: 0 } }),
    enabled: plain !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const blocked = askBlocked(status.data, meter.data);
  const cost = status.data?.estimate?.cost ?? null;
  const tokens = status.data?.estimate ? status.data.estimate.inputTokens + status.data.estimate.outputTokens : null;
  const left = meter.data?.percent != null ? Math.max(0, 100 - meter.data.percent) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const question = text.trim();
    if (question.length < ASK_QUESTION_MIN) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    setAsked(question);
    if (blocked === null) {
      setPlain(null);
      ask.mutate(question);
    } else {
      // Vy cannot be asked: the same words, as a plain search of the transcripts the member reads (no model, nothing to approve).
      ask.reset();
      const words = askKeywords(question, 3).join(' ');
      setPlain(words.length >= 2 ? words : question.slice(0, 200));
    }
  };
  const clear = () => {
    ask.reset();
    setAsked(null);
    setPlain(null);
    setText('');
    setTooShort(false);
  };

  // Nothing to show before the server has answered (a deployment whose API does not know the box would show nothing, not a broken form).
  if (!status.data) return null;
  return (
    <section className="space-y-3" aria-labelledby="meeting-ask-label" data-testid="meeting-ask">
      <form className="space-y-2" onSubmit={submit}>
        <div className="max-w-2xl space-y-1">
          <Label id="meeting-ask-label" htmlFor="meeting-ask-input">
            {t('label')}
          </Label>
          <Textarea id="meeting-ask-input" aria-describedby="meeting-ask-hint" rows={2} maxLength={ASK_QUESTION_MAX} placeholder={t('placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={ask.isPending || (plain !== null && search.isFetching)} disabled={ask.isPending}>
            {blocked === null ? t('submit') : t('submitSearch')}
          </Button>
          {asked !== null && (
            <Button type="button" variant="ghost" onClick={clear}>
              {t('clear')}
            </Button>
          )}
          {blocked !== null && (
            <span className="text-xs text-muted-foreground" role="status" data-testid="meeting-ask-blocked">
              {t(`blocked.${blocked}`)}
            </span>
          )}
          {blocked === null && cost !== null && <span className="text-xs text-muted-foreground">{t('estimate', { cost: f.aiAmount(cost) })}</span>}
          {blocked === null && cost === null && tokens !== null && <span className="text-xs text-muted-foreground">{t('estimateTokens', { tokens: f.number(tokens) })}</span>}
          {blocked === null && left !== null && (
            <span className={left <= LOW_PERCENT_LEFT ? 'text-xs text-warning' : 'text-xs text-muted-foreground'} data-testid="meeting-ask-budget">
              {t(left <= LOW_PERCENT_LEFT ? 'budgetLow' : 'budgetLeft', { left: String(left) })}
            </span>
          )}
        </div>
      </form>
      <p id="meeting-ask-hint" className="text-xs text-muted-foreground">
        {t('hint')}
      </p>
      <div aria-live="polite" className="space-y-2">
        {tooShort && <ErrorText>{t('tooShort', { min: String(ASK_QUESTION_MIN) })}</ErrorText>}
        {ask.isPending && <p className="text-xs">{t('running')}</p>}
        {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
        {ask.data && asked !== null && <AskResult slug={slug} answer={ask.data} typed={askKeywords(asked, 6).join(' ')} />}
        {plain !== null && asked !== null && (
          <div className="space-y-2" data-testid="meeting-ask-plain">
            <p className="text-xs text-muted-foreground">{t('searchNote', { words: plain })}</p>
            {search.error && <ErrorText>{errorMessage(search.error)}</ErrorText>}
            {search.data && <SearchResults slug={slug} result={search.data} typed={plain} page={1} onPage={() => undefined} />}
          </div>
        )}
      </div>
    </section>
  );
}
