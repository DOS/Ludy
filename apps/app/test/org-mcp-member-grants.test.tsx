// SPDX-License-Identifier: AGPL-3.0-only
// "Connected AI apps" for each role (issue #2975, slice 3, step 3a-2), rendered on the server with the API's answers seeded: an owner has the org's switch for member connections,
// an admin sees the org's connections without it, a member sees only their own list and no switch and no wake-up, and the English and Vietnamese strings match.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { OrgMcpGrants } = await import('../src/components/org-mcp-grants.tsx');

const members = [{ userId: 'u-1', displayName: 'Một', email: 'one@example.test' }];
const grant = { id: 'g-1', userId: 'u-1', clientId: 'c', clientName: 'Claude', clientHost: 'claude.example.com', scopes: ['ludy.read'], createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null, kind: 'company', mine: false };

function render(role: string, locale: 'en' | 'vi' = 'en', grants: Array<typeof grant> = [grant], wakes: unknown[] = []): string {
  client.current.setQueryData(['mcp', 'grant', 'list'], grants);
  client.current.setQueryData(['mcp', 'memberGrants', 'get'], { enabled: false });
  client.current.setQueryData(['mcp', 'wake', 'get'], wakes);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <OrgMcpGrants members={members} viewerRole={role} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('OrgMcpGrants by role', () => {
  beforeEach(() => client.current.clear());

  it('gives an owner the switch for member connections, off by default, with what turning it off does', () => {
    const html = render('owner');
    expect(html).toContain('org-mcp-member-grants');
    expect(html).toContain(en.orgMcpGrants.memberSwitch);
    expect(html).not.toMatch(/checked=""/);
  });

  it('shows an admin the org\'s connections and its wake-up panel, without the switch', () => {
    const html = render('admin');
    expect(html).not.toContain('org-mcp-member-grants');
    expect(html).toContain('org-mcp-wake');
    expect(html).toContain(en.orgMcpGrants.intro.slice(0, 30));
  });

  it('shows a member only their own list: no switch, no wake-up panel, the own-connections intro', () => {
    const html = render('member');
    expect(html).not.toContain('org-mcp-member-grants');
    expect(html).not.toContain('org-mcp-wake');
    expect(html).toContain(en.orgMcpGrants.introOwn.slice(0, 30));
    expect(html).toContain('Claude');
  });

  it('gives a member the wake-up panel on their own member-bound connection and on no other', () => {
    const own = { ...grant, id: 'g-own', kind: 'member' as const, mine: true };
    const html = render('member', 'en', [own]);
    expect(html).toContain('org-mcp-wake');
    expect(html).toContain(en.orgMcpGrants.memberKind);
    // A company connection the member somehow sees has no panel for them; neither does a connection that is not theirs.
    expect(render('member', 'en', [{ ...grant, kind: 'company' as const, mine: false }])).not.toContain('org-mcp-wake');
    expect(render('member', 'en', [{ ...own, mine: false }])).not.toContain('org-mcp-wake');
  });

  it('shows an owner or admin another member\'s wake-up as its host alone, with no panel to change it, and their own member-bound one whole', () => {
    const other = { ...grant, id: 'g-other', kind: 'member' as const, mine: false };
    const host = { grantId: 'g-other', url: 'https://hooks.example.com', enabled: true, schedule: 'off', secretHint: 'whk_00000000', consecutiveFailures: 0 };
    const html = render('admin', 'en', [other], [host]);
    expect(html).toContain('org-mcp-wake-host');
    expect(html).toContain('hooks.example.com');
    expect(html).not.toContain('data-testid="org-mcp-wake"');
    // Nothing to show when that member set no wake-up.
    expect(render('admin', 'en', [other], [])).not.toContain('org-mcp-wake-host');
    // Their own member-bound connection has the panel.
    expect(render('admin', 'en', [{ ...other, mine: true }])).toContain('org-mcp-wake');
  });

  it('speaks Vietnamese with the same keys as English, for the new strings too', () => {
    expect(render('owner', 'vi')).toContain(viMessages.orgMcpGrants.memberSwitch);
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(viMessages.orgMcpGrants).sort()).toEqual(keys(en.orgMcpGrants).sort());
    expect(keys(viMessages.oauthConsent).sort()).toEqual(keys(en.oauthConsent).sort());
  });
});
