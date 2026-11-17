// SPDX-License-Identifier: AGPL-3.0-only
// "Chuẩn bị cho buổi họp" on a meeting's page and on the card of an upcoming calendar event (#3543): the numbered facts (decisions, open items, the customer's open deals with their stage), each linking
// to its source; no card at all with nothing to say or for a reader who did not read the previous meeting; Vy's button only when Vy can be used (absent with AI off, the reason said when paused or the
// budget is spent); and Vy's sentences shown as text with the numbers of the facts they rest on. Rendered on the server from the query cache.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { BriefAnswer, BriefFacts, BriefStatus } from '@crove/kernel-contract';
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

const { AgendaBrief, BriefResult, MeetingBrief, briefFailureKey } = await import('../src/components/meeting-brief.tsx');

const ME = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const NAM = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c';
const M1 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5d';
const P1 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5e';
const D1 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5f';
const facts = (over: Partial<BriefFacts> = {}): BriefFacts => ({
  previous: { meetingId: M1, title: 'Giao ban tuần trước', startedAt: '2026-11-10T02:00:00.000Z' },
  decisions: ['Chốt giá gói kế toán 15.000.000 đồng'],
  items: [
    { id: 'i1', title: 'Gửi báo giá', who: 'Nam', whoUserId: NAM, assigneeSeat: null, when: 'thứ sáu', whenDate: null, assigned: true, taskStatus: 'in_progress', due: '2026-12-01T00:00:00.000Z' },
    { id: 'i2', title: 'Chưa ai nhận', who: '', whoUserId: null, assigneeSeat: null, when: '', whenDate: null, assigned: false, taskStatus: null, due: null },
  ],
  customer: { partyId: P1, name: 'Công ty Á Châu' },
  deals: [{ id: D1, title: 'Gói kế toán năm', stage: 'Báo giá', amount: '15000000', expectedClose: '2026-12-31' }],
  empty: false,
  ...over,
});
const status = (over: Partial<BriefStatus> = {}): BriefStatus => ({ enabled: true, reason: null, estimate: null, ...over });
const EMPTY = facts({ previous: null, decisions: [], items: [], customer: null, deals: [], empty: true });

function render(data: BriefFacts | undefined, opts: { status?: BriefStatus; meter?: { aiOn: boolean; state: 'none' | 'ok' | 'warn' | 'stop' }; locale?: 'en' | 'vi'; node?: ReactNode } = {}) {
  client.current.clear();
  if (data) client.current.setQueryData(['meetings', 'brief', 'facts'], data);
  if (opts.status) client.current.setQueryData(['meetings', 'brief', 'status'], opts.status);
  client.current.setQueryData(['ai', 'meter'], opts.meter ?? { aiOn: true, state: 'ok', percent: 10 });
  client.current.setQueryData(['org', 'get'], { role: 'member', members: [{ userId: ME, email: 'me@example.com', displayName: 'Tôi', role: 'member' }, { userId: NAM, email: 'nam@example.com', displayName: 'Anh Nam', role: 'member' }] });
  client.current.setQueryData(['me', 'get'], { userId: ME });
  const locale = opts.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {opts.node ?? <MeetingBrief slug="acme" meetingId="m2" />}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the brief before a meeting', () => {
  it('lists the numbered facts and links each to its source: the previous meeting, the deal', () => {
    const html = render(facts(), { status: status() });
    expect(html).toContain('data-testid="meeting-brief"');
    expect(html).toContain(en.meetings.brief.title);
    expect(html).toContain('Giao ban tuần trước');
    expect(html).toContain('href="/o/acme/meetings/' + M1 + '"');
    expect(html).toContain('Chốt giá gói kế toán 15.000.000 đồng');
    expect(html).toContain('Gửi báo giá');
    expect(html).toContain('Anh Nam');
    expect(html).toContain(en.meetings.series.status.in_progress);
    expect(html).toContain(en.meetings.series.unassigned);
    expect(html).toContain('Gói kế toán năm');
    expect(html).toContain('Báo giá');
    expect(html).toContain('vnd:15000000');
    expect(html).toContain('href="/o/acme/deals"');
    // Four facts, numbered 1 to 4 in the order the model is given them.
    expect(html.match(/data-testid="brief-fact"/g)).toHaveLength(4);
    expect(html).toMatch(/aria-label="1"[^>]*>1<[\s\S]*aria-label="4"[^>]*>4</);
  });

  it('shows no card at all with nothing to say, or while the facts are not here yet (a reader of nothing is told nothing)', () => {
    expect(render(EMPTY, { status: status() })).toBe('');
    expect(render(undefined, { status: status() })).toBe('');
  });

  it('shows Vy\'s button when Vy can be used, and nothing about Vy with AI off', () => {
    expect(render(facts(), { status: status() })).toContain('data-testid="brief-write"');
    expect(render(facts(), { status: status({ enabled: false, reason: 'off' }) })).not.toContain('data-testid="brief-vy"');
    expect(render(facts(), { status: status(), meter: { aiOn: false, state: 'none' } })).not.toContain('data-testid="brief-vy"');
    // The facts are there all the same.
    expect(render(facts(), { status: status({ enabled: false, reason: 'off' }) })).toContain('data-testid="brief-decisions"');
  });

  it('says why Vy cannot be used when it is paused or the budget is spent, with the button off', () => {
    const paused = render(facts(), { status: status({ enabled: false, reason: 'paused' }) });
    expect(paused).toContain(en.meetings.ask.blocked.paused);
    expect(paused).toMatch(/<button[^>]*disabled[^>]*data-testid="brief-write"|data-testid="brief-write"[^>]*disabled/);
    expect(render(facts(), { status: status(), meter: { aiOn: true, state: 'stop' } })).toContain(en.meetings.ask.blocked.budget.replaceAll("'", '&#x27;'));
  });

  it('shows the cost of one brief before the click', () => {
    expect(render(facts(), { status: status({ estimate: { inputTokens: 1800, outputTokens: 300, cost: '0.000123' } }) })).toContain('Each one costs about $0.000123.');
  });

  it('opens an upcoming event\'s brief only on a click (the closed card reads nothing)', () => {
    const html = render(undefined, { node: <AgendaBrief slug="acme" agendaId="a1" /> });
    expect(html).toContain('data-testid="agenda-brief"');
    expect(html).toContain(en.meetings.brief.show);
    expect(html).not.toContain('data-testid="meeting-brief"');
  });

  it('shows a task\'s due day as the Vietnam day, the same date the facts give the model, and the header day too', () => {
    const html = render(facts({ items: [{ ...facts().items[0]!, due: '2026-12-07T17:00:00.000Z', whenDate: '2026-12-05' }], previous: { meetingId: M1, title: 'Giao ban', startedAt: '2026-11-09T23:30:00.000Z' } }), { status: status() });
    expect(html).toContain('Due 2026-12-08');
    expect(html).not.toContain('2026-12-07');
    expect(html).toContain('on 2026-11-10');
  });

  it('says in one line that there is nothing to prepare when an upcoming event\'s brief is opened and is empty', () => {
    const opened = render(EMPTY, { node: <MeetingBrief slug="acme" agendaId="a1" emptyNote /> });
    expect(opened).toContain('data-testid="brief-nothing"');
    expect(opened).toContain(en.meetings.brief.nothing);
    expect(render(EMPTY, { node: <MeetingBrief slug="acme" meetingId="m2" /> })).toBe('');
  });

  it('has the words in Vietnamese too', () => {
    const html = render(facts(), { status: status(), locale: 'vi' });
    expect(html).toContain(viMessages.meetings.brief.title);
    expect(html).toContain(viMessages.meetings.brief.submit);
    expect(html).toContain(viMessages.meetings.brief.decisions);
  });
});

describe('the answer of Vy', () => {
  const answer = (over: Partial<BriefAnswer> = {}): BriefAnswer => ({ state: 'written', errorCode: null, sentences: [{ text: 'Buổi trước chốt giá 15.000.000 đồng.', facts: [1, 4] }], dropped: 0, ...over });
  const show = (a: BriefAnswer) => render(undefined, { node: <BriefResult answer={a} /> });

  it('shows each sentence as text with the numbers of the facts it rests on, and that it is not stored', () => {
    const html = show(answer({ sentences: [{ text: 'Đọc <b>kỹ</b> trước khi họp.', facts: [1, 4] }], dropped: 2 }));
    expect(html).toContain('data-testid="brief-answer"');
    expect(html).toContain('Based on: 1, 4');
    expect(html).toContain('Left out 2 sentence(s)');
    expect(html).toContain(en.meetings.brief.private);
    // Text only: markup in a sentence is escaped, never a tag or a link.
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('says plainly when there is nothing to add, and names a failure by its fixed words', () => {
    expect(show(answer({ state: 'none', sentences: [] }))).toContain(en.meetings.brief.none);
    const failed = show(answer({ state: 'failed', errorCode: 'BRIEF_TIMEOUT', sentences: [] }));
    expect(failed).toContain(en.meetings.brief.failed);
    expect(failed).toContain(en.meetings.brief.codes.BRIEF_TIMEOUT);
    expect(briefFailureKey('SOMETHING_ELSE')).toBe('default');
    expect(briefFailureKey('AI_STOPPED')).toBe('AI_STOPPED');
  });
});
