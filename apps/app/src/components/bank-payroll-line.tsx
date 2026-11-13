// SPDX-License-Identifier: AGPL-3.0-only
// The payroll payment an open money-out bank line may be (#2933, payroll plan 6.4 and 6.6), for owners and admins. Code decides by the amount (finance.bank.payroll_match): each candidate names the
// month, the kind and the amount, never a person. The coworker's one line on why is asked by a button (a model call costs) and is display only: with AI off, busy, out of budget or refused the
// candidate stays and only the sentence is missing. "Ask for this payment" sends the ordinary payment request with the line (finance.payroll_payment.record, bankLineId); a person approves it in the
// Inbox, and Ludy moves no money.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import type { BankLine, BankPayrollCandidate } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

function Candidate({ slug, line, bankAccount, candidate }: { slug: string; line: BankLine; bankAccount: string; candidate: BankPayrollCandidate }) {
  const t = useTranslations('bank.payroll');
  const pay = useTranslations('hrPayroll');
  const f = useFormat();
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const [open, setOpen] = useState(false);
  // One key per request, renewed once it succeeds: a retry returns the same proposal, but a new request after the approver rejected the first one must not replay it.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const explain = useMutation({ mutationFn: () => client.bank.payrollExplain({ bankLineId: line.id, runId: candidate.runId, kind: candidate.kind, lang }) });
  const ask = useMutation({
    mutationFn: () =>
      client.inbox.request({
        command: 'finance.payroll_payment.record',
        idempotencyKey,
        input: { runId: candidate.runId, kind: candidate.kind, type: 'bank_debit', date: line.date, cashAccount: bankAccount, bankLineId: line.id },
      }),
    onSuccess: () => setIdempotencyKey(crypto.randomUUID()),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const kind = pay(`payKind.${candidate.kind}`);
  return (
    <li className="mt-2 rounded-md border border-border p-2 text-xs" data-testid={`bank-payroll-${candidate.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{t('candidate', { kind, month: candidate.month, amount: f.money(candidate.amount) })}</span>
        <Badge variant="secondary">{t(`reason.${candidate.reason}`)}</Badge>
      </div>
      {ask.data ? (
        <p className="mt-2 text-foreground" data-testid="bank-payroll-asked">
          {t('asked')}{' '}
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: ask.data.proposalId }} className="text-link underline">
            {t('openProposal')}
          </Link>
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" loading={explain.isPending} onClick={() => explain.mutate()} data-testid="bank-payroll-why">
            {t('why')}
          </Button>
          {!open && (
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="bank-payroll-open">
              {t('ask')}
            </Button>
          )}
        </div>
      )}
      {explain.error && <ErrorText>{errorMessage(explain.error)}</ErrorText>}
      {explain.data?.ai === 'used' && explain.data.text && (
        <p className="mt-2 text-muted-foreground" data-testid="bank-payroll-sentence">
          {explain.data.text} <span className="text-subtle-foreground">{t('note')}</span>
        </p>
      )}
      {explain.data && explain.data.ai !== 'used' && (
        <p className="mt-2 text-subtle-foreground" data-testid="bank-payroll-ai-state">
          {t(`aiState.${explain.data.ai}`)}
        </p>
      )}
      {!ask.data && open && (
        <form
          className="mt-2 space-y-2"
          data-testid="bank-payroll-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ask.isPending) ask.mutate();
          }}
        >
          <p className="text-foreground">{t('confirm', { date: f.date(line.date), account: bankAccount })}</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={ask.isPending} data-testid="bank-payroll-send">
              {t('send')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
    </li>
  );
}

// Nothing renders for a line that equals no payroll payment (and while the answer is loading, or if it fails): the line keeps its ordinary "Enter voucher" button. The caller passes only open
// money-out lines to owners and admins, as the query is theirs alone.
export function BankPayrollLine({ slug, line, bankAccount }: { slug: string; line: BankLine; bankAccount: string }) {
  const match = useQuery(orpc.bank.payrollMatch.queryOptions({ input: { bankLineId: line.id } }));
  const candidates = match.data?.candidates ?? [];
  if (candidates.length === 0) return null;
  return (
    <ul className="mt-1" data-testid="bank-payroll-candidates">
      {candidates.map((c) => (
        <Candidate key={`${c.runId}:${c.kind}`} slug={slug} line={line} bankAccount={bankAccount} candidate={c} />
      ))}
    </ul>
  );
}
