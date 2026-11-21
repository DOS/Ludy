// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's one sentence under an open bank line the matcher could not settle (#4219, Tingee S4c): several candidates fit, or none stands out. Code listed the candidates and decides; the
// sentence is display only, tainted text that picks nothing and makes no voucher, and a person approves any voucher. It is shown only when the server returns one: with AI off, a spent budget, a refused
// sentence or a line with nothing to choose, nothing is rendered and the screen is the same as without it. Not refetched on window focus: a model call costs and the server keeps an answer for a while.
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import { orpc } from '../lib/api.ts';

export function BankCandidatesSentence({ bankLineId }: { bankLineId: string }) {
  const t = useTranslations('bank.match');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const sentence = useQuery({ ...orpc.bank.candidatesLine.queryOptions({ input: { bankLineId, lang } }), retry: false, staleTime: 5 * 60_000, refetchOnWindowFocus: false });
  if (sentence.data?.ai !== 'used' || !sentence.data.text) return null;
  return (
    <span className="mt-0.5 block text-muted-foreground" data-testid="match-look-sentence">
      {sentence.data.text} <span className="text-subtle-foreground">{t('candidatesNote')}</span>
    </span>
  );
}
