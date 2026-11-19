// SPDX-License-Identifier: AGPL-3.0-only
// The Team tasks screen (#3597, audit TK-1 to TK-4): one name in the menu, the tab title and the H1; the filters in one popover whose
// button counts them, so the first task is on the first screen of a phone; the My work hint and keys on this screen too; and no second
// tab strip on My work (the menu is the one place that lists the five Cộng tác screens).
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('Team tasks: one name, one filter popover, the keys, and the first row on a phone screen', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('tasks-screen'));
  const slug = await createOrg(page, 'Công ty Việc Nhóm');
  const panel = () => page.getByRole('dialog');

  await test.step('a task to look at', async () => {
    await page.goto(`/o/${slug}/tasks`);
    await page.getByRole('button', { name: 'Thêm việc', exact: true }).click();
    await panel().getByLabel('Tên việc').fill('Gửi báo giá tuần này');
    await panel().getByRole('button', { name: 'Giao việc', exact: true }).click();
    await expect(panel()).toHaveCount(0);
    await expect(page.getByTestId('task-row')).toHaveCount(1);
  });

  await test.step('TK-1: the menu, the tab title and the H1 are one name, with no org-chart words', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/o/${slug}/tasks`);
    await expect(page.getByRole('heading', { name: 'Việc nhóm', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Việc nhóm', exact: true }).first()).toBeVisible();
    await expect(page).toHaveTitle(/Việc nhóm/);
    await expect(page.getByRole('main')).not.toContainText('sơ đồ');
  });

  await test.step('TK-2: the filters are behind one button; on a 390 wide phone the first task row is on the first screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/o/${slug}/tasks`);
    await expect(page.getByTestId('task-filter-search')).toBeVisible();
    await expect(page.getByTestId('task-filter-status')).toHaveCount(0);
    const row = await page.getByTestId('task-row').first().boundingBox();
    expect(row !== null && row.y + row.height <= 844).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await test.step('TK-2: the popover holds the filters, its button counts them, Esc closes it and focus returns to the button', async () => {
    const button = page.getByTestId('task-filter-button');
    await expect(button).toHaveAccessibleName('Bộ lọc');
    await button.click();
    const popover = page.getByTestId('task-filter-popover');
    await expect(popover).toBeVisible();
    await popover.getByTestId('task-filter-status').selectOption('done');
    await expect(page.getByTestId('task-row')).toHaveCount(0);
    await expect(button).toHaveAccessibleName('Bộ lọc, đang bật 1');
    await expect(page.getByTestId('task-filter-count')).toHaveText('1');
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(button).toBeFocused();
    await button.click();
    await page.getByTestId('task-filter-popover').getByTestId('task-filter-clear').click();
    await expect(page.getByTestId('task-row')).toHaveCount(1);
    await expect(page.getByTestId('task-filter-count')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  await test.step('TK-4: the hint line is here, N opens the new-task panel, J selects the row and E edits it', async () => {
    await expect(page.getByTestId('tasks-shortcuts')).toContainText('Phím tắt: N thêm việc');
    await page.keyboard.press('n');
    await expect(panel().getByLabel('Tên việc')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
    await page.keyboard.press('j');
    await expect(page.getByTestId('task-row').first()).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('e');
    await expect(panel().getByRole('heading', { name: 'Sửa việc' })).toBeVisible();
    await expect(panel().getByLabel('Tên việc')).toHaveValue('Gửi báo giá tuần này');
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
  });

  await test.step('TK-3: My work has no second tab strip beside the menu, and keeps its hint', async () => {
    await page.goto(`/o/${slug}/my-work`);
    await expect(page.getByRole('heading', { name: 'Việc của tôi', level: 1 })).toBeVisible();
    for (const name of ['Ghi chú', 'Việc nhóm', 'Dự án', 'Cuộc họp']) {
      await expect(page.getByRole('main').getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByText('Phím tắt: N thêm việc, Alt+Q')).toBeVisible();
  });
});
