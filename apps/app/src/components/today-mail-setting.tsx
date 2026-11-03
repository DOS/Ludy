// SPDX-License-Identifier: AGPL-3.0-only
// The member's opt-in to the daily "Hôm nay cần bạn" brief by email (issue #2406), in their notification settings: off by default,
// theirs alone, and only sent when the server has mail. The mail's unsubscribe link opens this page with `?todayMail=off`: that
// shows a one-click "Turn off" (a plain visit changes nothing, so a mail scanner cannot unsubscribe anyone).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';

// The link in the mail asks to turn the mail off.
const asksToTurnOff = () => {
  try {
    return new URLSearchParams(window.location.search).get('todayMail') === 'off';
  } catch {
    return false;
  }
};

export function TodayMailSetting() {
  const t = useTranslations('notifications.todayMail');
  const queryClient = useQueryClient();
  // The mail is written in the language the member uses in the app when they turn it on.
  const language = useLocale() === 'en' ? 'en' : 'vi';
  const setting = useQuery(orpc.today.mail.get.queryOptions());
  const set = useMutation({
    mutationFn: (enabled: boolean) => client.today.mail.set({ enabled, language }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.today.mail.get.queryOptions().queryKey }),
  });
  const mailOn = getConfig().mailEnabled;
  const enabled = set.isPending ? set.variables === true : (setting.data?.enabled ?? false);
  return (
    <Card className="block space-y-3 p-4" data-testid="today-mail-setting">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('title')}</h2>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {asksToTurnOff() && enabled && (
        <Alert role="status" className="flex flex-wrap items-center justify-between gap-2">
          <AlertDescription>{t('turnOffAsked')}</AlertDescription>
          <Button size="sm" loading={set.isPending} onClick={() => set.mutate(false)}>
            {t('turnOff')}
          </Button>
        </Alert>
      )}
      {asksToTurnOff() && !enabled && setting.isSuccess && <p className="text-sm text-success">{t('turnedOff')}</p>}
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={enabled} disabled={setting.isPending || set.isPending} onCheckedChange={(checked) => set.mutate(checked === true)} />
        {t('label')}
      </label>
      {!mailOn && <p className="text-xs text-subtle-foreground">{t('noMail')}</p>}
      {(setting.error || set.error) && <ErrorText>{errorMessage(setting.error ?? set.error)}</ErrorText>}
    </Card>
  );
}
