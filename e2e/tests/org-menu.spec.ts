// SPDX-License-Identifier: AGPL-3.0-only
// The bottom account popover and org switcher (#3579, #4502), end to end: active org context stays visible on the
// bottom trigger, opening the account popover reveals OrgMenu, multi-org link, segmented theme & language controls,
// and sign-out. Escape closes layered popups cleanly, and on a phone all controls inside the drawer stay >= 44px.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const accountButton = (scope: Locator | Page) => scope.getByRole('button', { name: /^Tài khoản:/ });
const orgButton = (scope: Locator | Page) => scope.getByRole('button', { name: /^Tổ chức:/ });

test('the bottom account popover switches orgs, theme, and language by mouse and keyboard', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('org-menu'));
  const first = await createOrg(page, 'Công ty Hoa Sen');
  await page.goto('/onboarding');
  const second = await createOrg(page, 'Công ty Hướng Dương');
  await expect(page).toHaveURL(new RegExp(`/o/${second}/overview$`));
  const sidebar = page.getByRole('complementary');
  const trigger = accountButton(sidebar);

  await test.step('active org context sits on the bottom account trigger, not a top org dropdown', async () => {
    await expect(trigger).toHaveAccessibleName(new RegExp(String.raw`^Tài khoản: .*Công ty Hướng Dương`));
    await expect(trigger).toHaveAttribute('title', /Công ty Hướng Dương/);
    await expect(sidebar.getByRole('combobox')).toHaveCount(0);
    await expect(orgButton(sidebar)).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'Thêm tổ chức' })).toHaveCount(0);
  });

  await test.step('opening the account popover shows OrgMenu and multi-org navigation', async () => {
    await trigger.click();
    await expect(sidebar.getByRole('link', { name: 'Tất cả doanh nghiệp' })).toBeVisible();
    const button = orgButton(sidebar);
    await expect(button).toHaveAccessibleName('Tổ chức: Công ty Hướng Dương');
    await button.click();
    const menu = page.getByRole('menu', { name: /^Tổ chức:/ });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Công ty Hướng Dương' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Công ty Hoa Sen' })).toHaveAttribute('aria-checked', 'false');
    // "Thêm tổ chức" is the last item, after a separator.
    await expect(menu.getByRole('menuitem').last()).toHaveText('Thêm tổ chức');
    await expect(menu.getByRole('separator')).toHaveCount(1);
  });

  await test.step('Escape closes OrgMenu first, then AccountPopover, returning focus at each layer', async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(orgButton(sidebar)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sidebar.getByTestId('account-popover')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  await test.step('the theme and language segmented toggles stay in sync with DOM and reload', async () => {
    await trigger.click();
    const themeGroup = sidebar.getByRole('radiogroup', { name: 'Giao diện' });
    await expect(themeGroup.getByRole('radio', { name: 'Sáng' })).toHaveAttribute('aria-checked', 'true');
    await themeGroup.getByRole('radio', { name: 'Tối' }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(themeGroup.getByRole('radio', { name: 'Tối' })).toHaveAttribute('aria-checked', 'true');

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await trigger.click();
    await expect(sidebar.getByRole('radiogroup', { name: 'Giao diện' }).getByRole('radio', { name: 'Tối' })).toHaveAttribute('aria-checked', 'true');
    await sidebar.getByRole('radiogroup', { name: 'Giao diện' }).getByRole('radio', { name: 'Sáng' }).click();
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);

    const langGroup = sidebar.getByRole('radiogroup', { name: 'Ngôn ngữ' });
    await langGroup.getByRole('radio', { name: /English/ }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(sidebar.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: /English/ })).toHaveAttribute('aria-checked', 'true');
    await sidebar.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: /Tiếng Việt/ }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await page.keyboard.press('Escape');
  });

  await test.step('the arrow keys and Enter switch to the other org', async () => {
    await trigger.click();
    const button = orgButton(sidebar);
    await button.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: /^Tổ chức:/ });
    await expect(menu).toBeVisible();
    const names = await menu.getByRole('menuitemradio').allTextContents();
    const target = menu.getByRole('menuitemradio', { name: 'Công ty Hoa Sen' });
    for (let i = 0; i < names.indexOf('Công ty Hoa Sen'); i += 1) await page.keyboard.press('ArrowDown');
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/o/${first}/overview$`));
    await expect(trigger).toHaveAccessibleName(new RegExp(String.raw`^Tài khoản: .*Công ty Hoa Sen`));
    await expect(trigger).toHaveAttribute('title', /Công ty Hoa Sen/);
  });

  await test.step('on an App screen, the expanded bottom trigger visibly displays the active org name', async () => {
    await sidebar.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${first}/accounting$`));
    await expect(trigger).toContainText('Công ty Hoa Sen');
  });

  await test.step('Cmd+K tracks org-isolated recents and runs quick actions cleanly (#4525)', async () => {
    await sidebar.getByRole('link', { name: 'Sổ sách', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${first}/ledger$`));

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Bảng lệnh' });
    await expect(palette).toBeVisible();
    const combobox = palette.getByRole('combobox');
    await expect(combobox).toBeFocused();
    const recentGroup = palette.getByRole('group', { name: 'Gần đây' });
    await expect(recentGroup).toContainText('Sổ sách');
    await expect(recentGroup).toContainText('Tổng quan tài chính');

    // Switch theme via inline submenu and verify live sync with AccountPopover's ThemeSwitcher.
    await combobox.fill('doi giao dien');
    await page.keyboard.press('Enter');
    await expect(palette.getByTestId('palette-back')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await trigger.click();
    await expect(sidebar.getByRole('radiogroup', { name: 'Giao diện' }).getByRole('radio', { name: 'Tối' })).toHaveAttribute('aria-checked', 'true');
    await sidebar.getByRole('radiogroup', { name: 'Giao diện' }).getByRole('radio', { name: 'Sáng' }).click();
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await page.keyboard.press('Escape');

    // Open New task quick capture dialog from Cmd+K.
    await page.keyboard.press('Control+k');
    await combobox.fill('tao viec moi');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('quick-capture-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-dialog')).toBeHidden();

    // Switch org via Cmd+K inline org list and verify first org's recents do not leak.
    await page.keyboard.press('Control+k');
    await combobox.fill('doi to chuc');
    await page.keyboard.press('Enter');
    await palette.getByRole('option', { name: 'Công ty Hướng Dương' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${second}/overview$`));

    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    const secondRecentGroup = palette.getByRole('group', { name: 'Gần đây' });
    await expect(secondRecentGroup).toContainText('Tổng quan');
    await expect(secondRecentGroup).not.toContainText('Sổ sách');
    await expect(secondRecentGroup).not.toContainText('Tổng quan tài chính');
    await expect(palette).not.toContainText('Sổ sách');
    await page.keyboard.press('Escape');
  });

  await test.step('"Thêm tổ chức" opens the form for the next org', async () => {
    await trigger.click();
    await orgButton(sidebar).click();
    await page.getByRole('menuitem', { name: 'Thêm tổ chức' }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole('heading', { name: 'Thêm tổ chức' })).toBeVisible();
  });
});

test('on a phone the account popover and org menu open inside the drawer, with 44px controls', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await signInNewUser(page, newEmail('org-menu-phone'));
  const first = await createOrg(page, 'Công ty Hoa Sen');
  await page.goto('/onboarding');
  await createOrg(page, 'Công ty Hướng Dương');

  await page.getByRole('button', { name: 'Mở menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Menu chính' });
  await expect(drawer).toBeVisible();
  const trigger = accountButton(drawer);
  expect((await trigger.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await trigger.click();

  const popover = drawer.getByTestId('account-popover');
  await expect(popover).toBeVisible();
  for (const radio of await popover.getByRole('radio').all()) {
    const box = await radio.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }

  const button = orgButton(popover);
  expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  // Escape closes OrgMenu first, then AccountPopover, leaving the drawer open.
  await button.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(popover).toBeVisible();
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
