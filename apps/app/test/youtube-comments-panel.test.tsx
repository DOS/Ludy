// SPDX-License-Identifier: AGPL-3.0-only
// The YouTube comments switch of a channel (#3134), rendered on the server with the API's answer seeded in the cache: off with its hint, off for a grant
// without the comment scope, on with the day's units, and the two ways reading stops (Google's quota spent, the channel's own budget used up), each said
// in words with the time it resumes; and who may change the switch. The mutation itself is covered by the kernel's database test.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { YOUTUBE_POLL_BUDGET_UNITS, type YoutubeCommentsStatus } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
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
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false, client: {} };
});

const { YoutubeCommentsPanel } = await import('../src/components/youtube-comments-panel.tsx');

const ID = '3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b';
const status = (over: Partial<YoutubeCommentsStatus> = {}): YoutubeCommentsStatus => ({
  connectionId: ID,
  displayName: 'Tiệm Bánh B',
  enabled: true,
  scopeGranted: true,
  pollUnitsUsed: 12,
  pollBudget: YOUTUBE_POLL_BUDGET_UNITS,
  replyUnitsUsed: 100,
  resetAt: '2026-11-14T08:01:00.000Z',
  blockedUntil: null,
  nextPollAt: '2026-11-13T12:30:00.000Z',
  lastPolledAt: '2026-11-13T12:15:00.000Z',
  ...over,
});

function render(rows: YoutubeCommentsStatus[] | null, isAdmin = true, locale: 'en' | 'vi' = 'en'): string {
  // The query's key is the route's path and its input.
  client.current.setQueryData(['conversations', 'youtubeComments', {}], rows ?? undefined);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <YoutubeCommentsPanel connectionId={ID} isAdmin={isAdmin} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('YoutubeCommentsPanel (#3134)', () => {
  it('shows nothing until the answer is there, and nothing for another channel', () => {
    expect(render(null)).toBe('');
    expect(render([status({ connectionId: '00000000-0000-4000-8000-000000000000' })])).toBe('');
  });

  it('says what the switch does while it is off, and asks for a reconnect when the grant lacks the scope', () => {
    const off = render([status({ enabled: false, nextPollAt: null, lastPolledAt: null })]);
    expect(off).toContain('data-testid="youtube-comments-toggle"');
    expect(off).toContain('every channel connected to this system shares');
    expect(off).not.toContain('youtube-quota"');
    const noScope = render([status({ enabled: false, scopeGranted: false })]);
    expect(noScope).toContain('Reconnect the channel');
    // The box is disabled for a grant without the scope.
    expect(noScope).toMatch(/data-testid="youtube-comments-toggle"[^>]*disabled|disabled[^>]*data-testid="youtube-comments-toggle"/);
  });

  it('says so when the switch is on but the grant lost the comment scope', () => {
    expect(render([status({ scopeGranted: false })])).toContain('data-testid="youtube-scope-lost"');
    expect(render([status()])).not.toContain('youtube-scope-lost');
  });

  it('is only for owners and admins to change', () => {
    expect(render([status()], false)).toMatch(/disabled/);
    expect(render([status()], true)).not.toMatch(/<button[^>]*disabled/);
  });

  it('shows the day’s units against the budget, the replies, and when it reads next', () => {
    const html = render([status()]);
    expect(html).toContain(`Today: reading used 12 of ${YOUTUBE_POLL_BUDGET_UNITS} units; replies used 100 units (50 each)`);
    expect(html).toContain('Next reading:');
    expect(html).toContain('Last reading:');
    expect(html).toContain('The quota resets:');
    expect(html).not.toContain('youtube-quota-blocked');
    expect(html).not.toContain('youtube-quota-budget');
  });

  it('says why reading stopped: Google’s quota is spent (replies stop too), or this channel’s own budget is used up (replies still go)', () => {
    const blocked = render([status({ blockedUntil: '2026-11-14T08:01:00.000Z', nextPollAt: '2026-11-14T08:01:00.000Z' })]);
    expect(blocked).toContain('data-testid="youtube-quota-blocked"');
    expect(blocked).toContain('YouTube’s daily quota is spent. Reading and replying resume after');
    expect(blocked).not.toContain('Next reading:');
    const spent = render([status({ pollUnitsUsed: YOUTUBE_POLL_BUDGET_UNITS - 3 })]);
    expect(spent).toContain('data-testid="youtube-quota-budget"');
    expect(spent).toContain('replies still go out');
  });

  it('is worded in Vietnamese too', () => {
    const html = render([status({ blockedUntil: '2026-11-14T08:01:00.000Z' })], true, 'vi');
    expect(html).toContain('Hạn mức YouTube trong ngày đã hết');
    expect(html).toContain('Hôm nay: đọc bình luận dùng 12/150 đơn vị');
  });
});
