// SPDX-License-Identifier: AGPL-3.0-only
// Settings "Ứng dụng" (ADR-0053, slice d of #3307): an owner starts with every app on, switches Social off after the confirmation, and its screen no longer opens
// (the address goes to the overview, as for an app the deployment leaves out); switching it back on opens it again. The AI coworker here: none acts, every change is a person's.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

test('an owner switches Social off and on again from Settings', async ({ page }) => {
  await signUp(page, newEmail('org-apps'));
  const slug = await createOrg(page, 'Công ty chọn ứng dụng');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();

  const social = page.getByTestId('org-app-social');
  await expect(social).toBeVisible();
  await expect(social.getByRole('checkbox')).toBeChecked();
  await expect(social.getByText('Đang bật')).toBeVisible();

  // Turning off asks first and says what is kept.
  await social.getByRole('checkbox').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Tắt ứng dụng Social?')).toBeVisible();
  await expect(dialog.getByText('Dữ liệu được giữ nguyên')).toBeVisible();
  await dialog.getByRole('button', { name: 'Giữ nguyên' }).click();
  await expect(social.getByRole('checkbox')).toBeChecked();

  await social.getByRole('checkbox').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Tắt ứng dụng' }).click();
  await expect(social.getByText('Đã tắt')).toBeVisible();
  await expect(social.getByRole('checkbox')).not.toBeChecked();

  // The screen does not open for anyone in the company: the address goes to the overview.
  await page.goto(`/o/${slug}/social`);
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/overview$`));

  // Back on: everything is where it was.
  await page.goto(`/o/${slug}/settings`);
  await page.getByTestId('org-app-social').getByRole('checkbox').click();
  await expect(page.getByTestId('org-app-social').getByText('Đang bật')).toBeVisible();
  await page.goto(`/o/${slug}/social`);
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/social`));
});
