// SPDX-License-Identifier: AGPL-3.0-only
// The member's notification preferences (NT-1, #3592), moved here from the bottom of the bell's screen: which kinds of notice they get, then the daily brief by email. Both are theirs alone
// (a mute is per member and org), so the card is the tab "Thông báo của tôi". The bell's screen keeps the list and a link here. No AI acts on this card: a person switches kinds.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { MORNING_KIND } from '@crove/kernel-contract';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { ErrorText } from '../../components/ui.tsx';
import { Anchor } from './frame.tsx';
import { SETTINGS_CARD } from './tabs.ts';
import { meetingsInstalled } from '../../components/linked-meetings.tsx';
import { MorningNoticeSetting } from '../../components/morning-notice-setting.tsx';
import { TodayMailSetting } from '../../components/today-mail-setting.tsx';
import { client, errorMessage, orpc, queryClient } from '../../lib/api.ts';
import { installedModules, useModulesVersion } from '../../lib/org-modules.ts';
import { kindKey, notificationKinds, type KnownNotificationKind } from '../../lib/notifications.ts';

// The list the bell reads carries the member's mutes, so the card shares its cache entry and a switch here shows in the bell at once.
const refresh = () =>
  void queryClient.invalidateQueries({
    queryKey: orpc.notifications.list.key(),
  });

export function NotificationPreferences() {
  const t = useTranslations('notifications');
  useModulesVersion(); // the apps of the org can change while this screen is open
  const kinds = notificationKinds(installedModules());
  const list = useQuery(orpc.notifications.list.queryOptions({ input: {} }));
  const muted = list.data?.muted ?? [];
  const mute = useMutation({
    mutationFn: (v: { kind: KnownNotificationKind; muted: boolean }) => client.notifications.mute(v),
    onSettled: refresh,
  });
  return (
    <>
      <Anchor id={SETTINGS_CARD.notifications}>
        <Card className="block space-y-3 p-4" data-testid="notification-preferences">
          <div>
            <h2 className="text-sm font-medium text-foreground">{t('prefsTitle')}</h2>
            <p className="text-xs text-subtle-foreground">{t('settingsHint')}</p>
          </div>
          <fieldset className="space-y-2" disabled={!list.data}>
            <legend className="mb-2 text-sm text-muted-foreground">{t('settings')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {kinds.map((kind) => {
                const on = mute.isPending && mute.variables?.kind === kind ? !mute.variables.muted : !muted.includes(kind);
                return (
                  <label key={kind} className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground md:min-h-0">
                    <Checkbox checked={on} disabled={mute.isPending} onCheckedChange={(checked) => mute.mutate({ kind, muted: checked !== true })} />
                    {t(`kinds.${kindKey(kind)}`)}
                  </label>
                );
              })}
            </div>
          </fieldset>
          {(list.error || mute.error) && <ErrorText>{errorMessage(list.error ?? mute.error)}</ErrorText>}
        </Card>
      </Anchor>
      {/* The daily "Hôm nay cần bạn" brief by email: the member's own opt-in (#2406). The mail's turn-off link lands on this card with ?todayMail=off. */}
      <Anchor id={SETTINGS_CARD.todayMail}>
        <TodayMailSetting />
      </Anchor>
      {/* The opt-in morning notice of the day's meetings (#3955): the member's own, with the meetings app. */}
      {meetingsInstalled() && <MorningNoticeSetting muted={muted.includes(MORNING_KIND)} />}
    </>
  );
}
