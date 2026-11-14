// SPDX-License-Identifier: AGPL-3.0-only
// The consent page and the draft scope (#3227, owner decision 2026-11-14): the choice to also allow writing Social post drafts is shown only when the client asked for the scope, only for the
// company, and is off until the person ticks it; the read-only wording is the one the page shows otherwise. Rendered on the server with the interaction details already loaded.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import type { ConsentDetails } from '../src/lib/oauth-consent.ts';

vi.mock('../src/lib/api.ts', () => ({ apiFetch: vi.fn(), errorMessage: String }));

const { OauthConsentPage } = await import('../src/routes/oauth-consent.tsx');

const UID = 'au3opBAruRuEEW2q_13PDiBqNCa2bR1Yx5941fUcreG';
const details = (scopes: string[], role: string): ConsentDetails => ({
  client: { id: 'c1', name: 'Vy', logoUri: null, redirectHost: 'vy.example.com', selfDeclared: true },
  scopes,
  expiresInDays: 89,
  orgs: [{ orgId: '00000000-0000-4000-8000-000000000001', slug: 'a', name: 'Cửa hàng A', role, memberGrants: false }],
});

const render = (data: ConsentDetails, locale: 'en' | 'vi' = 'en') => {
  const client = new QueryClient();
  client.setQueryData(['oauth-interaction', UID], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <OauthConsentPage uid={UID} />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

describe('the consent page and the draft scope', () => {
  it('offers nothing about drafts to a client that asked only to read', () => {
    const html = render(details(['ludy.read'], 'owner'));
    expect(html).not.toContain('oauth-consent-draft');
    expect(html).toContain(en.oauthConsent.scope.read.slice(0, 40));
  });

  it('offers the draft scope, unticked, to an owner when the client asked for it, in both languages', () => {
    const html = render(details(['ludy.read', 'ludy.social.draft'], 'owner'));
    expect(html).toContain('data-testid="oauth-consent-draft"');
    expect(html).toContain(en.oauthConsent.draftOption);
    expect(html).toContain(en.oauthConsent.scope.draft);
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    // Off: the read-only wording and the plain "allow" line stay.
    expect(html).toContain(en.oauthConsent.limits);
    expect(html).not.toContain(en.oauthConsent.limitsDraft);
    expect(render(details(['ludy.read', 'ludy.social.draft'], 'admin'), 'vi')).toContain(viMessages.oauthConsent.draftOption);
  });

  it('does not offer it to a member, who can connect only for themself', () => {
    const html = render(details(['ludy.read', 'ludy.social.draft'], 'member'));
    expect(html).not.toContain('data-testid="oauth-consent-draft"');
    expect(html).toContain('data-testid="oauth-consent-draft-company-only"');
    expect(html).toContain(en.oauthConsent.draftOwnerOnly);
    expect(html).not.toContain(en.oauthConsent.draftCompanyOnly);
    // An owner who picks the member kind is told to choose the company instead (the radio group is there for them).
  });
});
