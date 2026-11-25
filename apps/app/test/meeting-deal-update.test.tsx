// SPDX-License-Identifier: AGPL-3.0-only
// The "update the deal" card of a meeting (#4766): it shows only when a deal is linked, the minutes are published and the deal is open; the Vy button is there only when Vy may be asked;
// with Vy off the recorder still gets the two fields; Save waits until there is a text. Rendered on the server from a seeded status.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DealUpdateStatus } from '@ludy/kernel-contract';
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
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});

const { MeetingDealUpdate } = await import('../src/components/meeting-deal-update.tsx');

const MEETING = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const STATUS: DealUpdateStatus = {
  meetingId: MEETING,
  available: true,
  enabled: true,
  reason: null,
  deal: { id: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c', title: 'Hợp đồng cà phê', stage: 'Đàm phán' },
  minutesKey: 'k1',
};

function render(status: DealUpdateStatus, locale: 'en' | 'vi' = 'en') {
  client.current.setQueryData(['meetings', 'dealUpdate', 'status'], status);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingDealUpdate meetingId={MEETING} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('MeetingDealUpdate', () => {
  beforeEach(() => client.current.clear());

  it('shows nothing when there is no deal, no published minutes or the deal is closed', () => {
    for (const reason of ['no_deal', 'no_minutes', 'deal_closed', 'not_recorder'] as const) {
      expect(render({ ...STATUS, available: false, enabled: false, reason, deal: null, minutesKey: null }), reason).toBe('');
    }
  });

  it('names the deal, offers Vy and the two fields, and keeps Save disabled until there is a text', () => {
    const html = render(STATUS);
    expect(html).toContain('data-testid="meeting-deal-update"');
    expect(html).toContain('Hợp đồng cà phê');
    expect(html).toContain(en.meetings.dealUpdate.ask);
    expect(html).toContain(en.meetings.dealUpdate.step);
    expect(html).toContain(en.meetings.dealUpdate.note);
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="deal-update-save"|<button[^>]*data-testid="deal-update-save"[^>]*disabled/u);
    // Nothing to read yet, so no "I have read it" box.
    expect(html).not.toContain('data-testid="deal-update-read"');
  });

  it('works with Vy off: no ask button, the reason, and the same two fields', () => {
    const html = render({ ...STATUS, enabled: false, reason: 'off' });
    expect(html).not.toContain('data-testid="deal-update-ask"');
    expect(html).toContain(en.meetings.dealUpdate.state.off);
    expect(html).toContain('data-testid="deal-update-save"');
    expect(html).toContain(en.meetings.dealUpdate.step);
  });

  it('reads in Vietnamese', () => {
    const html = render(STATUS, 'vi');
    expect(html).toContain(viMessages.meetings.dealUpdate.step);
    expect(html).toContain(viMessages.meetings.dealUpdate.save);
  });
});
