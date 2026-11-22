// SPDX-License-Identifier: AGPL-3.0-only
// Settings "Thời gian lưu hội thoại" (CV6, #2305; moved from the top of the Engage Inbox, #3582): how long conversations are kept after their last message. Owners
// and admins change it (the command already refuses anyone else, and Settings shows the card to them only). Older conversations are deleted every night with their
// messages and notes; "keep" holds them until someone deletes them. A shorter time (or one where there was none) asks first, as it deletes tonight. The AI coworker
// here: none; the setting is a person's, audited by the command as before.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { CONVERSATION_RETENTION_MONTHS } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { NativeSelect } from '@ludy/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

type Months = 6 | 12 | 24 | null;
const monthsOf = (m: Months) => (m === null ? Number.POSITIVE_INFINITY : m);

export function ConversationRetentionCard() {
  const t = useTranslations('conversations');
  const current = useQuery(orpc.conversations.retention.queryOptions({ input: {} }));
  const [asking, setAsking] = useState<Months | undefined>(undefined);
  const set = useMutation({
    // Saves run one after another, so a second change made while one is saving is never lost or reordered.
    scope: { id: 'conversation-retention' },
    mutationFn: (retentionMonths: Months) => client.conversations.setRetention({ retentionMonths }),
    onSuccess: () => {
      setAsking(undefined);
      void queryClient.invalidateQueries({ queryKey: orpc.conversations.retention.key() });
    },
  });
  const heading = <h2 className="text-sm font-medium text-muted-foreground">{t('retention.title')}</h2>;
  if (current.isError) {
    return (
      <Card className="block space-y-2 p-4" data-testid="conversation-retention-error">
        {heading}
        <ErrorText>{errorMessage(current.error)}</ErrorText>
        <Button type="button" size="sm" variant="outline" onClick={() => void current.refetch()}>
          {t('retention.retry')}
        </Button>
      </Card>
    );
  }
  if (!current.data) return null;
  const choose = (next: Months) => {
    if (monthsOf(next) < monthsOf(current.data.retentionMonths)) setAsking(next);
    else set.mutate(next);
  };
  // While a save is out, the select shows the value being saved (not the old one) and stays enabled: a disabled select drops the keyboard's focus, and the 44 px height holds on a phone.
  const shownMonths = set.isPending && set.variables !== undefined ? set.variables : current.data.retentionMonths;
  const value = shownMonths === null ? 'keep' : String(shownMonths);
  return (
    <Card className="block space-y-3 p-4" data-testid="conversation-retention">
      {heading}
      <NativeSelect
        aria-label={t('retention.title')}
        value={value}
        aria-busy={set.isPending}
        className="w-full md:w-fit [&_select]:h-11 md:[&_select]:h-8"
        data-testid="conversation-retention-select"
        onChange={(e) => choose(e.target.value === 'keep' ? null : (Number(e.target.value) as 6 | 12 | 24))}
      >
        {CONVERSATION_RETENTION_MONTHS.map((m) => (
          <option key={m} value={String(m)}>
            {t(`retention.m${m}`)}
            {current.data.isDefault && m === 24 ? ` ${t('retention.default')}` : ''}
          </option>
        ))}
        <option value="keep">{t('retention.keep')}</option>
      </NativeSelect>
      <p className="text-xs text-muted-foreground">{t('retention.hint')}</p>
      {asking !== undefined && asking !== null && (
        <div role="alertdialog" aria-label={t('retention.title')} className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="conversation-retention-confirm">
          <p>{t('retention.shorten', { months: String(asking) })}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" disabled={set.isPending} data-testid="conversation-retention-yes" onClick={() => set.mutate(asking)}>
              {t('retention.shortenYes')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(undefined)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </Card>
  );
}
