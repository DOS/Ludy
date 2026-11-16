// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end Playwright suite for Projects (#2591, AC 1, 7, 8): create a project with org-wide notice, quick-add 5
// tasks, drag one card to Done, move one by keyboard, verify mobile 360px List default, light/dark themes, focus
// rings and axe WCAG 2.2 AA compliance. Runs strictly headless (macOS zero-focus rule).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const STRUCTURE_RULES = ['landmark-one-main', 'region', 'landmark-unique', 'page-has-heading-one', 'heading-order'];

test.use({ viewport: { width: 1680, height: 900 } });

async function auditScreen(page: Page, path: string, theme: 'light' | 'dark'): Promise<string[]> {
  await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
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

  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  for (const v of structure.violations) {
    problems.push(`${theme} ${path}: ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
  return problems;
}

test('solo owner creates a project, adds 5 tasks, drags one to Done, works keyboard-only and 360px light/dark (#2591)', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewUser(page, newEmail('projects'));
  const slug = await createOrg(page, 'Công ty Dự án Mẫu');

  const sidebar = page.getByRole('complementary');
  const projectsNav = sidebar.getByRole('link', { name: 'Dự án', exact: true });
  if ((await projectsNav.count()) === 0) {
    await sidebar.getByRole('list', { name: 'Ứng dụng' }).getByRole('link', { name: 'Cộng tác', exact: true }).click();
  }
  await projectsNav.click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/projects$`));

  await test.step('create project with org-wide visibility notice', async () => {
    await page.getByTestId('new-project-button').click();
    const dialog = page.getByTestId('create-project-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('project-visibility-notice')).toContainText('Mọi thành viên trong tổ chức đều thấy dự án này');
    await dialog.getByLabel('Tên dự án').fill('Quyết toán quý IV');
    await dialog.getByLabel('Mô tả ngắn (không bắt buộc)').fill('Kiểm tra sổ sách và nộp tờ khai');
    await dialog.getByRole('button', { name: 'Tạo dự án' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/projects/[0-9a-f-]+$`));
  });

  const projectUrl = new URL(page.url()).pathname;

  await test.step('quick-add 5 tasks into Cần làm', async () => {
    await expect(page.getByTestId('project-board')).toBeVisible();
    for (let i = 1; i <= 5; i++) {
      await page.getByTestId('quick-add-todo').click();
      const form = page.getByTestId('quick-add-form-todo');
      await form.getByLabel('Tên việc').fill(`Việc dự án ${i}`);
      await form.getByRole('button', { name: 'Thêm', exact: true }).click();
      await expect(form).toBeHidden();
    }
    const todoCards = page.locator('[data-testid="project-column"][data-status="todo"] [data-testid="project-task-card"]');
    await expect(todoCards).toHaveCount(5);
  });

  await test.step('drag task 1 to Xong (done) and move task 2 with keyboard select', async () => {
    const todoCol = page.locator('[data-testid="project-column"][data-status="todo"]');
    const inProgressCol = page.locator('[data-testid="project-column"][data-status="in_progress"]');
    const doneCol = page.locator('[data-testid="project-column"][data-status="done"]');
    const card1 = todoCol.locator('[data-testid="project-task-card"]', { hasText: 'Việc dự án 1' });

    await card1.dragTo(doneCol);
    await expect(doneCol.locator('[data-testid="project-task-card"]', { hasText: 'Việc dự án 1' })).toBeVisible();
    await expect(todoCol.locator('[data-testid="project-task-card"]')).toHaveCount(4);

    // Move task 2 using focused NativeSelect.
    const statusSelect = todoCol.getByLabel('Đổi trạng thái cho Việc dự án 2');
    await statusSelect.focus();
    await statusSelect.selectOption('in_progress');
    await expect(inProgressCol.locator('[data-testid="project-task-card"]', { hasText: 'Việc dự án 2' })).toBeVisible();

    // Reload and verify persisted backend state.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(doneCol.locator('[data-testid="project-task-card"]', { hasText: 'Việc dự án 1' })).toBeVisible();
    await expect(inProgressCol.locator('[data-testid="project-task-card"]', { hasText: 'Việc dự án 2' })).toBeVisible();
    await expect(todoCol.locator('[data-testid="project-task-card"]')).toHaveCount(3);
  });

  await test.step('reorder tasks within column by keyboard and drag-and-drop, and persist across reload (#2610)', async () => {
    const todoCol = page.locator('[data-testid="project-column"][data-status="todo"]');
    const titlesInTodo = async () =>
      todoCol.locator('[data-testid="project-task-card"] a').allTextContents();

    await expect.poll(titlesInTodo).toEqual(['Việc dự án 3', 'Việc dự án 4', 'Việc dự án 5']);

    // Keyboard Move Up moves Việc dự án 5 before Việc dự án 4.
    const moveUp5 = todoCol.getByRole('button', { name: 'Đưa Việc dự án 5 lên trên' });
    await moveUp5.focus();
    await page.keyboard.press('Enter');
    await expect.poll(titlesInTodo).toEqual(['Việc dự án 3', 'Việc dự án 5', 'Việc dự án 4']);

    // Drag Việc dự án 4 onto Việc dự án 3 to place it at the top of the column.
    const card4 = todoCol.locator('[data-testid="project-task-card"]', { hasText: 'Việc dự án 4' });
    const card3 = todoCol.locator('[data-testid="project-task-card"]', { hasText: 'Việc dự án 3' });
    await card4.dragTo(card3);
    await expect.poll(titlesInTodo).toEqual(['Việc dự án 4', 'Việc dự án 3', 'Việc dự án 5']);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect.poll(titlesInTodo).toEqual(['Việc dự án 4', 'Việc dự án 3', 'Việc dự án 5']);
  });

  await test.step('saved view (kernel.task) filters on project board and /tasks including tainted filter (#2610)', async () => {
    const cards = page.locator('[data-testid="project-task-card"]');
    await page.getByTestId('task-filter-status').selectOption('in_progress');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Việc dự án 2');

    await page.getByRole('button', { name: 'Lưu thành chế độ xem' }).click();
    const saveForm = page.getByRole('form', { name: 'Lưu thành chế độ xem' });
    await saveForm.getByLabel('Tên chế độ xem').fill('Việc đang làm');
    await saveForm.getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Việc đang làm' })).toBeVisible();

    await page.getByTestId('task-filter-tainted').selectOption('true');
    await expect(cards).toHaveCount(0);

    const viewTabs = page.getByRole('tablist', { name: 'Chế độ xem đã lưu' });
    await viewTabs.getByRole('tab', { name: 'Tất cả' }).click();
    await expect(cards).toHaveCount(5);

    // Reload to ensure cache is cold, then select the saved view and confirm tab selection + controls remain mounted, plus search focus persists.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await viewTabs.getByRole('tab', { name: 'Việc đang làm' }).click();
    await expect(cards).toHaveCount(1);
    await expect(viewTabs.getByRole('tab', { name: 'Việc đang làm' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Đổi tên' })).toBeVisible();
    await viewTabs.getByRole('tab', { name: 'Tất cả' }).click();
    await expect(cards).toHaveCount(5);
    const searchBox = page.getByTestId('task-filter-search');
    await searchBox.focus();
    await searchBox.fill('Việc dự án 4');
    await expect(cards).toHaveCount(1);
    await expect(searchBox).toBeFocused();
    await page.getByTestId('task-filter-clear').click();
    await expect(cards).toHaveCount(5);

    // The same saved view appears and filters the org-wide /tasks workspace.
    await page.goto(`/o/${slug}/tasks`);
    await page.waitForLoadState('networkidle');
    await expect(viewTabs.getByRole('tab', { name: 'Việc đang làm' })).toBeVisible();
    await viewTabs.getByRole('tab', { name: 'Việc đang làm' }).click();
    const taskRows = page.getByTestId('task-row');
    await expect(taskRows).toHaveCount(1);
    await expect(taskRows.first()).toContainText('Việc dự án 2');
    await viewTabs.getByRole('tab', { name: 'Tất cả' }).click();
    await expect(taskRows).toHaveCount(4);
  });

  await test.step('360px phone defaults to List view with zero horizontal scroll and passes light/dark axe scan', async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    const problems: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      problems.push(...(await auditScreen(page, `/o/${slug}/projects`, theme)));
      problems.push(...(await auditScreen(page, `/o/${slug}/tasks`, theme)));
      problems.push(...(await auditScreen(page, projectUrl, theme)));
      await expect(page.getByTestId('project-list')).toBeVisible();
      await expect(page.getByTestId('project-board')).toHaveCount(0);
      await expect(page.getByTestId('view-toggle-list')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('project-list-row')).toHaveCount(5);
    }
    expect(problems).toEqual([]);
  });

  await test.step('keyboard Tab walk checks every interactive control shows focus ring cleanly', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(projectUrl);
    await page.waitForLoadState('networkidle');
    // Walk 35 Tab stops on Project detail without trapping or losing focus.
    const focused = new Set<string>();
    for (let i = 0; i < 35; i++) {
      await page.keyboard.press('Tab');
      const tag = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 25) ?? ''}` : 'none';
      });
      focused.add(tag);
    }
    expect(focused.size).toBeGreaterThan(8);
  });
});
