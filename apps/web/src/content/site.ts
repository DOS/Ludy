// SPDX-License-Identifier: AGPL-3.0-only
// Links shared by both languages. NEXT_PUBLIC_APP_URL points at a running Ludy app (the kernel serves it with the
// sign-in page at /login); without it the sign-in link goes to the hosted app at app.ludy.vn (the owner moved the
// domains from crove.com to ludy.vn and ludy.so on 2026-10-30; ADR-0027).
export const GITHUB_URL = 'https://github.com/DOS/Ludy';
export const DOCS_URL = `${GITHUB_URL}#readme`;
export const SECURITY_URL = `${GITHUB_URL}/blob/main/SECURITY.md`;
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.ludy.vn').replace(/\/+$/, '');
export const SIGN_IN_URL = `${APP_URL}/login`;
export const SITE_URL = 'https://ludy.vn';

// The apps that have a page of their own (DESIGN.md 1.1 and 6.4), in the switcher's order (#3225, #3235), each with its
// one public path (the same in both languages; the language comes from the visitor's choice, see src/proxy.ts), the route
// of its English page inside the app (`enRoute`, which the proxy rewrites to and which is never a public address) and the
// module of the home page's dictionary that names it. /ke-toan and /engage keep their existing addresses; Ludy Notes
// moved to /cong-tac when the shell regrouped into Ludy Cộng tác.
export const APP_PAGES = {
  teamwork: { path: '/cong-tac', enRoute: '/en/teamwork', module: 'notes' },
  finance: { path: '/ke-toan', enRoute: '/en/accounting', module: 'finance' },
  engage: { path: '/engage', enRoute: '/en/engage', module: 'social' },
} as const;
export type AppPageKey = keyof typeof APP_PAGES;
// Addresses of pages that no longer exist, with the page that took their place. A request for one is a permanent redirect
// (301), and so is the old /en twin of one (src/proxy.ts), so links, bookmarks and search results keep working. Ludy CRM
// folded into Ludy Engage on 2026-11-03 (#2435, #2440); Ludy Notes became Ludy Cộng tác on 2026-11-14 (#3225, #3235).
export const RETIRED_PAGES: Readonly<Record<string, string>> = {
  '/crm': '/engage',
  '/notes': '/cong-tac',
};
export const appPagePath = (key: AppPageKey) => APP_PAGES[key].path;

// Pages that are not an app: legal text. Same rule as the app pages (one public path for both languages, the English tree
// at `enRoute` behind the proxy). /privacy is the address the Chrome Web Store listing of the Ludy extension links
// (ludy.vn and ludy.so both serve this app); it is in the footer and the sitemap but is not an app card.
export const LEGAL_PAGES = {
  privacy: { path: '/privacy', enRoute: '/en/privacy' },
} as const;
export type LegalPageKey = keyof typeof LEGAL_PAGES;
// The version of the privacy page and the day it took effect (ISO date). The copy of both languages shows them, and
// privacy-page.test.ts checks that they do. Change them in the same commit as any change to what the page says.
export const PRIVACY_VERSION = '1.0';
export const PRIVACY_UPDATED = '2026-11-13';
// Where a privacy request goes by email (deletion, export, questions): the address the owner gave on 2026-11-13. null hides the
// contact line, so a deployment of this site with no address shows none. Never invent one.
export const PRIVACY_CONTACT_EMAIL: string | null = 'hi@ludy.so';
// Who operates Ludy Cloud, as the privacy page names it: the English form of the legal name the owner gave on 2026-11-13. The
// Vietnamese page uses it too until the owner gives a Vietnamese registered name: change this one constant then. No address
// is shown, because none has been given.
export const PRIVACY_OPERATOR = 'DOS LTD';
