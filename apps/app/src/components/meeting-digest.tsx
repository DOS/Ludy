// SPDX-License-Identifier: AGPL-3.0-only
// "Tuần này" (#3949, plan docs/plan/meetings.md §1 "the weekly job"): on the meetings page, what was decided in the meetings the member reads over the last 7, 14 or 30 days and what is still open, meeting by meeting.
// The facts are read by code as the member (a meeting they do not read, a draft result and a meeting past its text date show nothing) and work with AI off. Every fact is numbered and sits under the meeting
// it comes from, with a link. On top, one click has the member's own Vy write two or three sentences from those numbered facts: code checked each sentence before it got here (it must cite facts above and write
// no figure or date they do not hold), the answer lives only in this component's state and is never stored.
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { DIGEST_DAYS, briefItemDue, digestLines, vnDateOf, type DigestAnswer, type DigestAsk, type DigestFacts } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { askBlocked } from './meeting-ask.tsx';
import { memberLabel } from './meeting-results.tsx';
import { useMe } from './conversation-inbox.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

// Reading the facts is a sensitive read that leaves an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
const KNOWN_FAILURES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'DIGEST_TIMEOUT', 'DIGEST_FAILED', 'DIGEST_UNPARSABLE', 'DIGEST_TOO_LONG', 'DIGEST_NOTHING', 'DIGEST_BUSY'] as const;

// How a fixed code of a failed answer reads: the codes this screen knows, else the general words.
export function digestFailureKey(code: string | null): (typeof KNOWN_FAILURES)[number] | 'default' {
  return (KNOWN_FAILURES as readonly string[]).includes(code ?? '') ? (code as (typeof KNOWN_FAILURES)[number]) : 'default';
}

const FactNumber = ({ n }: { n: number }) => (
  <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted px-1 text-xs text-muted-foreground" aria-label={String(n)}>
    {n}
  </span>
);

export function MeetingDigest({ slug }: { slug: string }) {
  const t = useTranslations('meetings.digest');
  const [days, setDays] = useState<DigestAsk['days']>(7);
  // The card stays on screen while another window loads (the picker the member just used must not vanish).
  const facts = useQuery({ ...orpc.meetings.digest.facts.queryOptions({ input: { days } }), ...READ_ONCE, placeholderData: keepPreviousData });
  const data = facts.data;
  if (facts.error && !data) return <ErrorText>{errorMessage(facts.error)}</ErrorText>;
  // Nothing else is shown until the facts have been read.
  if (!data) return null;
  return (
    <Card data-testid="meeting-digest">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">
          {t('title')}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t('description')}</span>
          <NativeSelect aria-label={t('window')} value={String(days)} onChange={(e) => setDays(Number(e.target.value) as DigestAsk['days'])} data-testid="digest-window">
            {DIGEST_DAYS.map((d) => (
              <NativeSelectOption key={d} value={String(d)}>
                {t('days', { count: String(d) })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.empty ? (
          <>
            <p className="text-sm text-muted-foreground" data-testid="digest-nothing">
              {t('nothing', { count: String(days) })}
            </p>
            {data.cut && (
              <p className="text-xs text-muted-foreground" data-testid="digest-cut">
                {t('cut')}
              </p>
            )}
          </>
        ) : (
          <>
            <Meetings slug={slug} facts={data} />
            {data.cut && (
              <p className="text-xs text-muted-foreground" data-testid="digest-cut">
                {t('cut')}
              </p>
            )}
            <VyWords key={days} days={days} count={digestLines(data).length} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// The numbered facts, meeting by meeting: the number is the one a sentence of Vy cites (decisions, then open items, in the order `digestLines` numbers them).
function Meetings({ slug, facts }: { slug: string; facts: DigestFacts }) {
  const t = useTranslations('meetings.digest');
  const series = useTranslations('meetings.series');
  const { members } = useMe();
  let n = 0;
  return (
    <div className="space-y-4 text-sm">
      {facts.meetings.map((meeting) => (
        <section key={meeting.meetingId} className="space-y-1" data-testid="digest-meeting">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <Link to="/o/$slug/meetings/$id" params={{ slug, id: meeting.meetingId }} className="text-link underline" data-testid="digest-open-meeting">
              {meeting.title}
            </Link>
            <span className="text-xs font-normal text-muted-foreground">{vnDateOf(meeting.startedAt)}</span>
          </h3>
          <ol className="space-y-1">
            {meeting.decisions.map((decision, index) => (
              <li key={`d${index}`} className="flex gap-2" data-testid="digest-fact" data-kind="decision">
                <FactNumber n={(n += 1)} />
                <span>
                  <Badge variant="outline" className="mr-2">
                    {t('decision')}
                  </Badge>
                  {decision}
                </span>
              </li>
            ))}
            {meeting.items.map((item) => {
              const who = item.whoUserId ? memberLabel(members, item.whoUserId, item.who) : (item.assigneeSeat ?? item.who);
              return (
                <li key={item.id} className="flex flex-wrap items-center gap-2" data-testid="digest-fact" data-kind="item" data-assigned={item.assigned}>
                  <FactNumber n={(n += 1)} />
                  <Badge variant="outline">{t('open')}</Badge>
                  <span className="font-medium">{item.title}</span>
                  {who !== '' && <span className="text-muted-foreground">{who}</span>}
                  {item.assigned ? item.taskStatus && <Badge variant="outline">{series(`status.${item.taskStatus}`)}</Badge> : <Badge variant="secondary">{series('unassigned')}</Badge>}
                  {briefItemDue(item) !== null && <span className="text-xs text-muted-foreground">{series('due', { date: briefItemDue(item) as string })}</span>}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

// The click: Vy's two or three sentences. Absent when AI is off (no model, the deployment's switch, no right to work with Vy), with the reason said when the member could expect it to be there.
function VyWords({ days, count }: { days: DigestAsk['days']; count: number }) {
  const t = useTranslations('meetings.digest');
  const ask = useTranslations('meetings.ask');
  const f = useFormat();
  const status = useQuery({ ...orpc.meetings.digest.status.queryOptions({ input: {} }), ...READ_ONCE });
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'meetings' } }), staleTime: 15_000 });
  const recap = useMutation({ mutationFn: (): Promise<DigestAnswer> => orpc.meetings.digest.recap.call({ days }) });
  if (!status.data) return null;
  const blocked = askBlocked(status.data, meter.data);
  // With AI off the facts above are the whole digest: no button and no message about what is not there.
  if (blocked === 'off' || blocked === 'noModel') return null;
  const cost = status.data.estimate?.cost ?? null;
  const tokens = status.data.estimate ? status.data.estimate.inputTokens + status.data.estimate.outputTokens : null;
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="digest-vy">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" loading={recap.isPending} disabled={blocked !== null || recap.isPending} onClick={() => recap.mutate()} data-testid="digest-recap">
          {t('submit')}
        </Button>
        {blocked !== null && (
          <span className="text-xs text-muted-foreground" role="status" data-testid="digest-blocked">
            {ask(`blocked.${blocked}`)}
          </span>
        )}
        {blocked === null && cost !== null && <span className="text-xs text-muted-foreground">{t('estimate', { cost: f.aiAmount(cost) })}</span>}
        {blocked === null && cost === null && tokens !== null && <span className="text-xs text-muted-foreground">{t('estimateTokens', { tokens: f.number(tokens) })}</span>}
      </div>
      <div aria-live="polite" className="space-y-2">
        {recap.isPending && <p className="text-xs">{t('running')}</p>}
        {recap.error && <ErrorText>{errorMessage(recap.error)}</ErrorText>}
        {recap.data && <DigestResult answer={recap.data} count={count} />}
      </div>
    </div>
  );
}

// The answer from the server's answer alone: the sentences with the numbers of the facts they rest on, or "nothing to add", or the fixed words of a failure.
export function DigestResult({ answer, count }: { answer: DigestAnswer; count?: number }) {
  const t = useTranslations('meetings.digest');
  if (answer.state === 'written') {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-card p-3" data-testid="digest-answer">
        <p className="text-sm font-semibold">{t('answerTitle')}</p>
        <ol className="space-y-2">
          {answer.sentences.map((sentence, index) => (
            <li key={index} className="space-y-1" data-testid="digest-sentence">
              <p className="whitespace-pre-wrap text-sm">{sentence.text}</p>
              <p className="text-xs text-muted-foreground">{t('cites', { numbers: sentence.facts.join(', ') })}</p>
            </li>
          ))}
        </ol>
        {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{t('dropped', { count: String(answer.dropped) })}</p>}
        {count !== undefined && answer.lines !== count && (
          <p className="text-xs text-destructive" role="status" data-testid="digest-stale">
            {t('stale')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('private')}</p>
      </div>
    );
  }
  return answer.state === 'failed' ? (
    <div data-testid="digest-failed">
      <ErrorText>{`${t('failed')} ${t(`codes.${digestFailureKey(answer.errorCode)}`)}`}</ErrorText>
    </div>
  ) : (
    <p className="text-sm text-muted-foreground" data-testid="digest-none">
      {t('none')}
    </p>
  );
}
