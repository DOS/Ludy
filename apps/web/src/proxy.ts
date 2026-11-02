// SPDX-License-Identifier: AGPL-3.0-only
// One URL per page in both languages (#2360, DESIGN.md 6.4 and 8). The pages stay static, one tree per language
// ((vi) at the public paths, (en) under /en); this proxy picks the tree for each request:
//   - an old `/en...` link is redirected (301) to the public address and the English choice is remembered;
//   - `?lang=vi|en`, the header toggle, remembers the choice in a cookie and goes back to the same address (302);
//   - otherwise the cookie, else the browser's language, decides, and English is a rewrite to the page's /en route.
// The answer depends on the Cookie and Accept-Language headers, so every response says so in `Vary`.
import { NextResponse, type NextRequest } from 'next/server';
import { chooseLanguage, englishRoute, isLang, LANG_COOKIE, LANG_COOKIE_MAX_AGE, LANG_PARAM, publicPathOfLegacy, type Lang } from './lib/language';

function remember(response: NextResponse, request: NextRequest, lang: Lang): NextResponse {
  response.cookies.set(LANG_COOKIE, lang, {
    path: '/',
    maxAge: LANG_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
  });
  return response;
}

function varied(response: NextResponse): NextResponse {
  response.headers.append('Vary', 'Cookie, Accept-Language');
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, searchParams } = request.nextUrl;
  // The social preview images are routes of their own that each tree names in its meta tags: serve them as asked.
  if (pathname.includes('opengraph-image')) return NextResponse.next();

  const asked = searchParams.get(LANG_PARAM);
  const legacy = publicPathOfLegacy(pathname);
  if (legacy !== null || isLang(asked)) {
    const target = request.nextUrl.clone();
    target.pathname = legacy ?? pathname;
    target.searchParams.delete(LANG_PARAM);
    const lang: Lang = isLang(asked) ? asked : 'en';
    // An old link is permanent for search engines, but no browser should keep it: a repeat visit with the cookie
    // cleared must still pass through here to set it. A toggle is a choice that can change.
    const response = remember(NextResponse.redirect(target, legacy !== null ? 301 : 302), request, lang);
    response.headers.set('Cache-Control', 'no-store');
    return varied(response);
  }

  const lang = chooseLanguage(request.cookies.get(LANG_COOKIE)?.value, request.headers.get('accept-language'));
  const route = lang === 'en' ? englishRoute(pathname) : null;
  if (route === null) return varied(NextResponse.next());
  const target = request.nextUrl.clone();
  target.pathname = route;
  return varied(NextResponse.rewrite(target));
}

// Pages only: no Next.js internals and no file with an extension (fonts, favicon.svg, sitemap.xml, robots.txt).
export const config = {
  matcher: ['/((?!_next/|.*\\.[a-zA-Z0-9]+$).*)'],
};
