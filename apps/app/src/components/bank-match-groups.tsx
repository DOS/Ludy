// SPDX-License-Identifier: AGPL-3.0-only
// The matches of an account's open bank lines for a month, in groups (#2385). The clean group, lines with exactly one
// exact candidate and no warning, is asked for and approved in one action: a voucher proposal per line through the same
// request as a single line (each marked as the matcher's suggestion), then one bulk approval with one step-up per batch,
// each voucher checked one by one by the server. Lines that need a look are listed with why and are entered one by one
// in the table below. Nothing here decides a match; a voucher the policy does not let this person approve posts nothing
// and the screen says so.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BankMatchLine } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useChosenEntity } from './entity-switcher.tsx';
import { useMatchText } from './bank-match-text.ts';
import { StepUpPrompt } from './two-factor.tsx';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { needsSecondApprover, summarizeApproval, voucherRequestOf } from '../lib/bank-groups.ts';
import { planBatches, sendBatches, type BulkBatch, type BulkProgress } from '../lib/review.ts';

interface Run {
  phase: 'requesting' | 'approving' | 'done';
  asked: number;
  // The proposals asked for, by line: what the bulk approval sends and what is reported by.
  proposals: Array<{ id: string; date: string; amount: string }>;
  askFailed: Array<{ date: string; message: string }>;
  batches: BulkBatch[];
  progress: BulkProgress;
  sending: boolean;
  stopped: boolean;
}

const empty = (): BulkProgress => ({ results: [], next: 0, error: null });

export function BankMatchGroups({ slug, bankAccount, month, canApprove }: { slug: string; bankAccount: string; month: string; canApprove: boolean }) {
  const t = useTranslations('bank.match');
  const say = useMatchText();
  const f = useFormat();
  // The open lines of the entity chosen in the shell (#1280); each voucher goes to that entity's books.
  const entity = useChosenEntity();
  const groups = useQuery({ ...orpc.bank.matchGroups.queryOptions({ input: { bankAccount, period: month, legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const [run, setRun] = useState<Run | null>(null);
  const clean = groups.data?.clean ?? [];
  const look = groups.data?.look ?? [];

  async function approve(current: Run) {
    setRun({ ...current, phase: 'approving', sending: true, stopped: false, progress: { ...current.progress, error: null } });
    const progress = await sendBatches(
      current.batches,
      current.progress,
      (batch) => client.inbox.approveMany({ items: batch.items, idempotencyKey: batch.idempotencyKey }),
      (step) => setRun((r) => (r ? { ...r, progress: step } : r)),
    );
    const finished = !progress.error;
    setRun((r) => (r ? { ...r, progress, sending: false, phase: finished ? 'done' : 'approving' } : r));
    if (finished) await queryClient.invalidateQueries();
  }

  async function start(list: readonly BankMatchLine[]) {
    const state: Run = { phase: 'requesting', asked: 0, proposals: [], askFailed: [], batches: [], progress: empty(), sending: true, stopped: false };
    setRun({ ...state });
    for (const item of list) {
      const input = voucherRequestOf(item, entity.legalEntityId);
      if (!input) continue;
      try {
        const asked = await client.inbox.request({ command: 'finance.voucher.record', idempotencyKey: crypto.randomUUID(), input });
        state.asked += 1;
        state.proposals.push({ id: asked.proposalId, date: item.line.date, amount: item.line.amount });
      } catch (error) {
        state.askFailed.push({ date: item.line.date, message: errorMessage(error) });
      }
      setRun({ ...state, proposals: [...state.proposals], askFailed: [...state.askFailed] });
    }
    await queryClient.invalidateQueries();
    if (!canApprove || state.proposals.length === 0) {
      setRun({ ...state, phase: 'done', sending: false });
      return;
    }
    // A fresh proposal is at revision 1; the server checks each one again as if it were approved alone.
    const batches = planBatches(state.proposals.map((p) => ({ id: p.id, revision: 1 })));
    await approve({ ...state, batches, proposals: [...state.proposals], askFailed: [...state.askFailed] });
  }

  const stop = () => setRun((r) => (r ? { ...r, stopped: true, sending: false, phase: 'done', progress: { ...r.progress, error: null } } : r));

  if (run) {
    const summary = summarizeApproval(run.progress.results);
    const error = run.phase === 'approving' && !run.sending && !run.stopped ? run.progress.error : null;
    const notSent = run.phase === 'done' && canApprove ? run.proposals.length - run.progress.results.length : 0;
    return (
      <>
        <Alert className="mb-4" data-testid="match-run">
          <AlertDescription>
            {run.sending ? <Spinner className="mr-2 inline-block text-current" /> : null}
            {run.phase === 'requesting' && t('asking', { done: run.asked })}
            {run.phase === 'approving' && run.sending && t('approving', { done: Math.min(run.progress.next + 1, run.batches.length), total: run.batches.length })}
            {run.phase === 'done' && (
              <>
                <span data-testid="match-summary">{canApprove ? t('doneApproved', { asked: run.asked, approved: summary.approved }) : t('doneAsked', { asked: run.asked })}</span>
                {summary.refused.length > 0 && (
                  <>
                    {needsSecondApprover(summary) && <span className="block text-warning">{t('secondApprover')}</span>}
                    <span className="block text-destructive">{t('refused', { count: summary.refused.length })}</span>
                    <ul className="list-disc pl-5 text-sm text-muted-foreground">
                      {summary.refused.map((r) => (
                        <li key={r.id}>
                          <Link to="/o/$slug/inbox/$id" params={{ slug, id: r.id }} className="text-link hover:underline">
                            {t('proposal')}
                          </Link>
                          {': '}
                          {/* A voucher with a warning of its own is never approved in a batch (#2419). */}
                          {r.code === 'BULK_NOT_ALLOWED' ? t('aloneOnly') : errorMessage({ code: r.code, data: r.rule ? { rule: r.rule } : undefined })}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {notSent > 0 && <span className="block text-warning">{t('notSent', { count: notSent })}</span>}
                {run.askFailed.map((failure, i) => (
                  <span key={i} className="block text-destructive">
                    {t('askFailed', { date: f.date(failure.date), message: failure.message })}
                  </span>
                ))}
                <button type="button" className="ml-2 text-link underline" onClick={() => setRun(null)}>
                  {t('close')}
                </button>
              </>
            )}
          </AlertDescription>
        </Alert>
        {error !== null && isStepUpRequired(error) && (
          <div className="mb-4">
            <StepUpPrompt action={t('stepUp', { count: run.proposals.length - run.progress.results.length })} onVerified={() => void approve(run)} onCancel={stop} />
          </div>
        )}
        {error !== null && !isStepUpRequired(error) && (
          <div className="mb-4 space-y-2">
            <ErrorText>{errorMessage(error)}</ErrorText>
            <div className="flex gap-2">
              <Button onClick={() => void approve(run)}>{t('retry')}</Button>
              <Button variant="ghost" onClick={stop}>
                {t('dismiss')}
              </Button>
            </div>
          </div>
        )}
      </>
    );
  }

  if (groups.isLoading) return null;
  if (groups.error) return <ErrorText>{errorMessage(groups.error)}</ErrorText>;
  if (clean.length === 0 && look.length === 0) return null;
  return (
    <Card className="mb-4 space-y-3 p-4" data-testid="match-groups">
      {clean.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{t('cleanTitle', { count: clean.length })}</p>
            <p className="text-xs text-subtle-foreground">{canApprove ? t('cleanHintApprove') : t('cleanHintAsk')}</p>
          </div>
          <Button type="button" data-testid="match-clean-action" onClick={() => void start(clean)}>
            {canApprove ? t('cleanApprove', { count: clean.length }) : t('cleanAsk', { count: clean.length })}
          </Button>
        </div>
      )}
      {clean.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground" aria-label={t('cleanTitle', { count: clean.length })}>
          {clean.map((item) => {
            const why = say.reason({ reason: item.suggested?.reason, invoice: item.suggested?.invoice });
            return (
              <li key={item.line.id} data-testid="match-clean-line">
                {f.date(item.line.date)} {f.money(item.line.amount.replace(/^-/, ''))}
                {item.suggested ? `, ${item.suggested.party.name}` : ''}: {why}
              </li>
            );
          })}
        </ul>
      )}
      {look.length > 0 && (
        <div>
          <p className="text-sm font-medium text-foreground">{t('lookTitle', { count: look.length })}</p>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {look.map((item) => (
              <li key={item.line.id} data-testid="match-look-line">
                {f.date(item.line.date)} {f.money(item.line.amount.replace(/^-/, ''))}: {item.why ? say.look(item.why) : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {groups.data?.more && <p className="text-xs text-warning">{t('more')}</p>}
    </Card>
  );
}
