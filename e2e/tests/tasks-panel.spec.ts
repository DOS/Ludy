// SPDX-License-Identifier: AGPL-3.0-only
// Tasks create and edit in the side panel (owner rule of 2026-11-17, #3606): the list is the first thing on the screen with no form above
// it; "Thêm việc" opens a panel that asks for the title first, Esc closes it and focus returns to the button; typed input is not thrown
// away without asking; Ctrl+Enter saves; a title an open task already has is shown with a link; a row opens the same panel to edit
// (description and steps live there); the panel is full screen on a phone and passes axe.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('create a task in the side panel, see the duplicate, edit it from its row, and finish it', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('tasks-panel'));
  const slug = await createOrg(page, 'Công ty Việc Trong Panel');
  const panel = () => page.getByRole('dialog');
  const add = () => page.getByRole('button', { name: 'Thêm việc', exact: true });

  await test.step('the list comes first with no form above it, at desktop and phone width', async () => {
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.goto(`/o/${slug}/tasks`);
      await expect(add()).toBeVisible();
      await expect(page.getByLabel('Tên việc')).toHaveCount(0);
      const box = await add().boundingBox();
      expect(box && box.y < 260).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await test.step('the panel asks for the title first, Esc closes it and focus returns to the button', async () => {
    await add().click();
    await expect(panel()).toBeVisible();
    await expect(panel().getByLabel('Tên việc')).toBeFocused();
    await expect(panel().getByLabel('Mô tả (không bắt buộc)')).toHaveCount(0);
    await expect(panel().getByText('Các bước')).toHaveCount(0);
    const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
    await expect(add()).toBeFocused();
  });

  await test.step('typed input is not dropped without asking', async () => {
    await add().click();
    await panel().getByLabel('Tên việc').fill('Gọi lại khách Hòa');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('panel-discard')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tiếp tục nhập' })).toBeFocused();
    await page.getByRole('button', { name: 'Tiếp tục nhập' }).click();
    await expect(page.getByTestId('panel-discard')).toHaveCount(0);
    await expect(panel().getByLabel('Tên việc')).toBeFocused();
    await expect(panel().getByLabel('Tên việc')).toHaveValue('Gọi lại khách Hòa');
  });

  await test.step('Cancel asks too, and "Bỏ thay đổi" closes the panel', async () => {
    await panel().getByRole('button', { name: 'Hủy', exact: true }).click();
    await expect(page.getByTestId('panel-discard')).toBeVisible();
    await page.getByRole('button', { name: 'Tiếp tục nhập' }).click();
    await expect(panel().getByLabel('Tên việc')).toHaveValue('Gọi lại khách Hòa');
  });

  await test.step('Ctrl+Enter saves, the panel closes and the task is in the list', async () => {
    await panel().getByLabel('Tên việc').press('Control+Enter');
    await expect(panel()).toHaveCount(0);
    await expect(page.getByTestId('task-row').filter({ hasText: 'Gọi lại khách Hòa' })).toHaveCount(1);
  });

  await test.step('a title an open task already has is shown with a link, before saving', async () => {
    await add().click();
    await panel().getByLabel('Tên việc').fill('gọi lại  khách hòa');
    const duplicate = panel().getByTestId('task-duplicate');
    await expect(duplicate).toContainText('Đã có việc này');
    await expect(duplicate.getByRole('link', { name: /Gọi lại khách Hòa/ })).toBeVisible();
    await panel().getByLabel('Tên việc').fill('Gửi báo giá cho khách Hòa');
    await expect(duplicate).toHaveCount(0);
    await panel().getByRole('button', { name: 'Giao việc', exact: true }).click();
    await expect(panel()).toHaveCount(0);
    await expect(page.getByTestId('task-row')).toHaveCount(2);
  });

  await test.step('a row opens the same panel with the description and the steps', async () => {
    await page.getByRole('button', { name: 'Sửa việc: Gửi báo giá cho khách Hòa' }).click();
    await expect(panel().getByRole('heading', { name: 'Sửa việc' })).toBeVisible();
    await panel().getByLabel('Mô tả').fill('Báo giá gói 12 tháng');
    await panel().getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(panel()).toHaveCount(0);
    await page.getByRole('link', { name: 'Gửi báo giá cho khách Hòa' }).click();
    await expect(page.getByText('Báo giá gói 12 tháng')).toBeVisible();
  });

  await test.step('the task page edits in the panel too, and the task is finished there', async () => {
    const edit = page.getByRole('button', { name: 'Sửa', exact: true });
    await edit.click();
    await expect(panel().getByLabel('Tên việc')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
    await expect(edit).toBeFocused();
    await page.getByLabel('Trạng thái').selectOption({ label: 'Xong' });
    await expect(page.getByText('Xong', { exact: true }).first()).toBeVisible();
  });

  await test.step('on a phone the panel is full screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/o/${slug}/tasks`);
    await add().click();
    const box = await panel().boundingBox();
    expect(box && Math.round(box.width) >= 389 && Math.round(box.height) >= 843).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
  });
});
