// SPDX-License-Identifier: AGPL-3.0-only
// The name proposals of the last check against the MISA catalogue (#4124, S3b of #4103), under the preview, for an owner or admin: a party of Ludy with no tax code and the one catalogue entry that has the same
// name. Nothing is matched until a person confirms (the party then goes on the vouchers with that entry's code) or rejects (the proposal is deleted; a later check may propose it again). The names are text, never
// markup. The coworker has no part in it: no model reads a name, and no agent path confirms.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { MisaAmisNameProposal } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { ErrorText } from './ui.tsx';

/** `onDecided` runs after a decision lands, so the preview is read again and its blockers show what the decision changed. */
export function MisaAmisNameProposals({ connectionId, onDecided }: { connectionId: string; onDecided: () => void }) {
  const t = useTranslations('misaAmisNames');
  const proposals = useQuery(orpc.misaAmis.matches.proposals.queryOptions({ input: { connectionId } }));
  const decide = useMutation<unknown, Error, { partyId: string; confirm: boolean }>({
    mutationFn: ({ partyId, confirm }) => (confirm ? client.misaAmis.matches.confirmName({ connectionId, partyId }) : client.misaAmis.matches.rejectName({ connectionId, partyId })),
    onSettled: async () => {
      await proposals.refetch();
      onDecided();
    },
  });
  const list = proposals.data ?? [];
  if (list.length === 0) return null;
  return (
    <section className="mt-3 rounded-md border border-border p-2" aria-labelledby="misa-amis-names-title" data-testid="misa-amis-names">
      <h4 id="misa-amis-names-title" className="font-medium text-foreground">
        {t('title', { count: String(list.length) })}
      </h4>
      <p className="mt-1 text-xs text-muted-foreground">{t('hint')}</p>
      <ul className="mt-2 divide-y divide-border">
        {list.map((p) => (
          <ProposalRow key={p.partyId} proposal={p} busy={decide.isPending} onDecide={(confirm) => decide.mutate({ partyId: p.partyId, confirm })} />
        ))}
      </ul>
      {decide.error && (
        <div className="mt-1" data-testid="misa-amis-names-error">
          <ErrorText>{errorMessage(decide.error)}</ErrorText>
        </div>
      )}
    </section>
  );
}

export function ProposalRow({ proposal, busy, onDecide }: { proposal: MisaAmisNameProposal; busy: boolean; onDecide: (confirm: boolean) => void }) {
  const t = useTranslations('misaAmisNames');
  return (
    <li className="flex flex-wrap items-center gap-2 py-2" data-testid="misa-amis-name-proposal">
      <span className="min-w-0 flex-1 break-words text-foreground">
        {t('row', { party: proposal.partyName, candidate: proposal.candidateName, code: proposal.candidateCode })}
      </span>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide(true)} aria-label={t('confirmLabel', { party: proposal.partyName })} data-testid="misa-amis-name-confirm">
        {t('confirm')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(false)} aria-label={t('rejectLabel', { party: proposal.partyName })} data-testid="misa-amis-name-reject">
        {t('reject')}
      </Button>
    </li>
  );
}
