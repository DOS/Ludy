// SPDX-License-Identifier: AGPL-3.0-only
// One URL per page in both languages (#2360): which language a request gets, and what the proxy does with an old /en
// link, the header toggle and a plain visit. The rendered result (the toggle on a real page, the cookie across pages)
// is checked in language.spec.ts.
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from '../src/proxy';
import { chooseLanguage, englishRoute, languageFromAcceptHeader, publicPathOfLegacy } from '../src/lib/language';
import { APP_PAGES } from '../src/content/site';

const visit = (path: string, headers: Record<string, string> = {}) => new NextRequest(`https://ludy.vn${path}`, { headers });
const rewrittenTo = (path: string, headers?: Record<string, string>) => proxy(visit(path, headers)).headers.get('x-middleware-rewrite');

describe('language of a request', () => {
  it('is Vietnamese with no signal, `*` or an empty header (crawlers)', () => {
    for (const header of [undefined, null, '', '*']) expect(languageFromAcceptHeader(header)).toBe('vi');
  });

  it('follows the browser order between the two languages of the site', () => {
    expect(languageFromAcceptHeader('vi-VN,vi;q=0.9,en;q=0.8')).toBe('vi');
    expect(languageFromAcceptHeader('en-US,en;q=0.9')).toBe('en');
    expect(languageFromAcceptHeader('en;q=0.5, vi;q=0.9')).toBe('vi');
    expect(languageFromAcceptHeader('fr-FR, vi;q=0.5')).toBe('vi');
    expect(languageFromAcceptHeader('ja, en;q=0.4')).toBe('en');
  });

  it('is English for a browser that names neither language', () => {
    expect(languageFromAcceptHeader('de-DE,de;q=0.9')).toBe('en');
  });

  it('lets the cookie decide over the browser, and ignores a cookie it does not know', () => {
    expect(chooseLanguage('vi', 'en-US')).toBe('vi');
    expect(chooseLanguage('en', 'vi-VN')).toBe('en');
    expect(chooseLanguage('fr', 'en-US')).toBe('en');
    expect(chooseLanguage(undefined, undefined)).toBe('vi');
  });
});

describe('addresses', () => {
  it('maps every page of the site to its English route and back', () => {
    expect(englishRoute('/')).toBe('/en');
    for (const page of Object.values(APP_PAGES)) {
      expect(englishRoute(page.path)).toBe(page.enRoute);
      expect(publicPathOfLegacy(page.enRoute)).toBe(page.path);
    }
    expect(publicPathOfLegacy('/en')).toBe('/');
    expect(publicPathOfLegacy('/en/')).toBe('/');
    expect(publicPathOfLegacy('/ke-toan')).toBeNull();
    expect(publicPathOfLegacy('/engineering')).toBeNull();
    expect(englishRoute('/nope')).toBeNull();
  });
});

describe('proxy', () => {
  it('serves Vietnamese at the page itself to a visit with no language, and says the answer varies', () => {
    const response = proxy(visit('/ke-toan'));
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('vary')).toMatch(/cookie/i);
    expect(response.headers.get('vary')).toMatch(/accept-language/i);
  });

  it('rewrites to the English route, keeping the address, for an English browser or cookie', () => {
    expect(rewrittenTo('/', { 'accept-language': 'en-US,en;q=0.9' })).toBe('https://ludy.vn/en');
    expect(rewrittenTo('/ke-toan', { 'accept-language': 'en' })).toBe('https://ludy.vn/en/accounting');
    expect(rewrittenTo('/crm', { cookie: 'ludy-lang=en' })).toBe('https://ludy.vn/en/crm');
    expect(rewrittenTo('/notes', { cookie: 'ludy-lang=en', 'accept-language': 'vi' })).toBe('https://ludy.vn/en/notes');
    expect(proxy(visit('/', { cookie: 'ludy-lang=en' })).headers.get('vary')).toMatch(/cookie/i);
  });

  it('keeps Vietnamese for a cookie that says so, whatever the browser asks for', () => {
    expect(rewrittenTo('/', { cookie: 'ludy-lang=vi', 'accept-language': 'en-US' })).toBeNull();
  });

  it('redirects an old /en link for good to the public address and remembers English', () => {
    for (const [from, to] of [['/en', '/'], ['/en/accounting', '/ke-toan'], ['/en/crm', '/crm'], ['/en/notes', '/notes']] as const) {
      const response = proxy(visit(from));
      expect(response.status, from).toBe(301);
      expect(new URL(response.headers.get('location')!).pathname, from).toBe(to);
      expect(response.cookies.get('ludy-lang')?.value, from).toBe('en');
    }
  });

  it('turns the toggle into a cookie and the same address without the parameter', () => {
    const toEnglish = proxy(visit('/crm?lang=en'));
    expect(toEnglish.status).toBe(302);
    expect(toEnglish.headers.get('location')).toBe('https://ludy.vn/crm');
    expect(toEnglish.cookies.get('ludy-lang')).toMatchObject({ value: 'en', path: '/', sameSite: 'lax', secure: true });
    expect(toEnglish.cookies.get('ludy-lang')?.maxAge).toBeGreaterThan(60 * 60 * 24 * 300);
    // The choice is Vietnamese even when the browser is English, and other parameters survive.
    const toVietnamese = proxy(visit('/?lang=vi&utm=x', { 'accept-language': 'en' }));
    expect(toVietnamese.headers.get('location')).toBe('https://ludy.vn/?utm=x');
    expect(toVietnamese.cookies.get('ludy-lang')?.value).toBe('vi');
  });

  it('ignores a language it does not know and leaves the social preview images alone', () => {
    expect(proxy(visit('/?lang=fr')).status).toBe(200);
    const image = proxy(visit('/en/opengraph-image-1abc', { 'accept-language': 'vi' }));
    expect(image.headers.get('x-middleware-next')).toBe('1');
    expect(image.headers.get('location')).toBeNull();
  });
});
