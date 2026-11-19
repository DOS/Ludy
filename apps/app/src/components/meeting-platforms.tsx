// SPDX-License-Identifier: AGPL-3.0-only
// "Kết nối nền tảng họp" in Settings (meetings integrations C1, #3173): the member's own meeting platform connections, when each was last listed, a refresh, a disconnect that asks first,
// and the connect button of each provider this deployment offers: the offline sandbox where the deployment's test channels are on, and Zoom (C3, #3175) and Microsoft Teams (C4, #3176) where the
// deployment has its own app; Google Meet comes in a later step and is not offered. Ludy only lists recordings through a connection; the import is a click on the Meetings tab. The core works with AI off: no model is called here.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MeetingPlatformConnectProvider, MeetingPlatformConnectionView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { MEETINGS_TEAMS_GUIDE, errorKey } from '../lib/meeting-platform.ts';
import { adminConsentLink, rememberAdminLink } from '../lib/calendar-oauth.ts';
import { rememberOAuthAttempt } from '../lib/oauth.ts';
import { toast } from '../lib/toast.ts';
import { meetingsInstalled } from './linked-meetings.tsx';
import { ErrorText, RowsSkeleton } from './ui.tsx';

const refreshAll = () => queryClient.invalidateQueries({ queryKey: orpc.meetingPlatform.key() });

function ConnectionRow({ connection }: { connection: MeetingPlatformConnectionView }) {
  const t = useTranslations('meetings.platform.settings');
  const tp = useTranslations('meetings.platform');
  const f = useFormat();
  const [confirm, setConfirm] = useState(false);
  const refresh = useMutation({
    mutationFn: () => orpc.meetingPlatform.refresh.call({ connectionId: connection.id }),
    onSuccess: async () => {
      toast(t('refreshed'), 'success');
      await refreshAll();
    },
  });
  // The server refuses while a download from this connection is in flight (MEETING_PLATFORM_BUSY); the error catalog words it.
  const disconnect = useMutation({
    // The connection's recording rows go with it, so the empty meetings its failed tries left are cleaned first, by the same rule as a retry; that step is best effort and never blocks the disconnect.
    mutationFn: async () => {
      await orpc.meetings.importDiscardEmpty.call({ connectionId: connection.id }).catch(() => undefined);
      return orpc.meetingPlatform.disconnect.call({ connectionId: connection.id });
    },
    onSuccess: async () => {
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.list.key() });
      await refreshAll();
    },
  });
  const name = `${tp(`provider.${connection.provider}`)}: ${connection.displayName}`;
  const expired = connection.status === 'expired';
  return (
    <li className="py-3 text-sm" data-testid="meeting-platform-connection">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
            <span className="min-w-0 break-words">{name}</span>
            <Badge variant={expired ? 'destructive' : 'secondary'}>{expired ? t('statusExpired') : t('statusActive')}</Badge>
          </p>
          <p className="text-xs text-subtle-foreground">{connection.lastSyncedAt ? t('lastListed', { time: f.dateTime(connection.lastSyncedAt) }) : t('neverListed')}</p>
          {connection.statusReason && (
            <p className="text-xs text-destructive" data-testid="meeting-platform-reason">
              {t('reason', { reason: tp(`errors.${errorKey(connection.statusReason)}`) })}
            </p>
          )}
        </div>
        {confirm ? (
          <div className="flex shrink-0 flex-wrap gap-2" role="alertdialog" aria-label={t('disconnectOf', { name })} data-testid="meeting-platform-confirm">
            <Button size="sm" variant="destructive" loading={disconnect.isPending} disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              {t('disconnectYes')}
            </Button>
            <Button size="sm" variant="outline" disabled={disconnect.isPending} onClick={() => setConfirm(false)}>
              {t('disconnectNo')}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" loading={refresh.isPending} disabled={refresh.isPending} aria-label={t('refreshOf', { name })} onClick={() => refresh.mutate()}>
              {t('refresh')}
            </Button>
            <Button type="button" size="sm" variant="ghost" aria-label={t('disconnectOf', { name })} onClick={() => setConfirm(true)}>
              {t('disconnect')}
            </Button>
          </div>
        )}
      </div>
      {confirm && <p className="mt-2 text-xs text-muted-foreground">{t('disconnectAsk', { name })}</p>}
      {refresh.error && <ErrorText>{errorMessage(refresh.error)}</ErrorText>}
      {disconnect.error && <ErrorText>{errorMessage(disconnect.error)}</ErrorText>}
    </li>
  );
}

export function MeetingPlatforms({ canConnect }: { canConnect: boolean }) {
  const t = useTranslations('meetings.platform.settings');
  const on = meetingsInstalled();
  const connections = useQuery({ ...orpc.meetingPlatform.connections.queryOptions(), enabled: on });
  const connectSandbox = useMutation({
    mutationFn: () => orpc.meetingPlatform.connectSandbox.call({}),
    onSuccess: async () => {
      toast(t('connectedToast'), 'success');
      await refreshAll();
    },
  });
  // The platforms with a connect dialog this deployment can finish (the app credentials and a credential key are set); empty hides the buttons.
  const providers = useQuery({ ...orpc.meetingPlatform.providers.queryOptions(), enabled: on && canConnect });
  const start = useMutation({
    mutationFn: (provider: MeetingPlatformConnectProvider) => client.meetingPlatform.connectStart({ provider }),
    onSuccess: (attempt) => {
      // The org the screen is showing: the platform sends the browser back to one address for every org.
      const slug = getCurrentOrg();
      if (slug) rememberOAuthAttempt(attempt.state, slug);
      // A Microsoft tenant may need its administrator's consent: the address for them is kept with the attempt, so the return page can show it. Null for any other platform's address.
      const adminLink = adminConsentLink(attempt.authorizeUrl);
      if (adminLink) rememberAdminLink(attempt.state, adminLink);
      window.location.assign(attempt.authorizeUrl);
    },
  });
  if (!on) return null;
  const offeredZoom = canConnect && (providers.data ?? []).includes('zoom');
  const offeredTeams = canConnect && (providers.data ?? []).includes('microsoft_teams');
  // The offline test platform is offered only where the deployment turned its test channels on (the same switch as the channels screen).
  const sandbox = getConfig().channels?.sandbox ?? false;
  // A test connection left from a build with the test channels on is hidden where they are off, so an owner never sees one (ST-4).
  const rows = (connections.data ?? []).filter((c) => sandbox || c.provider !== 'sandbox');
  const offerSandbox = canConnect && sandbox && !rows.some((c) => c.provider === 'sandbox');
  return (
    <Card className="block space-y-3 p-4" data-testid="meeting-platforms">
      <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {connections.isPending && !connections.error && (
        <div data-testid="meeting-platforms-loading" aria-label={t('loading')}>
          <RowsSkeleton rows={2} />
        </div>
      )}
      {connections.error && <ErrorText>{errorMessage(connections.error)}</ErrorText>}
      {connections.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="meeting-platforms-empty">
          {t('none')}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y">
          {rows.map((c) => (
            <ConnectionRow key={c.id} connection={c} />
          ))}
        </ul>
      )}
      {offerSandbox && (
        <div>
          <Button type="button" variant="outline" size="sm" loading={connectSandbox.isPending} disabled={connectSandbox.isPending} onClick={() => connectSandbox.mutate()} data-testid="meeting-platform-connect-sandbox">
            {t('connectSandbox')}
          </Button>
        </div>
      )}
      {connectSandbox.error && <ErrorText>{errorMessage(connectSandbox.error)}</ErrorText>}
      {offeredZoom && (
        <div className="space-y-2">
          <Button type="button" variant="outline" size="sm" loading={start.isPending} disabled={start.isPending} onClick={() => start.mutate('zoom')} data-testid="meeting-platform-connect-zoom">
            {t('connectZoom')}
          </Button>
          <p className="text-xs text-subtle-foreground" data-testid="meeting-platform-zoom-note">
            {t('zoomNote')}
          </p>
        </div>
      )}
      {offeredTeams && (
        <div className="space-y-2">
          <Button type="button" variant="outline" size="sm" loading={start.isPending} disabled={start.isPending} onClick={() => start.mutate('microsoft_teams')} data-testid="meeting-platform-connect-teams">
            {t('connectTeams')}
          </Button>
          <p className="text-xs text-subtle-foreground" data-testid="meeting-platform-teams-note">
            {t('teamsNote')}
          </p>
          <p className="text-xs text-subtle-foreground" data-testid="meeting-platform-teams-cost">
            {t('teamsCost')}
          </p>
          <a href={MEETINGS_TEAMS_GUIDE} target="_blank" rel="noreferrer" className="text-xs font-medium text-primary hover:underline" data-testid="meeting-platform-teams-guide">
            {t('teamsGuide')}
          </a>
        </div>
      )}
      {start.error && <ErrorText>{errorMessage(start.error)}</ErrorText>}
      <p className="text-xs text-subtle-foreground">{t('moreLater')}</p>
    </Card>
  );
}
