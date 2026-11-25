// SPDX-License-Identifier: AGPL-3.0-only
// Read-only suggestion banner rendered under an open money-in bank statement line when an executed non-confidential
// eSign VietQR deposit matches the amount and/or CK-<CODE> memo token (#4723). Never auto-posts: prepares a Báo Có proposal.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import type { BankLine, BankSignDepositCandidate } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';

function DepositCandidate({
  line,
  candidate,
  onPrepareProposal,
}: {
  line: BankLine;
  candidate: BankSignDepositCandidate;
  onPrepareProposal: (candidate: BankSignDepositCandidate) => void;
}) {
  const t = useTranslations('bank.signDeposit');
  const f = useFormat();
  const lang = useLocale() === 'en' ? 'en' : 'vi';

  const explain = useMutation({
    mutationFn: () =>
      client.bank.signDepositExplain({
        bankLineId: line.id,
        envelopeId: candidate.envelopeId,
        lang,
      }),
  });

  return (
    <li className="mt-2 rounded-md border border-border p-2 text-xs" data-testid="bank-sign-deposit-candidate">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">
          {t('candidate', {
            title: candidate.title,
            memo: candidate.memoToken,
            amount: f.money(candidate.amount),
          })}
        </span>
        <Badge variant="secondary">{t(`reason.${candidate.reason}`)}</Badge>
        {candidate.signerNoticeAt ? <Badge variant="success">{t('signerNoticed')}</Badge> : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={explain.isPending}
          onClick={() => explain.mutate()}
          data-testid="bank-sign-deposit-why"
        >
          {t('why')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPrepareProposal(candidate)}
          data-testid="bank-sign-deposit-prepare"
        >
          {t('prepare')}
        </Button>
      </div>

      {explain.error ? <ErrorText>{errorMessage(explain.error)}</ErrorText> : null}
      {explain.data?.ai === 'used' && explain.data.text ? (
        <p className="mt-2 text-muted-foreground" data-testid="bank-sign-deposit-sentence">
          {explain.data.text} <span className="text-subtle-foreground">{t('note')}</span>
        </p>
      ) : null}
      {explain.data && explain.data.ai !== 'used' ? (
        <p className="mt-2 text-subtle-foreground" data-testid="bank-sign-deposit-ai-state">
          {t(`aiState.${explain.data.ai}`)}
        </p>
      ) : null}
    </li>
  );
}

export function BankSignDepositLine({
  line,
  candidates: prefetchedCandidates,
  onPrepareProposal,
}: {
  line: BankLine;
  candidates?: readonly BankSignDepositCandidate[];
  onPrepareProposal: (line: BankLine, candidate: BankSignDepositCandidate) => void;
}) {
  const match = useQuery({
    ...orpc.bank.signDepositMatch.queryOptions({ input: { bankLineId: line.id } }),
    enabled: prefetchedCandidates === undefined,
  });
  const candidates = prefetchedCandidates ?? match.data?.candidates ?? [];
  if (candidates.length === 0) return null;

  return (
    <ul className="mt-1" data-testid="bank-sign-deposit-candidates">
      {candidates.map((candidate) => (
        <DepositCandidate
          key={candidate.envelopeId}
          line={line}
          candidate={candidate}
          onPrepareProposal={(picked) => onPrepareProposal(line, picked)}
        />
      ))}
    </ul>
  );
}
