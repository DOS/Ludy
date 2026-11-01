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

// The apps that have a page of their own (DESIGN.md 1.1 names), each with its path in both languages and the module of
// the home page's dictionary that names it. The sitemap, the footer links, the home page's module cards and the
// language switch of each page read this list, so a new app page is one entry here, its copy and its routes.
export const APP_PAGES = {
  accounting: { vi: '/ke-toan', en: '/en/accounting', module: 'finance' },
  crm: { vi: '/crm', en: '/en/crm', module: 'crm' },
} as const;
export type AppPageKey = keyof typeof APP_PAGES;
export const appPagePath = (key: AppPageKey, lang: string) => APP_PAGES[key][lang === 'vi' ? 'vi' : 'en'];
