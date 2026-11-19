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
    expect(html).not.toContain(en.oauthConsent.limitsWrite);
    expect(render(details(['ludy.read', 'ludy.social.draft'], 'admin'), 'vi')).toContain(viMessages.oauthConsent.draftOption);
  });

  it('does not offer it to a member, who can connect only for themself', () => {
    const html = render(details(['ludy.read', 'ludy.social.draft'], 'member'));
    expect(html).not.toContain('data-testid="oauth-consent-draft"');
    expect(html).toContain('data-testid="oauth-consent-draft-company-only"');
    expect(html).toContain(en.oauthConsent.writeOwnerOnly);
    expect(html).not.toContain(en.oauthConsent.writeCompanyOnly);
    // An owner who picks the member kind is told to choose the company instead (the radio group is there for them).
  });
});

describe('the consent page and the per-line write scopes (ADR-0051 decision 11, #3858)', () => {
  it('offers each write scope the client asked for, each on its own and unticked, in both languages', () => {
    const html = render(details(['ludy.read', 'ludy.engage.write', 'ludy.ads.draft'], 'owner'));
    expect(html).toContain('data-testid="oauth-consent-engage"');
    expect(html).toContain('data-testid="oauth-consent-ads"');
    expect(html).not.toContain('data-testid="oauth-consent-draft"');
    expect(html).toContain(en.oauthConsent.engageOption);
    expect(html).toContain(en.oauthConsent.scope.engage);
    expect(html).toContain(en.oauthConsent.scope.ads);
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toContain(en.oauthConsent.limits);
    expect(html).not.toContain(en.oauthConsent.limitsWrite);
    const vietnamese = render(details(['ludy.read', 'ludy.engage.write', 'ludy.ads.draft'], 'admin'), 'vi');
    expect(vietnamese).toContain(viMessages.oauthConsent.engageOption);
    expect(vietnamese).toContain(viMessages.oauthConsent.adsOption);
  });

  it('offers a scope the client did not ask for to nobody, and never to a member, who connects only for themself', () => {
    expect(render(details(['ludy.read', 'ludy.engage.write'], 'owner'))).not.toContain('data-testid="oauth-consent-ads"');
    expect(render(details(['ludy.read'], 'owner'))).not.toContain('data-testid="oauth-consent-engage"');
    const member = render(details(['ludy.read', 'ludy.engage.write', 'ludy.ads.draft'], 'member'));
    expect(member).not.toContain('data-testid="oauth-consent-engage"');
    expect(member).not.toContain('data-testid="oauth-consent-ads"');
    expect(member).toContain(en.oauthConsent.writeOwnerOnly);
  });

  it('says in plain words that what goes out waits for a person, and keeps the two languages in step', () => {
    for (const messages of [en.oauthConsent, viMessages.oauthConsent]) {
      expect(Object.keys(messages.scope).sort()).toEqual(Object.keys(en.oauthConsent.scope).sort());
    }
    expect(en.oauthConsent.scope.engage).toMatch(/proposal/);
    expect(en.oauthConsent.scope.ads).toMatch(/proposal/);
    expect(viMessages.oauthConsent.scope.engage).toMatch(/đề xuất/);
  });
});
