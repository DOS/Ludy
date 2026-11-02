// SPDX-License-Identifier: AGPL-3.0-only
// Which language a request gets (#2360, DESIGN.md 6.4 and 8). Every page has one public address; the language comes
// from the visitor's choice (a cookie the header toggle sets) or, on a first visit, from the browser's language.
// The proxy (src/proxy.ts) turns that into a rewrite to the page's English route, which stays under /en inside the app.
import { APP_PAGES } from '../content/site';

export type Lang = 'vi' | 'en';

export const LANG_COOKIE = 'ludy-lang';
// The query parameter of the header toggle: `?lang=en` sets the cookie and goes back to the same address without it.
export const LANG_PARAM = 'lang';
export const LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const isLang = (value: unknown): value is Lang => value === 'vi' || value === 'en';

// The browser's order of preference decides between the two languages the site has: the first of `vi` or `en` in it
// wins, any other language is skipped, a header with neither gets English, and no header (most crawlers), `*` alone
// or an empty one gets Vietnamese.
export function languageFromAcceptHeader(header: string | null | undefined): Lang {
  const wanted = (header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { primary: tag.trim().toLowerCase().split('-')[0] ?? '', weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.primary !== '' && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  if (wanted.every((entry) => entry.primary === '*')) return 'vi';
  for (const entry of wanted) {
    if (entry.primary === 'vi') return 'vi';
    if (entry.primary === 'en') return 'en';
  }
  return 'en';
}

export function chooseLanguage(cookie: string | undefined, acceptLanguage: string | null | undefined): Lang {
  return isLang(cookie) ? cookie : languageFromAcceptHeader(acceptLanguage);
}

// The home page and each app page: its public address (the same in both languages) and the route of its English tree.
const EN_ROUTES: Record<string, string> = { '/': '/en' };
const PUBLIC_PATHS: Record<string, string> = { '/en': '/' };
for (const page of Object.values(APP_PAGES)) {
  EN_ROUTES[page.path] = page.enRoute;
  PUBLIC_PATHS[page.enRoute] = page.path;
}

const stripTrailingSlash = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname) || '/';

// The English route that serves a public address, or null when the site has no page there.
export function englishRoute(pathname: string): string | null {
  return EN_ROUTES[stripTrailingSlash(pathname)] ?? null;
}

// The public address an old `/en...` link now lives at, or null when the path is not one. An unknown page under /en
// keeps its rest, so it ends as a 404 at the public address like any other unknown page.
export function publicPathOfLegacy(pathname: string): string | null {
  const path = stripTrailingSlash(pathname);
  if (path !== '/en' && !path.startsWith('/en/')) return null;
  return PUBLIC_PATHS[path] ?? path.slice('/en'.length);
}
