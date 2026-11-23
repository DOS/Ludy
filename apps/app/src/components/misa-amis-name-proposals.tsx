// SPDX-License-Identifier: AGPL-3.0-only
// The name proposals of the last check against the MISA catalogue (#4124, S3b of #4103), under the preview, for an owner or admin: a party of Ludy with no tax code and the one catalogue entry that has the same
// name. Nothing is matched until a person confirms (the party then goes on the vouchers with that entry's code) or rejects (the proposal is deleted; a later check may propose it again). The names are text, never
// markup. The coworker has no part in it: no model reads a name, and no agent path confirms.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MisaAmisNameProposal } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { ErrorText } from './ui.tsx';

/** `onDecided` runs after a decision lands, so the preview is read again and its blockers show what the decision changed. */
export function MisaAmisNameProposals({ connectionId, onDecided }: { connectionId: string; onDecided: () => void }) {
  const t = useTranslations('misaAmisNames');
  const proposals = useQuery(orpc.misaAmis.matches.proposals.queryOptions({ input: { connectionId } }));
  // A decision is about the row the person saw and the candidate on it (its code), never about "the party's proposal": a row a newer check replaced is refused by the server.
  const decide = useMutation<unknown, Error, { proposal: MisaAmisNameProposal; confirm: boolean }>({
    mutationFn: ({ proposal, confirm }) => {
      const input = { connectionId, partyId: proposal.partyId, proposalId: proposal.id, candidateCode: proposal.candidateCode };
      return confirm ? client.misaAmis.matches.confirmName(input) : client.misaAmis.matches.rejectName(input);
    },
    onSettled: async () => {
      await proposals.refetch();
      setDecisions((n) => n + 1);
      onDecided();
    },
  });
  // After a decision the row that held the keyboard focus is gone: focus moves to the section, which says what is left (or that nothing is).
  const [decisions, setDecisions] = useState(0);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (decisions > 0) section.current?.focus();
  }, [decisions]);
  const list = proposals.data ?? [];
  // A load that failed is not an empty list: with nothing to show the person is told and can try again. A member who may not decide (the list is for owners and admins) is refused and sees nothing, as before.
  const status = (proposals.error as { status?: number } | null)?.status;
  if (proposals.isError && proposals.data === undefined && status !== 403) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="misa-amis-names-load-error">
        <ErrorText>{errorMessage(proposals.error)}</ErrorText>
        <Button size="sm" variant="outline" loading={proposals.isFetching} onClick={() => void proposals.refetch()} data-testid="misa-amis-names-retry">
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (list.length === 0 && decisions === 0) return null;
  // The button of the decision in flight shows the spinner and keeps its label; every other one waits.
  const inFlight = decide.isPending ? decide.variables : undefined;
  return (
    <section ref={section} tabIndex={-1} className="mt-3 rounded-md border border-border p-2 outline-none" aria-labelledby="misa-amis-names-title" data-testid="misa-amis-names">
      <h4 id="misa-amis-names-title" className="font-medium text-foreground">
        {list.length > 0 ? t('title', { count: String(list.length) }) : t('titleDone')}
      </h4>
      {list.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{t('hint')}</p>}
      <div role="status">{list.length === 0 && <p className="mt-2 text-foreground" data-testid="misa-amis-names-done">{t('allDecided')}</p>}</div>
      <ul className="mt-2 divide-y divide-border">
        {list.map((p) => (
          <ProposalRow key={p.id} proposal={p} busy={decide.isPending} active={inFlight?.proposal.id === p.id ? (inFlight.confirm ? 'confirm' : 'reject') : null} onDecide={(confirm) => decide.mutate({ proposal: p, confirm })} />
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

export function ProposalRow({ proposal, busy, active = null, onDecide }: { proposal: MisaAmisNameProposal; busy: boolean; active?: 'confirm' | 'reject' | null; onDecide: (confirm: boolean) => void }) {
  const t = useTranslations('misaAmisNames');
  return (
    <li className="flex flex-wrap items-center gap-2 py-2" data-testid="misa-amis-name-proposal">
      <span className="min-w-0 flex-1 break-words text-foreground">
        {t('row', { party: proposal.partyName, candidate: proposal.candidateName, code: proposal.candidateCode })}
      </span>
      <Button size="sm" variant="outline" loading={active === 'confirm'} disabled={busy} onClick={() => onDecide(true)} aria-label={t('confirmLabel', { party: proposal.partyName })} data-testid="misa-amis-name-confirm">
        {t('confirm')}
      </Button>
      <Button size="sm" variant="ghost" loading={active === 'reject'} disabled={busy} onClick={() => onDecide(false)} aria-label={t('rejectLabel', { party: proposal.partyName })} data-testid="misa-amis-name-reject">
        {t('reject')}
      </Button>
    </li>
  );
}
