// SPDX-License-Identifier: AGPL-3.0-only
// "This week in your meetings" on the meetings page (#3949): the decisions and open items of the meetings the member reads, numbered across meetings and each under its meeting with a link; a plain note when
// there is nothing; Vy's button only when Vy can be used (absent with AI off, the reason said when paused or the budget is spent); and Vy's sentences shown as text with the numbers of the facts they rest on.
// Rendered on the server from the query cache.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { DigestAnswer, DigestFacts } from '@crove/kernel-contract';
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
vi.mock('../src/i18n/provider.tsx', () => ({ useFormat: () => ({ date: (v: string) => `date:${v.slice(0, 10)}`, aiAmount: (v: string) => `$${v}`, number: (v: number | bigint | string) => String(v), money: (v: string) => `vnd:${v}` }) }));
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string> } & Record<string, unknown>) =>
      createElement('a', { href: to.replace('$slug', params?.slug ?? '').replace('$id', params?.id ?? ''), ...rest }, children),
  };
});

const { DigestResult, MeetingDigest, digestFailureKey } = await import('../src/components/meeting-digest.tsx');

const ME = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const NAM = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c';
const M1 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5d';
const M2 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5e';
const facts = (over: Partial<DigestFacts> = {}): DigestFacts => ({
  days: 7,
  meetings: [
    {
      meetingId: M1,
      title: 'Giao ban tuần',
      startedAt: '2026-11-17T02:00:00.000Z',
      decisions: ['Chốt giá gói kế toán 15.000.000 đồng', 'Gặp khách thứ sáu'],
      items: [
        { id: 'i1', title: 'Gửi báo giá', who: 'Nam', whoUserId: NAM, assigneeSeat: null, when: 'thứ sáu', whenDate: null, assigned: true, taskStatus: 'in_progress', due: '2026-11-20T00:00:00.000Z' },
        { id: 'i2', title: 'Chưa ai nhận', who: '', whoUserId: null, assigneeSeat: null, when: '', whenDate: null, assigned: false, taskStatus: null, due: null },
      ],
    },
    { meetingId: M2, title: 'Họp khách Á Châu', startedAt: '2026-11-16T02:00:00.000Z', decisions: ['Hẹn ký hợp đồng'], items: [] },
  ],
  cut: false,
  empty: false,
  ...over,
});
const status = (over: Partial<{ enabled: boolean; reason: 'off' | 'forbidden' | 'paused' | 'budget' | null }> = {}) => ({ enabled: true, reason: null, estimate: null, ...over });
const EMPTY = facts({ meetings: [], empty: true });

function render(data: DigestFacts | undefined, opts: { status?: ReturnType<typeof status>; meter?: { aiOn: boolean; state: 'none' | 'ok' | 'warn' | 'stop' }; locale?: 'en' | 'vi'; node?: ReactNode } = {}) {
  client.current.clear();
  if (data) client.current.setQueryData(['meetings', 'digest', 'facts'], data);
  if (opts.status) client.current.setQueryData(['meetings', 'digest', 'status'], opts.status);
  client.current.setQueryData(['ai', 'meter'], opts.meter ?? { aiOn: true, state: 'ok', percent: 10 });
  client.current.setQueryData(['org', 'get'], { role: 'member', members: [{ userId: ME, email: 'me@example.com', displayName: 'Tôi', role: 'member' }, { userId: NAM, email: 'nam@example.com', displayName: 'Anh Nam', role: 'member' }] });
  client.current.setQueryData(['me', 'get'], { userId: ME });
  const locale = opts.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {opts.node ?? <MeetingDigest slug="acme" />}
      </IntlProvider>
    </QueryClientProvider>,
  );
}
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('MeetingDigest', () => {
  it('lists the decisions and the open items meeting by meeting, numbered across meetings, each meeting linking to its page', () => {
    const html = render(facts());
    expect(html).toContain('data-testid="meeting-digest"');
    expect(html.match(/data-testid="digest-meeting"/g)).toHaveLength(2);
    expect(html).toContain('href="/o/$slug/meetings/$id"'.replace('$slug', 'acme').replace('$id', M1));
    expect(html).toContain('href="/o/$slug/meetings/$id"'.replace('$slug', 'acme').replace('$id', M2));
    expect(html.match(/data-testid="digest-fact"/g)).toHaveLength(5);
    // The numbers run on from one meeting to the next: 1-2 decisions, 3-4 items, 5 the second meeting's decision.
    // The number is the text of the circle; it has no `aria-label` of its own (a name on a plain `span` is not allowed by ARIA), so a screen reader reads the number, which Vy's sentences cite.
    const numbers = [...html.matchAll(/<span class="inline-flex h-5[^"]*">(\d+)<\/span>/g)].map((m) => m[1]);
    expect(numbers).toEqual(['1', '2', '3', '4', '5']);
    expect(html).not.toMatch(/<span class="inline-flex h-5[^"]*"[^>]*aria-label/);
    const t = text(html);
    expect(t).toContain('Chốt giá gói kế toán 15.000.000 đồng');
    expect(t).toContain('Gửi báo giá');
    expect(t).toContain('Chưa ai nhận');
    expect(t).toContain('Hẹn ký hợp đồng');
    expect(t).toContain('2026-11-17');
    // A person is named, never an id.
    expect(t).not.toContain(NAM);
  });

  it('has one polite line that is always in the page, empty on load, and the words it is filled with in both languages (#4055; filling it after a pick is left to the browser spec)', () => {
    const html = render(facts(), { status: status() });
    // Empty until the picker is used: nothing is announced on load. It is in the page from the start, so the later text is read when it is filled in.
    expect(html).toMatch(/<p[^>]*role="status"[^>]*data-testid="digest-window-status"[^>]*><\/p>|<p[^>]*data-testid="digest-window-status"[^>]*role="status"[^>]*><\/p>/);
    expect(en.meetings.digest.windowShown).toBe('Showing the last {count} days');
    expect(viMessages.meetings.digest.windowShown).toBe('Đang xem {count} ngày gần đây');
  });

  it('says plainly when there is nothing, with the window still pickable, and says when the caps cut', () => {
    const none = render(EMPTY);
    expect(none).toContain('data-testid="digest-nothing"');
    expect(none).toContain('data-testid="digest-window"');
    expect(none).not.toContain('data-testid="digest-vy"');
    expect(render(facts({ cut: true }))).toContain('data-testid="digest-cut"');
    // Nothing shown but the limit hid some: the note says so rather than leaving "nothing" alone.
    expect(render(facts({ meetings: [], empty: true, cut: true }))).toContain('data-testid="digest-cut"');
    expect(none).not.toContain('data-testid="digest-cut"');
    expect(render(facts({ cut: false }))).not.toContain('data-testid="digest-cut"');
    // Nothing at all until the facts are read.
    expect(render(undefined)).toBe('');
  });

  it('offers Vy only when Vy can be used: absent with AI off, the reason said when paused or the budget is spent', () => {
    expect(render(facts())).not.toContain('data-testid="digest-vy"');
    expect(render(facts(), { status: status({ enabled: false, reason: 'off' }) })).not.toContain('data-testid="digest-vy"');
    expect(render(facts(), { status: status(), meter: { aiOn: false, state: 'ok' } })).not.toContain('data-testid="digest-vy"');
    const on = render(facts(), { status: status() });
    expect(on).toContain('data-testid="digest-recap"');
    expect(on).toContain(en.meetings.digest.submit);
    expect(on).not.toContain('data-testid="digest-blocked"');
    const paused = render(facts(), { status: status({ enabled: false, reason: 'paused' }) });
    expect(paused).toContain('data-testid="digest-blocked"');
    expect(paused).toMatch(/data-testid="digest-recap"[^>]*disabled|disabled[^>]*data-testid="digest-recap"/);
    expect(render(facts(), { status: status(), meter: { aiOn: true, state: 'stop' } })).toContain('data-testid="digest-blocked"');
  });

  it('reads in Vietnamese too, with the same keys as English', () => {
    const vi = render(facts(), { status: status(), locale: 'vi' });
    expect(vi).toContain(viMessages.meetings.digest.title);
    expect(vi).toContain(viMessages.meetings.digest.submit);
    expect(Object.keys(viMessages.meetings.digest).sort()).toEqual(Object.keys(en.meetings.digest).sort());
    expect(Object.keys(viMessages.meetings.digest.codes).sort()).toEqual(Object.keys(en.meetings.digest.codes).sort());
  });
});

describe('DigestResult', () => {
  const answer = (over: Partial<DigestAnswer>): DigestAnswer => ({ state: 'written', errorCode: null, sentences: [{ text: 'Tuần này đã chốt giá gói kế toán 15.000.000 đồng.', facts: [1] }], dropped: 0, lines: 5, ...over });
  const show = (a: DigestAnswer, count?: number) => render(undefined, { node: <DigestResult answer={a} {...(count === undefined ? {} : { count })} /> });

  it('shows the sentences as text with the numbers of the facts they rest on, and what was left out', () => {
    const html = show(answer({ dropped: 2 }));
    expect(html).toContain('data-testid="digest-answer"');
    expect(html.match(/data-testid="digest-sentence"/g)).toHaveLength(1);
    expect(text(html)).toContain('Tuần này đã chốt giá gói kế toán 15.000.000 đồng.');
    expect(text(html)).toContain('Based on: 1');
    expect(text(html)).toContain('Left out 2 sentence(s)');
    expect(text(html)).toContain(en.meetings.digest.private);
  });

  it('says so when the lists changed since the card read them: the numbers a sentence cites may point at other facts', () => {
    expect(show(answer({ lines: 5 }), 5)).not.toContain('data-testid="digest-stale"');
    const stale = show(answer({ lines: 5 }), 6);
    expect(stale).toContain('data-testid="digest-stale"');
    expect(text(stale)).toContain(en.meetings.digest.stale);
  });

  it('writes a sentence as text and never as markup', () => {
    const html = show(answer({ sentences: [{ text: '<img src=x onerror=alert(1)>', facts: [1] }] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('says there is nothing to add, and names a failure by its fixed code', () => {
    expect(show(answer({ state: 'none', sentences: [] }))).toContain('data-testid="digest-none"');
    const failed = show(answer({ state: 'failed', errorCode: 'DIGEST_TIMEOUT', sentences: [] }));
    expect(text(failed)).toContain(en.meetings.digest.failed);
    expect(text(failed)).toContain(en.meetings.digest.codes.DIGEST_TIMEOUT);
    expect(digestFailureKey('DIGEST_BUSY')).toBe('DIGEST_BUSY');
    expect(digestFailureKey('SOMETHING_ELSE')).toBe('default');
    expect(digestFailureKey(null)).toBe('default');
  });
});
