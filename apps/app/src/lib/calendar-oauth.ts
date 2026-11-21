// SPDX-License-Identifier: AGPL-3.0-only
// Small facts about the calendar providers the screens need (Meetings B3, #3167): which OAuth dialog a stored connection belongs to, and whether an answer that came back through the
// address bar means the member's Microsoft tenant needs its administrator to allow the app first.
import type { CalendarOAuthProvider } from '@crove/kernel-contract';

// The OAuth provider id of the connect dialog for a stored connection's provider.
export function oauthProviderOf(provider: string): CalendarOAuthProvider | null {
  return provider === 'google' ? 'google_calendar' : provider === 'microsoft' ? 'microsoft_calendar' : null;
}

// The error a Microsoft tenant sends back to the redirect address when its administrator has not allowed the app: consent_required, or an AADSTS65001 (not consented) or AADSTS90094 (the grant
// requires admin permission) or AADSTS90095 (admin approval is required, a tenant with an admin-consent workflow) in the description. A member's own "no" (access_denied with AADSTS65004) is not this.
export function needsAdminConsent(provider: string, params: URLSearchParams): boolean {
  // The calendar's OAuth provider id and the Teams recording import's connect provider (C4, #3176): both go through a Microsoft tenant's administrator consent.
  if (provider !== 'microsoft_calendar' && provider !== 'microsoft_teams') return false;
  const description = params.get('error_description') ?? '';
  return params.get('error') === 'consent_required' || /AADSTS(?:65001|90094|90095)\b/.test(description);
}

// The address an administrator opens to allow the app for their whole Microsoft 365 organization, built from the authorize address the connect used (its application id and return address,
// both public): Microsoft's admin consent endpoint on the generic `organizations` tenant. Null for anything that is not a Microsoft authorize address.
export function adminConsentLink(authorizeUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(authorizeUrl);
  } catch {
    return null;
  }
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' || !clientId || !redirectUri) return null;
  const link = new URL('https://login.microsoftonline.com/organizations/adminconsent');
  link.searchParams.set('client_id', clientId);
  link.searchParams.set('redirect_uri', redirectUri);
  return link.toString();
}

// The link is kept with the attempt (under its state) so the callback page, which comes back through the provider's redirect, can show it; read once, like the attempt itself.
const LINK_PREFIX = 'crove.oauth.admin-link.';
export function rememberAdminLink(state: string, link: string): void {
  try {
    sessionStorage.setItem(LINK_PREFIX + state, link);
  } catch {
    // Storage off: the page then says what to ask without a link.
  }
}
export function takeAdminLink(state: string): string | null {
  try {
    const link = sessionStorage.getItem(LINK_PREFIX + state);
    sessionStorage.removeItem(LINK_PREFIX + state);
    if (link === null) return null;
    // Only the address this module builds is shown back: the right host and path, nothing else.
    const parsed = new URL(link);
    return parsed.protocol === 'https:' && parsed.hostname === 'login.microsoftonline.com' && parsed.pathname === '/organizations/adminconsent' ? link : null;
  } catch {
    return null;
  }
}
