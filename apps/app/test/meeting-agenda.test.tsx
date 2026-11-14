// SPDX-License-Identifier: AGPL-3.0-only
// The member's own calendar on the Meetings tab and the attach prompt on a recorded meeting (B1, #3165). The list shows exactly the events the server returned, a recorded event links to its
// meeting, an unrecorded one only opens the normal record screen with the title (the consent step is that screen's), and the prompt is a question a person answers with a click.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AgendaEvent } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const modules = vi.hoisted(() => ({ list: ['kernel', 'crm', 'meetings'] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: modules.list }) }));
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, search, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string>; 'data-testid'?: string }) =>
      createElement('a', { href: to, 'data-testid': rest['data-testid'], 'data-params': JSON.stringify(params ?? {}), 'data-search': JSON.stringify(search ?? {}) }, children),
  };
});

const { TodayAgenda, AgendaAttach, joinService } = await import('../src/components/meeting-agenda.tsx');

const event = (over: Partial<AgendaEvent>): AgendaEvent => ({
  id: 'a1',
  title: 'Họp với khách A',
  startsAt: '2026-11-14T02:00:00.000Z',
  endsAt: '2026-11-14T03:00:00.000Z',
  timeZone: 'Asia/Ho_Chi_Minh',
  joinUrl: 'https://meet.google.com/abc-defg-hij',
  invitees: 3,
  meetingId: null,
  ...over,
});
const wrap = (node: ReactNode) => (
  <QueryClientProvider client={client.current}>
    <IntlProvider locale="en" messages={catalog('en')}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);
const reset = () => {
  client.current.clear();
  modules.list = ['kernel', 'crm', 'meetings'];
};

describe('joinService', () => {
  it('names the service by host and never anything else', () => {
    expect(joinService('https://meet.google.com/abc')).toBe('meet');
    expect(joinService('https://us02web.zoom.us/j/1')).toBe('zoom');
    expect(joinService('https://teams.microsoft.com/l/meetup-join/x')).toBe('teams');
    expect(joinService('https://evil.example/zoom.us')).toBeNull();
    expect(joinService('not a url')).toBeNull();
    expect(joinService(null)).toBeNull();
  });
});

describe('TodayAgenda', () => {
  it('lists the events, links a recorded one to its meeting and an unrecorded one to the record screen with the title', () => {
    reset();
    client.current.setQueryData(['meetings', 'agenda', 'list'], { enabled: true, events: [event({}), event({ id: 'a2', title: 'Chốt báo giá', meetingId: 'm9', joinUrl: null, invitees: 0 })] });
    const html = renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />));
    expect(html.match(/data-testid="meeting-agenda-event"/g)).toHaveLength(2);
    expect(html).toContain('Họp với khách A');
    expect(html).toContain(en.meetings.agenda.service.meet);
    expect(html).toContain('3 invited');
    expect(html.match(/data-testid="meeting-agenda-record"/g)).toHaveLength(1);
    expect(html).toContain('&quot;title&quot;:&quot;Họp với khách A&quot;');
    expect(html).toContain('&quot;agendaId&quot;:&quot;a1&quot;');
    expect(html).toContain(en.meetings.agenda.recorded);
    expect(html).toContain('&quot;id&quot;:&quot;m9&quot;');
    expect(html).toContain(en.meetings.agenda.private.replaceAll('"', '&quot;'));
    // The address itself is never drawn, only the service it leads to.
    expect(html).not.toContain('abc-defg-hij');
  });

  it('says so when today has no meetings, and shows the opt-in line when the switch is off and Google can be connected', () => {
    reset();
    client.current.setQueryData(['meetings', 'agenda', 'list'], { enabled: true, events: [] });
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toContain(en.meetings.agenda.none);
    reset();
    client.current.setQueryData(['meetings', 'agenda', 'list'], { enabled: false, events: [] });
    client.current.setQueryData(['calendar', 'providers'], ['google_calendar']);
    const off = renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />));
    expect(off).toContain('data-testid="meeting-agenda-off"');
    expect(off).toContain(en.meetings.agenda.offLink);
    expect(off).not.toContain('meeting-agenda-event');
  });

  it('draws nothing when no calendar can be connected, while loading, or without the meetings module', () => {
    reset();
    client.current.setQueryData(['meetings', 'agenda', 'list'], { enabled: false, events: [] });
    client.current.setQueryData(['calendar', 'providers'], []);
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toBe('');
    reset();
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toBe('');
    reset();
    modules.list = ['kernel'];
    client.current.setQueryData(['meetings', 'agenda', 'list'], { enabled: true, events: [event({})] });
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toBe('');
  });
});

describe('AgendaAttach', () => {
  it('asks whether to link the one overlapping event, with a yes and a no', () => {
    reset();
    client.current.setQueryData(['meetings', 'agenda', 'suggest'], { meetingId: 'm1', linked: null, suggestion: event({}) });
    const html = renderToStaticMarkup(wrap(<AgendaAttach meetingId="m1" />));
    expect(html).toContain('data-testid="meeting-agenda-suggestion"');
    expect(html).toContain(en.meetings.agenda.attachAsk);
    expect(html).toContain(en.meetings.agenda.attach);
    expect(html).toContain(en.meetings.agenda.attachNo);
    expect(html).toContain('Họp với khách A');
  });

  it('shows the event a meeting is linked to with a way to take the link away, and nothing when there is no event', () => {
    reset();
    client.current.setQueryData(['meetings', 'agenda', 'suggest'], { meetingId: 'm1', linked: event({ meetingId: 'm1' }), suggestion: null });
    const linked = renderToStaticMarkup(wrap(<AgendaAttach meetingId="m1" />));
    expect(linked).toContain('data-testid="meeting-agenda-linked"');
    expect(linked).toContain(en.meetings.agenda.linkedFrom);
    expect(linked).toContain(en.meetings.agenda.unlink);
    reset();
    client.current.setQueryData(['meetings', 'agenda', 'suggest'], { meetingId: 'm1', linked: null, suggestion: null });
    expect(renderToStaticMarkup(wrap(<AgendaAttach meetingId="m1" />))).toBe('');
  });
});

describe('strings', () => {
  it('has the same agenda keys in Vietnamese and English', () => {
    expect(Object.keys(viMessages.meetings.agenda).sort()).toEqual(Object.keys(en.meetings.agenda).sort());
    expect(viMessages.meetings.agenda.record).toBe('Ghi cuộc họp này');
    expect(viMessages.meetings.agenda.attachAsk).toBe('Gắn vào sự kiện lịch này?');
    expect(viMessages.workingHours.externalReadEvents).toBe('Cho Ludy đọc tên và giờ cuộc họp trong lịch');
  });
});
