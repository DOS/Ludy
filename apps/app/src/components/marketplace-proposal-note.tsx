// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import { orpc } from '../lib/api.ts';

// The finance coworker's note on a pending marketplace settlement or payout (#4389): the figures of the proposal in a fixed text built by code from the stored proposal (always shown), the model's words on
// what drives it (three sentences at most, no figure in them, only when the model wrote them), then the Uncertain (#2520) points of the posting rows the entry uses, chosen by code. A read: it has no
// button, changes nothing in the proposal and is not asked for any other voucher (the answer is empty). Not refetched on focus: a model call costs, and the server keeps the answer for a while.
export function MarketplaceProposalNote({ proposalId }: { proposalId: string }) {
  const t = useTranslations('inboxDetail');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const note = useQuery({ ...orpc.marketplace.proposalNote.queryOptions({ input: { proposalId, lang } }), retry: false, staleTime: 5 * 60_000, refetchOnWindowFocus: false });
  const data = note.data;
  if (!data) return null;
  return (
    <section className="mt-4 rounded-md border border-border p-3 text-sm" data-testid="marketplace-proposal-note" aria-label={t('proposalNoteTitle')}>
      <p className="text-xs font-medium text-muted-foreground">{t('proposalNoteTitle')}</p>
      {data.figures !== '' && (
        <p className="mt-1 text-foreground" data-testid="marketplace-proposal-figures">
          {data.figures}
        </p>
      )}
      {data.note !== '' && (
        <p className="mt-2 text-foreground" data-testid="marketplace-proposal-note-text">
          {data.note}
        </p>
      )}
      {data.ai === 'used' && data.note !== '' && <p className="mt-1 text-xs text-subtle-foreground">{t('proposalNoteAi')}</p>}
      {data.uncertain.length > 0 && (
        <div className="mt-3" data-testid="marketplace-proposal-uncertain">
          <p className="text-xs font-medium text-muted-foreground">{t('proposalUncertainTitle')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-foreground">
            {data.uncertain.map((p) => (
              <li key={p.key}>{p.text}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-subtle-foreground">{t('proposalUncertainHint')}</p>
        </div>
      )}
    </section>
  );
}
