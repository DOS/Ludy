// SPDX-License-Identifier: AGPL-3.0-only
// The push address block of a marketplace connection (#4348, S3b of #4315), rendered on the server with the API's status seeded in the cache: what it says before an address exists, once one exists, and when the hook
// stopped; that the status never carries an address, and that the address and replace-confirmation are not drawn until a person asks (the one-time address is only ever in the mutation's own onSuccess, see the component).
import { MutationObserver, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceConnection, MarketplacePushHookStatus } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions() / key(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { MarketplacePushHook, PushHookAddressBox, pushHookMutationOptions } = await import('../src/components/marketplace-push-hook.tsx');

const at = '2026-11-21T00:00:00.000Z';
const connection: MarketplaceConnection = {
  id: 'c1',
  connectionId: 'ch1',
  legalEntityId: 'e1',
  provider: 'marketplace_tiktok_shop',
  platform: 'tiktok_shop',
  displayName: 'Gian hàng thử',
  status: 'active',
  lastTestState: null,
  lastTestedAt: null,
  lastPolledAt: null,
  lastPollState: null,
  ordersWaiting: 0,
  authorizeState: null,
  reauthorizeBy: null,
};
const fresh: MarketplacePushHookStatus = { exists: true, createdAt: at, rotatedAt: null, lastSeenAt: null, rejectedCount: 0, stopped: false };

function block(status: MarketplacePushHookStatus | null, locale: 'en' | 'vi' = 'en'): string {
  const qc = client.current;
  if (status) qc.setQueryData(['marketplace', 'connections', 'pushHook'], status);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MarketplacePushHook connection={connection} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const ADDRESS = 'https://api.example.test/api/marketplace/shopee/webhook/AbCdEfGhIjKlMnOpQrStUv';

describe('the address once it is made (#4348)', () => {
  beforeEach(() => client.current.clear());

  it('shows the address in a read-only field with its notes, a copy button and a close button, each 44 px high, and says it was a replacement when it was', () => {
    const box = (replaced: boolean) =>
      renderToStaticMarkup(
        <IntlProvider locale="en" messages={catalog('en')}>
          <PushHookAddressBox address={ADDRESS} replaced={replaced} onCopy={() => undefined} onHide={() => undefined} />
        </IntlProvider>,
      );
    const fresh1 = box(false);
    expect(fresh1).toMatch(new RegExp(`<input[^>]*readOnly=""[^>]*value="${ADDRESS}"|<input[^>]*value="${ADDRESS}"[^>]*readOnly=""`));
    expect(fresh1).toContain(`aria-label="${en.marketplaceConnections.pushHook.addressLabel}"`);
    expect(fresh1).toContain(en.marketplaceConnections.pushHook.noteExact);
    expect(fresh1).toContain(en.marketplaceConnections.pushHook.noteShared);
    expect(fresh1).toContain(`>${en.marketplaceConnections.pushHook.copy}<`);
    expect(fresh1).toContain(`>${en.marketplaceConnections.pushHook.close}<`);
    expect(fresh1.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(3);
    expect(fresh1).not.toContain(en.marketplaceConnections.pushHook.replacedExisting);
    expect(box(true)).toContain(en.marketplaceConnections.pushHook.replacedExisting);
  });

  it('does not keep the address in the mutation cache: no cache time, and the card resets the mutation in its own success callback', async () => {
    const options = pushHookMutationOptions();
    expect(options.gcTime).toBe(0);
    // The call as the card makes it (run): the address is read in the call's onSuccess and the mutation is reset at once.
    const observer = new MutationObserver(client.current, { ...options, mutationFn: async () => ({ adapter: 'shopee' as const, address: ADDRESS, created: true }) });
    // As in the card, something watches the mutation (the callbacks of mutate run only for a watched observer).
    const stopWatching = observer.subscribe(() => undefined);
    let seen = '';
    await new Promise<void>((resolve) => {
      void observer.mutate({ id: 'c1' }, { onSuccess: (made: { address: string }) => { seen = made.address; observer.reset(); resolve(); } });
    });
    expect(seen).toBe(ADDRESS);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(JSON.stringify(client.current.getMutationCache().getAll().map((m) => m.state))).not.toContain(ADDRESS);
    expect(client.current.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(observer.getCurrentResult())).not.toContain(ADDRESS);
    stopWatching();
    // And no query holds it either.
    expect(JSON.stringify(client.current.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(ADDRESS);
  });
});

describe('MarketplacePushHook', () => {
  beforeEach(() => client.current.clear());

  it('offers to create an address when there is none, and to replace it when there is one', () => {
    const none = block({ ...fresh, exists: false, createdAt: null });
    expect(none).toContain(`aria-label="${en.marketplaceConnections.pushHook.title}"`);
    expect(none).toContain(en.marketplaceConnections.pushHook.intro);
    expect(none).toContain(en.marketplaceConnections.pushHook.none);
    expect(none).toContain(`>${en.marketplaceConnections.pushHook.create}<`);
    expect(none).not.toContain(`>${en.marketplaceConnections.pushHook.rotate}<`);
    const has = block(fresh);
    expect(has).toContain(`>${en.marketplaceConnections.pushHook.rotate}<`);
    expect(has).not.toContain(`>${en.marketplaceConnections.pushHook.create}<`);
    // Replacing stops the old address at once, so the confirmation is not drawn until a person asks.
    expect(has).not.toContain(en.marketplaceConnections.pushHook.warnRotate);
    expect(has).not.toContain(en.marketplaceConnections.pushHook.confirmRotate);
  });

  it('says when the last notification came and how many were refused, and warns when the hook stopped', () => {
    const quiet = block(fresh);
    expect(quiet).toContain(en.marketplaceConnections.pushHook.noNotice);
    expect(quiet).not.toContain(en.marketplaceConnections.pushHook.stopped);
    const seen = block({ ...fresh, lastSeenAt: '2026-11-21T01:00:00.000Z', rejectedCount: 3 });
    expect(seen).not.toContain(en.marketplaceConnections.pushHook.noNotice);
    expect(seen).toContain('3 notifications refused this hour');
    // One is singular in English.
    expect(block({ ...fresh, rejectedCount: 1 })).toContain('1 notification refused this hour');
    const stopped = block({ ...fresh, rejectedCount: 10, stopped: true });
    expect(stopped).toContain(en.marketplaceConnections.pushHook.stopped);
    expect(stopped).toContain('role="alert"');
  });

  it('draws no address, copy button or warning about the address before one is made, and never a key or address from the status', () => {
    const html = block(fresh);
    expect(html).not.toContain(en.marketplaceConnections.pushHook.shownOnce);
    expect(html).not.toContain(en.marketplaceConnections.pushHook.addressLabel);
    expect(html).not.toContain(en.marketplaceConnections.pushHook.copy);
    expect(html).not.toContain('/api/marketplace/');
    // The announcement region is always drawn (empty), so a screen reader hears the address when it arrives.
    expect(html).toContain('role="status"');
  });

  it('keeps the Vietnamese and English texts in step and tells the seller to paste the whole address and that one app has one address box', () => {
    expect(Object.keys(viMessages.marketplaceConnections.pushHook).sort()).toEqual(Object.keys(en.marketplaceConnections.pushHook).sort());
    expect(viMessages.marketplaceConnections.pushHook.noteExact.length).toBeGreaterThan(20);
    expect(viMessages.marketplaceConnections.pushHook.noteShared.length).toBeGreaterThan(20);
    const html = block(fresh, 'vi');
    expect(html).toContain(viMessages.marketplaceConnections.pushHook.title);
    expect(html).toContain(viMessages.marketplaceConnections.pushHook.rotate);
  });
});
