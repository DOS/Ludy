// SPDX-License-Identifier: AGPL-3.0-only
// A member's own Google Calendar meetings, read to suggest "record this meeting" (Meetings B1, #3165). Two small pieces:
//   - TodayAgenda, on the meetings list: today's events of the member's own calendar, each with "Ghi cuộc họp này", which only opens the normal record screen with the title filled in (its
//     consent step always runs); an event already recorded shows the meeting. Off until the member switches the read on in Settings.
//   - AgendaAttach, on a meeting the member recorded: "Gắn vào sự kiện lịch này?" when exactly one event overlaps the recording (within 15 minutes), or the event the meeting is linked to.
// Nothing here uses a model, starts a recording or joins a call; a person clicks every step, and the events are the member's alone (the server's row security).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { joinServiceFromUrl, safeJoinUrl, type AgendaEvent } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { DataTable, Empty, ErrorText } from './ui.tsx';
import { meetingsInstalled } from './linked-meetings.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { BriefBody } from './meeting-brief.tsx';

// Where a join address leads, by its host: the badge names the service, never the address.
export function joinService(url: string | null): 'meet' | 'zoom' | 'teams' | null {
  return joinServiceFromUrl(url);
}

// Local calendar YYYY-MM-DD of an instant so f.date matches f.weekdayShort and f.time in the viewer's time zone.
function localDayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const refreshAgenda = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.meetings.agenda.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.meetings.today.key() });
};

// One event: its time, its title, the service of its join address and how many people are invited. `titleId` names the title for a link of the same row that has to say which event it acts on.
function EventLine({ event, titleId, showJoin = false }: { event: AgendaEvent; titleId?: string; showJoin?: boolean }) {
  const t = useTranslations('meetings.agenda');
  const f = useFormat();
  const service = joinService(event.joinUrl);
  const safeUrl = showJoin ? safeJoinUrl(event.joinUrl) : null;
  return (
    <>
      <span className="font-mono text-xs text-muted-foreground">
        {f.time(event.startsAt)}
        {' - '}
        {f.time(event.endsAt)}
      </span>
      <span id={titleId} className="min-w-0 break-words font-medium">{event.title === '' ? t('untitled') : event.title}</span>
      {service && <Badge variant="outline">{t(`service.${service}`)}</Badge>}
      {safeUrl && (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={titleId}
          className={buttonVariants({ variant: 'outline', size: 'sm', className: 'max-md:min-h-11' })}
          data-testid="meeting-agenda-join"
        >
          {t('join')}
        </a>
      )}
      {event.invitees > 0 && <span className="text-xs text-muted-foreground">{t('invitees', { count: String(event.invitees) })}</span>}
    </>
  );
}

function AgendaDisabledNotice({
  slug,
  providers,
  providersPending,
  providersError,
  showUnconfiguredHint,
  offTestId,
  unconfiguredTestId,
}: {
  slug: string;
  providers: readonly string[] | undefined;
  providersPending: boolean;
  providersError: unknown;
  showUnconfiguredHint: boolean;
  offTestId: string;
  unconfiguredTestId: string;
}) {
  const t = useTranslations('meetings.agenda');
  if ((providers ?? []).length > 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={offTestId}>
        {t('off')}{' '}
        <Link to="/o/$slug/settings/bookings" params={{ slug }} hash="booking-settings" className="font-medium text-foreground underline">
          {t('offLink')}
        </Link>
      </p>
    );
  }
  if (!showUnconfiguredHint || (providersPending && !providersError)) return null;
  return (
    <div data-testid={unconfiguredTestId}>
      <Empty title={t('unconfiguredTitle')} hint={t('unconfiguredHint')} />
    </div>
  );
}

export function TodayAgenda({ slug, showUnconfiguredHint = false }: { slug: string; showUnconfiguredHint?: boolean }) {
  const t = useTranslations('meetings.agenda');
  const on = meetingsInstalled();
  // The Today view (#3955): today's events with the facts of each one's brief, read as the member in one call (no model runs; Vy's sentences stay the brief's own click).
  const agenda = useQuery({ ...orpc.meetings.today.facts.queryOptions({ input: {} }), enabled: on, staleTime: 60_000, refetchOnWindowFocus: false });
  const providers = useQuery({ ...orpc.calendar.providers.queryOptions(), enabled: on, staleTime: 5 * 60_000 });
  if (!on) return null;
  if (agenda.error) return <ErrorText>{errorMessage(agenda.error)}</ErrorText>;
  if (!agenda.data) return null;
  if (!agenda.data.enabled) {
    return (
      <AgendaDisabledNotice
        slug={slug}
        providers={providers.data}
        providersPending={providers.isPending}
        providersError={providers.error}
        showUnconfiguredHint={showUnconfiguredHint}
        offTestId="meeting-agenda-off"
        unconfiguredTestId="meeting-agenda-unconfigured"
      />
    );
  }
  const items = agenda.data.items;
  // "2 h 30 min": hours and minutes in the member's own words.
  const hours = Math.floor(agenda.data.totalMinutes / 60);
  const rest = agenda.data.totalMinutes % 60;
  const span = hours === 0 ? t('durationM', { minutes: String(rest) }) : rest === 0 ? t('durationH', { hours: String(hours) }) : t('durationHM', { hours: String(hours), minutes: String(rest) });
  return (
    <section className="space-y-2" aria-labelledby="meeting-agenda-title" data-testid="meeting-agenda">
      <h2 id="meeting-agenda-title" className="text-sm font-semibold">
        {t('title')}
      </h2>
      {items.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="meeting-agenda-total">
          {t('summary', { count: String(items.length), duration: span })}
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="meeting-agenda-empty">
          {t('none')}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border border-border bg-card">
          {items.map(({ event, brief }) => (
            <li key={event.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm" data-testid="meeting-agenda-event">
              <EventLine event={event} titleId={`agenda-event-${event.id}`} showJoin />
              <span className="ml-auto">
                {event.meetingId ? (
                  <Link
                    to="/o/$slug/meetings/$id"
                    params={{ slug, id: event.meetingId }}
                    aria-describedby={`agenda-event-${event.id}`}
                    className="inline-flex min-h-7 max-md:min-h-11 items-center text-xs font-medium text-link underline-offset-4 hover:underline"
                  >
                    {t('recorded')}
                  </Link>
                ) : (
                  // Fills the title and opens the normal record screen: its consent step runs before anything is recorded, and the event is linked to the meeting once it is made.
                  <Link
                    to="/o/$slug/meetings/record"
                    params={{ slug }}
                    search={{ title: event.title.slice(0, 200), agendaId: event.id }}
                    aria-describedby={`agenda-event-${event.id}`}
                    className={buttonVariants({ size: 'sm', className: 'max-md:min-h-11' })}
                    data-testid="meeting-agenda-record"
                  >
                    {t('record')}
                  </Link>
                )}
              </span>
              {/* What was decided last time, what is still open and the customer's open deals (#3543), read by code and shown with the event; Vy's sentences are the click under them. Nothing for an event with nothing to say. */}
              {!brief.empty && (
                <div className="basis-full space-y-3 border-t border-border pt-3" data-testid="meeting-agenda-brief">
                  <BriefBody slug={slug} showSource facts={brief} target={event.meetingId ? { meetingId: event.meetingId, agendaId: null } : { meetingId: null, agendaId: event.id }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('private')}</p>
    </section>
  );
}

// Next 7 days of calendar events for the caller alone (#4477); uses DataTable stacked for responsive mobile cards.
export function UpcomingAgenda({ slug, showUnconfiguredHint = false }: { slug: string; showUnconfiguredHint?: boolean }) {
  const t = useTranslations('meetings.agenda');
  const f = useFormat();
  const on = meetingsInstalled();
  const agenda = useQuery({ ...orpc.meetings.agenda.list.queryOptions({ input: { range: 'upcoming' } }), enabled: on, staleTime: 60_000, refetchOnWindowFocus: false });
  const providers = useQuery({ ...orpc.calendar.providers.queryOptions(), enabled: on, staleTime: 5 * 60_000 });
  if (!on) return null;
  if (agenda.error) return <ErrorText>{errorMessage(agenda.error)}</ErrorText>;
  if (!agenda.data) return null;
  if (!agenda.data.enabled) {
    return (
      <AgendaDisabledNotice
        slug={slug}
        providers={providers.data}
        providersPending={providers.isPending}
        providersError={providers.error}
        showUnconfiguredHint={showUnconfiguredHint}
        offTestId="meeting-upcoming-off"
        unconfiguredTestId="meeting-upcoming-unconfigured"
      />
    );
  }
  const events = agenda.data.events;
  return (
    <section className="space-y-3" aria-labelledby="meeting-upcoming-title" data-testid="meeting-upcoming">
      <h2 id="meeting-upcoming-title" className="text-sm font-semibold">
        {t('upcoming.title')}
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="meeting-upcoming-empty">
          {t('upcoming.none')}
        </p>
      ) : (
        <DataTable
          stacked
          head={[t('upcoming.colWhen'), t('upcoming.colMeeting'), t('upcoming.colPlatform'), t('upcoming.colInvitees'), t('upcoming.colActions')]}
        >
          {events.map((event) => {
            const titleId = `upcoming-event-${event.id}`;
            const service = joinService(event.joinUrl);
            const safeUrl = safeJoinUrl(event.joinUrl);
            return (
              <TableRow key={event.id} data-testid="meeting-upcoming-event">
                <TableCell data-label={t('upcoming.colWhen')} className="px-4 py-3 text-xs text-muted-foreground">
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium text-foreground">{`${f.weekdayShort(event.startsAt)}, ${f.date(localDayOf(event.startsAt))}`}</span>
                    <span className="font-mono">{`${f.time(event.startsAt)} - ${f.time(event.endsAt)}`}</span>
                  </span>
                </TableCell>
                <TableCell data-label={t('upcoming.colMeeting')} className="px-4 py-3 font-medium text-foreground">
                  <span id={titleId} className="min-w-0 break-words">
                    {event.title === '' ? t('untitled') : event.title}
                  </span>
                </TableCell>
                <TableCell data-label={t('upcoming.colPlatform')} className="px-4 py-3">
                  {service ? <Badge variant="outline">{t(`service.${service}`)}</Badge> : <span className="text-xs text-muted-foreground">-</span>}
                </TableCell>
                <TableCell data-label={t('upcoming.colInvitees')} className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                  {event.invitees > 0 ? t('invitees', { count: String(event.invitees) }) : '-'}
                </TableCell>
                <TableCell data-label={t('upcoming.colActions')} className="px-4 py-3">
                  <div className="inline-flex flex-wrap items-center gap-2">
                    {safeUrl && (
                      <a
                        href={safeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-describedby={titleId}
                        className={buttonVariants({ variant: 'outline', size: 'sm', className: 'max-md:min-h-11' })}
                        data-testid="meeting-upcoming-join"
                      >
                        {t('join')}
                      </a>
                    )}
                    {event.meetingId ? (
                      <Link
                        to="/o/$slug/meetings/$id"
                        params={{ slug, id: event.meetingId }}
                        aria-describedby={titleId}
                        className="inline-flex min-h-7 max-md:min-h-11 items-center text-xs font-medium text-link underline-offset-4 hover:underline"
                        data-testid="meeting-upcoming-recorded"
                      >
                        {t('recorded')}
                      </Link>
                    ) : (
                      <Link
                        to="/o/$slug/meetings/record"
                        params={{ slug }}
                        search={{ title: event.title.slice(0, 200), agendaId: event.id }}
                        aria-describedby={titleId}
                        className={buttonVariants({ size: 'sm', className: 'max-md:min-h-11' })}
                        data-testid="meeting-upcoming-record"
                      >
                        {t('record')}
                      </Link>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </DataTable>
      )}
      <p className="text-xs text-muted-foreground">{t('private')}</p>
    </section>
  );
}

// On a meeting the member recorded: the event it is linked to, or, when exactly one event overlaps the recording, the question whether to link it. A "no" is remembered on this screen only.
export function AgendaAttach({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.agenda');
  const on = meetingsInstalled();
  const [dismissed, setDismissed] = useState(false);
  const suggest = useQuery({ ...orpc.meetings.agenda.suggest.queryOptions({ input: { meetingId } }), enabled: on, staleTime: 60_000, refetchOnWindowFocus: false, retry: false });
  const link = useMutation({ mutationFn: (v: { agendaId: string; meetingId: string | null }) => orpc.meetings.agenda.link.call(v), onSuccess: refreshAgenda });
  const data = suggest.data;
  if (!on || !data) return null;
  if (data.linked) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm" data-testid="meeting-agenda-linked">
        <span className="text-xs text-muted-foreground">{t('linkedFrom')}</span>
        <EventLine event={data.linked} />
        <Button type="button" variant="ghost" size="sm" className="ml-auto" disabled={link.isPending} onClick={() => link.mutate({ agendaId: (data.linked as AgendaEvent).id, meetingId: null })}>
          {t('unlink')}
        </Button>
        {link.error && <ErrorText>{errorMessage(link.error)}</ErrorText>}
      </div>
    );
  }
  if (!data.suggestion || dismissed) return null;
  const event = data.suggestion;
  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-sm" data-testid="meeting-agenda-suggestion">
      <p className="font-medium">{t('attachAsk')}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <EventLine event={event} />
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" loading={link.isPending} disabled={link.isPending} onClick={() => link.mutate({ agendaId: event.id, meetingId })}>
          {t('attach')}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={link.isPending} onClick={() => setDismissed(true)}>
          {t('attachNo')}
        </Button>
      </div>
      {link.error && <ErrorText>{errorMessage(link.error)}</ErrorText>}
    </div>
  );
}
