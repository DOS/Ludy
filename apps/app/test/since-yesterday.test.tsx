// SPDX-License-Identifier: AGPL-3.0-only
// "Since yesterday" on Home (#3256) as the member sees it: one line per AI coworker that prepared something, named as the
// kernel names it now, linking to the AI inbox; nothing while loading, on an error and when every count is zero; the same in
// Vietnamese; and no "assistant" wording in either language. Rendered on the server with the query answered from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zSinceYesterday, type SinceYesterday } from '@crove/kernel-contract';
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
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('../src/lib/stream-hook.ts', () => ({ useStreamLive: () => false, pollEvery: () => false, SAFETY_POLL_MS: 300_000 }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history: { push: () => undefined } }) }));

const { SinceYesterday } = await import('../src/components/since-yesterday.tsx');

const AGENT = (n: number) => `0190c1c0-0000-7000-8000-00000000000${n}`;
const ANSWER: SinceYesterday = {
  items: [
    { agentId: AGENT(1), name: 'Ly', count: 5, href: '/inbox' },
    { agentId: AGENT(2), name: 'Lan', count: 1, href: '/inbox' },
  ],
};

async function render(opts: { data?: unknown; error?: boolean; locale?: 'en' | 'vi' } = {}): Promise<string> {
  const qc = client.current;
  qc.clear();
  const key = ['today', 'sinceYesterday'];
  if (opts.data !== undefined) qc.setQueryData(key, opts.data);
  // A failed fetch settled before the render; with data cached it is a failed refetch, which keeps the last good data.
  if (opts.error) await qc.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error('boom')), retry: false, staleTime: 0 }).catch(() => undefined);
  const locale = opts.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale) as never}>
        <SinceYesterday slug="acme" />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => client.current.clear());

describe('SinceYesterday', () => {
  it('has the shape the kernel answers with', () => {
    expect(zSinceYesterday.safeParse(ANSWER).success).toBe(true);
    // A field the read must never carry (a row's text) is refused by the schema.
    expect(zSinceYesterday.safeParse({ items: [{ ...ANSWER.items[0], summary: 'Soạn thư cho khách' }] }).success).toBe(false);
    expect(zSinceYesterday.safeParse({ items: [{ ...ANSWER.items[0], count: 0 }] }).success).toBe(false);
  });

  it('says one line per coworker with its name and count, each linking to the AI inbox in the org', async () => {
    const html = await render({ data: ANSWER });
    expect(html).toContain('Since yesterday');
    expect(html).toContain('Ly did 5 things for you');
    // A renamed coworker shows the name the kernel gave.
    expect(html).toContain('Lan did 1 thing for you');
    expect([...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/o/acme/inbox', '/o/acme/inbox']);
  });

  it('says it in Vietnamese', async () => {
    const html = await render({ data: ANSWER, locale: 'vi' });
    expect(html).toContain(viMessages.today.since.title);
    expect(html).toContain('Ly đã làm 5 việc cho bạn');
  });

  it('renders nothing when every count is zero (nobody is listed), while loading, on an error and when a refetch fails over old counts', async () => {
    expect(await render({ data: { items: [] } })).toBe('');
    expect(await render()).toBe('');
    expect(await render({ error: true })).toBe('');
    // The query keeps the last good counts through a failed refetch; the section does not show them.
    expect(await render({ data: ANSWER, error: true })).toBe('');
  });

  it('never calls a coworker an assistant (DESIGN.md 1.1)', () => {
    for (const since of [en.today.since, viMessages.today.since]) {
      expect(JSON.stringify(since)).not.toMatch(/assistant|trợ lý/i);
    }
  });
});
