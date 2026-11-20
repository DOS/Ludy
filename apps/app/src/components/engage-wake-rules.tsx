// SPDX-License-Identifier: AGPL-3.0-only
// Settings "Khi nào nhắc việc" (Engage's wake rules, #3862, E3 of epic #3857): the three numbers at which the inbox and the CRM raise work, both on Home and, when the org connected an AI coworker (Dy, Uy), as
// a wake-up that carries ids and dates only. Owners and admins change them (the command already refuses anyone else, and Settings shows the card to them only); with no choice the defaults apply. It lives in
// Settings, not on the inbox screen. The AI coworker here: none acts in this card; it only says when a coworker is called in, and a person still sends, approves and spends.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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
  const key = orpc.conversations.wakeRules.queryKey({ input: {} });
  const current = useQuery(orpc.conversations.wakeRules.queryOptions({ input: {} }));
  // What the person changed and has not been answered for yet, laid over what is stored (the cache). Every change sends all three numbers as the card shows them, so the last change is the last save and
  // an earlier one is never undone; saves run one after another. A ref beside the state keeps the newest overlay for a click that comes before the next render.
  const [overlay, setOverlay] = useState<Partial<EngageWakeRules>>({});
  const overlayRef = useRef<Partial<EngageWakeRules>>({});
  const inFlight = useRef(0);
  const put = (next: Partial<EngageWakeRules>) => {
    overlayRef.current = next;
    setOverlay(next);
  };
  const set = useMutation({
    scope: { id: 'engage-wake-rules' },
    mutationFn: (rules: EngageWakeRules) => client.conversations.setWakeRules(rules),
    // Each answer is the new stored truth, kept in the cache (the saves are in order, so the last answer is the last stored); the overlay is dropped only once no save is left, whatever the last one did, and a refetch settles
    // the card on what is stored: a failed save leaves nothing of it on the card.
    onSuccess: (saved) => queryClient.setQueryData(key, saved),
    onSettled: () => {
      inFlight.current -= 1;
      if (inFlight.current <= 0) {
        inFlight.current = 0;
        put({});
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
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
  const { isDefault, ...stored } = current.data;
  const rules: EngageWakeRules = { ...stored, ...overlay };
  const change = (field: keyof EngageWakeRules, value: number) => {
    const shown: EngageWakeRules = { ...(queryClient.getQueryData<EngageWakeRules>(key) ?? stored), ...overlayRef.current };
    const next = { ...shown, [field]: value };
    put({ ...overlayRef.current, [field]: value });
    inFlight.current += 1;
    set.mutate({ unansweredHours: next.unansweredHours, replyWindowHours: next.replyWindowHours, quoteDays: next.quoteDays });
  };
  return (
    <Card className="block space-y-3 p-4" data-testid="engage-wake-rules">
      {heading}
      <p className="text-xs text-muted-foreground">{t('wake.hint')}</p>
      <div className="grid gap-3 md:grid-cols-3">
        {FIELDS.map((field) => {
          const [min, max] = ENGAGE_WAKE_BOUNDS[field];
          // The saved value is always shown, even one outside the short list (set another way), so the select never lies about it.
          const values = [...new Set([...CHOICES[field], rules[field]])].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
          return (
            <label key={field} className="flex flex-col gap-1 text-sm">
              <span>{t(`wake.${field}`)}</span>
              {/* Never disabled while saving, so the keyboard keeps its place; 44 px high on a phone. */}
              <NativeSelect
                className="w-full [&_select]:h-11 md:[&_select]:h-8"
                value={String(rules[field])}
                aria-busy={set.isPending}
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
      </div>
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </Card>
  );
}
