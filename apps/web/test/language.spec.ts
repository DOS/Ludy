// SPDX-License-Identifier: AGPL-3.0-only
// One URL per page in both languages (#2360; DESIGN.md 6.4 and 8), on the built site: the header toggle switches the
// language without changing the path, a cookie keeps the choice across pages, old /en links redirect with English
// shown, and a first visit gets the browser's language (Vietnamese with no signal, as crawlers are served).
import { expect, test } from '@playwright/test';

const lang = (page: import('@playwright/test').Page) => page.locator('html').getAttribute('lang');

test('the toggle switches the language at the same path and a cookie keeps it across pages', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'vi-VN' });
  const page = await context.newPage();
  await page.goto('/ke-toan');
  expect(await lang(page)).toBe('vi');

  await page.getByRole('banner').getByRole('link', { name: /English|tiếng Anh/i }).click();
  await expect(page).toHaveURL(/\/ke-toan$/);
  expect(await lang(page)).toBe('en');
  expect((await context.cookies()).find((cookie) => cookie.name === 'ludy-lang')?.value).toBe('en');

  for (const path of ['/', '/engage', '/cong-tac']) {
    await page.goto(path);
    expect(new URL(page.url()).pathname, path).toBe(path);
    expect(await lang(page), path).toBe('en');
  }

  await page.getByRole('banner').getByRole('link', { name: /Vietnamese|tiếng Việt/i }).click();
  await expect(page).toHaveURL(/\/cong-tac$/);
  expect(await lang(page)).toBe('vi');
  await context.close();
});

test('the retired /crm and /notes redirect for good to /engage and /cong-tac, in either language', async ({ browser, request }) => {
  for (const [retired, replacement] of [['/crm', '/engage'], ['/notes', '/cong-tac']] as const) {
    const response = await request.get(`${retired}?utm=x`, { maxRedirects: 0 });
    expect(response.status(), retired).toBe(301);
    expect(new URL(response.headers()['location']!, 'http://x').pathname, retired).toBe(replacement);
    const context = await browser.newContext({ locale: 'vi-VN' });
    const page = await context.newPage();
    await page.goto(retired);
    expect(new URL(page.url()).pathname, retired).toBe(replacement);
    expect(await lang(page), retired).toBe('vi');
    await context.close();
  }
});

test('old /en links redirect to the public address and show English', async ({ browser }) => {
  for (const [from, to] of [['/en', '/'], ['/en/accounting', '/ke-toan'], ['/en/crm', '/engage'], ['/en/teamwork', '/cong-tac'], ['/en/notes', '/cong-tac']] as const) {
    const context = await browser.newContext({ locale: 'vi-VN' });
    const page = await context.newPage();
    await page.goto(from);
    expect(new URL(page.url()).pathname, from).toBe(to);
    expect(await lang(page), from).toBe('en');
    await context.close();
  }
});

test('a first visit follows the browser language, and a request with none gets Vietnamese', async ({ browser, request }) => {
  const english = await browser.newContext({ locale: 'en-US' });
  const englishPage = await english.newPage();
  await englishPage.goto('/');
  expect(await lang(englishPage)).toBe('en');
  await english.close();

  const vietnamese = await browser.newContext({ locale: 'vi-VN' });
  const vietnamesePage = await vietnamese.newPage();
  await vietnamesePage.goto('/');
  expect(await lang(vietnamesePage)).toBe('vi');
  await vietnamese.close();

  const crawler = await request.get('/', { headers: { 'Accept-Language': '' } });
  expect(await crawler.text()).toMatch(/<html lang="vi"/);
  // The toggle's redirect says its answer varies with the cookie.
  const toggle = await request.get('/ke-toan?lang=en', { maxRedirects: 0 });
  expect(toggle.status()).toBe(302);
  expect(toggle.headers()['vary'] ?? '').toMatch(/cookie/i);
});

test('the sitemap lists one address per page and the pages declare no /en alternate', async ({ request, page }) => {
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).not.toMatch(/\/en(\/|<)/);
  expect(sitemap).not.toContain('xhtml:link');
  for (const path of ['/', '/cong-tac', '/ke-toan', '/engage']) {
    await page.goto(path);
    expect(await page.locator('link[rel="alternate"][hreflang]').count(), path).toBe(0);
    expect(await page.locator('link[rel="canonical"]').getAttribute('href'), path).toMatch(new RegExp(`https://ludy\\.vn${path === '/' ? '/?' : path}$`));
  }
});
