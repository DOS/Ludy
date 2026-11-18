// SPDX-License-Identifier: AGPL-3.0-only
// The public booking page's slot picker (#3646), rendered on the server with the week's answer seeded: touch-size slots in a
// three or four column grid, no IANA zone name in front of a customer (a visitor in Vietnam sees no zone at all, one elsewhere
// sees the place and the offset), and an error in the page's own words with "Tải lại".
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog } from '../src/i18n/runtime.ts';
import { weekRange } from '../src/lib/booking.ts';

vi.mock('../src/lib/api.ts', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  takeOrgLeftNotice: () => null,
}));

const { SlotPicker, whenOf } = await import('../src/routes/booking-page.tsx');

const NOW = Date.parse('2026-11-02T01:00:00.000Z');
const PATH = '/api/booking/acme/goi-y';
const slots = [
  { start: '2026-11-02T02:00:00.000Z', end: '2026-11-02T02:30:00.000Z' },
  { start: '2026-11-02T03:00:00.000Z', end: '2026-11-02T03:30:00.000Z' },
];

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

function render(zone: string, seed: 'slots' | 'error', locale: 'vi' | 'en' = 'vi'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const key = ['booking-page', PATH, weekRange(NOW, 0, zone).from];
  if (seed === 'slots') qc.setQueryData(key, { orgName: 'Tiệm Bánh', eventType: { slug: 'goi-y', title: 'Tư vấn', description: null, durationMin: 30, locationKind: 'video' }, slots });
  else qc.getQueryCache().build(qc, { queryKey: key }).setState({ status: 'error', error: new Error('Không tải được'), fetchStatus: 'idle', data: undefined });
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <IntlProvider locale={locale} messages={catalog(locale)}>
          <SlotPicker path={PATH} zone={zone} onPick={() => undefined} />
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('the booking page slot picker', () => {
  it('makes every time and week button 44 px high, the times in a grid of three, four from sm up', () => {
    const html = render('Asia/Ho_Chi_Minh', 'slots');
    expect(html).toContain('grid grid-cols-3 gap-2 sm:grid-cols-4');
    expect(html.match(/<button[^>]*class="[^"]*\bh-11\b[^"]*"[^>]*>(09:00|10:00)</g)).toHaveLength(2);
    expect(html.match(/h-11 px-4/g)).toHaveLength(2);
    expect(html).not.toContain('h-7');
  });

  it('names no zone to a visitor in Vietnam, and never the IANA name', () => {
    const html = render('Asia/Ho_Chi_Minh', 'slots');
    expect(html).not.toContain('Asia/Ho_Chi_Minh');
    expect(html).not.toContain('múi giờ');
  });

  it('tells a visitor elsewhere the place and the offset, in the page language', () => {
    const vi = render('Asia/Tokyo', 'slots');
    expect(vi).toContain('Giờ hiển thị theo múi giờ của bạn: Tokyo (GMT+9).');
    expect(vi).not.toContain('Asia/Tokyo');
    const en = render('America/New_York', 'slots', 'en');
    expect(en).toContain('Times are in your time zone: New York (GMT-4 / GMT-5).');
    expect(en).not.toContain('America/New_York');
  });

  it('shows an error with the reload button, not a bare box', () => {
    const html = render('Asia/Ho_Chi_Minh', 'error');
    expect(html).toContain('Không tải được');
    expect(html).toContain('>Tải lại<');
  });
});

describe('whenOf', () => {
  const s = slots[0]!;
  it('prints no zone for Vietnam and the offset, never the IANA name, elsewhere', () => {
    expect(whenOf(s, 'Asia/Ho_Chi_Minh', 'vi')).toBe('Thứ Hai, 02/11/2026, 09:00 - 09:30');
    expect(whenOf(s, 'Asia/Tokyo', 'vi')).toBe('Thứ Hai, 02/11/2026, 11:00 - 11:30 (GMT+9)');
  });

  it('keeps the offset in a text that leaves the screen, a reply to a customer whose zone is not known', () => {
    expect(whenOf(s, 'Asia/Ho_Chi_Minh', 'vi', { named: true })).toBe('Thứ Hai, 02/11/2026, 09:00 - 09:30 (GMT+7)');
  });
});
