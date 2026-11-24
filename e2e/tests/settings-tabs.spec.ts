// SPDX-License-Identifier: AGPL-3.0-only
// Settings in the left sidebar (ST-1, ST-8, #3589, #4499): eleven sub-pages in the secondary sidebar, each with its own address and under 1200 px at 1440 wide;
// no horizontal tab strip above the Settings header; an old link to the single page still lands on its card; and on a phone tapping Cài đặt keeps the drawer open
// to pick a sub-page with >= 44px touch targets.
import { expect, test } from '@playwright/test';
import { openSettingsTab, SETTINGS_TAB } from '../lib/settings.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

const TAB_PATHS = { org: '', members: '/members', apps: '/apps', bookings: '/bookings', sales: '/sales', quotes: '/quotes', accounting: '/accounting', connections: '/connections', notifications: '/notifications', security: '/security', data: '/data' } as const;

test('every sub-page of Settings sits in the left sidebar, has its own address, and stays under 1200 px at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, newEmail('settings-tabs'));
  const slug = await createOrg(page, 'Công ty chia thẻ');
  const railSettings = page.getByRole('navigation').getByRole('link', { name: 'Cài đặt', exact: true });
  await railSettings.click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings$`));

  await expect(page.getByRole('list', { name: 'Các thẻ của màn hình' })).toHaveCount(0);
  await expect(railSettings).toHaveAttribute('aria-current', 'true');
  const menu = page.getByRole('navigation').getByRole('region', { name: 'Cài đặt', exact: true });
  await expect(menu.getByRole('link')).toHaveText(Object.values(SETTINGS_TAB));
  await expect(menu.getByRole('link', { name: SETTINGS_TAB.org, exact: true })).toHaveAttribute('aria-current', 'page');

  for (const tab of Object.keys(TAB_PATHS) as Array<keyof typeof TAB_PATHS>) {
    await openSettingsTab(page, tab);
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings${TAB_PATHS[tab]}$`));
    await expect(railSettings).toHaveAttribute('aria-current', 'true');
    await expect(menu.getByRole('link', { name: SETTINGS_TAB[tab], exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(menu.locator('[aria-current="page"]')).toHaveCount(1);
    // One column of cards: the heading of the screen, then the cards, no two-column grid.
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText('Cài đặt');
    await page.waitForLoadState('networkidle');
    // The height of the sub-page itself, from its title to its last card.
    const grid = page.getByRole('main').locator('div.grid.max-w-4xl');
    const height = await grid.evaluate((el) => Math.round(el.getBoundingClientRect().bottom - (document.querySelector('main h1')?.getBoundingClientRect().top ?? 0)));
    const cards = await grid.locator('> *').evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().height)));
    console.log(`settings tab ${tab}: ${height} px from title to last card, cards ${cards.join(' + ')}`);
    // Soft, so one run reports the height of every sub-page, not only the first that is too tall.
    expect.soft(height, `${tab} tab is ${height} px tall`).toBeLessThan(1200);
  }

  // One column: the cards of the bookings sub-page sit under each other, not beside.
  await openSettingsTab(page, 'bookings');
  const boxes = await page.getByRole('main').locator('div.grid.max-w-4xl > *').evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().left));
  expect(new Set(boxes.map((x) => Math.round(x))).size).toBe(1);
});

test('an old link to a card of the single Settings page lands on the sub-page that holds it, with its fragment', async ({ page }) => {
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

  test('tapping Cài đặt keeps the drawer open, lists 44px sub-page links, and tapping one closes the drawer', async ({ page }) => {
    await signUp(page, newEmail('settings-phone'));
    const slug = await createOrg(page, 'Công ty điện thoại');
    const openMenu = page.getByRole('button', { name: 'Mở menu' });
    await openMenu.click();

    const drawer = page.getByRole('dialog', { name: 'Menu chính' });
    const railSettings = drawer.getByRole('link', { name: 'Cài đặt', exact: true });
    await railSettings.click();

    // Tapping Cài đặt in the rail keeps the drawer open so mobile users can pick among the Settings pages.
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings$`));
    await expect(railSettings).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('list', { name: 'Các thẻ của màn hình' })).toHaveCount(0);

    const menu = drawer.getByRole('region', { name: 'Cài đặt', exact: true });
    await expect(menu.getByRole('link')).toHaveText(Object.values(SETTINGS_TAB));
    await expect(menu.getByRole('link', { name: SETTINGS_TAB.org, exact: true })).toHaveAttribute('aria-current', 'page');

    // Rail button and every Settings menu item keep >= 44px touch targets.
    expect((await railSettings.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    for (const link of await menu.getByRole('link').all()) {
      expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }

    // Tapping a Settings sub-page navigates and closes the drawer, with no horizontal overflow.
    const dataLink = menu.getByRole('link', { name: SETTINGS_TAB.data, exact: true });
    await dataLink.scrollIntoViewIfNeeded();
    await dataLink.click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings/data$`));
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(3000);

    // Reopening the drawer highlights the active sub-page and lets the user switch cleanly.
    await openMenu.click();
    await expect(drawer).toBeVisible();
    await expect(railSettings).toHaveAttribute('aria-current', 'true');
    await expect(menu.getByRole('link', { name: SETTINGS_TAB.data, exact: true })).toHaveAttribute('aria-current', 'page');
    await menu.getByRole('link', { name: SETTINGS_TAB.members, exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings/members$`));
  });
});
