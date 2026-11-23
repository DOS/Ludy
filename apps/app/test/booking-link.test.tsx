// SPDX-License-Identifier: AGPL-3.0-only
// The booking link where the owner sets bookings up (#3643, audit CR-1, CR-11, CR-19, CR-20), rendered on the server with the API's answers seeded in the
// cache: Lịch hẹn shows the link of the one active event type (copy, "Mở thử"), a picker for several, an empty state whose one action is that link and a
// link to the settings (or, with no event type, to create the first), the calendar feed closed under its own heading, and nothing of it for a viewer; each
// active event type in Settings has its copy and view buttons; the form's default view is short, with visible labels and the generated link.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingItem, EventType } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

// A link as an anchor that names where it leads: the route with its parameters filled in, and its hash.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, to, params, hash }: { children?: ReactNode; to: string; params?: Record<string, string>; hash?: string }) =>
      createElement('a', { href: `${to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '')}${hash ? `#${hash}` : ''}` }, children),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions({ input }) / mutationOptions() / key(): the key is the path and the input, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (options?: { input?: unknown }) => ({
            queryKey: options?.input === undefined ? path : [...path, options.input],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

// The panel portals to the body, which the server does not render: this stand-in draws its form in place so the fields can be read.
vi.mock('../src/components/form-panel.tsx', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    FormPanel: (p: { title: string; footer: ReactNode | ((close: () => void) => ReactNode); children: ReactNode }) =>
      createElement('form', { 'aria-label': p.title }, p.children, typeof p.footer === 'function' ? p.footer(() => undefined) : p.footer),
  };
});

// Which apps are on comes from the deployment's config, which a render here has none of: none of the optional apps (notes, meetings) is on.
vi.mock('../src/lib/org-modules.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), installedModules: () => [] }));

const { BookingsPage } = await import('../src/routes/bookings.tsx');
const { EventTypesCard, EventTypeForm } = await import('../src/routes/event-types.tsx');

const ME = '00000000-0000-7000-8000-000000000001';
const at = '2026-10-24T00:00:00.000Z';
const type = (over: Partial<EventType>): EventType => ({
  description: null,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 240,
  horizonDays: 60,
  dailyLimit: null,
  locationValue: null,
  assignment: 'single',
  coHostUserIds: [],
  createdAt: at,
  updatedAt: at,
  id: '00000000-0000-7000-8000-0000000000a1',
  slug: 'tu-van-thue',
  title: 'Tư vấn thuế',
  durationMin: 30,
  locationKind: 'video',
  hostUserId: ME,
  active: true,
  ...over,
});
const consult = type({});
const review = type({ id: '00000000-0000-7000-8000-0000000000a2', slug: 'doi-soat', title: 'Đối soát', durationMin: 60 });
const archived = type({ id: '00000000-0000-7000-8000-0000000000a3', slug: 'cu', title: 'Loại cũ', active: false });

const booking: BookingItem = {
  id: '00000000-0000-7000-8000-0000000000b1',
  eventType: { id: consult.id, slug: consult.slug, title: consult.title, active: true },
  hostUserId: ME,
  hostUserIds: [ME],
  status: 'confirmed',
  startsAt: '2031-01-02T02:00:00.000Z',
  endsAt: '2031-01-02T02:30:00.000Z',
  timeZone: 'Asia/Ho_Chi_Minh',
  visitor: { name: 'Nguyễn Văn Khách', email: 'khach@example.test', phone: null, note: null },
  partyId: null,
  calendarEventId: '00000000-0000-7000-8000-0000000000c1',
  meeting: { state: 'none', url: null },
  deal: null,
  dealSuggestions: [],
};

const orgOf = (role: 'owner' | 'viewer') => ({ slug: 'acme', role, members: [{ userId: ME, email: 'me@example.test', displayName: 'Lan', role }] });

function page(role: 'owner' | 'viewer', types: EventType[], bookings: BookingItem[], locale: 'en' | 'vi' = 'en'): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['org', 'get'], orgOf(role));
  qc.setQueryData(['crm', 'eventTypes', 'list'], types);
  qc.setQueryData(['crm', 'bookings', 'list', { scope: role === 'owner' ? 'mine' : 'mine', period: 'upcoming', withSuggestions: true }], bookings);
  qc.setQueryData(['crm', 'bookingFeed', 'get', {}], null);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <BookingsPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

// A text as a pattern: every character with a meaning of its own, the backslash included, escaped.
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (html: string, text: string) => html.split(text).length - 1;

describe('Lịch hẹn: the booking link', () => {
  beforeEach(() => client.current.clear());

  it('with no booking yet, the empty state has the link as its one action, "Try it" and a link to the settings', () => {
    const html = page('owner', [consult, archived], []);
    expect(html).toContain(en.bookings.emptyLink.title);
    expect(html).toContain('value="/-/b/acme/tu-van-thue"');
    // One copy action on the screen, and the page header's "Booking settings" beside the empty state's own link to the hours and types.
    expect(count(html, `>${en.bookings.link.copy}<`)).toBe(1);
    expect(html).toContain(`href="/-/b/acme/tu-van-thue"`);
    expect(html).toContain(`>${en.bookings.link.open}<`);
    expect(html).toContain(`href="/o/acme/settings/bookings#booking-settings">${en.bookings.emptyLink.settings}<`);
    expect(html).toContain(`href="/o/acme/settings/bookings#booking-settings">${en.bookings.settingsLink}<`);
    // The archived type is not offered.
    expect(html).not.toContain('Loại cũ');
    expect(html).not.toContain('<select');
  });

  it('with no active event type, the empty state leads to creating the first one', () => {
    const html = page('owner', [archived], []);
    expect(html).toContain(en.bookings.emptyNoType.title);
    // Creating the first type goes to the event types card; the hours link goes to the card above it.
    expect(html).toContain(`href="/o/acme/settings/bookings#booking-event-types">${en.bookings.emptyNoType.action}<`);
    expect(html).not.toContain(`>${en.bookings.link.copy}<`);
  });

  it('with several active event types, the owner picks which link to copy', () => {
    const html = page('owner', [consult, review], []);
    expect(html).toContain(`>${en.bookings.link.type}`);
    expect(html).toMatch(/<option [^>]*value="00000000-0000-7000-8000-0000000000a1" selected="">Tư vấn thuế<\/option>/);
    expect(html).toMatch(/<option [^>]*value="00000000-0000-7000-8000-0000000000a2">Đối soát<\/option>/);
    expect(html).toContain('value="/-/b/acme/tu-van-thue"');
  });

  it('with bookings, the link sits above the list and the calendar feed is closed under its own heading', () => {
    const html = page('owner', [consult], [booking]);
    expect(html).toContain(`>${en.bookings.link.title}<`);
    expect(html).toContain('value="/-/b/acme/tu-van-thue"');
    expect(html).not.toContain(en.bookings.emptyLink.title);
    const details = html.slice(html.indexOf('<details'));
    expect(details.startsWith('<details ')).toBe(true);
    expect(details.slice(0, details.indexOf('>'))).not.toContain(' open');
    expect(details).toContain(`>${en.bookings.feed.section}</summary>`);
    // The feed comes after the list, no longer before the first booking.
    expect(html.indexOf('booking-row')).toBeLessThan(html.indexOf('<details'));
  });

  it('shows a viewer neither the link, the settings link nor the feed', () => {
    const html = page('viewer', [consult], []);
    expect(html).not.toContain('booking-link');
    expect(html).not.toContain('booking-settings');
    expect(html).not.toContain('<details');
    expect(html).toContain(en.bookings.emptyUpcoming);
  });

  it('reads in Vietnamese', () => {
    const html = page('owner', [consult], [], 'vi');
    expect(html).toContain(viMessages.bookings.emptyLink.title);
    expect(html).toContain(`>${viMessages.bookings.link.copy}<`);
    expect(html).toContain(`>${viMessages.bookings.link.open}<`);
    expect(html).toContain(`>${viMessages.bookings.emptyLink.settings}<`);
  });
});

describe('Settings: event types and their link', () => {
  const card = (list: EventType[], role: 'owner' | 'viewer' = 'owner') => {
    const qc = client.current;
    qc.clear();
    qc.setQueryData(['crm', 'eventTypes', 'list'], list);
    qc.setQueryData(['calendar', 'connections'], []);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <EventTypesCard slug="acme" members={orgOf('owner').members.map((m) => ({ ...m, role: 'owner' as const }))} me={ME} role={role} />
        </IntlProvider>
      </QueryClientProvider>,
    );
  };

  it('gives each active event type its copy and view buttons, and an archived one none', () => {
    const rows = card([consult, archived]).split('<li').slice(1);
    expect(rows[0]).toContain(`aria-label="${en.bookings.link.copyOf.replace('{title}', 'Tư vấn thuế')}"`);
    expect(rows[0]).toContain(`>${en.bookings.link.copy}<`);
    expect(rows[0]).toContain('href="/-/b/acme/tu-van-thue"');
    expect(rows[0]).toContain(`>${en.bookings.link.view}<`);
    expect(rows[1]).not.toContain(`>${en.bookings.link.copy}<`);
    expect(rows[1]).not.toContain('href="/-/b/acme/cu"');
  });

  it('marks the event types card as the target of "Tạo loại lịch hẹn"', () => {
    expect(card([consult])).toContain('id="booking-event-types"');
  });

  it('offers the link to a viewer too: it is the public address', () => {
    expect(card([consult], 'viewer')).toContain('href="/-/b/acme/tu-van-thue"');
  });

  it('opens the add form with a name, length, format and place, each labelled, and the rest under "More options"', () => {
    // The card holds a button; the form is in the panel behind it (#3608), drawn here by the stand-in above.
    expect(card([])).not.toContain('<form');
    const qc = client.current;
    qc.clear();
    qc.setQueryData(['calendar', 'connections'], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <EventTypeForm slug="acme" type={null} members={orgOf('owner').members.map((m) => ({ ...m, role: 'owner' as const }))} me={ME} manager pending={false} submitLabel={en.eventTypes.add} onSubmit={() => undefined} onCancel={() => undefined} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    const form = html.slice(html.indexOf('<form'));
    for (const field of ['title', 'durationMin', 'locationKind', 'locationValue'] as const) {
      expect(form).toMatch(new RegExp(`<label[^>]*>${escaped(en.eventTypes.fields[field])}<`));
    }
    expect(form).toContain(`>${en.eventTypes.moreOptions}</button>`);
    expect(form).toContain('aria-expanded="false"');
    for (const field of ['bufferBeforeMin', 'minNoticeHours', 'host', 'assignment', 'slug', 'description'] as const) {
      expect(form).not.toContain(`>${en.eventTypes.fields[field]}`);
    }
    // The generated link instead of a slug box; it shows once the name makes it.
    expect(form).toContain(en.eventTypes.linkPending);
    // "Add" is the primary button, not an outline one.
    expect(form).toMatch(/<button[^>]*type="submit"[^>]*>/);
    expect(form.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('border-border');
  });
});
