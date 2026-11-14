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
import type { AgendaEvent } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { ErrorText } from './ui.tsx';
import { meetingsInstalled } from './linked-meetings.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// Where a join address leads, by its host: the badge names the service, never the address.
export function joinService(url: string | null): 'meet' | 'zoom' | 'teams' | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'meet.google.com') return 'meet';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'teams';
  return null;
}

const refreshAgenda = () => queryClient.invalidateQueries({ queryKey: orpc.meetings.agenda.key() });

// One event: its time, its title, the service of its join address and how many people are invited.
function EventLine({ event }: { event: AgendaEvent }) {
  const t = useTranslations('meetings.agenda');
  const f = useFormat();
  const service = joinService(event.joinUrl);
  return (
    <>
      <span className="font-mono text-xs text-muted-foreground">
        {f.time(event.startsAt)}
        {'–'}
        {f.time(event.endsAt)}
      </span>
      <span className="min-w-0 break-words font-medium">{event.title === '' ? t('untitled') : event.title}</span>
      {service && <Badge variant="outline">{t(`service.${service}`)}</Badge>}
      {event.invitees > 0 && <span className="text-xs text-muted-foreground">{t('invitees', { count: String(event.invitees) })}</span>}
    </>
  );
}

export function TodayAgenda({ slug }: { slug: string }) {
  const t = useTranslations('meetings.agenda');
  const on = meetingsInstalled();
  const agenda = useQuery({ ...orpc.meetings.agenda.list.queryOptions({ input: {} }), enabled: on, staleTime: 60_000, refetchOnWindowFocus: false });
  const providers = useQuery({ ...orpc.calendar.providers.queryOptions(), enabled: on, staleTime: 5 * 60_000 });
  if (!on || !agenda.data) return null;
  if (!agenda.data.enabled) {
    // Only where Google Calendar can be connected at all; otherwise there is nothing to switch on.
    if (!(providers.data ?? []).includes('google_calendar')) return null;
    return (
      <p className="text-xs text-muted-foreground" data-testid="meeting-agenda-off">
        {t('off')}{' '}
        <Link to="/o/$slug/settings" params={{ slug }} className="font-medium text-foreground underline">
          {t('offLink')}
        </Link>
      </p>
    );
  }
  const events = agenda.data.events;
  return (
    <section className="space-y-2" aria-labelledby="meeting-agenda-title" data-testid="meeting-agenda">
      <h2 id="meeting-agenda-title" className="text-sm font-semibold">
        {t('title')}
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="meeting-agenda-empty">
          {t('none')}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border border-border bg-card">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm" data-testid="meeting-agenda-event">
              <EventLine event={event} />
              <span className="ml-auto">
                {event.meetingId ? (
                  <Link to="/o/$slug/meetings/$id" params={{ slug, id: event.meetingId }} className="text-xs font-medium underline">
                    {t('recorded')}
                  </Link>
                ) : (
                  // Fills the title and opens the normal record screen: its consent step runs before anything is recorded, and the event is linked to the meeting once it is made.
                  <Link to="/o/$slug/meetings/record" params={{ slug }} search={{ title: event.title.slice(0, 200), agendaId: event.id }} className="text-xs font-medium underline" data-testid="meeting-agenda-record">
                    {t('record')}
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
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
