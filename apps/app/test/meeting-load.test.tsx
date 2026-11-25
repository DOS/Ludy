// SPDX-License-Identifier: AGPL-3.0-only
// The week's meeting load on the meetings page (#4770): the member table with the total, the recurring series that may be worth trimming with each reason in words, shown to an owner or an admin only, member
// names from the org's members, titles as plain text, and Vietnamese words for everything. Rendered on the server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadWeek } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) };
});
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string> } & Record<string, unknown>) =>
      createElement('a', { href: to.replace('$slug', params?.slug ?? '').replace('$id', params?.id ?? ''), ...rest }, children),
  };
});

const { MeetingLoad } = await import('../src/components/meeting-load.tsx');

const LAN = '00000000-0000-4000-8000-00000000000a';
const HUNG = '00000000-0000-4000-8000-00000000000b';
const STRANGER = '00000000-0000-4000-8000-00000000000c';
const LATEST = '00000000-0000-4000-8000-0000000000d1';
const SERIES = '00000000-0000-4000-8000-0000000000e1';

const WEEK: LoadWeek = {
  weeksBack: 0,
  weekStart: '2026-11-23',
  weekEnd: '2026-11-29',
  meetings: 3,
  personMinutes: 255,
  members: [
    { userId: LAN, meetings: 3, minutes: 150 },
    { userId: HUNG, meetings: 2, minutes: 90 },
    { userId: STRANGER, meetings: 1, minutes: 15 },
  ],
  series: [{ seriesId: SERIES, latestMeetingId: LATEST, title: 'Họp giao ban tuần', meetings: 5, averageMinutes: 45, soloMeetings: 3, withMinutes: 1, openItems: [4, 3], signals: ['few_people', 'no_minutes', 'items_piling'] }],
  seriesCut: false,
};
const MEMBERS = [
  { userId: LAN, displayName: 'Lan', email: 'lan@example.com' },
  { userId: HUNG, displayName: null, email: 'hung@example.com' },
];

const wrap = (node: ReactNode, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const show = (data: LoadWeek | null, role: 'owner' | 'admin' | 'member' | 'viewer' | null = 'owner', locale: 'en' | 'vi' = 'en') => {
  if (role) client.current.setQueryData(['org', 'get'], { role, members: MEMBERS });
  if (data) client.current.setQueryData(['meetings', 'load', 'week'], data);
  return wrap(<MeetingLoad slug="acme" />, locale);
};
// The text of a piece of markup, by a scan (no pattern is used to strip tags): everything outside a tag.
const textOf = (html: string): string => {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
};
const cells = (html: string, row: string) => [...html.matchAll(new RegExp(`<tr[^>]*data-testid="${row}"[^>]*>((?:(?!</tr>).)*)</tr>`, 'g'))].map((m) => [...(m[1] ?? '').matchAll(/<t[hd][^>]*>((?:(?!<\/t[hd]>).)*)<\/t[hd]>/g)].map((c) => textOf(c[1] ?? '')));

beforeEach(() => client.current.clear());

describe('who sees it', () => {
  it('shows the card to an owner and to an admin', () => {
    expect(show(WEEK, 'owner')).toContain('data-testid="meeting-load"');
    client.current.clear();
    expect(show(WEEK, 'admin')).toContain('data-testid="meeting-load"');
  });

  it('shows nothing to a member or a viewer, even with the answer in the cache, and nothing before the answer is read', () => {
    expect(show(WEEK, 'member')).toBe('');
    client.current.clear();
    expect(show(WEEK, 'viewer')).toBe('');
    client.current.clear();
    expect(show(null, 'owner')).toBe('');
    client.current.clear();
    expect(show(WEEK, null)).toBe('');
  });
});

describe('the week', () => {
  it('lists each member with the meetings and the time, then the total of the team', () => {
    const html = show(WEEK);
    expect(textOf(html.slice(html.indexOf('data-testid="load-range"')))).toContain('From 2026-11-23 to 2026-11-29');
    expect(cells(html, 'load-member-row')).toEqual([
      ['Lan', '3', '2 h 30 min'],
      ['hung@example.com', '2', '1 h 30 min'],
      ['A member', '1', '15 min'],
    ]);
    expect(cells(html, 'load-total')).toEqual([['Whole team (everyone added up)', '3', '4 h 15 min']]);
    expect(html).toContain(en.meetings.load.basis);
  });

  it('says so when no meeting with a length is read that week', () => {
    const html = show({ ...WEEK, meetings: 0, personMinutes: 0, members: [] });
    expect(html).toContain('data-testid="load-empty"');
    expect(html).toContain(en.meetings.load.noMembers);
    expect(html).not.toContain('data-testid="load-members"');
  });

  it('offers this week, last week and the weeks before up to twelve back', () => {
    const html = show(WEEK);
    expect(html).toContain(`>${en.meetings.load.thisWeek}</option>`);
    expect(html).toContain(`>${en.meetings.load.lastWeek}</option>`);
    expect(html).toContain('>12 weeks ago</option>');
    expect(html).not.toContain('>13 weeks ago</option>');
  });
});

describe('the recurring meetings that may be worth trimming', () => {
  it('names the series by its latest meeting, links to it and gives each reason in words', () => {
    const html = show(WEEK);
    expect(html).toContain('data-testid="load-series"');
    expect(html).toContain(`href="/o/acme/meetings/${LATEST}"`);
    const text = textOf(html);
    expect(text).toContain('Họp giao ban tuần');
    expect(text).toContain('5 meetings, 45 min on average');
    expect(text).toContain('3 of 5 meetings had only the recorder in them, nobody added.');
    expect(text).toContain('Only 1 of 5 meetings have published minutes.');
    expect(text).toContain('Open items are piling up: 4 after the latest meeting and 3 after the one before.');
    expect(text).toContain(en.meetings.load.trim.hint.replace('{weeks, number}', '8').replace('{min, number}', '3'));
  });

  it('says so when no series is worth a look, and when the list was cut', () => {
    expect(show({ ...WEEK, series: [] })).toContain(en.meetings.load.trim.none);
    client.current.clear();
    expect(show({ ...WEEK, seriesCut: true })).toContain(en.meetings.load.trim.cut);
  });

  it('writes a title as plain text, never as markup', () => {
    const [first] = WEEK.series;
    if (!first) throw new Error('fixture');
    const html = show({ ...WEEK, series: [{ ...first, title: '<img src=x onerror=alert(1)> & <b>họp</b>' }] });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &lt;b&gt;họp&lt;/b&gt;');
  });
});

describe('Vietnamese', () => {
  it('has words for everything it shows, with the same keys as English', () => {
    const html = show(WEEK, 'owner', 'vi');
    expect(html).toContain(viMessages.meetings.load.title);
    expect(html).toContain(viMessages.meetings.load.member);
    expect(html).toContain(viMessages.meetings.load.trim.title);
    expect(textOf(html)).toContain('Lan');
    expect(textOf(html)).toContain('2 giờ 30 phút');
    expect(textOf(html)).toContain('3 trong 5 cuộc họp chỉ có người ghi, chưa thêm ai.');
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v).map((s) => `${k}.${s}`) : [k]));
    expect(keys(viMessages.meetings.load).sort()).toEqual(keys(en.meetings.load).sort());
    expect(viMessages.meetings.tools.load).toBeTruthy();
  });
});
