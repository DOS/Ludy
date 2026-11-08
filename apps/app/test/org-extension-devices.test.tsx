// SPDX-License-Identifier: AGPL-3.0-only
// The members' extension devices in Settings (issue #2868), rendered on the server with the API's answer seeded in the cache:
// what an owner and an admin can disconnect, that an admin is offered nothing for an owner's device, that your own devices
// are left to the card above, and the English and Vietnamese strings.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionOrgTokenView } from '@crove/kernel-contract';
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

const { OrgExtensionDevices } = await import('../src/components/org-extension-devices.tsx');

const FUTURE = '2099-01-01T00:00:00.000Z';
const at = '2026-11-01T00:00:00.000Z';
const members = [
  { userId: 'u-owner', displayName: 'Chủ Sở Hữu', email: 'owner@example.test', role: 'owner' },
  { userId: 'u-admin', displayName: null, email: 'admin@example.test', role: 'admin' },
  { userId: 'u-member', displayName: 'Thành Viên', email: 'member@example.test', role: 'member' },
];
const device = (id: string, userId: string, deviceName: string, over: Partial<ExtensionOrgTokenView> = {}): ExtensionOrgTokenView => ({
  id,
  userId,
  deviceName,
  scopes: ['meetings'],
  createdAt: at,
  expiresAt: FUTURE,
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

function screen(viewerRole: 'owner' | 'admin', me: string, rows: ExtensionOrgTokenView[], locale: 'en' | 'vi' = 'en'): string {
  client.current.setQueryData(['extension', 'tokens', 'listOrg'], rows);
  // The server markup escapes an apostrophe; the strings are compared as written.
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <OrgExtensionDevices members={members} viewerRole={viewerRole} me={me} />
      </IntlProvider>
    </QueryClientProvider>,
  ).replaceAll('&#x27;', "'");
}

describe('OrgExtensionDevices', () => {
  beforeEach(() => client.current.clear());

  it('lets an owner disconnect the devices of an admin and of a member, with the member named', () => {
    const html = screen('owner', 'u-owner', [device('d1', 'u-member', 'Chrome ở văn phòng'), device('d2', 'u-admin', 'Edge của quản trị')]);
    expect(html).toContain(`>${en.orgExtensionDevices.title}<`);
    expect(html).toContain('Thành Viên');
    expect(html).toContain('admin@example.test');
    expect(html).toContain('Chrome ở văn phòng');
    expect(html.match(new RegExp(`>${en.orgExtensionDevices.disconnect}<`, 'g'))).toHaveLength(2);
    expect(html).toContain('aria-label="Disconnect Chrome ở văn phòng of Thành Viên"');
    expect(html).not.toContain(en.orgExtensionDevices.ownerOnly);
  });

  it('offers an admin nothing for an owner\'s device, and says why, but lets the admin disconnect a member\'s', () => {
    const html = screen('admin', 'u-admin', [device('d1', 'u-owner', 'Chrome của chủ'), device('d2', 'u-member', 'Chrome của thành viên')]);
    expect(html).toContain('Chrome của chủ');
    expect(html.match(new RegExp(en.orgExtensionDevices.ownerOnly, 'g'))).toHaveLength(1);
    expect(html.match(new RegExp(`>${en.orgExtensionDevices.disconnect}<`, 'g'))).toHaveLength(1);
    expect(html).toContain('aria-label="Disconnect Chrome của thành viên of Thành Viên"');
    expect(html).not.toContain('aria-label="Disconnect Chrome của chủ');
  });

  it('leaves your own devices to the card above', () => {
    const html = screen('owner', 'u-owner', [device('d1', 'u-owner', 'Chrome của tôi'), device('d2', 'u-member', 'Chrome của thành viên')]);
    expect(html).not.toContain('Chrome của tôi');
    expect(html).toContain('Chrome của thành viên');
  });

  it('says so when no other member has a device, and lists ended devices apart', () => {
    expect(screen('owner', 'u-owner', [device('d1', 'u-owner', 'Chrome của tôi')])).toContain(en.orgExtensionDevices.none);
    const html = screen('owner', 'u-owner', [
      device('d1', 'u-member', 'Cũ đã ngắt', { revokedAt: at }),
      device('d2', 'u-member', 'Cũ đã hết hạn', { expiresAt: '2026-11-02T00:00:00.000Z' }),
    ]);
    expect(html).toContain(en.orgExtensionDevices.none);
    expect(html).toContain('Disconnected or expired (2)');
    expect(html).toContain(`>${en.orgExtensionDevices.revoked}<`);
    expect(html).toContain(`>${en.orgExtensionDevices.expired}<`);
    expect(html).not.toContain(`>${en.orgExtensionDevices.disconnect}<`);
  });

  it('names a device of a member who is no longer in the org as a former member', () => {
    const html = screen('owner', 'u-owner', [device('d1', 'u-gone', 'Chrome cũ')]);
    expect(html).toContain(en.orgExtensionDevices.formerMember);
  });

  it('has the same strings in Vietnamese as in English, and shows them', () => {
    const keys = (o: Record<string, unknown>): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v as Record<string, unknown>).map((x) => `${k}.${x}`) : [k]));
    expect(keys(viMessages.orgExtensionDevices).sort()).toEqual(keys(en.orgExtensionDevices).sort());
    const html = screen('admin', 'u-admin', [device('d1', 'u-owner', 'Chrome', {})], 'vi');
    expect(html).toContain(viMessages.orgExtensionDevices.title);
    expect(html).toContain(viMessages.orgExtensionDevices.ownerOnly);
  });
});
