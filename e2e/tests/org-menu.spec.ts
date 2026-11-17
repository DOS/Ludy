// SPDX-License-Identifier: AGPL-3.0-only
// The org menu at the top of the sidebar (#3579), end to end: a button with the current org's name opens a menu of
// every org the person belongs to, the current one checked, and "Thêm tổ chức" after a separator. The keyboard works
// (arrows, Enter, Escape, focus back on the button), and on a phone the menu opens inside the drawer with 44px items.
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const orgButton = (page: Page) => page.getByRole('button', { name: /^Tổ chức:/ });

test('the org menu switches orgs and adds one, by mouse and by keyboard', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('org-menu'));
  const first = await createOrg(page, 'Công ty Hoa Sen');
  await page.goto('/onboarding');
  const second = await createOrg(page, 'Công ty Hướng Dương');
  await expect(page).toHaveURL(new RegExp(`/o/${second}/overview$`));
  const sidebar = page.getByRole('complementary');
  const button = sidebar.getByRole('button', { name: /^Tổ chức:/ });

  await test.step('the button names the current org, and the menu checks it', async () => {
    await expect(button).toHaveAccessibleName('Tổ chức: Công ty Hướng Dương');
    await expect(sidebar.getByRole('combobox')).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'Thêm tổ chức' })).toHaveCount(0);
    await button.click();
    const menu = page.getByRole('menu', { name: /^Tổ chức:/ });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Công ty Hướng Dương' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Công ty Hoa Sen' })).toHaveAttribute('aria-checked', 'false');
    // "Thêm tổ chức" is the last item, after a separator.
    await expect(menu.getByRole('menuitem').last()).toHaveText('Thêm tổ chức');
    await expect(menu.getByRole('separator')).toHaveCount(1);
  });

  await test.step('Escape closes the menu and focus goes back to the button', async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  await test.step('the arrow keys and Enter switch to the other org', async () => {
    await button.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: /^Tổ chức:/ });
    await expect(menu).toBeVisible();
    const names = await menu.getByRole('menuitemradio').allTextContents();
    const target = menu.getByRole('menuitemradio', { name: 'Công ty Hoa Sen' });
    // Opened from the keyboard, the menu highlights its first item; the arrows move from there.
    for (let i = 0; i < names.indexOf('Công ty Hoa Sen'); i += 1) await page.keyboard.press('ArrowDown');
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/o/${first}/overview$`));
    await expect(button).toHaveAccessibleName('Tổ chức: Công ty Hoa Sen');
  });

  await test.step('"Thêm tổ chức" opens the form for the next org', async () => {
    await button.click();
    await page.getByRole('menuitem', { name: 'Thêm tổ chức' }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole('heading', { name: 'Thêm tổ chức' })).toBeVisible();
  });
});

test('on a phone the org menu opens inside the drawer, with 44px items', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await signInNewUser(page, newEmail('org-menu-phone'));
  const first = await createOrg(page, 'Công ty Hoa Sen');
  await page.goto('/onboarding');
  await createOrg(page, 'Công ty Hướng Dương');

  await page.getByRole('button', { name: 'Mở menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Menu chính' });
  await expect(drawer).toBeVisible();
  const button = orgButton(page);
  expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  // Escape closes the menu, not the drawer around it.
  await button.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(button).toBeFocused();
  await button.click();
  const target = page.getByRole('menuitemradio', { name: 'Công ty Hoa Sen' });
  await expect(target).toBeVisible();
  expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole('menuitem', { name: 'Thêm tổ chức' }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await target.click();
  await expect(page).toHaveURL(new RegExp(`/o/${first}/overview$`));
  // Picking an org closes the drawer, as every link in it does.
  await expect(drawer).toBeHidden();
});
