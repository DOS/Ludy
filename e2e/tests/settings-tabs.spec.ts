// SPDX-License-Identifier: AGPL-3.0-only
// Settings in tabs (ST-1, ST-8, #3589): nine tabs, each with its own address and under 1200 px at 1440 wide, one kind of setting each; an old link to the single page still lands on its
// card; and a phone gets a strip that scrolls sideways, not a 10000 px page. The AI coworker here: none acts, this is a layout of settings a person changes.
import { expect, test } from '@playwright/test';
import { openSettingsTab, SETTINGS_TAB } from '../lib/settings.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

const TAB_PATHS = { org: '', members: '/members', apps: '/apps', bookings: '/bookings', sales: '/sales', accounting: '/accounting', connections: '/connections', security: '/security', data: '/data' } as const;

test('every tab of Settings has its own address, shows one kind of setting and stays under 1200 px at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, newEmail('settings-tabs'));
  const slug = await createOrg(page, 'Công ty chia thẻ');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings$`));

  const strip = page.getByRole('list', { name: 'Các thẻ của màn hình' });
  await expect(strip.getByRole('link')).toHaveText(Object.values(SETTINGS_TAB));
  await expect(strip.getByRole('link', { name: SETTINGS_TAB.org, exact: true })).toHaveAttribute('aria-current', 'page');

  for (const tab of Object.keys(TAB_PATHS) as Array<keyof typeof TAB_PATHS>) {
    await openSettingsTab(page, tab);
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings${TAB_PATHS[tab]}$`));
    await expect(strip.getByRole('link', { name: SETTINGS_TAB[tab], exact: true })).toHaveAttribute('aria-current', 'page');
    // One column of cards: the heading of the screen, then the cards, no two-column grid.
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText('Cài đặt');
    await page.waitForLoadState('networkidle');
    const height = await page.getByRole('main').evaluate((main) => main.scrollHeight);
    const cards = await page.getByRole('main').locator('div.grid.max-w-4xl > *').evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().height)));
    console.log(`settings tab ${tab}: ${height} px in all, cards ${cards.join(' + ')}`);
    // Soft, so one run reports the height of every tab, not only the first that is too tall.
    expect.soft(height, `${tab} tab is ${height} px tall`).toBeLessThan(1200);
  }

  // One column: the cards of the bookings tab sit under each other, not beside.
  await openSettingsTab(page, 'bookings');
  const boxes = await page.getByRole('main').locator('div.grid.max-w-4xl > *').evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().left));
  expect(new Set(boxes.map((x) => Math.round(x))).size).toBe(1);
});

test('an old link to a card of the single Settings page lands on the tab that holds it, with its fragment', async ({ page }) => {
  await signUp(page, newEmail('settings-links'));
  const slug = await createOrg(page, 'Công ty giữ liên kết cũ');
  await page.goto(`/o/${slug}/settings#booking-settings`);
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings/bookings#booking-settings$`));
  await expect(page.getByLabel('Giờ bắt đầu Thứ Hai')).toBeVisible();

  await page.goto(`/o/${slug}/settings#integrations`);
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings/connections#integrations$`));
  await expect(page.getByRole('heading', { name: 'Tích hợp', exact: true })).toBeVisible();

  await page.goto(`/o/${slug}/settings?invite=ke.toan%40example.test`);
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings/members\\?invite=`));
  await expect(page.getByPlaceholder('email@congty.vn')).toHaveValue('ke.toan@example.test');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the tab strip scrolls sideways and no tab is a page of thousands of pixels', async ({ page }) => {
    await signUp(page, newEmail('settings-phone'));
    const slug = await createOrg(page, 'Công ty điện thoại');
    await page.goto(`/o/${slug}/settings/members`);
    const strip = page.getByRole('list', { name: 'Các thẻ của màn hình' });
    await expect(strip).toBeVisible();
    // The strip is wider than the screen and scrolls inside itself; the page itself does not scroll sideways.
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // A tab off the right edge is reached by scrolling the strip, and opens its own address.
    await strip.getByRole('link', { name: SETTINGS_TAB.data, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings/data$`));
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(3000);
  });
});
