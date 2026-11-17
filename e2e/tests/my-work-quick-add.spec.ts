// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end tests for Notes v2 Quick Add natural-language chips, dismissal restoration,
// global Alt+Q capture shortcut, and 360px light/dark accessibility (#3556).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('natural-language Quick Add parses chips, restores dismissed tokens, and Alt+Q captures globally (#3556)', async ({ page }) => {
  await signInNewUser(page, newEmail('quick-add'));
  const slug = await createOrg(page, 'Công ty Việc Nhanh');

  await test.step('Alt+Q opens Quick Capture modal on Overview and saves via keyboard only', async () => {
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/overview$`));
    await page.keyboard.press('Alt+q');
    const dialog = page.getByTestId('quick-capture-dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByTestId('todo-quick-add-input');
    await expect(input).toBeFocused();

    await input.fill('Gọi anh Nam ngày mai 9h !p1 #sales /CongViec');
    await expect(dialog.getByTestId('quick-add-chip-date')).toBeVisible();
    await expect(dialog.getByTestId('quick-add-chip-time')).toContainText('09:00');
    await expect(dialog.getByTestId('quick-add-chip-priority')).toContainText('P1');
    await expect(dialog.getByTestId('quick-add-chip-tag')).toContainText('#sales');
    await expect(dialog.getByTestId('quick-add-chip-list')).toContainText('CongViec');

    await input.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Đã thêm việc:' })).toBeVisible();
  });

  await test.step('Alt+Q does not trigger while typing inside an editable field', async () => {
    await page.goto(`/o/${slug}/notes`);
    await page.getByRole('region', { name: 'Danh sách ghi chú' }).getByRole('button', { name: 'Ghi chú mới' }).click();
    const noteTitle = page.getByRole('textbox', { name: 'Tiêu đề' });
    await noteTitle.focus();
    await page.keyboard.press('Alt+q');
    await expect(page.getByTestId('quick-capture-dialog')).toBeHidden();
  });

  await test.step('My Work shows captured todo with due time and supports dismissing a chip to restore text', async () => {
    await page.goto(`/o/${slug}/my-work`);
    const savedRow = page.getByTestId('todo-row').filter({ hasText: 'Gọi anh Nam !p1 #sales /CongViec' });
    await expect(savedRow).toBeVisible();
    await expect(savedRow.getByTestId('todo-due')).toContainText('09:00');

    const quickInput = page.getByRole('textbox', { name: 'Thêm việc, Enter để lưu' });
    await quickInput.fill('Đọc lại kế hoạch ngày mai 9h');
    await expect(page.getByTestId('quick-add-chip-date')).toBeVisible();
    await expect(page.getByTestId('quick-add-chip-time')).toBeVisible();

    await page.getByTestId('quick-add-dismiss-date').click();
    await expect(page.getByTestId('quick-add-chip-date')).toHaveCount(0);
    await expect(page.getByTestId('quick-add-chip-time')).toBeVisible();
    await expect(page.getByTestId('quick-add-chip-time')).toContainText('09:00');
    await expect(quickInput).toHaveValue('Đọc lại kế hoạch ngày mai 9h');
    await expect(page.getByTestId('quick-add-preview')).toContainText('Đọc lại kế hoạch ngày mai');

    await quickInput.press('Enter');
    await expect(page.getByTestId('todo-row').filter({ hasText: 'Đọc lại kế hoạch ngày mai' })).toBeVisible();
  });

  await test.step('360px phone layout fits with zero horizontal scroll and passes axe in light and dark', async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      const quickInput = page.getByRole('textbox', { name: 'Thêm việc, Enter để lưu' });
      await quickInput.fill('Nộp thuế cuối tháng 9h !p1 #thue /KeToan');
      await expect(page.getByTestId('quick-add-chips')).toBeVisible();
      const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
      expect(widths.page, theme).toBeLessThanOrEqual(widths.view);
      const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'), theme).toEqual([]);
    }
  });
});
