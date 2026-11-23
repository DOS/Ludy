// SPDX-License-Identifier: AGPL-3.0-only
// The approved supplier payment an open money-out bank line may be (#3113 S3c, #3700), for owners and admins. Code decides by the amount and the rules of the payment (finance.bank.supplier_match):
// each candidate names the supplier, the invoice and the amount, never a bank number. "Ask to record" sends the ordinary request for the settlement (finance.supplier_payment.settle.record) with
// the payment and the line; the beneficiary account on the statement is compared when it is asked for, and a different one refuses it and says so. A person approves in the Inbox, and Ludy moves no
// money. No AI is involved here: the whole slice works with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BankLine, BankSupplierCandidate } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { isServerRefusal } from '../lib/errors.ts';

// What a request changes: the state of the line (proposed), the open-line counts, the candidates, the Inbox. Not the payroll matches, which it never touches.
const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.bank.lines.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.bank.lineVoucher.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.bank.openLines.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.bank.supplierMatch.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.inbox.list.key() }),
  ]);

function Candidate({ line, candidate, onAsked }: { line: BankLine; candidate: BankSupplierCandidate; onAsked: (candidate: BankSupplierCandidate, proposalId: string) => void }) {
  const t = useTranslations('bank.supplier');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  // One key per request, renewed once it succeeds: a retry returns the same proposal, but a new request after the approver rejected the first one must not replay it.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const ask = useMutation({
    mutationFn: () => client.inbox.request({ command: 'finance.supplier_payment.settle.record', idempotencyKey, input: { paymentId: candidate.paymentId, bankLineId: line.id } }),
    onSuccess: (data) => {
      setIdempotencyKey(crypto.randomUUID());
      onAsked(candidate, data.proposalId);
    },
    // A refusal the server made (a different account, a payment that moved) changes nothing, so nothing is refetched. A lost response may have created the proposal, so that case reconciles.
    onSettled: (_data, error) => {
      if (!isServerRefusal(error)) void refresh();
    },
  });
  return (
    <li className="mt-2 rounded-md border border-border p-2 text-xs" data-testid="bank-supplier-candidate">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{t('candidate', { name: candidate.partyName, invoice: candidate.invoiceNumber, amount: f.money(candidate.amount) })}</span>
        <Badge variant="secondary">{t(`reason.${candidate.reason}`)}</Badge>
      </div>
      {!open && (
        <div className="mt-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="bank-supplier-open">
            {t('ask')}
          </Button>
        </div>
      )}
      {open && (
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
// lines to owners and admins, as the query is theirs alone. A request that was made stays shown here, above the list: the refreshed list no longer offers that payment (its request is pending), and the
// person still needs the link to the proposal.
export function BankSupplierLine({ slug, line }: { slug: string; line: BankLine }) {
  const t = useTranslations('bank.supplier');
  const f = useFormat();
  const match = useQuery(orpc.bank.supplierMatch.queryOptions({ input: { bankLineId: line.id } }));
  const [asked, setAsked] = useState<Record<string, { candidate: BankSupplierCandidate; proposalId: string }>>({});
  const candidates = (match.data?.candidates ?? []).filter((c) => !asked[c.paymentId]);
  const requests = Object.values(asked);
  if (candidates.length === 0 && requests.length === 0) return null;
  return (
    <ul className="mt-1" data-testid="bank-supplier-candidates">
      {requests.map(({ candidate, proposalId }) => (
        <li key={candidate.paymentId} className="mt-2 rounded-md border border-border p-2 text-xs" data-testid="bank-supplier-candidate">
          <span className="font-medium text-foreground">{t('candidate', { name: candidate.partyName, invoice: candidate.invoiceNumber, amount: f.money(candidate.amount) })}</span>
          <p className="mt-2 text-foreground" data-testid="bank-supplier-asked">
            {t('asked')}{' '}
            <Link to="/o/$slug/inbox/$id" params={{ slug, id: proposalId }} className="text-link underline">
              {t('openProposal')}
            </Link>
          </p>
        </li>
      ))}
      {candidates.map((c) => (
        <Candidate key={c.paymentId} line={line} candidate={c} onAsked={(candidate, proposalId) => setAsked((prev) => ({ ...prev, [candidate.paymentId]: { candidate, proposalId } }))} />
      ))}
    </ul>
  );
}
