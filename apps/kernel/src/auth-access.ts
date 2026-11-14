// SPDX-License-Identifier: AGPL-3.0-only
// Who may use this deployment when its identity provider is shared (issue #2704, ADR-0028 section 1).
//
// Pointing AUTH_JWKS_URL and AUTH_ISSUER at a Supabase Auth project that serves other products too (a company's own
// identity provider, say) makes every account of that project a valid token holder here: the kernel would create a
// user account for it on its first call and let it create orgs (ORG_CREATE_LIMIT_*). AUTH_SIGNUP_POLICY cannot
// restrict that, since it is enforced by the /auth/v1 proxy in front of the bundled Supabase Auth only.
//
// AUTH_ALLOWED_EMAILS closes it from this side. A comma or space separated list of exact addresses
// (`owner@example.com`) and of domains written with a leading `@` (`@example.com`, exact domain, no subdomains). Unset:
// no restriction, as before. Set: a token whose `email` matches no entry is refused with 403 ACCOUNT_NOT_ALLOWED on
// every request, before any database work, so no user account is created for it; taking an entry out of the list
// takes effect on the next request. The check reads the email of the verified token, so it is only as strong as the
// provider's promise that it issues tokens for confirmed addresses (the provider must require email confirmation);
// a token that says its email is not verified (`user_metadata.email_verified` is false) is refused too.
import { DomainError } from '@crove/kernel-runtime';

const LOCAL_PART = /^[a-z0-9][a-z0-9._%+-]{0,63}$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// The entries of AUTH_ALLOWED_EMAILS, lower-cased and de-duplicated, and the ones that are neither an address nor an
// `@domain`. Plain ASCII only: a look-alike letter never matches an address Supabase Auth lower-cased.
export function parseAllowedEmails(raw: string): { entries: string[]; invalid: string[] } {
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const entry of raw.split(/[\s,]+/).map((e) => e.trim()).filter(Boolean)) {
    const value = /[^\x21-\x7e]/.test(entry) ? null : asciiLower(entry);
    const at = value === null ? -1 : value.lastIndexOf('@');
    const local = value === null || at < 0 ? '' : value.slice(0, at);
    const domain = value === null || at < 0 ? '' : value.slice(at + 1);
    const wellFormed = value !== null && value.length <= 254 && DOMAIN.test(domain) && (at === 0 || (LOCAL_PART.test(local) && !local.includes('..')));
    if (wellFormed && value !== null) entries.push(value);
    else invalid.push(entry);
  }
  return { entries: [...new Set(entries)], invalid };
}

export const accountNotAllowed = () =>
  new DomainError('ACCOUNT_NOT_ALLOWED', 403, 'Tài khoản này chưa được phép dùng hệ thống này');

export type EmailAccess = (email: string, emailVerified: unknown) => void;

// The check the token verifier runs after the token verified. entries empty: allows everything.
export function createEmailAccess(entries: readonly string[]): EmailAccess {
  if (entries.length === 0) return () => undefined;
  const addresses = new Set(entries.filter((e) => !e.startsWith('@')));
  const domains = new Set(entries.filter((e) => e.startsWith('@')));
  return (email, emailVerified) => {
    const address = asciiLower(email.trim());
    const at = address.lastIndexOf('@');
    const allowed = addresses.has(address) || (at > 0 && address.indexOf('@') === at && domains.has(address.slice(at)));
    if (!allowed || emailVerified === false) throw accountNotAllowed();
  };
}
