// SPDX-License-Identifier: AGPL-3.0-only
// The org's N of the stale-deal rule (#2381), for owners and admins: after how many days without a change an open deal raises a next step
// (7 to 60, 14 until set). A deal past its expected close always does. It applies from the next daily run.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { DEAL_STALE_DAYS_MAX, DEAL_STALE_DAYS_MIN } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { ErrorText, Field } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

const settingKey = () => orpc.crm.dealSetting.get.queryKey({ input: {} });

export function DealStaleSetting() {
  const t = useTranslations('deals.setting');
  const current = useQuery(orpc.crm.dealSetting.get.queryOptions({ input: {} }));
  const [days, setDays] = useState('');
  const [saved, setSaved] = useState(false);
  const staleDays = current.data?.staleDays;
  useEffect(() => {
    if (staleDays !== undefined) setDays(String(staleDays));
  }, [staleDays]);
  const set = useMutation(
    orpc.crm.dealSetting.set.mutationOptions({
      onSuccess: (data) => {
        queryClient.setQueryData(settingKey(), data);
        setSaved(true);
      },
    }),
  );
  const value = /^\d{1,2}$/.test(days.trim()) ? Number(days.trim()) : null;
  const valid = value !== null && value >= DEAL_STALE_DAYS_MIN && value <= DEAL_STALE_DAYS_MAX;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || value === null) return;
    setSaved(false);
    set.mutate({ staleDays: value });
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-border p-3" data-testid="stale-setting">
      <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
      <p className="text-xs text-muted-foreground">{t('hint', { min: String(DEAL_STALE_DAYS_MIN), max: String(DEAL_STALE_DAYS_MAX) })}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('days')} className="w-32">
          {(c) => <Input {...c} inputMode="numeric" maxLength={2} value={days} onChange={(e) => { setDays(e.target.value); setSaved(false); }} />}
        </Field>
        <Button type="submit" size="sm" disabled={!valid || current.isPending} loading={set.isPending}>
          {t('save')}
        </Button>
        {saved && (
          <span role="status" className="text-sm text-muted-foreground">
            {t('saved')}
          </span>
        )}
      </div>
      {days.trim() !== '' && !valid && <ErrorText>{t('invalid', { min: String(DEAL_STALE_DAYS_MIN), max: String(DEAL_STALE_DAYS_MAX) })}</ErrorText>}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </form>
  );
}
