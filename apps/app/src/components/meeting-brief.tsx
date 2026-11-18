// SPDX-License-Identifier: AGPL-3.0-only
// "Chuẩn bị cho buổi họp" (#3543): the facts before a meeting of a series, on the meeting's page and on the card of an upcoming calendar event: what was decided at the previous meeting, what is still
// open, and the linked customer's open deals with their stage. Every fact is numbered and links to where it comes from. They are read by code as the member (a member who did not read the previous
// meeting gets nothing of it, not even that it exists) and work with AI off; with nothing to say there is no card at all. On top, one click has the member's own Vy write two or three sentences from
// those numbered facts: code checked each sentence before it got here (it must cite facts above and write no figure they do not hold), the answer lives only in this component's state and is never stored.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { briefItemDue, briefLines, vnDateOf, type BriefAnswer, type BriefFacts, type BriefLine, type BriefTarget } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { ErrorText } from './ui.tsx';
import { askBlocked } from './meeting-ask.tsx';
import { memberLabel } from './meeting-results.tsx';
import { useMe } from './conversation-inbox.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

// Reading the facts is a sensitive read that leaves an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
const KNOWN_FAILURES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'BRIEF_TIMEOUT', 'BRIEF_FAILED', 'BRIEF_UNPARSABLE', 'BRIEF_TOO_LONG', 'BRIEF_NOTHING', 'BRIEF_BUSY'] as const;

// How a fixed code of a failed answer reads: the codes this screen knows, else the general words.
export function briefFailureKey(code: string | null): (typeof KNOWN_FAILURES)[number] | 'default' {
  return (KNOWN_FAILURES as readonly string[]).includes(code ?? '') ? (code as (typeof KNOWN_FAILURES)[number]) : 'default';
}

const target = (t: { meetingId: string } | { agendaId: string }): BriefTarget => ('meetingId' in t ? { meetingId: t.meetingId, agendaId: null } : { meetingId: null, agendaId: t.agendaId });

export function MeetingBrief({ slug, emptyNote = false, ...which }: { slug: string; emptyNote?: boolean } & ({ meetingId: string } | { agendaId: string })) {
  const t = useTranslations('meetings.brief');
  const input = target(which);
  const facts = useQuery({ ...orpc.meetings.brief.facts.queryOptions({ input }), ...READ_ONCE });
  const data = facts.data;
  // No fact, no card: nothing is shown for a meeting with nothing to say, or whose previous meeting the member did not read. Opened by a click (an upcoming event's card), one line says so.
  if (!data) return null;
  if (data.empty) {
    return emptyNote ? (
      <p className="text-xs text-muted-foreground" data-testid="brief-nothing">
        {t('nothing')}
      </p>
    ) : null;
  }
  return (
    <Card data-testid="meeting-brief">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">{t('title')}</CardTitle>
        {data.previous && (
          <CardDescription className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t('from', { title: data.previous.title, date: vnDateOf(data.previous.startedAt) })}</span>
            <Link to="/o/$slug/meetings/$id" params={{ slug, id: data.previous.meetingId }} className="font-medium text-link underline" data-testid="brief-open-previous">
              {t('openPrevious')}
            </Link>
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <Facts slug={slug} facts={data} />
        <VyWords input={input} lines={briefLines(data)} />
      </CardContent>
    </Card>
  );
}

// The numbered facts, grouped: the number is the one a sentence of Vy cites.
function Facts({ slug, facts }: { slug: string; facts: BriefFacts }) {
  const t = useTranslations('meetings.brief');
  const series = useTranslations('meetings.series');
  const f = useFormat();
  const { members } = useMe();
  const lines = briefLines(facts);
  const of = (kind: BriefLine['kind']) => lines.filter((l) => l.kind === kind);
  const decisions = of('decision');
  const items = of('item');
  const deals = of('deal');
  return (
    <div className="space-y-3 text-sm">
      {decisions.length > 0 && (
        <section className="space-y-1" data-testid="brief-decisions">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">{t('decisions')}</h3>
          <ol className="space-y-1">
            {decisions.map((line, index) => (
              <li key={line.n} className="flex gap-2" data-testid="brief-fact">
                <FactNumber n={line.n} />
                <span>{facts.decisions[index]}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {items.length > 0 && (
        <section className="space-y-1" data-testid="brief-items">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">{t('items')}</h3>
          <ol className="space-y-1">
            {items.map((line, index) => {
              const item = facts.items[index];
              if (!item) return null;
              const who = item.whoUserId ? memberLabel(members, item.whoUserId, item.who) : (item.assigneeSeat ?? item.who);
              return (
                <li key={line.n} className="flex flex-wrap items-center gap-2" data-testid="brief-fact" data-assigned={item.assigned}>
                  <FactNumber n={line.n} />
                  <span className="font-medium">{item.title}</span>
                  {who !== '' && <span className="text-muted-foreground">{who}</span>}
                  {item.assigned ? item.taskStatus && <Badge variant="outline">{series(`status.${item.taskStatus}`)}</Badge> : <Badge variant="secondary">{series('unassigned')}</Badge>}
                  {briefItemDue(item) !== null && <span className="text-xs text-muted-foreground">{series('due', { date: briefItemDue(item) as string })}</span>}
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {deals.length > 0 && (
        <section className="space-y-1" data-testid="brief-deals">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">{facts.customer ? t('deals', { name: facts.customer.name }) : t('dealsNoName')}</h3>
          <ol className="space-y-1">
            {deals.map((line, index) => {
              const deal = facts.deals[index];
              if (!deal) return null;
              return (
                <li key={line.n} className="flex flex-wrap items-center gap-2" data-testid="brief-fact">
                  <FactNumber n={line.n} />
                  <Link to="/o/$slug/deals" params={{ slug }} className="font-medium text-link underline" title={t('openDeals')} data-testid="brief-deal-link">
                    {deal.title}
                  </Link>
                  {deal.stage !== '' && <Badge variant="outline">{deal.stage}</Badge>}
                  {deal.amount !== null && <span>{f.money(deal.amount)}</span>}
                  {deal.expectedClose && <span className="text-xs text-muted-foreground">{t('closeOn', { date: f.date(deal.expectedClose) })}</span>}
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {facts.customer && deals.length === 0 && (
        <Link to="/o/$slug/contacts" params={{ slug }} className="text-sm text-link underline" title={t('openContacts')} data-testid="brief-customer-link">
          {facts.customer.name}
        </Link>
      )}
    </div>
  );
}

const FactNumber = ({ n }: { n: number }) => (
  <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted px-1 text-xs text-muted-foreground" aria-label={String(n)}>
    {n}
  </span>
);

// The click: Vy's two or three sentences. Absent when AI is off (no model, the deployment's switch, no right to work with Vy), with the reason said when the member could expect it to be there.
function VyWords({ input, lines }: { input: BriefTarget; lines: BriefLine[] }) {
  const t = useTranslations('meetings.brief');
  const ask = useTranslations('meetings.ask');
  const f = useFormat();
  const status = useQuery({ ...orpc.meetings.brief.status.queryOptions({ input: {} }), ...READ_ONCE });
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'meetings' } }), staleTime: 15_000 });
  const write = useMutation({ mutationFn: (): Promise<BriefAnswer> => orpc.meetings.brief.write.call(input) });
  if (!status.data || lines.length === 0) return null;
  const blocked = askBlocked(status.data, meter.data);
  // With AI off the facts above are the whole brief: no button and no message about what is not there.
  if (blocked === 'off' || blocked === 'noModel') return null;
  const cost = status.data.estimate?.cost ?? null;
  const tokens = status.data.estimate ? status.data.estimate.inputTokens + status.data.estimate.outputTokens : null;
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="brief-vy">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" loading={write.isPending} disabled={blocked !== null || write.isPending} onClick={() => write.mutate()} data-testid="brief-write">
          {t('submit')}
        </Button>
        {blocked !== null && (
          <span className="text-xs text-muted-foreground" role="status" data-testid="brief-blocked">
            {ask(`blocked.${blocked}`)}
          </span>
        )}
        {blocked === null && cost !== null && <span className="text-xs text-muted-foreground">{t('estimate', { cost: f.aiAmount(cost) })}</span>}
        {blocked === null && cost === null && tokens !== null && <span className="text-xs text-muted-foreground">{t('estimateTokens', { tokens: f.number(tokens) })}</span>}
      </div>
      <div aria-live="polite" className="space-y-2">
        {write.isPending && <p className="text-xs">{t('running')}</p>}
        {write.error && <ErrorText>{errorMessage(write.error)}</ErrorText>}
        {write.data && <BriefResult answer={write.data} />}
      </div>
    </div>
  );
}

// The answer from the server's answer alone: the sentences with the numbers of the facts they rest on, or "nothing to add", or the fixed words of a failure.
export function BriefResult({ answer }: { answer: BriefAnswer }) {
  const t = useTranslations('meetings.brief');
  if (answer.state === 'written') {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-card p-3" data-testid="brief-answer">
        <p className="text-sm font-semibold">{t('answerTitle')}</p>
        <ol className="space-y-2">
          {answer.sentences.map((sentence, index) => (
            <li key={index} className="space-y-1" data-testid="brief-sentence">
              <p className="whitespace-pre-wrap text-sm">{sentence.text}</p>
              <p className="text-xs text-muted-foreground">{t('cites', { numbers: sentence.facts.join(', ') })}</p>
            </li>
          ))}
        </ol>
        {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{t('dropped', { count: String(answer.dropped) })}</p>}
        <p className="text-xs text-muted-foreground">{t('private')}</p>
      </div>
    );
  }
  return answer.state === 'failed' ? (
    <div data-testid="brief-failed">
      <ErrorText>{`${t('failed')} ${t(`codes.${briefFailureKey(answer.errorCode)}`)}`}</ErrorText>
    </div>
  ) : (
    <p className="text-sm text-muted-foreground" data-testid="brief-none">
      {t('none')}
    </p>
  );
}

// On the card of an upcoming calendar event: the brief opens on a click, so listing the day's events reads nothing. The event is the member's own, not recorded yet.
export function AgendaBrief({ slug, agendaId }: { slug: string; agendaId: string }) {
  const t = useTranslations('meetings.brief');
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full space-y-2" data-testid="agenda-brief">
      <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? t('hide') : t('show')}
      </Button>
      {open && <MeetingBrief slug={slug} agendaId={agendaId} emptyNote />}
    </div>
  );
}
