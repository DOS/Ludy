// SPDX-License-Identifier: AGPL-3.0-only
// The member's outside calendars in Settings (issue #2123, part of #1374): connect Google Calendar, see when each last
// synced, disconnect. The busy times of a connected calendar block booking slots; only start and end are read. With no
// OAuth app configured no connect button is shown and the card says so in a line. A viewer has no
// calendar of their own to connect.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { CalendarConnectionView, CalendarOAuthProvider } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { meetingsInstalled } from '../components/linked-meetings.tsx';
import { ErrorText } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { adminConsentLink, oauthProviderOf, rememberAdminLink } from '../lib/calendar-oauth.ts';
import { rememberOAuthAttempt } from '../lib/oauth.ts';

// The longer words of an option, folded behind "Tìm hiểu thêm" (#3650): one short line shows, the permissions and what is kept are one click away.
function More({ children }: { children: React.ReactNode }) {
  const t = useTranslations('workingHours');
  return (
    <details className="mt-0.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer text-link">{t('externalMore')}</summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.calendar.connections.key() });
// The member's own meetings list (B1) follows the switch: it is shown or emptied as soon as the switch changes.
const refreshAgenda = () => Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: orpc.meetings.agenda.key() })]);

function ConnectionRow({
  connection,
  canEdit,
  onAllowWriteBack,
  onAllowReadEvents,
}: {
  connection: CalendarConnectionView;
  canEdit: boolean;
  onAllowWriteBack: () => void;
  onAllowReadEvents: () => void;
}) {
  const t = useTranslations('workingHours');
  const f = useFormat();
  const disconnect = useMutation(orpc.calendar.disconnect.mutationOptions({ onSuccess: refresh }));
  const writeBack = useMutation(orpc.calendar.setWriteBack.mutationOptions({ onSuccess: refresh }));
  const readEvents = useMutation(orpc.meetings.agenda.setReadEvents.mutationOptions({ onSuccess: refreshAgenda }));
  // Writing appointments is Google's for now, for a member who edits, on a connection that works.
  const offerWriteBack = canEdit && connection.provider === 'google' && connection.status === 'active';
  // Reading the names and times of the member's own meetings (B1, B3): offered with the meetings module, for a Google or Microsoft connection that works. Off until the member ticks it; Google
  // asks its own consent for it, Microsoft's carries it from the connect.
  const offerReadEvents = canEdit && oauthProviderOf(connection.provider) !== null && connection.status === 'active' && meetingsInstalled();
  const microsoft = connection.provider === 'microsoft';
  const note =
    connection.status === 'expired'
      ? t('externalExpired')
      : connection.statusReason
        ? t('externalFailed')
        : connection.lastSyncedAt
          ? t('externalSynced', { time: f.dateTime(connection.lastSyncedAt) })
          : t('externalNeverSynced');
  return (
    <li className="py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {t(`externalProviders.${connection.provider}`)}: {connection.displayName}
        </span>
        <span className={connection.status === 'expired' || connection.statusReason ? 'block text-xs text-destructive' : 'block text-xs text-subtle-foreground'}>{note}</span>
      </span>
      <ConfirmDialog
        render={<Button type="button" variant="ghost" size="sm" disabled={disconnect.isPending} aria-label={t('externalDisconnectOf', { name: connection.displayName })} />}
        title={t('externalDisconnectTitle', { name: connection.displayName })}
        description={t('externalDisconnectDescription')}
        confirm={t('externalDisconnect')}
        destructive
        onConfirm={() => disconnect.mutate({ connectionId: connection.id })}
      >
        {t('externalDisconnect')}
      </ConfirmDialog>
      </div>
      {offerWriteBack &&
        (connection.canWriteBack ? (
          <label className="mt-1 flex items-start gap-2 text-xs text-muted-foreground">
            <Checkbox checked={connection.writeBack} disabled={writeBack.isPending} onCheckedChange={(on) => writeBack.mutate({ connectionId: connection.id, enabled: on === true })} />
            <span>
              <span className="font-medium text-foreground">{t('externalWriteBack')}</span>
              <More>
                <p>{t('externalWriteBackHint')}</p>
              </More>
            </span>
          </label>
        ) : (
          <div className="mt-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t('externalWriteBack')}</p>
            <More>
              <p>{t('externalWriteBackHint')}</p>
            </More>
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={onAllowWriteBack}>
              {t('externalAllowWriteBack')}
            </Button>
          </div>
        ))}
      {writeBack.error && <ErrorText>{errorMessage(writeBack.error)}</ErrorText>}
      {offerReadEvents &&
        (connection.canReadEvents ? (
          <label className="mt-1 flex items-start gap-2 text-xs text-muted-foreground">
            <Checkbox checked={connection.readEvents} disabled={readEvents.isPending} onCheckedChange={(on) => readEvents.mutate({ connectionId: connection.id, enabled: on === true })} data-testid="calendar-read-events" />
            <span>
              <span className="font-medium text-foreground">{t('externalReadEvents')}</span>
              <More>
                <p>{microsoft ? t('externalReadEventsHintMicrosoft') : t('externalReadEventsHint')}</p>
              </More>
            </span>
          </label>
        ) : (
          <div className="mt-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t('externalReadEvents')}</p>
            <More>
              <p>{microsoft ? t('externalReadEventsHintMicrosoft') : t('externalReadEventsHint')}</p>
            </More>
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={onAllowReadEvents} data-testid="calendar-allow-read-events">
              {t('externalAllowReadEvents')}
            </Button>
          </div>
        ))}
      {readEvents.error && <ErrorText>{errorMessage(readEvents.error)}</ErrorText>}
      {microsoft && (
        <div data-testid="calendar-microsoft-note">
          <More>
            <p>{t('externalMicrosoftNote')}</p>
          </More>
        </div>
      )}
    </li>
  );
}

// Connecting again grants exactly what is asked, so the plain button asks for the capabilities the member's Google connection already has (it must not drop write-back or the read of meetings).
function keepOf(rows: readonly CalendarConnectionView[]): { writeBack?: boolean; readEvents?: boolean } {
  const google = rows.find((c) => c.provider === 'google');
  return { ...(google?.canWriteBack ? { writeBack: true } : {}), ...(google?.canReadEvents ? { readEvents: true } : {}) };
}

export function ExternalCalendars({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('workingHours');
  const providers = useQuery(orpc.calendar.providers.queryOptions());
  const connections = useQuery(orpc.calendar.connections.queryOptions());
  const start = useMutation({
    // A connect again grants exactly the scopes asked that time, so asking for one capability keeps the other the connection already has.
    mutationFn: (v: { provider: CalendarOAuthProvider; writeBack?: boolean; readEvents?: boolean }) =>
      client.calendar.connectStart({ provider: v.provider, ...(v.writeBack ? { writeBack: true } : {}), ...(v.readEvents ? { readEvents: true } : {}) }),
    onSuccess: (attempt) => {
      // The org the screen is showing: the provider sends the browser back to one address for every org.
      const slug = getCurrentOrg();
      if (slug) rememberOAuthAttempt(attempt.state, slug);
      // For a Microsoft tenant that turns out to need its administrator: the address to hand them, kept for the callback page.
      const link = adminConsentLink(attempt.authorizeUrl);
      if (link) rememberAdminLink(attempt.state, link);
      window.location.assign(attempt.authorizeUrl);
    },
  });
  const offered: readonly CalendarOAuthProvider[] = providers.data ?? [];
  const rows = connections.data ?? [];
  // Nothing to connect and nothing connected: the feature is not on here, which the card says in one line instead of vanishing (#3650).
  if (offered.length === 0 && rows.length === 0) {
    return (
      <div className="mt-4" aria-label={t('externalTitle')}>
        <p className="text-xs font-medium text-muted-foreground">{t('externalTitle')}</p>
        <p className="mt-1 text-xs text-subtle-foreground">{t('externalNotOn')}</p>
      </div>
    );
  }
  return (
    <div className="mt-4" aria-label={t('externalTitle')}>
      <p className="text-xs font-medium text-muted-foreground">{t('externalTitle')}</p>
      <p className="mt-1 text-xs text-subtle-foreground">{t('externalIntro')}</p>
      <More>
        <p>{t('externalIntroDetail')}</p>
        {(offered.includes('microsoft_calendar') || rows.some((c) => c.provider === 'microsoft')) && <p>{t('externalIntroMicrosoft')}</p>}
      </More>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-subtle-foreground">{t('externalNone')}</p>
      ) : (
        <ul className="mt-2 divide-y">
          {rows.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              canEdit={canEdit}
              onAllowWriteBack={() => start.mutate({ provider: 'google_calendar', writeBack: true, readEvents: c.canReadEvents })}
              onAllowReadEvents={() => start.mutate({ provider: oauthProviderOf(c.provider) ?? 'google_calendar', readEvents: true, ...(c.provider === 'google' ? { writeBack: c.canWriteBack } : {}) })}
            />
          ))}
        </ul>
      )}
      {canEdit && offered.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {offered.map((p) => (
            <Button key={p} loading={start.isPending && start.variables?.provider === p} type="button" variant="outline" size="sm" disabled={start.isPending} onClick={() => start.mutate({ provider: p, ...(p === 'google_calendar' ? keepOf(rows) : {}) })}>
              {t('externalConnect', { provider: t(`externalProviders.${p}`) })}
            </Button>
          ))}
        </div>
      )}
      {(start.error ?? connections.error) && <ErrorText>{errorMessage(start.error ?? connections.error)}</ErrorText>}
    </div>
  );
}
