// SPDX-License-Identifier: AGPL-3.0-only
// The booking calendar feed on the Bookings screen (#1382, #2117): making a new address and revoking it ask first in the
// app's dialog, not the browser's. The confirm button names the outcome, Cancel and Escape change nothing, and only the
// confirm button runs the action.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('recreate and revoke the booking feed address through a dialog that names the outcome', async ({ page }) => {
  const email = newEmail('booking-feed');
  await page.goto('/');
  await signInNewUser(page, email);
  await createOrg(page, 'Công ty Lịch Đăng Ký');
  await page.getByRole('navigation').getByRole('link', { name: 'CRM', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Lịch hẹn' }).click();

  const card = page.getByTestId('booking-feed');
  const live = card.getByText('Bạn đang có một địa chỉ đăng ký lịch hẹn', { exact: false });
  const address = card.getByLabel('Địa chỉ đăng ký lịch hẹn');

  // The browser's own dialog must never open: answering it would hide the very thing this test is about.
  const browserDialogs: string[] = [];
  page.on('dialog', (dialog) => {
    browserDialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });

  await test.step('the first address is made with no question: nothing is cut off', async () => {
    await expect(card.getByText('Bạn chưa có địa chỉ đăng ký lịch hẹn.')).toBeVisible();
    await card.getByRole('button', { name: 'Tạo địa chỉ đăng ký' }).click();
    await expect(live).toBeVisible();
    await expect(address).toBeVisible();
  });

  const firstAddress = await address.inputValue();

  await test.step('making a new one asks first, and Cancel keeps the old address', async () => {
    const trigger = card.getByRole('button', { name: 'Tạo lại địa chỉ' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Tạo địa chỉ đăng ký mới?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Địa chỉ cũ sẽ ngừng hoạt động', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Tạo địa chỉ mới' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await address.inputValue()).toBe(firstAddress);
  });

  await test.step('Escape closes the revoke dialog and changes nothing', async () => {
    await card.getByRole('button', { name: 'Thu hồi' }).click();
    const dialog = page.getByRole('dialog', { name: 'Thu hồi địa chỉ đăng ký lịch hẹn?' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(live).toBeVisible();
    expect(await address.inputValue()).toBe(firstAddress);
  });

  await test.step('confirming makes a different address', async () => {
    await card.getByRole('button', { name: 'Tạo lại địa chỉ' }).click();
    const dialog = page.getByRole('dialog', { name: 'Tạo địa chỉ đăng ký mới?' });
    await dialog.getByRole('button', { name: 'Tạo địa chỉ mới' }).click();
    await expect(dialog).toBeHidden();
    await expect(address).not.toHaveValue(firstAddress);
  });

  await test.step('revoking asks first, names the outcome, and removes the address once confirmed', async () => {
    await card.getByRole('button', { name: 'Thu hồi' }).click();
    const dialog = page.getByRole('dialog', { name: 'Thu hồi địa chỉ đăng ký lịch hẹn?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Thu hồi địa chỉ' }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByText('Bạn chưa có địa chỉ đăng ký lịch hẹn.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Thu hồi' })).toHaveCount(0);
  });

  expect(browserDialogs).toEqual([]);
});
