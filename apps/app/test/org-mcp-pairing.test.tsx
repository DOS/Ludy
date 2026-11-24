// SPDX-License-Identifier: AGPL-3.0-only
// The pairing-code action of "Connected AI apps" (#4591; ADR-0051 decision 2), rendered on the server with the API's answers seeded: an owner or an admin has it, a member does not, a connection that
// was made with a code is badged, and the English and Vietnamese strings match and name what the code is for.
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

const grant = { id: 'g-1', userId: 'u-1', clientId: 'c', clientName: 'Claude', clientHost: 'claude.example.com', scopes: ['ludy.read'], createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null, kind: 'company', mine: false };

function render(role: string, locale: 'en' | 'vi' = 'en', grants: Array<typeof grant> = [grant]): string {
  client.current.setQueryData(['mcp', 'grant', 'list'], grants);
  client.current.setQueryData(['mcp', 'memberGrants', 'get'], { enabled: false });
  client.current.setQueryData(['mcp', 'wake', 'get'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <OrgMcpGrants members={[{ userId: 'u-1', displayName: 'Một', email: 'one@example.test' }]} viewerRole={role} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the pairing code in Connected AI apps', () => {
  beforeEach(() => client.current.clear());

  it('is offered to an owner and an admin, closed, with what it is for and how long it lasts', () => {
    for (const role of ['owner', 'admin']) {
      const html = render(role);
      expect(html, role).toContain('org-mcp-pairing');
      expect(html, role).toContain(en.orgMcpGrants.pairing.title);
      expect(html, role).toContain(en.orgMcpGrants.pairing.open);
      // Closed until asked: no form and no code.
      expect(html, role).not.toContain('org-mcp-pairing-code');
      expect(html, role).not.toContain(en.orgMcpGrants.pairing.create);
    }
    expect(en.orgMcpGrants.pairing.hint).toContain('10 minutes');
  });

  it('is not offered to a member, who makes no company connection', () => {
    expect(render('member')).not.toContain('org-mcp-pairing');
    expect(render('viewer')).not.toContain('org-mcp-pairing');
  });

  it('badges a connection that was made with a code, and no other', () => {
    const paired = { ...grant, clientId: 'pairing:0d9f8c1e-0000-4000-8000-000000000000', clientName: 'My agent' };
    const html = render('owner', 'en', [paired, grant]);
    expect(html.split(en.orgMcpGrants.pairingKind).length - 1).toBe(1);
    expect(html).toContain('My agent');
  });

  it('speaks Vietnamese with the same keys as English', () => {
    expect(render('owner', 'vi')).toContain(viMessages.orgMcpGrants.pairing.title);
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(viMessages.orgMcpGrants.pairing).sort()).toEqual(keys(en.orgMcpGrants.pairing).sort());
    expect(viMessages.orgMcpGrants.pairingKind).toBeTruthy();
  });
});
