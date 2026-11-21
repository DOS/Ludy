// SPDX-License-Identifier: AGPL-3.0-only
// The consent page and Meetings (#3731, owner decision 2026-11-18): a connection of the company says in plain words that it also reads the published minutes of meetings shared with the whole
// company, in both languages, and what stays unreadable; a member, who connects only for themself and whose connection reads nothing of Meetings, is not told it does.
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
const details = (role: string): ConsentDetails => ({
  client: { id: 'c1', name: 'Vy', logoUri: null, redirectHost: 'vy.example.com', selfDeclared: true },
  scopes: ['ludy.read'],
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

describe('the consent page and Meetings', () => {
  it('tells a company connection, in both languages, that it reads the published minutes of meetings shared with the whole company', () => {
    expect(render(details('owner'))).toContain('data-testid="oauth-consent-meetings"');
    expect(render(details('owner'))).toContain(en.oauthConsent.scope.meetings.slice(0, 60));
    expect(render(details('admin'), 'vi')).toContain(viMessages.oauthConsent.scope.meetings.slice(0, 40));
    // What stays out is said too.
    expect(en.oauthConsent.scope.meetings).toMatch(/attendees only.*transcripts, notes and translations/);
  });

  it('says nothing of Meetings to a member, who connects only for themself and reads none of it', () => {
    expect(render(details('member'))).not.toContain('oauth-consent-meetings');
  });
});

describe('the consent page and the Engage reads (#3860)', () => {
  it('tells a company connection, in both languages, that it reads the inbox, deals, quotes, bookings and the results of Social and ads', () => {
    expect(render(details('owner'))).toContain('data-testid="oauth-consent-engage-reads"');
    expect(render(details('owner'))).toContain(en.oauthConsent.scope.engageReads.slice(0, 60));
    expect(render(details('admin'), 'vi')).toContain(viMessages.oauthConsent.scope.engageReads.slice(0, 40));
    expect(en.oauthConsent.scope.engageReads).toMatch(/inbox.*deals and quotes.*bookings.*ads/);
  });

  it('tells a member connection that it reads only what the member may read, and no bookings, Social results or ads', () => {
    const html = render(details('member'));
    expect(html).toContain('data-testid="oauth-consent-engage-reads"');
    expect(html).not.toContain(en.oauthConsent.scope.engageReads.slice(0, 60));
    expect(en.oauthConsent.scope.engageReadsMember).toMatch(/no bookings, Social results or ads/);
    expect(viMessages.oauthConsent.scope.engageReadsMember).toMatch(/không đọc lịch hẹn/);
  });
});

