// SPDX-License-Identifier: AGPL-3.0-only
// The member's opt-in to the weekly notice of the week's meetings (#4967), in their notification settings: off by default, theirs alone, on Monday at a time of day they pick in their own time zone (the browser's,
// taken when they turn it on or change the time). The notice, in the app and by mail, says only a few numbers (the meetings they read with a published result in the last 7 days, the decisions published, the open
// action items and the overdue ones) and links to the "This week" card: no title, no name, no word of a decision. One more switch of the same page (the kind "Last week's meetings") mutes it too.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { WEEKLY_DEFAULT_MINUTE, WEEKLY_KIND, type WeeklyState } from '@ludy/kernel-contract';
import { Card } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Input } from '@ludy/ui/components/input';
import { ErrorText } from './ui.tsx';
import { minuteToTime, timeToMinute } from './morning-notice-setting.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { toast } from '../lib/toast.ts';

// The browser's zone, else Vietnam's: the notice is for people working in Vietnam first.
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
}

export function WeeklyNoticeSetting({ muted = false }: { muted?: boolean }) {
  const t = useTranslations('notifications.weeklyNotice');
  const queryClient = useQueryClient();
  // The mail is written in the language the member uses in the app when they turn it on.
  const language = useLocale() === 'en' ? 'en' : 'vi';
  const setting = useQuery(orpc.meetings.weekly.get.queryOptions({ input: {} }));
  const set = useMutation({
    mutationFn: async (input: { enabled: boolean; minute: number }) => {
      // One switch: turning the notice on also lifts an earlier mute of its kind in the notification settings, or nothing would ever be sent.
      if (input.enabled && muted) await client.notifications.mute({ kind: WEEKLY_KIND, muted: false });
      return client.meetings.weekly.set({ enabled: input.enabled, minute: input.minute, timeZone: browserZone(), language });
    },
    // Saving is silent otherwise (the switch moves, a time is saved when its field is left): the toaster is a live region, so a screen reader hears that it was kept (WCAG 4.1.3).
    onSuccess: () => toast(t('saved'), 'success'),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.weekly.get.queryOptions({ input: {} }).queryKey });
      void queryClient.invalidateQueries({ queryKey: orpc.notifications.list.key() });
    },
  });
  const state: WeeklyState | undefined = setting.data;
  const minute = set.isPending ? set.variables.minute : (state?.minute ?? WEEKLY_DEFAULT_MINUTE);
  const enabled = set.isPending ? set.variables.enabled : (state?.enabled ?? false);
  const mailOn = getConfig().mailEnabled;
  // The time is saved when the field is left (a browser fires a change for each part of a time while it is typed).
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const next = draft === null ? null : timeToMinute(draft);
    setDraft(null);
    if (next !== null && next !== minute) set.mutate({ enabled: true, minute: next });
  };
  return (
    <Card className="block space-y-3 p-4" data-testid="weekly-notice-setting">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('title')}</h2>
        <p id="weekly-notice-hint" className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={enabled} aria-describedby="weekly-notice-hint" disabled={setting.isPending || set.isPending} onCheckedChange={(checked) => set.mutate({ enabled: checked === true, minute })} />
        {t('label')}
      </label>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        {t('at')}
        <Input
          type="time"
          aria-label={t('at')}
          aria-describedby={enabled ? 'weekly-notice-zone' : undefined}
          className="w-32"
          value={draft ?? minuteToTime(minute)}
          disabled={!enabled || setting.isPending}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          data-testid="weekly-notice-time"
        />
      </label>
      {enabled && <p id="weekly-notice-zone" className="text-xs text-subtle-foreground">{t('zone', { zone: state?.timeZone ?? browserZone() })}</p>}
      {!mailOn && <p className="text-xs text-subtle-foreground">{t('noMail')}</p>}
      {(setting.error || set.error) && <ErrorText>{errorMessage(setting.error ?? set.error)}</ErrorText>}
    </Card>
  );
}
