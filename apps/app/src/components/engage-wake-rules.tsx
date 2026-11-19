// SPDX-License-Identifier: AGPL-3.0-only
// Settings "Khi nào nhắc việc" (Engage's wake rules, #3862, E3 of epic #3857): the three numbers at which the inbox and the CRM raise work, both on Home and, when the org connected an AI coworker (Dy, Uy), as
// a wake-up that carries ids and dates only. Owners and admins change them (the command already refuses anyone else, and Settings shows the card to them only); with no choice the defaults apply. It lives in
// Settings, not on the inbox screen. The AI coworker here: none acts in this card; it only says when a coworker is called in, and a person still sends, approves and spends.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { ENGAGE_WAKE_BOUNDS, type EngageWakeRules } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

// The values a person picks from: a short list, never a free number.
const CHOICES: Record<keyof EngageWakeRules, readonly number[]> = {
  unansweredHours: [1, 2, 4, 8, 12, 24, 48, 72],
  replyWindowHours: [1, 2, 3, 6, 12, 23],
  quoteDays: [2, 3, 5, 7, 10, 14, 30],
};

const FIELDS = ['unansweredHours', 'replyWindowHours', 'quoteDays'] as const;

export function EngageWakeRulesCard() {
  const t = useTranslations('conversations');
  const current = useQuery(orpc.conversations.wakeRules.queryOptions({ input: {} }));
  const set = useMutation({
    mutationFn: (rules: EngageWakeRules) => client.conversations.setWakeRules(rules),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.wakeRules.key() }),
  });
  const heading = <h2 className="text-sm font-medium text-muted-foreground">{t('wake.title')}</h2>;
  if (current.isError) {
    return (
      <Card className="block space-y-2 p-4" data-testid="engage-wake-rules-error">
        {heading}
        <ErrorText>{errorMessage(current.error)}</ErrorText>
        <Button type="button" size="sm" variant="outline" onClick={() => void current.refetch()}>
          {t('retention.retry')}
        </Button>
      </Card>
    );
  }
  if (!current.data) return null;
  const { isDefault, ...rules } = current.data;
  const change = (field: keyof EngageWakeRules, value: number) => set.mutate({ ...rules, [field]: value });
  return (
    <Card className="block space-y-3 p-4" data-testid="engage-wake-rules">
      {heading}
      <p className="text-xs text-muted-foreground">{t('wake.hint')}</p>
      {FIELDS.map((field) => {
        const [min, max] = ENGAGE_WAKE_BOUNDS[field];
        // The saved value is always shown, even one outside the short list (set another way), so the select never lies about it.
        const values = [...new Set([...CHOICES[field], rules[field]])].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
        return (
          <label key={field} className="flex flex-col gap-1 text-sm">
            <span>{t(`wake.${field}`)}</span>
            <NativeSelect
              value={String(rules[field])}
              disabled={set.isPending}
              data-testid={`engage-wake-${field}`}
              onChange={(e) => change(field, Number(e.target.value))}
            >
              {values.map((v) => (
                <option key={v} value={String(v)}>
                  {t(field === 'quoteDays' ? 'wake.days' : 'wake.hours', { n: v })}
                  {isDefault && v === rules[field] ? ` ${t('retention.default')}` : ''}
                </option>
              ))}
            </NativeSelect>
          </label>
        );
      })}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </Card>
  );
}
