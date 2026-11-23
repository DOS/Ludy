// SPDX-License-Identifier: AGPL-3.0-only
// The card on a published post (W3, #3834), rendered on the server with the API's answers seeded in the cache: the action that boosts a post, where each state of
// its boost stands, what each role is offered, and that with running ads off, a post that cannot be boosted, or ads not installed there is nothing at all (no button).
// The panel itself opens in a portal and is covered end to end (e2e/tests/ads-boost.spec.ts).
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADS_BOOST_STATES, type AdsBoostOptions, type AdsBoostState, type AdsBoostStateView } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const modules = vi.hoisted(() => ({ installed: ['ads', 'social'] as string[] }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, search }: { children?: ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string> }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '') + (search ? `?draft=${search.draft}` : '') }, children),
  };
});
vi.mock('../src/lib/org-modules.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), installedModules: () => modules.installed }));
vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (options?: { input?: unknown }) => ({ queryKey: options?.input === undefined ? path : [...path, options.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false, client: {} };
});

const { BoostCard } = await import('../src/components/ads-boost.tsx');

function render(node: ReactNode, locale: 'en' | 'vi' = 'en'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const POST_ID = '3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b';
const post = (over: Record<string, unknown> = {}) => ({
  id: POST_ID,
  title: null,
  body: 'Khai trương chi nhánh mới vào thứ Bảy này.',
  linkUrl: null,
  archivedAt: null,
  variants: [{ provider: 'facebook_page', connectionId: 'page-1', status: 'published', externalUrl: 'https://www.facebook.com/page/posts/1', removedAt: null, publishedAt: '2026-11-17T00:00:00.000Z' }],
  ...over,
});
const options = (over: Partial<AdsBoostOptions> = {}): AdsBoostOptions => ({ enabled: true, reason: null, accounts: [{ id: 'a1', name: 'Quảng cáo cửa hàng', currency: 'VND', provider: 'sandbox_ads' }], pages: [{ id: 'page-1', name: 'Trang cửa hàng' }], ...over });
const boost = (state: AdsBoostState, over: Partial<AdsBoostStateView> = {}): AdsBoostStateView => ({
  postId: POST_ID,
  draftId: '11111111-1111-4111-8111-111111111111',
  adAccountId: 'a1',
  adAccountName: 'Quảng cáo cửa hàng',
  currency: 'VND',
  state,
  objective: 'messenger',
  proposalId: state === 'waiting_approval' ? '22222222-2222-4222-8222-222222222222' : null,
  launchId: null,
  step: null,
  stopReason: null,
  maxSpend: '300000',
  days: 3,
  startOn: '2026-11-20',
  endOn: '2026-11-22',
  updatedAt: '2026-11-19T00:00:00.000Z',
  ...over,
});

function seed(role: string | null, opts: AdsBoostOptions | null, states: AdsBoostStateView[]) {
  client.current.clear();
  client.current.setQueryData(['me', 'get'], { orgs: role === null ? [] : [{ slug: 'acme', role }] });
  if (opts) client.current.setQueryData(['ads', 'boostOptions'], opts);
  client.current.setQueryData(['ads', 'boostStates', { postIds: [POST_ID] }], states);
}

const card = (over: Record<string, unknown> = {}, locale: 'en' | 'vi' = 'en') => render(<BoostCard slug="acme" post={post(over) as never} />, locale);

describe('the boost card on a published post', () => {
  beforeEach(() => {
    modules.installed = ['ads', 'social'];
  });

  it('offers the action on a published post when running ads is on, to an owner, an admin and a member', () => {
    for (const role of ['owner', 'admin', 'member']) {
      seed(role, options(), []);
      const html = card();
      expect(html, role).toContain('data-testid="boost-card"');
      expect(html, role).toContain('data-testid="boost-open"');
      expect(html, role).toContain('Boost post');
    }
    seed('owner', options(), []);
    expect(card({}, 'vi')).toContain('Đẩy bài');
  });

  it('has no button, no card and no words when running ads is off, launches are blocked or no account can run ads', () => {
    for (const reason of ['writing_off', 'launches_blocked', 'no_account'] as const) {
      seed('owner', options({ enabled: false, reason, accounts: [], pages: [] }), []);
      expect(card(), reason).toBe('');
    }
  });

  it('has nothing for a viewer, for a post that cannot be boosted, or when ads is not installed', () => {
    seed('viewer', options(), []);
    expect(card()).toBe('');
    seed('owner', options(), []);
    expect(card({ archivedAt: '2026-11-18T00:00:00.000Z' })).toBe('');
    expect(card({ variants: [{ provider: 'linkedin', connectionId: 'l1', status: 'published', externalUrl: null, removedAt: null, publishedAt: null }] })).toBe('');
    expect(card({ variants: [{ provider: 'facebook_page', connectionId: 'page-1', status: 'draft', externalUrl: null, removedAt: null, publishedAt: null }] })).toBe('');
    modules.installed = ['social'];
    expect(card()).toBe('');
  });

  it('shows where each state of the boost stands, with the amount and the days, and the way to its request or its draft', () => {
    for (const state of ADS_BOOST_STATES) {
      seed('member', options(), [boost(state)]);
      const html = card();
      expect(html, state).toContain(`data-state="${state}"`);
      expect(html, state).toContain('The most it can spend is');
      expect(html, state).toContain('See it in Campaigns');
      // Only a boost that is waiting has a request in the Inbox.
      expect(html.includes('Open the request in the Inbox'), state).toBe(state === 'waiting_approval');
    }
    seed('owner', options(), [boost('waiting_approval')]);
    expect(card()).toContain('href="/o/acme/inbox/22222222-2222-4222-8222-222222222222"');
    expect(card()).toContain('Waiting for approval');
  });

  it('offers to continue a draft and to boost again once a boost is over, and nothing while one is waiting or running', () => {
    seed('owner', options(), [boost('draft')]);
    expect(card()).toContain('Continue the draft');
    for (const state of ['stopped', 'failed', 'cancelled', 'ended'] as const) {
      seed('owner', options(), [boost(state)]);
      expect(card(), state).toContain('Boost again');
    }
    for (const state of ['waiting_approval', 'queued', 'launching', 'live', 'needs_attention'] as const) {
      seed('owner', options(), [boost(state)]);
      expect(card(), state).not.toContain('data-testid="boost-open"');
    }
  });

  it('still shows the state of a boost while running ads is off (no button), so a person sees what is going on', () => {
    seed('owner', options({ enabled: false, reason: 'writing_off', accounts: [], pages: [] }), [boost('live')]);
    const html = card();
    expect(html).toContain('data-state="live"');
    expect(html).not.toContain('data-testid="boost-open"');
  });

  it('says a created boost starts on its first day', () => {
    seed('owner', options(), [boost('launching', { step: 'paused' })]);
    expect(card()).toContain('Created, starts on its first day');
    seed('owner', options(), [boost('launching', { step: 'ad_set' })]);
    expect(card()).toContain('Being created at the ad platform');
  });
});
