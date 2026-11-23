// SPDX-License-Identifier: AGPL-3.0-only
// The member's own calendar on the Meetings tab and the attach prompt on a recorded meeting (B1, #3165). The list shows exactly the events the server returned, a recorded event links to its
// meeting, an unrecorded one only opens the normal record screen with the title (the consent step is that screen's), and the prompt is a question a person answers with a click.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { safeJoinUrl, type AgendaEvent, type BriefFacts } from '@ludy/kernel-contract';
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
    Link: ({ children, to, params, search, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string>; 'data-testid'?: string; 'aria-describedby'?: string }) =>
      createElement('a', { href: to, 'data-testid': rest['data-testid'], 'aria-describedby': rest['aria-describedby'], 'data-params': JSON.stringify(params ?? {}), 'data-search': JSON.stringify(search ?? {}) }, children),
  };
});

const { TodayAgenda, UpcomingAgenda, AgendaAttach, joinService } = await import('../src/components/meeting-agenda.tsx');

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
const briefOf = (over: Partial<BriefFacts> = {}): BriefFacts => ({ previous: null, decisions: [], items: [], customer: null, deals: [], empty: true, ...over });
const todayOf = (events: AgendaEvent[], briefs: Record<string, BriefFacts> = {}, totalMinutes = 60) => ({ enabled: true, totalMinutes, items: events.map((e) => ({ event: e, brief: briefs[e.id] ?? briefOf() })) });
const reset = () => {
  client.current.clear();
  modules.list = ['kernel', 'crm', 'meetings'];
};

describe('joinService & safeJoinUrl', () => {
  it('names the service by host and returns trimmed URL only for safe https hosts', () => {
    expect(joinService('https://meet.google.com/abc')).toBe('meet');
    expect(joinService('https://us02web.zoom.us/j/1')).toBe('zoom');
    expect(joinService('https://teams.microsoft.com/l/meetup-join/x')).toBe('teams');
    expect(joinService('https://evil.example/zoom.us')).toBeNull();
    expect(joinService('http://meet.google.com/abc')).toBeNull();
    expect(joinService('javascript:alert(1)')).toBeNull();
    expect(joinService('not a url')).toBeNull();
    expect(joinService(null)).toBeNull();

    expect(safeJoinUrl('  https://meet.google.com/abc-defg-hij  ')).toBe('https://meet.google.com/abc-defg-hij');
    expect(safeJoinUrl('http://meet.google.com/abc-defg-hij')).toBeNull();
    expect(safeJoinUrl('javascript:alert(1)')).toBeNull();
    expect(safeJoinUrl('https://evil.example/zoom.us')).toBeNull();
    expect(safeJoinUrl(null)).toBeNull();
  });
});

describe('TodayAgenda', () => {
  it('lists the events, links a recorded one to its meeting, renders safe https Join link without exposing raw URL text, and links an unrecorded one to the record screen', () => {
    reset();
    client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([event({}), event({ id: 'a2', title: 'Chốt báo giá', meetingId: 'm9', joinUrl: null, invitees: 0 })]));
    const html = renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />));
    expect(html.match(/data-testid="meeting-agenda-event"/g)).toHaveLength(2);
    expect(html).toContain('Họp với khách A');
    expect(html).toContain(en.meetings.agenda.service.meet);
    expect(html).toContain('data-testid="meeting-agenda-join"');
    expect(html).toContain('href="https://meet.google.com/abc-defg-hij"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(`>${en.meetings.agenda.join}</a>`);
    expect(html).toContain('3 invited');
    expect(html.match(/data-testid="meeting-agenda-record"/g)).toHaveLength(1);
    expect(html).toContain('&quot;title&quot;:&quot;Họp với khách A&quot;');
    expect(html).toContain('&quot;agendaId&quot;:&quot;a1&quot;');
    expect(html).toContain(en.meetings.agenda.recorded);
    expect(html).toContain('&quot;id&quot;:&quot;m9&quot;');
    expect(html).toContain(en.meetings.agenda.private.replaceAll('"', '&quot;'));
    // Visible stripped text never draws the raw URL path.
    const visibleText = html.replace(/<[^>]*>/g, ' ');
    expect(visibleText).not.toContain('abc-defg-hij');

    // Rejects http://, javascript:, and unrecognized hosts.
    for (const unsafe of ['http://meet.google.com/abc-defg-hij', 'javascript:alert(1)', 'https://evil.example/zoom.us']) {
      reset();
      client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([event({ joinUrl: unsafe })]));
      const badHtml = renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />));
      expect(badHtml).not.toContain('data-testid="meeting-agenda-join"');
      expect(badHtml).not.toContain('javascript:');
      expect(badHtml).not.toContain('evil.example');
    }
  });

  it('names the event a row\'s link acts on: the same words "Record this meeting" and "Recorded" on every row say which row they are on (WCAG 2.4.6, 4.1.2; #4055)', () => {
    reset();
    client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([event({}), event({ id: 'a2', title: 'Chốt báo giá', meetingId: 'm9', joinUrl: null, invitees: 0 })]));
    const html = renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />));
    // One row per <li>: the link's description is the id of the title span inside the same row.
    const rows = html.split('<li ').slice(1);
    expect(rows).toHaveLength(2);
    const titles: string[] = [];
    for (const row of rows) {
      const described = /<a [^>]*aria-describedby="([^"]+)"/.exec(row)?.[1];
      expect(described, row.slice(0, 80)).toBeDefined();
      const title = new RegExp(`<span id="${described}"[^>]*>([^<]*)</span>`).exec(row)?.[1];
      expect(title, `the title of ${described}`).toBeDefined();
      titles.push(title as string);
    }
    expect(titles).toEqual(['Họp với khách A', 'Chốt báo giá']);
    // Two rows, two different ids.
    expect(new Set(rows.map((row) => /aria-describedby="([^"]+)"/.exec(row)?.[1])).size).toBe(2);
  });

  it('says so when today has no meetings, and shows the opt-in line when the switch is off and Google can be connected', () => {
    reset();
    client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([], {}, 0));
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toContain(en.meetings.agenda.none);
    reset();
    client.current.setQueryData(['meetings', 'today', 'facts'], { enabled: false, totalMinutes: 0, items: [] });
    client.current.setQueryData(['calendar', 'providers'], ['google_calendar']);
    const off = renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />));
    expect(off).toContain('data-testid="meeting-agenda-off"');
    expect(off).toContain(en.meetings.agenda.offLink);
    expect(off).not.toContain('meeting-agenda-event');
  });

  it('draws nothing when no calendar can be connected, while loading, or without the meetings module', () => {
    reset();
    client.current.setQueryData(['meetings', 'today', 'facts'], { enabled: false, totalMinutes: 0, items: [] });
    client.current.setQueryData(['calendar', 'providers'], []);
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toBe('');
    reset();
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toBe('');
    reset();
    modules.list = ['kernel'];
    client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([event({})]));
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toBe('');
  });
  it('says how many meetings there are today and how long they take in all', () => {
    reset();
    client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([event({}), event({ id: 'a2', title: 'Chốt báo giá' })], {}, 150));
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toContain('2 meeting(s) today, 2 h 30 min in all.');
    client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([event({})], {}, 45));
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toContain('1 meeting(s) today, 45 min in all.');
    client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([event({})], {}, 120));
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).toContain('2 h in all.');
    // Nothing is said about the total on an empty day.
    client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([], {}, 0));
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).not.toContain('meeting-agenda-total');
  });

  it('shows the facts of an event\'s brief with the event, by code, for a recorded event too, and nothing for an event with nothing to say; Vy has no button without the switch', () => {
    reset();
    const brief = briefOf({
      previous: { meetingId: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5d', title: 'Giao ban tuần trước', startedAt: '2026-11-10T02:00:00.000Z' },
      decisions: ['Chốt giá gói kế toán 15.000.000 đồng'],
      items: [{ id: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a01', title: 'Gửi báo giá', who: 'Nam', whoUserId: null, assigneeSeat: null, when: 'thứ sáu', whenDate: null, assigned: false, taskStatus: null, due: null }],
      empty: false,
    });
    client.current.setQueryData(['meetings', 'today', 'facts'], todayOf([event({}), event({ id: 'a2', title: 'Chốt báo giá', meetingId: 'm9' }), event({ id: 'a3', title: 'Không có gì' })], { a1: brief, a2: brief }));
    const html = renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />));
    expect(html.match(/data-testid="meeting-agenda-brief"/g)).toHaveLength(2);
    // Two briefs, each with one decision and one open item.
    expect(html.match(/data-testid="brief-fact"/g)).toHaveLength(4);
    expect(html).toContain('Chốt giá gói kế toán 15.000.000 đồng');
    expect(html).toContain('Gửi báo giá');
    // The source of the facts is said, with a link to that meeting.
    expect(html.match(/data-testid="brief-source"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="brief-open-previous"');
    // AI off: the facts show and Vy has no button, whether the status is not known yet, says off, or the model is missing.
    expect(html).not.toContain('data-testid="brief-vy"');
    client.current.setQueryData(['meetings', 'brief', 'status'], { enabled: false, reason: 'off', estimate: null });
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).not.toContain('data-testid="brief-vy"');
    client.current.setQueryData(['meetings', 'brief', 'status'], { enabled: true, reason: null, estimate: null });
    client.current.setQueryData(['ai', 'meter'], { aiOn: false, state: 'ok', percent: 0 });
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />))).not.toContain('data-testid="brief-vy"');
    // With the switch on, each brief has Vy's button under its facts.
    client.current.setQueryData(['meetings', 'brief', 'status'], { enabled: true, reason: null, estimate: null });
    client.current.setQueryData(['ai', 'meter'], { aiOn: true, state: 'ok', percent: 10 });
    expect(renderToStaticMarkup(wrap(<TodayAgenda slug="acme" />)).match(/data-testid="brief-write"/g)).toHaveLength(2);
  });
});

describe('UpcomingAgenda', () => {
  it('renders 7-day upcoming events in a DataTable with safe Join links, Record/Recorded CTAs, and aria-describedby', () => {
    reset();
    client.current.setQueryData(['meetings', 'agenda', 'list'], {
      enabled: true,
      events: [
        event({}),
        event({
          id: 'a2',
          title: 'Họp Zoom ngày mai',
          startsAt: '2026-11-15T02:00:00.000Z',
          endsAt: '2026-11-15T03:00:00.000Z',
          joinUrl: 'http://zoom.us/j/unsafe',
          invitees: 0,
          meetingId: 'm9',
        }),
      ],
    });
    const html = renderToStaticMarkup(wrap(<UpcomingAgenda slug="acme" />));
    expect(html).toContain('data-testid="meeting-upcoming"');
    expect(html.match(/data-testid="meeting-upcoming-event"/g)).toHaveLength(2);
    expect(html).toContain('Họp với khách A');
    expect(html).toContain('Họp Zoom ngày mai');
    expect(html.match(/data-testid="meeting-upcoming-join"/g)).toHaveLength(1);
    expect(html).toContain('href="https://meet.google.com/abc-defg-hij"');
    expect(html).toContain('aria-describedby="upcoming-event-a1"');
    expect(html).toContain('aria-describedby="upcoming-event-a2"');
    expect(html).toContain('data-testid="meeting-upcoming-record"');
    expect(html).toContain('data-testid="meeting-upcoming-recorded"');
    expect(html).not.toContain('http://zoom.us/j/unsafe');
    const visibleText = html.replace(/<[^>]*>/g, ' ');
    expect(visibleText).not.toContain('abc-defg-hij');
  });

  it('handles empty, disabled with providers, disabled without providers, loading, and module-off states', () => {
    reset();
    client.current.setQueryData(['meetings', 'agenda', 'list'], { enabled: true, events: [] });
    expect(renderToStaticMarkup(wrap(<UpcomingAgenda slug="acme" />))).toContain('data-testid="meeting-upcoming-empty"');

    reset();
    client.current.setQueryData(['meetings', 'agenda', 'list'], { enabled: false, events: [] });
    client.current.setQueryData(['calendar', 'providers'], ['google_calendar']);
    const offHtml = renderToStaticMarkup(wrap(<UpcomingAgenda slug="acme" />));
    expect(offHtml).toContain('data-testid="meeting-upcoming-off"');
    expect(offHtml).toContain(en.meetings.agenda.offLink);

    reset();
    client.current.setQueryData(['meetings', 'agenda', 'list'], { enabled: false, events: [] });
    client.current.setQueryData(['calendar', 'providers'], []);
    expect(renderToStaticMarkup(wrap(<UpcomingAgenda slug="acme" />))).toBe('');

    reset();
    expect(renderToStaticMarkup(wrap(<UpcomingAgenda slug="acme" />))).toBe('');

    reset();
    modules.list = ['kernel'];
    client.current.setQueryData(['meetings', 'agenda', 'list'], { enabled: true, events: [event({})] });
    expect(renderToStaticMarkup(wrap(<UpcomingAgenda slug="acme" />))).toBe('');
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
