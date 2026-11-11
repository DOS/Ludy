// SPDX-License-Identifier: AGPL-3.0-only
// The links of a meeting and the meetings on a contact's or deal's page (L1, #2587). The recorder sees the links with a remove button and the add controls; a reader sees
// the links only; a contact or deal page lists exactly the rows the server returned (the server leaves out the meetings its viewer may not read, so nothing else is drawn).
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingLink, MeetingOfTarget } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
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
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: ['kernel', 'crm', 'meetings'] }) }));
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement('a', { href: to }, children),
  };
});

const { MeetingLinks } = await import('../src/components/meeting-links.tsx');
const { LinkedMeetings } = await import('../src/components/linked-meetings.tsx');

const link = (over: Partial<MeetingLink>): MeetingLink => ({ id: 'l1', meetingId: 'm1', kind: 'party', targetId: 'p1', label: 'Công ty Acme', createdBy: 'u1', createdAt: '2026-11-11T08:00:00.000Z', ...over });
const wrap = (node: ReactNode) => (
  <QueryClientProvider client={client.current}>
    <IntlProvider locale="en" messages={catalog('en')}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

describe('MeetingLinks', () => {
  it('names each link and gives the recorder a remove button and the contact search', () => {
    client.current.setQueryData(['meetings', 'links', 'list'], [link({}), link({ id: 'l2', kind: 'calendar_event', targetId: 'e1', label: 'Tư vấn' })]);
    const html = renderToStaticMarkup(wrap(<MeetingLinks meetingId="m1" isRecorder />));
    expect(html).toContain('Công ty Acme');
    expect(html).toContain('Tư vấn');
    expect(html).toContain(en.meetings.links.kindParty);
    expect(html).toContain(en.meetings.links.kindCalendar_event);
    expect(html.match(/data-testid="meeting-link"/g)).toHaveLength(2);
    expect(html.match(new RegExp(`>${en.meetings.links.remove}<`, 'g'))).toHaveLength(2);
    expect(html).toContain(en.meetings.links.searchLabel);
  });

  it("shows the recorder Vy's suggestion as a suggestion to click (never linked by itself), and a reader none", () => {
    client.current.setQueryData(['meetings', 'links', 'list'], []);
    client.current.setQueryData(['meetings', 'links', 'suggest'], { tainted: true, ai: 'off', parties: [{ partyId: 'p9', name: 'Công ty Á Châu', mentions: 2 }], deals: [{ dealId: 'd9', title: 'Gói kế toán', partyId: 'p9', partyName: 'Công ty Á Châu' }] });
    const html = renderToStaticMarkup(wrap(<MeetingLinks meetingId="m1" isRecorder />));
    expect(html).toContain(en.meetings.links.suggestTitle);
    expect(html).toContain(en.meetings.links.suggestNote);
    expect(html.match(/data-testid="suggested-party"/g)).toHaveLength(1);
    expect(html.match(/data-testid="suggested-deal"/g)).toHaveLength(1);
    // Suggestions are not links: the linked list stays empty until a click.
    expect(html).not.toContain('data-testid="meeting-link"');
    expect(html).toContain(en.meetings.links.none);
    expect(renderToStaticMarkup(wrap(<MeetingLinks meetingId="m1" isRecorder={false} />))).not.toContain('suggested-links');
  });

  it('shows a reader the links with no remove button and no add controls', () => {
    client.current.setQueryData(['meetings', 'links', 'list'], [link({})]);
    const html = renderToStaticMarkup(wrap(<MeetingLinks meetingId="m1" isRecorder={false} />));
    expect(html).toContain('Công ty Acme');
    expect(html).not.toContain(`>${en.meetings.links.remove}<`);
    expect(html).not.toContain(en.meetings.links.searchLabel);
  });

  it('says there is no link yet, and never shows an id for an unnamed target', () => {
    client.current.setQueryData(['meetings', 'links', 'list'], [link({ label: null, targetId: '0198a0b4-0000-7e6f-8a9b-0c1d2e3f4a5c' })]);
    const html = renderToStaticMarkup(wrap(<MeetingLinks meetingId="m1" isRecorder={false} />));
    expect(html).toContain(en.meetings.links.unnamed);
    expect(html.replace(/<[^>]*>/g, ' ')).not.toContain('0198a0b4');
    client.current.setQueryData(['meetings', 'links', 'list'], []);
    expect(renderToStaticMarkup(wrap(<MeetingLinks meetingId="m1" isRecorder />))).toContain(en.meetings.links.none);
  });
});

describe('LinkedMeetings', () => {
  const asRole = (role: string) => client.current.setQueryData(['org', 'get'], { role, members: [] });
  const row = (over: Partial<MeetingOfTarget>): MeetingOfTarget => ({ linkId: 'k1', meetingId: 'm1', title: 'Họp báo giá', startedAt: '2026-11-10T03:00:00.000Z', status: 'ready', visibility: 'org', recorderUserId: 'u1', ...over }) as MeetingOfTarget;

  it('lists the meetings the server returned, each as a link to the meeting', () => {
    asRole('member');
    client.current.setQueryData(['meetings', 'links', 'byTarget'], [row({}), row({ linkId: 'k2', meetingId: 'm2', title: 'Họp kỹ thuật', visibility: 'attendees' })]);
    const html = renderToStaticMarkup(wrap(<LinkedMeetings kind="deal" targetId="d1" />));
    expect(html).toContain('Họp báo giá');
    expect(html).toContain('Họp kỹ thuật');
    expect(html.match(/data-testid="linked-meeting"/g)).toHaveLength(2);
    expect(html).toContain('href="/o/$slug/meetings/$id"');
  });

  it('draws nothing but the empty line when the server returned no row (a meeting the viewer may not read is no row, and its title is nowhere)', () => {
    asRole('member');
    client.current.setQueryData(['meetings', 'links', 'byTarget'], []);
    const html = renderToStaticMarkup(wrap(<LinkedMeetings kind="party" targetId="p1" />));
    expect(html).toContain(en.meetings.links.forTargetEmpty);
    expect(html).not.toContain('Họp báo giá');
    expect(html).not.toContain('data-testid="linked-meeting"');
  });

  it('draws nothing for a viewer: the server answers members and above, so no refusal is shown on a contact or deal panel', () => {
    asRole('viewer');
    client.current.setQueryData(['meetings', 'links', 'byTarget'], [row({})]);
    expect(renderToStaticMarkup(wrap(<LinkedMeetings kind="party" targetId="p1" />))).toBe('');
  });
});
