// SPDX-License-Identifier: AGPL-3.0-only
// Keyword trackers on the pages (#4818): the card of a meeting lists the tracked words that came up with their count and the time of each line (a button), is absent with none, with no tracked word and
// after a failed read; the weekly tool lists the hits with the meetings, says so when none are tracked or none came up, shows the editor to an owner or an admin only, and writes words as plain text.
// Rendered on the server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerHits, TrackerTerms, TrackerWeek } from '@ludy/kernel-contract';
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

const { MeetingTrackerHits, TrackersWeek } = await import('../src/components/meeting-trackers.tsx');

const HITS_KEY = ['meetings', 'tracker', 'hits'];
const WEEK_KEY = ['meetings', 'tracker', 'week'];
const LIST_KEY = ['meetings', 'tracker', 'list'];
const ORG_KEY = ['org', 'get'];
const M1 = '00000000-0000-4000-8000-0000000000a1';
const M2 = '00000000-0000-4000-8000-0000000000a2';
const T1 = '00000000-0000-4000-8000-0000000000b1';
const T2 = '00000000-0000-4000-8000-0000000000b2';

const hits = (rows: TrackerHits['hits'], tracked = rows.length): TrackerHits => ({ meetingId: M1, tracked, hits: rows });
const WEEK: TrackerWeek = {
  weekStart: '2026-11-23',
  weekEnd: '2026-11-29',
  tracked: 2,
  meetings: 2,
  cut: false,
  terms: [
    { id: T1, term: 'giá', count: 5, meetings: [{ meetingId: M1, title: 'Họp bán hàng', count: 4 }, { meetingId: M2, title: '<b>Họp B</b>', count: 1 }], moreMeetings: 3 },
    { id: T2, term: 'Đại Việt', count: 1, meetings: [{ meetingId: M2, title: '<b>Họp B</b>', count: 1 }], moreMeetings: 0 },
  ],
};
const TERMS: TrackerTerms = { terms: [{ id: T1, term: 'giá' }, { id: T2, term: 'Đại Việt' }] };

const wrap = (node: ReactNode, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
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
const card = (data: TrackerHits | null, locale: 'en' | 'vi' = 'en') => {
  if (data) client.current.setQueryData(HITS_KEY, data);
  return wrap(<MeetingTrackerHits meetingId={M1} onJump={() => undefined} />, locale);
};
const weekTool = (role: 'owner' | 'admin' | 'member', week: TrackerWeek = WEEK, locale: 'en' | 'vi' = 'en') => {
  client.current.setQueryData(WEEK_KEY, week);
  client.current.setQueryData(LIST_KEY, TERMS);
  client.current.setQueryData(ORG_KEY, { role, members: [] });
  return wrap(<TrackersWeek slug="acme" />, locale);
};

beforeEach(() => client.current.clear());

describe("a meeting's card", () => {
  it('lists each tracked word that came up with its count and a button for the time of each line', () => {
    const html = card(hits([{ id: T1, term: 'giá', count: 3, seconds: [12, 3725], more: false }, { id: T2, term: 'Đại Việt', count: 1, seconds: [12], more: true }]));
    expect(html).toContain('data-testid="meeting-tracker-hits"');
    const rows = html.split('data-testid="tracker-hit"').slice(1);
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0] ?? '')).toContain('giá');
    expect(textOf(rows[0] ?? '')).toContain('3 times');
    expect(textOf(rows[0] ?? '')).toContain('0:12');
    expect(textOf(rows[0] ?? '')).toContain('1:02:05');
    expect(rows[0]).not.toContain('and more lines');
    expect(textOf(rows[1] ?? '')).toContain('1 time');
    expect(textOf(rows[1] ?? '')).toContain('and more lines');
    expect(rows[0]).toContain('Go to 0:12 in the transcript and the player');
  });

  it('is absent with no word that came up, with no tracked word and with no answer', () => {
    expect(card(hits([], 2))).toBe('');
    client.current.clear();
    expect(card(hits([], 0))).toBe('');
    client.current.clear();
    expect(card(null)).toBe('');
  });

  it('is absent after a failed read, whatever the earlier read held', () => {
    client.current.setQueryData(HITS_KEY, hits([{ id: T1, term: 'giá', count: 1, seconds: [1], more: false }]));
    client.current.getQueryCache().build(client.current, { queryKey: HITS_KEY }).setState({ data: hits([{ id: T1, term: 'giá', count: 1, seconds: [1], more: false }]), error: new Error('404'), status: 'error', fetchStatus: 'idle' } as never);
    expect(wrap(<MeetingTrackerHits meetingId={M1} onJump={() => undefined} />)).toBe('');
  });

  it('writes the word as plain text and speaks Vietnamese', () => {
    const html = card(hits([{ id: T1, term: '<img src=x onerror=alert(1)>', count: 2, seconds: [5], more: false }]), 'vi');
    expect(html).not.toContain('<img');
    expect(textOf(html)).toContain('Từ khóa theo dõi');
    expect(textOf(html)).toContain('2 lần');
  });
});

describe('the weekly tool', () => {
  it('lists each word with its count and the meetings it came up in, as links, the rest as "and N more"', () => {
    const html = weekTool('member');
    const terms = html.split('data-testid="trackers-term"').slice(1);
    expect(terms).toHaveLength(2);
    expect(textOf(terms[0] ?? '')).toContain('giá');
    expect(textOf(terms[0] ?? '')).toContain('5 times');
    expect(terms[0]).toContain(`href="/o/$slug/meetings/$id`.replace('$slug', 'acme').replace('$id', M1));
    expect(textOf(terms[0] ?? '')).toContain('and 3 more meetings');
    expect(textOf(html)).toContain('2026-11-23 to 2026-11-29');
    expect(textOf(html)).toContain('Meetings counted: 2');
    // A title is text, not markup.
    expect(html).not.toContain('<b>Họp B</b>');
  });

  it('shows the editor to an owner and an admin only', () => {
    expect(weekTool('owner')).toContain('data-testid="tracker-words"');
    client.current.clear();
    expect(weekTool('admin')).toContain('data-testid="tracker-words"');
    client.current.clear();
    const member = weekTool('member');
    expect(member).not.toContain('data-testid="tracker-words"');
    expect(member).not.toContain('A word or phrase to track');
  });

  it('says so when no word is tracked (and tells an owner where to add) and when none came up', () => {
    const none: TrackerWeek = { ...WEEK, tracked: 0, terms: [] };
    expect(textOf(weekTool('member', none))).toContain('An owner or an admin can add them');
    client.current.clear();
    expect(textOf(weekTool('owner', none))).toContain('Add the competitor names');
    client.current.clear();
    expect(textOf(weekTool('member', { ...WEEK, terms: [] }))).toContain('None of the tracked words came up');
  });

  it('says when the week was cut, and speaks Vietnamese', () => {
    const html = weekTool('owner', { ...WEEK, cut: true }, 'vi');
    expect(textOf(html)).toContain('Từ khóa theo dõi');
    expect(textOf(html)).toContain('các cuộc họp sớm nhất được đếm');
    expect(textOf(html)).toContain('Từ khóa bạn theo dõi (2/20)');
  });
});
