// SPDX-License-Identifier: AGPL-3.0-only
// "Việc tiếp theo" on the deals screen (#2381, docs/plan/crm.md): the next steps the daily stale-deal rule raised for open deals nobody changed for
// a while or that are past their expected close. Mine by default (a member's own deals; an owner or admin also reads those nobody owns), or
// everyone's. Done and snooze (3, 7 or 14 days) are one click each, for one step or for up to 20 picked at once, which is one action. A viewer reads
// and marks nothing. A step closes by itself when its deal is edited, moved or closed.
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { NEXT_STEP_BULK_MAX, NEXT_STEP_SNOOZE_DAYS, type NextStep, type NextStepCursor, type NextStepSnoozeDays } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';
import { refreshDeals } from './deal-form.tsx';
import { Empty, ErrorText } from './ui.tsx';

type Scope = 'mine' | 'all';

// The number on the tab: how many next steps are mine to look at.
export function useNextStepCount(): number {
  const count = useQuery(orpc.crm.nextSteps.list.queryOptions({ input: { scope: 'mine', limit: 1 } }));
  return count.data?.counts.mine ?? 0;
}

function Row({ step, canEdit, picked, busy, onPick, onDone, onSnooze }: { step: NextStep; canEdit: boolean; picked: boolean; busy: boolean; onPick: (on: boolean) => void; onDone: () => void; onSnooze: (days: NextStepSnoozeDays) => void }) {
  const t = useTranslations('deals.nextSteps');
  const { locale } = useLocaleSetting();
  return (
    <li data-testid="next-step" data-next-step-id={step.id} data-reason={step.reason} className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-card p-3 text-sm">
      {canEdit && <Checkbox className="mt-0.5" checked={picked} disabled={busy} aria-label={t('select', { title: step.dealTitle })} onCheckedChange={(on) => onPick(on === true)} />}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {step.dealTitle}{' '}
          <Badge variant={step.reason === 'past_close' ? 'destructive' : 'warning'}>{t(step.reason === 'past_close' ? 'pastCloseBadge' : 'noActivityBadge')}</Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          {step.partyName} · {step.stageName} · <span className="tabular-nums">{formatMoney(step.amount, locale, step.currency)}</span>
          {step.assigneeUserId === null && <> · {t('unowned')}</>}
        </p>
        <p className="text-xs text-foreground">{t(step.reason === 'past_close' ? 'pastClose' : 'noActivity', { date: step.sinceOn })}</p>
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1">
          <Button type="button" size="sm" disabled={busy} aria-label={t('doneOne', { title: step.dealTitle })} onClick={onDone}>
            {t('done')}
          </Button>
          {NEXT_STEP_SNOOZE_DAYS.map((days) => (
            <Button key={days} type="button" size="sm" variant="outline" disabled={busy} aria-label={t('snoozeOne', { title: step.dealTitle, days: String(days) })} onClick={() => onSnooze(days)}>
              {t('snoozeDays', { days: String(days) })}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}

export function DealNextSteps({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('deals.nextSteps');
  const [scope, setScope] = useState<Scope>('mine');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState('');
  const list = useInfiniteQuery({
    ...orpc.crm.nextSteps.list.infiniteOptions({
      input: (cursor: NextStepCursor | undefined) => ({ scope, ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined as NextStepCursor | undefined,
      getNextPageParam: (page) => page.next ?? undefined,
    }),
  });
  // The note under the tabs is where the answer of an action is read out and where focus goes when the acted row leaves the list.
  const noticeRef = useRef<HTMLParagraphElement>(null);
  // What an action settled: the steps it acted on are no longer picked (the rest of a selection stays), and the answer is read out.
  const settled = (verb: 'done' | 'snoozed') => (result: { changed: string[]; skipped: string[] }, variables: { nextStepIds: string[] }) => {
    setPicked((prev) => new Set([...prev].filter((id) => !variables.nextStepIds.includes(id))));
    setNotice(t(verb === 'done' ? 'doneResult' : 'snoozeResult', { count: String(result.changed.length) }));
    refreshDeals();
    noticeRef.current?.focus();
  };
  const done = useMutation(orpc.crm.nextSteps.done.mutationOptions({ onSuccess: settled('done'), onError: () => refreshDeals() }));
  const snooze = useMutation(orpc.crm.nextSteps.snooze.mutationOptions({ onSuccess: settled('snoozed'), onError: () => refreshDeals() }));
  const busy = done.isPending || snooze.isPending;
  // A new action forgets the last one's error and answer.
  const begin = () => {
    done.reset();
    snooze.reset();
    setNotice('');
  };
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = list.data?.pages[0]?.counts;
  // A step that left the list (done elsewhere, closed with its deal) is no longer picked, and does not count toward the 20.
  const chosen = items.filter((s) => picked.has(s.id)).map((s) => s.id);
  const pick = (id: string, on: boolean) =>
    setPicked(() => {
      const next = new Set(chosen);
      if (!on) next.delete(id);
      else if (next.size < NEXT_STEP_BULK_MAX) next.add(id);
      return next;
    });
  const failure = done.error ?? snooze.error ?? (list.error && items.length === 0 ? list.error : null);

  return (
    <section className="space-y-3" aria-labelledby="next-steps-title" data-testid="next-steps">
      <div>
        <h2 id="next-steps-title" className="text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      <Tabs
        value={scope}
        onValueChange={(v) => {
          setScope(v as Scope);
          setPicked(new Set());
          begin();
        }}
      >
        <TabsList aria-label={t('scopeLabel')}>
          <TabsTrigger value="mine">{counts ? t('mineCount', { count: String(counts.mine) }) : t('mine')}</TabsTrigger>
          <TabsTrigger value="all">{counts ? t('allCount', { count: String(counts.all) }) : t('all')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {canEdit && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-2 text-sm" data-testid="next-steps-bulk">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setPicked(chosen.length > 0 ? new Set() : new Set(items.slice(0, NEXT_STEP_BULK_MAX).map((s) => s.id)))}>
            {chosen.length > 0 ? t('clearSelection') : t('selectAll', { max: String(NEXT_STEP_BULK_MAX) })}
          </Button>
          {chosen.length > 0 && (
            <>
              <span className="text-muted-foreground">{t('selected', { count: String(chosen.length) })}</span>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                loading={done.isPending}
                onClick={() => {
                  begin();
                  done.mutate({ nextStepIds: chosen });
                }}
              >
                {t('bulkDone', { count: String(chosen.length) })}
              </Button>
              {NEXT_STEP_SNOOZE_DAYS.map((days) => (
                <Button
                  key={days}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    begin();
                    snooze.mutate({ nextStepIds: chosen, days });
                  }}
                >
                  {t('bulkSnooze', { days: String(days) })}
                </Button>
              ))}
              <span role="status" className="text-xs text-muted-foreground">
                {chosen.length >= NEXT_STEP_BULK_MAX ? t('bulkMax', { max: String(NEXT_STEP_BULK_MAX) }) : ''}
              </span>
            </>
          )}
        </div>
      )}
      <p ref={noticeRef} tabIndex={-1} role="status" aria-live="polite" className="text-sm text-muted-foreground outline-none">
        {notice}
      </p>
      {failure !== null && <ErrorText>{errorMessage(failure)}</ErrorText>}
      {list.isPending ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : items.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <>
          <ul className="space-y-2" aria-label={t('title')}>
            {items.map((step) => (
              <Row
                key={step.id}
                step={step}
                canEdit={canEdit}
                picked={picked.has(step.id)}
                busy={busy}
                onPick={(on) => pick(step.id, on)}
                onDone={() => {
                  begin();
                  done.mutate({ nextStepIds: [step.id] });
                }}
                onSnooze={(days) => {
                  begin();
                  snooze.mutate({ nextStepIds: [step.id], days });
                }}
              />
            ))}
          </ul>
          {list.hasNextPage && (
            <Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('loadMore')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
