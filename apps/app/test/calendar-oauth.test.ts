// SPDX-License-Identifier: AGPL-3.0-only
// The small calendar-provider facts the screens use (Meetings B3, #3167): which connect dialog a stored connection belongs to, and when a refusal that came back through the address bar is a
// Microsoft tenant asking for its administrator rather than the member's own "no".
import { describe, expect, it } from 'vitest';
import { adminConsentLink, needsAdminConsent, oauthProviderOf, rememberAdminLink, takeAdminLink } from '../src/lib/calendar-oauth.ts';

const params = (query: string) => new URLSearchParams(query);

describe('oauthProviderOf', () => {
  it('names the connect dialog of a Google or Microsoft connection and none for another', () => {
    expect(oauthProviderOf('google')).toBe('google_calendar');
    expect(oauthProviderOf('microsoft')).toBe('microsoft_calendar');
    expect(oauthProviderOf('caldav')).toBeNull();
    expect(oauthProviderOf('')).toBeNull();
  });
});

describe('needsAdminConsent', () => {
  it('recognises the answers of a tenant whose administrator has not allowed the app', () => {
    expect(needsAdminConsent('microsoft_calendar', params('error=consent_required'))).toBe(true);
    // The Teams recording import (C4) goes through the same tenant administrator consent; any other platform does not.
    expect(needsAdminConsent('microsoft_teams', params('error=access_denied&error_description=AADSTS90094%3A+Administrator+consent+is+required'))).toBe(true);
    expect(needsAdminConsent('microsoft_teams', params('error=access_denied&error_description=AADSTS65004%3A+The+user+declined'))).toBe(false);
    expect(needsAdminConsent('zoom', params('error=consent_required'))).toBe(false);
    expect(needsAdminConsent('microsoft_calendar', params('error=access_denied&error_description=AADSTS65001%3A+The+user+or+administrator+has+not+consented'))).toBe(true);
    expect(needsAdminConsent('microsoft_calendar', params('error=invalid_request&error_description=AADSTS90094%3A+The+grant+requires+admin+permission.'))).toBe(true);
    expect(needsAdminConsent('microsoft_calendar', params('error=access_denied&error_description=AADSTS90095%3A+Admin+approval+is+required.'))).toBe(true);
  });

  it('does not take the member\'s own refusal, another code or another provider for it', () => {
    expect(needsAdminConsent('microsoft_calendar', params('error=access_denied&error_description=AADSTS65004%3A+The+user+declined+to+consent'))).toBe(false);
    expect(needsAdminConsent('microsoft_calendar', params('error=access_denied'))).toBe(false);
    expect(needsAdminConsent('microsoft_calendar', params('error=access_denied&error_description=AADSTS650011'))).toBe(false);
    expect(needsAdminConsent('google_calendar', params('error=consent_required'))).toBe(false);
    expect(needsAdminConsent('microsoft_calendar', params(''))).toBe(false);
  });
});

describe('adminConsentLink', () => {
  const authorize = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=00000000-0000-4000-8000-000000000001&response_type=code&redirect_uri=https%3A%2F%2Fludy.example%2Fcalendar%2Foauth%2Fmicrosoft_calendar%2Fcallback&scope=openid&state=st';

  it('builds the administrator\'s address from the connect address: the application id and the return address, on the organizations tenant', () => {
    const link = adminConsentLink(authorize);
    expect(link).not.toBeNull();
    const url = new URL(link as string);
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/adminconsent');
    expect(url.searchParams.get('client_id')).toBe('00000000-0000-4000-8000-000000000001');
    expect(url.searchParams.get('redirect_uri')).toBe('https://ludy.example/calendar/oauth/microsoft_calendar/callback');
    // Nothing of the attempt (the state, the code challenge) goes into it.
    expect(link).not.toMatch(/state|code_challenge|scope/);
  });

  it('builds nothing for another host, a plain address, or an address without an application id', () => {
    expect(adminConsentLink('https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=https%3A%2F%2Fx.example')).toBeNull();
    expect(adminConsentLink('http://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=1&redirect_uri=x')).toBeNull();
    expect(adminConsentLink('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=x')).toBeNull();
    expect(adminConsentLink('not a url')).toBeNull();
  });

  it('is kept with the attempt and shown back once, and only if it is still the address this app builds', () => {
    const store = new Map<string, string>();
    const original = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
    try {
      const link = adminConsentLink(authorize) as string;
      rememberAdminLink('st1', link);
      expect(store.has('ludy.oauth.admin-link.st1')).toBe(true);
      expect(takeAdminLink('st1')).toBe(link);
      expect(takeAdminLink('st1')).toBeNull();
      store.set('ludy.oauth.admin-link.st2', 'https://evil.example/organizations/adminconsent?client_id=1');
      expect(takeAdminLink('st2')).toBeNull();
      store.set('crove.oauth.admin-link.st3', link);
      expect(takeAdminLink('st3')).toBe(link);
      expect(store.has('crove.oauth.admin-link.st3')).toBe(false);
      expect(takeAdminLink('none')).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: original });
    }
  });
});
