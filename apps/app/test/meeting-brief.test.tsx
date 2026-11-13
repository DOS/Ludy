// SPDX-License-Identifier: AGPL-3.0-only
// Dy's brief before a booking linked to a deal (#3115, docs/plan/calendar.md "Meeting brief as built"), rendered on the server: a confirmed booking that has not ended and has a deal offers
// "Chuẩn bị cuộc hẹn"; a cancelled booking, one that has ended and one with no deal offer nothing. The brief shows Dy's words in the proposal style only when the model wrote them and the facts list
// always, with the state in one line; a member who may not read the conversation sees the facts without messages.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BookingItem, MeetingBrief } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

const { BookingDeal, MeetingBriefBody } = await import('../src/components/booking-deal.tsx');

const ID = '00000000-0000-4000-8000-0000000000';
const booking = (over: Partial<BookingItem> = {}): BookingItem => ({
  id: `${ID}71`,
  eventType: { id: `${ID}50`, slug: 'tu-van', title: 'Tư vấn thuế', active: true },
  hostUserId: `${ID}01`,
  hostUserIds: [`${ID}01`],
  status: 'confirmed',
  startsAt: '2099-01-02T02:00:00.000Z',
  endsAt: '2099-01-02T02:30:00.000Z',
  timeZone: 'Asia/Ho_Chi_Minh',
  visitor: { name: 'Nguyễn Văn Khách', email: 'khach@example.test', phone: null, note: null },
  partyId: null,
  calendarEventId: `${ID}60`,
  meeting: { state: 'none', url: null },
  deal: { id: `${ID}40`, title: 'Gói kế toán năm', stage: 'Báo giá', status: 'open' },
  dealSuggestions: [],
  ...over,
});
const brief = (over: Partial<MeetingBrief> = {}): MeetingBrief => ({
  ai: 'used',
  bookingId: `${ID}71`,
  dealId: `${ID}40`,
  meeting: { title: 'Tư vấn thuế', startsOn: '2099-01-02', startsTime: '09:00', timeZone: 'Asia/Ho_Chi_Minh', guestName: 'Nguyễn Văn Khách' },
  deal: { title: 'Gói kế toán năm', stage: 'Báo giá', status: 'open', amount: '25000000.00', expectedClose: '2099-01-31', contactName: 'Công ty Hoa Mai' },
  nextSteps: [{ reason: 'quote_unanswered', sinceOn: '2098-12-20' }],
  quote: { label: 'BG-2026-0042', total: '48250000.00', status: 'sent', validUntil: '2099-01-20', expired: false, sentOn: '2098-12-20' },
  messages: ['Chị cần thêm 3 tài khoản nữa nhé'],
  summary: 'Cơ hội đang ở giai đoạn Báo giá.',
  points: ['Hỏi khách đã xem báo giá chưa.', 'Xác nhận số tài khoản.'],
  ...over,
});

function render(node: React.ReactNode): string {
  setActiveLocale('vi');
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the entry to the brief (#3115)', () => {
  it('offers "Chuẩn bị cuộc hẹn" for a confirmed, upcoming booking with a deal, and the panel stays closed until a person opens it', () => {
    const html = render(<BookingDeal booking={booking()} />);
    expect(html).toContain('data-testid="booking-brief-open"');
    expect(html).toContain('Chuẩn bị cuộc hẹn');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="booking-brief-body"');
  });

  it.each([
    ['a cancelled booking', booking({ status: 'cancelled' })],
    ['a booking that has ended', booking({ startsAt: '2020-01-02T02:00:00.000Z', endsAt: '2020-01-02T02:30:00.000Z' })],
    ['a booking with no deal', booking({ deal: null })],
  ])('offers nothing for %s', (_what, b) => {
    expect(render(<BookingDeal booking={b} />)).not.toContain('data-testid="booking-brief-open"');
  });
});

describe('the brief (#3115)', () => {
  it('shows Dy\'s words in the proposal style with the facts list from the books, the exact amounts and the customer\'s words', () => {
    const html = render(<MeetingBriefBody brief={brief()} />);
    expect(html).toContain('data-testid="booking-brief-words"');
    expect(html).toContain('data-state="used"');
    expect(html).toContain('Cơ hội đang ở giai đoạn Báo giá.');
    expect(html).toContain('Hỏi khách đã xem báo giá chưa.');
    // The facts list: the deal, the amount, the open follow-up, the latest sent quote with its total.
    const facts = html.slice(html.indexOf('data-testid="booking-brief-facts"'));
    expect(facts).toContain('Gói kế toán năm');
    expect(facts).toContain('Công ty Hoa Mai');
    expect(facts).toContain('BG-2026-0042');
    expect(facts).toContain('Chị cần thêm 3 tài khoản nữa nhé');
    expect(html.replace(/\s| /g, '')).toMatch(/25\.000\.000/);
    expect(html.replace(/\s| /g, '')).toMatch(/48\.250\.000/);
  });

  it.each(['off', 'busy', 'budget', 'failed'] as const)('shows the facts list alone, with the state in one line, when the state is %s', (ai) => {
    const html = render(<MeetingBriefBody brief={brief({ ai, summary: null, points: [] })} />);
    expect(html).toContain(`data-state="${ai}"`);
    expect(html).not.toContain('data-testid="booking-brief-words"');
    expect(html).toContain('data-testid="booking-brief-facts"');
    expect(html).toContain('Gói kế toán năm');
  });

  it('says so, and shows no message, for a member who may not read the conversation, and says there is no quote or follow-up when there is none', () => {
    const html = render(<MeetingBriefBody brief={brief({ messages: [], quote: null, nextSteps: [], deal: { ...brief().deal, amount: null, expectedClose: null } })} />);
    expect(html).toContain('Không có tin nhắn nào của khách mà bạn được xem.');
    expect(html).toContain('Chưa gửi báo giá nào cho cơ hội này.');
    expect(html).toContain('Không có việc cần theo dõi nào đang mở.');
    expect(html).toContain('Cơ hội chưa có giá trị');
    expect(html).not.toContain('3 tài khoản');
  });
});
