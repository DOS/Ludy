// SPDX-License-Identifier: AGPL-3.0-only
// The thresholds of the spend flags on the Ads screen (issue #2378), for owners and admins: when the pace of a month is judged, by what factor
// a day or a campaign's cost per result may exceed its share or its median, and how many results and days of history that last rule needs.
// An empty field means the default, which the server sends with the setting. Changing a threshold only changes which flags the rules raise:
// it moves no money and changes no campaign.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { formOf, isFlagFieldValid, sameForm, settingOf, wrongFlagFields, type FlagField, type FlagForm } from '../lib/ads-flag-settings.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { ErrorText, Field } from './ui.tsx';

const EMPTY: FlagForm = { paceMinDays: '', dayFactor: '', cprFactor: '', cprMinResults: '', cprMinHistoryDays: '' };

// The flags and their thresholds are read together, so a saved threshold shows its effect at once.
const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: orpc.ads.flagSettings.key() }), queryClient.invalidateQueries({ queryKey: orpc.ads.flags.key() })]);

export function AdsFlagSettingsCard() {
  const t = useTranslations('ads.flagSettings');
  const settings = useQuery(orpc.ads.flagSettings.queryOptions());
  const stored = settings.data ? formOf(settings.data.set) : EMPTY;
  // What the member typed; until they type, the form is the stored setting (so a save, or another admin's save, shows at once).
  const [draft, setDraft] = useState<FlagForm | null>(null);
  const form = draft ?? stored;
  // The saved setting goes into the cache before the draft is dropped, so the fields never show the old values while the read is repeated.
  const save = useMutation(
    orpc.ads.setFlagSettings.mutationOptions({
      onSuccess: async (saved) => {
        queryClient.setQueryData(orpc.ads.flagSettings.queryOptions().queryKey, saved);
        setDraft(null);
        toast(t('savedToast'));
        await refresh();
      },
    }),
  );
  if (settings.isError) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t('error')}
      </p>
    );
  }
  if (!settings.data) return null;
  const defaults = settings.data.defaults;
  const wrong = wrongFlagFields(form);
  const changed = !sameForm(form, stored);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (wrong.length > 0 || !changed) return;
    save.mutate({ ...settingOf(form), idempotencyKey: crypto.randomUUID() });
  };
  const useDefaults = () => save.mutate({ ...settingOf(EMPTY), idempotencyKey: crypto.randomUUID() });
  const field = (name: FlagField) => (
    <Field label={t(`fields.${name}`)} hint={t('default', { value: String(defaults[name]) })} error={isFlagFieldValid(name, form[name]) ? undefined : t('invalid')}>
      {(control) => <Input {...control} inputMode={name === 'dayFactor' || name === 'cprFactor' ? 'decimal' : 'numeric'} value={form[name]} disabled={save.isPending} placeholder={String(defaults[name])} onChange={(e) => setDraft({ ...form, [name]: e.target.value })} />}
    </Field>
  );
  return (
    <section aria-labelledby="ads-flag-settings-title" className="space-y-3">
      <h2 id="ads-flag-settings-title" className="text-base font-semibold text-foreground">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      <form onSubmit={submit} className="space-y-3" aria-label={t('title')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {field('paceMinDays')}
          {field('dayFactor')}
          {field('cprFactor')}
          {field('cprMinResults')}
          {field('cprMinHistoryDays')}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button loading={save.isPending} type="submit" size="lg" disabled={wrong.length > 0 || !changed}>
            {t('save')}
          </Button>
          <Button type="button" variant="outline" size="lg" disabled={save.isPending || sameForm(stored, EMPTY)} onClick={useDefaults}>
            {t('useDefaults')}
          </Button>
        </div>
      </form>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </section>
  );
}
