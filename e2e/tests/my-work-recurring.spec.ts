// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end tests for Notes v2 T3 & T4a (#3557): recurring personal to-dos (selector, badge, atomic next occurrence
// with reset checklist), 1-click and bulk overdue reschedule, Sap toi (Upcoming) 7d/30d agenda with drag-and-drop and
// accessible keyboard date-move, 360px responsive layout in light/dark themes, and WCAG axe checks.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

function addDays(base: string, days: number): string {
  const [y, m, d] = base.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function toDisplayDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-');
  return `${d}/${m}/${y}`;
}

async function auditMyWorkScreen(page: Page, path: string, theme: 'light' | 'dark'): Promise<string[]> {
  await page.evaluate((value) => localStorage.setItem('ludy-theme', value), theme);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);

  const problems: string[] = [];
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  if (widths.page > widths.view) {
    problems.push(`${theme} ${path}: horizontal overflow (${widths.page}px > ${widths.view}px)`);
  }

  const wcag = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  for (const v of wcag.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')) {
    problems.push(`${theme} ${path}: ${v.impact} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  return problems;
}

test('recurring personal to-dos, 1-click overdue reschedule, and Sap toi agenda work end to end (#3557)', async ({ page }) => {
  const email = newEmail('mywork-rec');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Cty Việc Lặp');

  await page.goto(`/o/${slug}/my-work`);
  await expect(page.getByRole('heading', { name: 'Việc của tôi', level: 1 })).toBeVisible();

  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  const dayLater = addDays(today, 12);

  await test.step('create a recurring personal to-do with checklist steps and complete it to spawn the next occurrence', async () => {
    const addBox = page.getByRole('textbox', { name: 'Thêm việc, Enter để lưu' });
    await addBox.fill('Kiểm tra sổ quỹ cuối ngày');
    await addBox.press('Enter');

    const row = page.getByTestId('todo-row').filter({ hasText: 'Kiểm tra sổ quỹ cuối ngày' });
    await expect(row).toBeVisible();
    await row.getByTestId('todo-title').click();

    const editor = page.getByTestId('todo-editor');
    await expect(editor).toBeVisible();
    await editor.getByPlaceholder('Thêm bước').fill('Đối chiếu tiền mặt');
    await editor.getByRole('button', { name: 'Thêm', exact: true }).click();
    await editor.getByRole('checkbox', { name: /Đối chiếu tiền mặt/ }).check();

    await editor.getByRole('textbox', { name: 'Ngày đến hạn' }).fill(toDisplayDate(today));
    await editor.getByTestId('todo-recurrence-preset').selectOption('daily');
    await editor.getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(row.getByTestId('todo-recurrence-badge')).toContainText('Hàng ngày');

    // Completing marks current done and creates tomorrow's occurrence with unchecked checklist step.
    await row.getByRole('checkbox', { name: 'Đánh dấu xong: Kiểm tra sổ quỹ cuối ngày' }).click();

    const nextRow = page.getByTestId('todo-row').filter({ hasText: 'Kiểm tra sổ quỹ cuối ngày' }).filter({ hasText: toDisplayDate(tomorrow) });
    await expect(nextRow).toBeVisible();
    await expect(nextRow.getByTestId('todo-due')).toContainText(toDisplayDate(tomorrow));
    await expect(nextRow).toContainText('0/1');

    const rows = sql<{ status: string; due_on: string | null }>(
      `SELECT td.status, td.due_on::text FROM crove_notes.todo td
       JOIN crove_kernel.tenant t ON t.org_id = td.org_id
       WHERE t.slug = :'slug' ORDER BY td.created_at ASC`,
      { slug },
    );
    expect(rows).toEqual([
      { status: 'done', due_on: today },
      { status: 'open', due_on: tomorrow },
    ]);
  });

  await test.step('1-click overdue reschedule and bulk overdue reschedule bar', async () => {
    const addBox = page.getByRole('textbox', { name: 'Thêm việc, Enter để lưu' });
    for (const title of ['Việc trễ 1', 'Việc trễ 2']) {
      await addBox.fill(title);
      await addBox.press('Enter');
      const r = page.getByTestId('todo-row').filter({ hasText: title });
      await expect(r).toBeVisible();
      await r.getByTestId('todo-title').click();
      await page.getByTestId('todo-editor').getByRole('textbox', { name: 'Ngày đến hạn' }).fill('01/10/2025');
      await page.getByTestId('todo-editor').getByRole('button', { name: 'Lưu', exact: true }).click();
      await expect(page.getByTestId('todo-editor')).toHaveCount(0);
    }

    const overdueGroup = page.getByTestId('todo-group-overdue');
    await expect(overdueGroup.getByTestId('todo-row')).toHaveCount(2);
    await expect(page.getByTestId('overdue-bulk-bar')).toBeVisible();

    // 1-click reschedule on the first overdue row moves it to tomorrow cleanly.
    const row1 = overdueGroup.getByTestId('todo-row').filter({ hasText: 'Việc trễ 1' });
    await row1.getByTestId('todo-reschedule-tomorrow').click();
    await expect(overdueGroup.getByTestId('todo-row')).toHaveCount(1);

    // Bulk reschedule moves the remaining overdue row via the bulk dialog or quick action.
    await page.getByTestId('overdue-bulk-bar').getByTestId('bulk-reschedule-overdue').click();
    await expect(page.getByTestId('reschedule-dialog')).toBeVisible();
    await page.getByTestId('reschedule-dialog-confirm').click();
    await expect(page.getByTestId('todo-group-overdue')).toHaveCount(0);
  });

  await test.step('Sap toi (Upcoming) tab supports 7d/30d range, accessible keyboard date move, and drag-and-drop', async () => {
    // Give one item a date 12 days ahead so 7-day vs 30-day range difference is visible.
    const moveRow = page.getByTestId('todo-row').filter({ hasText: 'Việc trễ 2' });
    await moveRow.getByTestId('todo-title').click();
    await page.getByTestId('todo-editor').getByRole('textbox', { name: 'Ngày đến hạn' }).fill(toDisplayDate(dayLater));
    await page.getByTestId('todo-editor').getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(page.getByTestId('todo-editor')).toHaveCount(0);

    await page.getByTestId('my-work-tab-upcoming').click();
    await expect(page.getByTestId('my-work-upcoming-agenda')).toBeVisible();
    await expect(page.getByTestId(`upcoming-day-${dayLater}`)).toHaveCount(0);

    // 30-day selector reveals day +12.
    await page.getByTestId('upcoming-range-30').click();
    await expect(page.getByTestId(`upcoming-day-${dayLater}`)).toBeVisible();
    await page.getByTestId('upcoming-range-7').click();

    // Accessible keyboard select moves 'Việc trễ 1' from tomorrow to dayAfter.
    const rowInTomorrow = page.getByTestId(`upcoming-day-${tomorrow}`).getByTestId('todo-row').filter({ hasText: 'Việc trễ 1' });
    await expect(rowInTomorrow).toBeVisible();
    await rowInTomorrow.getByTestId('todo-move-date-select').selectOption(dayAfter);

    const movedToDayAfter = page.getByTestId(`upcoming-day-${dayAfter}`).getByTestId('todo-row').filter({ hasText: 'Việc trễ 1' });
    await expect(movedToDayAfter).toBeVisible();
    await expect(movedToDayAfter).toHaveAttribute('draggable', 'true');

    // Drag-and-drop moves it back onto today's bucket.
    await movedToDayAfter.dragTo(page.getByTestId(`upcoming-day-${today}`));
    await expect(page.getByTestId(`upcoming-day-${today}`).getByTestId('todo-row').filter({ hasText: 'Việc trễ 1' })).toBeVisible();
  });

  await test.step('fits 360px mobile in light and dark themes with zero horizontal overflow and clean axe WCAG', async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    const problems: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      problems.push(...(await auditMyWorkScreen(page, `/o/${slug}/my-work`, theme)));
      await page.getByTestId('my-work-tab-upcoming').click();
      await expect(page.getByTestId('my-work-upcoming-agenda')).toBeVisible();
      const widths = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        view: document.documentElement.clientWidth,
      }));
      if (widths.page > widths.view) {
        problems.push(`${theme} upcoming 360px overflow (${widths.page}px > ${widths.view}px)`);
      }
    }
    expect(problems).toEqual([]);
  });
});
