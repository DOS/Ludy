// SPDX-License-Identifier: AGPL-3.0-only
// "Hỏi về cuộc họp này" (#4815): the question box of one meeting's page. It is the box above the meetings list (meeting-ask.tsx, A3 #3161) limited to this meeting: the member's own Vy answers from
// the transcript lines of THIS meeting that the member reads (the same row security, so a reader sees only the published lines), every sentence carries the time of the line it rests on and a click
// takes the transcript there. Code checked each sentence before it got here; this screen shows what the server kept, and the answer lives only in this component's state. With Vy unavailable the same
// box lists the lines of this meeting that hold the question's main words, so the core works with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { ASK_QUESTION_MAX, ASK_QUESTION_MIN, type AskAnswer, type MeetingSearchHit } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Label } from '@ludy/ui/components/label';
import { Textarea } from '@ludy/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { askBlocked, failureKey } from './meeting-ask.tsx';
import { clock } from './meeting-transcript.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const READ_ONCE = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

// A time that takes the transcript to a line: the visible time is the button's name, and the target is 44 px high on a phone.
function TimeButton({ line, onJump }: { line: MeetingSearchHit; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.askThis');
  return (
    <button
      type="button"
      className="inline-flex min-h-8 items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 max-md:min-h-11"
      aria-label={t('open', { time: clock(line.startSeconds) })}
      onClick={() => onJump(line.startSeconds)}
      data-testid="ask-this-time"
    >
      {clock(line.startSeconds)}
    </button>
  );
}

// The lines the plain search of this meeting found (no model), each with its time.
function PlainLines({ lines, onJump }: { lines: readonly MeetingSearchHit[]; onJump: (seconds: number) => void }) {
  return (
    <ul className="space-y-2" data-testid="ask-this-plain-list">
      {lines.map((line) => (
        <li key={line.segmentId} className="flex flex-wrap items-start gap-2 text-sm">
          <TimeButton line={line} onJump={onJump} />
          <span className="min-w-0 flex-1 break-words">{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

// The answer, from the server's answer alone: the sentences with the times they rest on, or "nothing found" with the plain lines, or the fixed words of a failure with the same lines.
export function AskThisResult({ answer, onJump }: { answer: AskAnswer; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.askThis');
  const ta = useTranslations('meetings.ask');
  if (answer.state === 'answered') {
    return (
      <div className="space-y-3 rounded-lg border border-border bg-card p-3" data-testid="ask-this-answer">
        <p className="text-sm font-semibold">{ta('answerTitle')}</p>
        <ol className="space-y-3">
          {answer.sentences.map((sentence, index) => (
            <li key={index} className="space-y-1" data-testid="ask-this-sentence">
              <p className="whitespace-pre-wrap text-sm">{sentence.text}</p>
              <div className="flex flex-wrap gap-1">
                {sentence.sources.map((place) => {
                  const source = answer.sources[place];
                  return source ? <TimeButton key={`${index}-${place}`} line={source} onJump={onJump} /> : null;
                })}
              </div>
            </li>
          ))}
        </ol>
        {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{ta('dropped', { count: String(answer.dropped) })}</p>}
        <p className="text-xs text-muted-foreground">{t('private')}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid={answer.state === 'failed' ? 'ask-this-failed' : 'ask-this-none'}>
      {answer.state === 'failed' ? <ErrorText>{`${ta('failed')} ${ta(`codes.${failureKey(answer.errorCode)}`)}`}</ErrorText> : <p className="text-sm font-medium">{t('none')}</p>}
      {answer.hits.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">{ta('noneHits')}</p>
          <PlainLines lines={answer.hits} onJump={onJump} />
        </>
      )}
    </div>
  );
}

export function MeetingAskThis({ meetingId, hasTranscript, onJump }: { meetingId: string; hasTranscript: boolean; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.askThis');
  const ta = useTranslations('meetings.ask');
  const f = useFormat();
  const status = useQuery({ ...orpc.meetings.ask.status.queryOptions({ input: {} }), ...READ_ONCE, enabled: hasTranscript });
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'meetings' } }), staleTime: 15_000, enabled: hasTranscript });
  const [text, setText] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  // The question of a plain search, when Vy cannot be asked.
  const [plain, setPlain] = useState<string | null>(null);
  const ask = useMutation({ mutationFn: (question: string): Promise<AskAnswer> => orpc.meetings.ask.ask.call({ question, meetingId }) });
  const lines = useQuery({
    ...orpc.meetings.ask.lines.queryOptions({ input: { question: plain ?? '------', meetingId } }),
    enabled: plain !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const blocked = askBlocked(status.data, meter.data);
  const cost = status.data?.estimate?.cost ?? null;

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
      // Vy cannot be asked: the lines of this meeting that hold the question's main words (no model, nothing to approve).
      ask.reset();
      setPlain(question);
    }
  };
  const clear = () => {
    ask.reset();
    setAsked(null);
    setPlain(null);
    setText('');
    setTooShort(false);
  };

  // A meeting with no transcript has nothing to ask about, and nothing shows before the server has answered.
  if (!hasTranscript || !status.data) return null;
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-labelledby="ask-this-label" data-testid="meeting-ask-this">
      <form className="space-y-2" onSubmit={submit}>
        <div className="max-w-2xl space-y-1">
          <Label id="ask-this-label" htmlFor="ask-this-input">
            {t('label')}
          </Label>
          <Textarea id="ask-this-input" aria-describedby="ask-this-hint" rows={2} maxLength={ASK_QUESTION_MAX} placeholder={t('placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={ask.isPending || (plain !== null && lines.isFetching)} disabled={ask.isPending}>
            {blocked === null ? ta('submit') : t('submitSearch')}
          </Button>
          {asked !== null && (
            <Button type="button" variant="ghost" onClick={clear}>
              {ta('clear')}
            </Button>
          )}
          {blocked !== null && (
            <span className="text-xs text-muted-foreground" role="status" data-testid="ask-this-blocked">
              {ta(`blocked.${blocked}`)}
            </span>
          )}
          {blocked === null && cost !== null && <span className="text-xs text-muted-foreground">{ta('estimate', { cost: f.aiAmount(cost) })}</span>}
        </div>
      </form>
      <p id="ask-this-hint" className="text-xs text-muted-foreground">
        {t('hint')}
      </p>
      <div aria-live="polite" className="space-y-2">
        {tooShort && <ErrorText>{ta('tooShort', { min: String(ASK_QUESTION_MIN) })}</ErrorText>}
        {ask.isPending && <p className="text-xs">{ta('running')}</p>}
        {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
        {ask.data && asked !== null && <AskThisResult answer={ask.data} onJump={onJump} />}
        {plain !== null && asked !== null && (
          <div className="space-y-2" data-testid="ask-this-plain">
            <p className="text-xs text-muted-foreground">{t('plainNote')}</p>
            {lines.error && <ErrorText>{errorMessage(lines.error)}</ErrorText>}
            {lines.data && (lines.data.lines.length === 0 ? <p className="text-sm font-medium">{t('none')}</p> : <PlainLines lines={lines.data.lines} onJump={onJump} />)}
          </div>
        )}
      </div>
    </section>
  );
}
