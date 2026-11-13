// SPDX-License-Identifier: AGPL-3.0-only
// A booking and its deal (#3103, docs/plan/calendar.md "Deal links"), rendered on the server from a seeded cache: the deal panel lists the deal's upcoming and past bookings with
// "Gỡ liên kết" and "Đặt lịch" for a person who reads bookings, and nothing for a viewer; a booking of the "Lịch hẹn" screen shows its deal, or Dy's suggestions with "Liên kết"
// (a person's click, in the proposal style), or nothing; the link "Đặt lịch" offers carries the deal and the public page reads only an id from its address.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingItem } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
// What each query was asked with, by path.
const asked = vi.hoisted(() => ({ inputs: [] as Array<{ path: string; input: unknown }> }));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  Link: ({ children, ...rest }: { children?: unknown }) => <a {...(rest as object)}>{children as never}</a>,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions')
          return (options?: { input?: unknown }) => {
            asked.inputs.push({ path: path.join('.'), input: options?.input });
            return { queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) };
          };
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

const { BookingDeal, DealBookings } = await import('../src/components/booking-deal.tsx');
const { bookingLinkOf } = await import('../src/components/booking-suggest.tsx');
const { dealIdOf } = await import('../src/routes/booking-page.tsx');

const DEAL_ID = '00000000-0000-4000-8000-000000000040';
const booking = (id: string, over: Partial<BookingItem> = {}): BookingItem => ({
  id,
  eventType: { id: '00000000-0000-4000-8000-000000000050', slug: 'tu-van', title: 'Tư vấn thuế', active: true },
  hostUserId: '00000000-0000-4000-8000-000000000001',
  hostUserIds: ['00000000-0000-4000-8000-000000000001'],
  status: 'confirmed',
  startsAt: '2031-01-02T02:00:00.000Z',
  endsAt: '2031-01-02T02:30:00.000Z',
  timeZone: 'Asia/Ho_Chi_Minh',
  visitor: { name: 'Nguyễn Văn Khách', email: 'khach@example.test', phone: null, note: null },
  partyId: null,
  calendarEventId: '00000000-0000-4000-8000-000000000060',
  meeting: { state: 'none', url: null },
  deal: { id: DEAL_ID, title: 'Gói kế toán năm', stage: 'Báo giá', status: 'open' },
  dealSuggestions: [],
  ...over,
});
const count = (html: string, needle: string) => html.split(needle).length - 1;

function panel(canEdit: boolean, data: { upcoming: BookingItem[]; past: BookingItem[] }): string {
  setActiveLocale('vi');
  client.current.setQueryData(['crm', 'deals', 'bookings'], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>
        <DealBookings deal={{ id: DEAL_ID, title: 'Gói kế toán năm' }} canEdit={canEdit} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const cell = (b: BookingItem): string => {
  setActiveLocale('vi');
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>
        <BookingDeal booking={b} />
      </I18nProvider>
    </QueryClientProvider>,
  );
};

describe('the deal panel (#3103)', () => {
  beforeEach(() => client.current.clear());

  it('lists the upcoming and the past bookings of the deal, each with "Gỡ liên kết", and offers "Đặt lịch"', () => {
    const html = panel(true, {
      upcoming: [booking('00000000-0000-4000-8000-000000000071'), booking('00000000-0000-4000-8000-000000000072', { status: 'cancelled' })],
      past: [booking('00000000-0000-4000-8000-000000000073', { startsAt: '2030-12-02T02:00:00.000Z', endsAt: '2030-12-02T02:30:00.000Z' })],
    });
    expect(html).toContain('Lịch hẹn của cơ hội này');
    expect(count(html, 'data-testid="deal-booking"')).toBe(3);
    expect(count(html, 'data-testid="deal-booking-unlink"')).toBe(3);
    expect(count(html, 'data-testid="deal-book"')).toBe(1);
    // The upcoming group holds two (one cancelled), the past one.
    const upcoming = html.slice(html.indexOf('data-testid="deal-bookings-upcoming"'), html.indexOf('data-testid="deal-bookings-past"'));
    expect(count(upcoming, 'data-testid="deal-booking"')).toBe(2);
    expect(upcoming).toContain('Đã hủy');
    expect(upcoming).toContain('Đã xác nhận');
    expect(html).toContain('Tư vấn thuế');
    expect(html).toContain('Nguyễn Văn Khách');
  });

  it('asks for the bookings of this deal and no other', () => {
    asked.inputs.length = 0;
    panel(true, { upcoming: [], past: [] });
    expect(asked.inputs.filter((a) => a.path === 'crm.deals.bookings').map((a) => a.input)).toEqual([{ dealId: DEAL_ID }]);
  });

  it('says so when the deal has no booking yet, and shows an erased guest as such', () => {
    const empty = panel(true, { upcoming: [], past: [] });
    expect(empty).toContain('Chưa có lịch hẹn sắp tới.');
    expect(empty).toContain('Chưa có lịch hẹn đã qua.');
    expect(count(empty, 'data-testid="deal-booking"')).toBe(0);
    const erased = panel(true, { upcoming: [booking('00000000-0000-4000-8000-000000000071', { visitor: { name: null, email: null, phone: null, note: null } })], past: [] });
    expect(erased).toContain('Đã xóa theo yêu cầu');
  });

  it('shows a viewer nothing: a viewer reads no booking', () => {
    expect(panel(false, { upcoming: [booking('00000000-0000-4000-8000-000000000071')], past: [] })).toBe('');
  });
});

describe('the deal of a booking on the Lịch hẹn screen (#3103)', () => {
  beforeEach(() => client.current.clear());

  it('shows the linked deal with its stage and "Gỡ liên kết", and no suggestion', () => {
    const html = cell(booking('00000000-0000-4000-8000-000000000071'));
    expect(count(html, 'data-testid="booking-deal-linked"')).toBe(1);
    expect(html).toContain('Gói kế toán năm');
    expect(html).toContain('Báo giá');
    expect(count(html, 'data-testid="booking-deal-unlink"')).toBe(1);
    expect(count(html, 'data-testid="booking-deal-suggestion"')).toBe(0);
  });

  it('shows the coworker\'s suggestions, each with its reason and a "Liên kết" button, in the proposal style', () => {
    const html = cell(
      booking('00000000-0000-4000-8000-000000000071', {
        deal: null,
        dealSuggestions: [
          { id: '00000000-0000-4000-8000-000000000041', title: 'Báo giá thuế', stage: 'Mới', match: 'contact' },
          { id: '00000000-0000-4000-8000-000000000042', title: 'Dịch vụ kế toán', stage: 'Đã liên hệ', match: 'email' },
          { id: '00000000-0000-4000-8000-000000000043', title: 'Hóa đơn điện tử', stage: 'Báo giá', match: 'phone' },
        ],
      }),
    );
    expect(count(html, 'data-testid="booking-deal-suggestion"')).toBe(3);
    expect(count(html, 'data-testid="booking-deal-link"')).toBe(3);
    expect(count(html, 'data-testid="booking-deal-unlink"')).toBe(0);
    expect(html).toContain('cùng liên hệ');
    expect(html).toContain('cùng email');
    expect(html).toContain('cùng số điện thoại');
    expect(html).toContain('border-dashed');
    expect(html).toContain('Liên kết');
  });

  it('shows nothing for a booking with no deal and no suggestion', () => {
    expect(cell(booking('00000000-0000-4000-8000-000000000071', { deal: null }))).toBe('');
  });
});

describe('"Đặt lịch" from a deal (#3103)', () => {
  it('puts the deal in the address of the booking page, and leaves a plain link plain', () => {
    expect(bookingLinkOf('https://app.example.test', 'acme', 'tu-van')).toBe('https://app.example.test/-/b/acme/tu-van');
    expect(bookingLinkOf('https://app.example.test', 'acme', 'tu-van', DEAL_ID)).toBe(`https://app.example.test/-/b/acme/tu-van?deal=${DEAL_ID}`);
  });

  it('reads only an id from the address of the public page', () => {
    expect(dealIdOf(`?deal=${DEAL_ID}`)).toBe(DEAL_ID);
    expect(dealIdOf(`?x=1&deal=${DEAL_ID.toUpperCase()}`)).toBe(DEAL_ID);
    expect(dealIdOf('')).toBeNull();
    expect(dealIdOf('?deal=')).toBeNull();
    expect(dealIdOf('?deal=khach@example.test')).toBeNull();
    expect(dealIdOf(`?deal=${DEAL_ID}x`)).toBeNull();
    expect(dealIdOf('?deal=<script>')).toBeNull();
    // An id the server's check would refuse (a version or a variant that is not an RFC one) is dropped here, so a hand-edited link never stops a booking.
    expect(dealIdOf('?deal=12345678-1234-0234-1234-123456789012')).toBeNull();
    expect(dealIdOf('?deal=12345678-1234-4234-0234-123456789012')).toBeNull();
    expect(dealIdOf('?deal=01a1d3d0-e67a-7cd2-8c2a-ca4658a32f14')).toBe('01a1d3d0-e67a-7cd2-8c2a-ca4658a32f14');
  });
});
