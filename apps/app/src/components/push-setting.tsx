// SPDX-License-Identifier: AGPL-3.0-only
// Browser push on this device (#1238, the kernel's since #3736): hidden when the deployment has no VAPID keys. Turning it on asks the browser for permission, subscribes it and saves the subscription as the
// viewer's; off removes both. The viewer's other devices are listed with a way to remove each. One subscription serves every app's notices, so this sits in Settings (Thông báo của tôi) and on Social's
// notification settings alike.
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { PushDenied, currentEndpoint, deviceOf, disablePush, enablePush, pushPermission, pushSupported } from '../lib/push.ts';
import { ErrorText } from './ui.tsx';

export function PushSetting() {
  const t = useTranslations('notifications');
  const f = useFormat();
  const supported = pushSupported();
  // undefined while the browser is asked for its subscription.
  const [endpoint, setEndpoint] = useState<string | null | undefined>(supported ? undefined : null);
  const [denied, setDenied] = useState(() => pushPermission() === 'denied');
  useEffect(() => {
    if (!supported) return;
    let gone = false;
    currentEndpoint()
      .then((e) => !gone && setEndpoint(e))
      .catch(() => !gone && setEndpoint(null));
    return () => {
      gone = true;
    };
  }, [supported]);
  const status = useQuery({ ...orpc.notifications.push.status.queryOptions({ input: { endpoint: endpoint ?? null } }), enabled: endpoint !== undefined });
  const reload = () => void queryClient.invalidateQueries({ queryKey: orpc.notifications.push.status.key() });
  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) {
        const publicKey = status.data?.publicKey;
        if (!publicKey) return;
        const sub = await enablePush(publicKey);
        const device = deviceOf(navigator.userAgent);
        const label = device.browser && device.os ? t('pushDevice', { browser: device.browser, os: device.os }) : (device.browser ?? device.os ?? undefined);
        await client.notifications.push.subscribe({ ...sub, ...(label ? { label } : {}) });
        setEndpoint(sub.endpoint);
      } else {
        if (endpoint) await client.notifications.push.unsubscribe({ endpoint });
        await disablePush();
        setEndpoint(null);
      }
    },
    onError: (error) => {
      if (error instanceof PushDenied) setDenied(true);
    },
    onSettled: reload,
  });
  const remove = useMutation({ mutationFn: (id: string) => client.notifications.push.unsubscribe({ id }), onSettled: reload });
  if (!status.data?.enabled) return null;
  const on = toggle.isPending && toggle.variables !== undefined ? toggle.variables : status.data.subscribed;
  const devices = status.data.devices;
  return (
    <div className="space-y-2 border-t pt-3" data-testid="push-setting">
      <label className="flex items-start gap-2 text-sm text-muted-foreground">
        <Checkbox checked={supported && on} disabled={!supported || toggle.isPending || (denied && !on)} onCheckedChange={(checked) => toggle.mutate(checked === true)} />
        <span>
          <span className="block text-foreground">{t('push')}</span>
          <span className="block text-xs text-subtle-foreground">{!supported ? t('pushUnsupported') : denied && !on ? t('pushDenied') : t('pushHint')}</span>
        </span>
      </label>
      {devices.length > 0 && (
        <div className="space-y-1 pl-6">
          <p className="text-xs font-medium text-muted-foreground">{t('pushDevices')}</p>
          <ul className="space-y-1">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 text-xs text-subtle-foreground">
                <span className="min-w-0 truncate">
                  {d.label ?? t('pushUnknownDevice')}
                  {d.current ? ` (${t('pushThisDevice')})` : ''} · {t('pushSince', { date: f.date(d.createdAt) })}
                </span>
                {!d.current && (
                  <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(d.id)}>
                    {t('pushRemove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(toggle.error && !(toggle.error instanceof PushDenied)) || remove.error ? <ErrorText>{errorMessage(toggle.error ?? remove.error)}</ErrorText> : null}
    </div>
  );
}
