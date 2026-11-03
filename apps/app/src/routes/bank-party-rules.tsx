// SPDX-License-Identifier: AGPL-3.0-only
// Learned bank-line rules in Settings (issue #2402): which party a bank statement line's words point at, learned when an approver
// chose the party of a bank line's voucher by hand. Each row names the party, who confirmed it, when, and the voucher that taught
// it; the words themselves are never kept (only a keyed hash), so none is shown. Owners and admins remove a rule; every role
// reads them. The server enforces every rule; the screen only offers what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BankPartyRule } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { ErrorText, RowsSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.bankPartyRules.list.key() });

function RuleRow({ rule, canManage }: { rule: BankPartyRule; canManage: boolean }) {
  const t = useTranslations('bankRules');
  const tc = useTranslations('common');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation(orpc.bankPartyRules.remove.mutationOptions({ onSuccess: refresh }));
  const name = rule.confirmedBy ?? t('formerMember');
  return (
    <li className="py-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-foreground">{t('forParty', { party: rule.party.name })}</p>
          <p className="mt-1 text-xs text-subtle-foreground">{t('learnedFrom', { name, date: f.date(rule.confirmedAt), code: rule.voucher.code })}</p>
        </div>
        {canManage && !confirming && (
          <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => setConfirming(true)} aria-label={t('removeOf', { party: rule.party.name })}>
            {t('remove')}
          </Button>
        )}
      </div>
      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
          <span className="text-sm text-foreground">{t('confirmRemove')}</span>
          <Button loading={remove.isPending} variant="destructive" size="sm" onClick={() => remove.mutate({ id: rule.id })}>
            {t('confirm')}
          </Button>
          <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => setConfirming(false)}>
            {tc('cancel')}
          </Button>
        </div>
      )}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </li>
  );
}

export function BankPartyRulesCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('bankRules');
  // The rules of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const rules = useQuery({ ...orpc.bankPartyRules.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {rules.isPending ? (
        <RowsSkeleton />
      ) : rules.error ? (
        <ErrorText>{errorMessage(rules.error)}</ErrorText>
      ) : rules.data.length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground">{t('empty')}</p>
      ) : (
        <ul className="mt-3 divide-y">
          {rules.data.map((rule) => (
            <RuleRow key={rule.id} rule={rule} canManage={canManage} />
          ))}
        </ul>
      )}
    </Card>
  );
}
