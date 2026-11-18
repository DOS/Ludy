// SPDX-License-Identifier: AGPL-3.0-only
// The register of fixed assets (#919, #3607): "Thêm tài sản" opens a panel over the list, the name comes first, an entry that
// looks like one already in the register says so before it is added, and Escape closes the panel with focus back on the button.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

test('add an asset in the side panel and see a duplicate hint before a second one', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('assets'));
  const slug = await createOrg(page, 'Công ty Tài Sản');
  await page.goto(`/o/${slug}/fixed-assets`);
  await expect(page.getByRole('heading', { name: 'Tài sản và chi phí trả trước' })).toBeVisible();
  await expect(page.getByText('Chưa có tài sản nào')).toBeVisible();

  await test.step('the form opens in a panel with the name first, and adds the asset', async () => {
    await page.getByRole('button', { name: 'Thêm tài sản' }).first().click();
    const panel = page.getByRole('dialog', { name: 'Thêm tài sản hoặc chi phí trả trước' });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('Tên', { exact: true })).toBeFocused();
    // The accounts wait behind "Thêm chi tiết".
    await expect(panel.getByLabel('Tài khoản tài sản')).toHaveCount(0);
    await panel.getByLabel('Tên', { exact: true }).fill('Máy in văn phòng');
    await panel.getByLabel('Nguyên giá (đồng)').fill('12.000.000');
    await expect(panel.getByText(/Có vẻ trùng với/)).toHaveCount(0);
    await panel.getByRole('button', { name: 'Thêm vào sổ' }).click();
    await expect(panel.getByText('Đã thêm vào sổ tài sản.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'Máy in văn phòng' })).toContainText('12.000.000');
  });

  await test.step('the same name and cost typed again shows it looks like the first, before it is added', async () => {
    await page.getByRole('button', { name: 'Thêm tài sản' }).first().click();
    const panel = page.getByRole('dialog', { name: 'Thêm tài sản hoặc chi phí trả trước' });
    await panel.getByLabel('Tên', { exact: true }).fill('máy in văn phòng ');
    await panel.getByLabel('Nguyên giá (đồng)').fill('12.000.000');
    await expect(panel.getByText(/Có vẻ trùng với "Máy in văn phòng"/)).toBeVisible();
    await panel.getByLabel('Nguyên giá (đồng)').fill('13.000.000');
    await expect(panel.getByText(/Có vẻ trùng với/)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Thêm tài sản' }).first()).toBeFocused();
  });
});
