// SPDX-License-Identifier: AGPL-3.0-only
// The approved supplier payment an open money-out bank line may be (#3113 S3c, #3700), for owners and admins. Code decides by the amount and the rules of the payment (finance.bank.supplier_match):
// each candidate names the supplier, the invoice and the amount, never a bank number. "Ask to record" sends the ordinary request for the settlement (finance.supplier_payment.settle.record) with
// the payment and the line; the beneficiary account on the statement is compared when it is asked for, and a different one refuses it and says so. A person approves in the Inbox, and Ludy moves no
// money. No AI is involved here: the whole slice works with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BankLine, BankSupplierCandidate } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

function Candidate({ slug, line, candidate }: { slug: string; line: BankLine; candidate: BankSupplierCandidate }) {
  const t = useTranslations('bank.supplier');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  // One key per request, renewed once it succeeds: a retry returns the same proposal, but a new request after the approver rejected the first one must not replay it.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const ask = useMutation({
    mutationFn: () => client.inbox.request({ command: 'finance.supplier_payment.settle.record', idempotencyKey, input: { paymentId: candidate.paymentId, bankLineId: line.id } }),
    onSuccess: () => setIdempotencyKey(crypto.randomUUID()),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  return (
    <li className="mt-2 rounded-md border border-border p-2 text-xs" data-testid="bank-supplier-candidate">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{t('candidate', { name: candidate.partyName, invoice: candidate.invoiceNumber, amount: f.money(candidate.amount) })}</span>
        <Badge variant="secondary">{t(`reason.${candidate.reason}`)}</Badge>
      </div>
      {ask.data ? (
        <p className="mt-2 text-foreground" data-testid="bank-supplier-asked">
          {t('asked')}{' '}
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: ask.data.proposalId }} className="text-link underline">
            {t('openProposal')}
          </Link>
        </p>
      ) : (
        !open && (
          <div className="mt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="bank-supplier-open">
              {t('ask')}
            </Button>
          </div>
        )
      )}
      {!ask.data && open && (
        <form
          className="mt-2 space-y-2"
          data-testid="bank-supplier-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ask.isPending) ask.mutate();
          }}
        >
          <p className="text-foreground">{t('confirm', { date: f.date(line.date) })}</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={ask.isPending} data-testid="bank-supplier-send">
              {t('send')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {ask.error && (
        <p className="mt-2 text-destructive" role="alert" data-testid="bank-supplier-refusal">
          {errorMessage(ask.error)}
        </p>
      )}
    </li>
  );
}

// Nothing renders for a line that equals no supplier payment (and while the answer is loading, or if it fails): the line keeps its ordinary "Enter voucher" button. The caller passes only open money-out
// lines to owners and admins, as the query is theirs alone.
export function BankSupplierLine({ slug, line }: { slug: string; line: BankLine }) {
  const match = useQuery(orpc.bank.supplierMatch.queryOptions({ input: { bankLineId: line.id } }));
  const candidates = match.data?.candidates ?? [];
  if (candidates.length === 0) return null;
  return (
    <ul className="mt-1" data-testid="bank-supplier-candidates">
      {candidates.map((c) => (
        <Candidate key={c.paymentId} slug={slug} line={line} candidate={c} />
      ))}
    </ul>
  );
}
