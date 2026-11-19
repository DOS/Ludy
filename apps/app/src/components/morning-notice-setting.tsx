// SPDX-License-Identifier: AGPL-3.0-only
// The member's opt-in to the morning notice of the day's meetings (#3955, part B), in their notification settings: off by default, theirs alone, at a time of day they pick in their own time zone (the browser's, taken
// when they turn it on or change the time). The notice, in the app and by mail, says only how many meetings they have today and links to the meetings page: no title, no name, no word of a brief. One more switch
// of the same page (the kind "Meetings today") mutes it too.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import { MORNING_DEFAULT_MINUTE, type MorningState } from '@crove/kernel-contract';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';

// "07:30" and 450 are the same time of day.
export const minuteToTime = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export function timeToMinute(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute <= 1439 ? minute : null;
}

// The browser's zone, else Vietnam's: the notice is for people working in Vietnam first.
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
}

export function MorningNoticeSetting() {
  const t = useTranslations('notifications.morningNotice');
  const queryClient = useQueryClient();
  // The mail is written in the language the member uses in the app when they turn it on.
  const language = useLocale() === 'en' ? 'en' : 'vi';
  const setting = useQuery(orpc.meetings.morning.get.queryOptions({ input: {} }));
  const set = useMutation({
    mutationFn: (input: { enabled: boolean; minute: number }) => client.meetings.morning.set({ enabled: input.enabled, minute: input.minute, timeZone: browserZone(), language }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.meetings.morning.get.queryOptions({ input: {} }).queryKey }),
  });
  const state: MorningState | undefined = setting.data;
  const minute = set.isPending ? set.variables.minute : (state?.minute ?? MORNING_DEFAULT_MINUTE);
  const enabled = set.isPending ? set.variables.enabled : (state?.enabled ?? false);
  const mailOn = getConfig().mailEnabled;
  return (
    <Card className="block space-y-3 p-4" data-testid="morning-notice-setting">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('title')}</h2>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={enabled} disabled={setting.isPending || set.isPending} onCheckedChange={(checked) => set.mutate({ enabled: checked === true, minute })} />
        {t('label')}
      </label>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        {t('at')}
        <Input
          type="time"
          aria-label={t('at')}
          className="w-32"
          value={minuteToTime(minute)}
          disabled={!enabled || setting.isPending || set.isPending}
          onChange={(e) => {
            const next = timeToMinute(e.target.value);
            if (next !== null) set.mutate({ enabled: true, minute: next });
          }}
          data-testid="morning-notice-time"
        />
      </label>
      {enabled && <p className="text-xs text-subtle-foreground">{t('zone', { zone: state?.timeZone ?? browserZone() })}</p>}
      {!mailOn && <p className="text-xs text-subtle-foreground">{t('noMail')}</p>}
      {(setting.error || set.error) && <ErrorText>{errorMessage(setting.error ?? set.error)}</ErrorText>}
    </Card>
  );
}
