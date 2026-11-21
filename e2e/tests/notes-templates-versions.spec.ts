// SPDX-License-Identifier: AGPL-3.0-only
// Quick note templates and note version history end to end (Notes v2 E3, #3562, docs/plan/notes-v2.md section 3.1): a
// member starts a note from a built-in Vietnamese starter template in one click, edits it twice, opens the version
// history drawer, sees the diff and restores the earlier text in one click, then saves the note as a custom template
// that the template picker lists.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('a starter template, the version history with a one-click restore, and saving a note as a template', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('notes-templates'));
  const slug = await createOrg(page, 'Công ty Mẫu Ghi Chú');
  await page.goto(`/o/${slug}/notes`);

  const title = page.getByRole('textbox', { name: 'Tiêu đề' });
  const body = page.getByRole('textbox', { name: 'Nội dung' });
  const saved = page.getByRole('status').filter({ hasText: 'Đã lưu' });

  await test.step('a built-in starter template makes a structured note in one click', async () => {
    await page.getByTestId('notes-new-from-template').click();
    const picker = page.getByTestId('notes-template-picker-dialog');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Biên bản họp');
    await expect(picker).toContainText('Ghi chú khách hàng');
    await expect(picker).toContainText('SOP quy trình');
    await expect(picker).toContainText('Nhật ký công việc tuần');
    await page.getByTestId('note-template-starter-meeting-notes').click();
    await expect(picker).toBeHidden();
    await expect(title).toHaveValue('Biên bản họp');
    await expect(body).toHaveValue(/## Quyết định đã chốt/);
  });

  await test.step('two edits leave snapshots behind', async () => {
    for (const text of ['Chốt giá 10 triệu', 'Chốt giá 12 triệu']) {
      // Each edit is one autosave: wait for its update to land before the next one.
      const updated = page.waitForResponse((r) => r.url().includes('/api/rpc/notes/update') && r.ok());
      await body.fill(text);
      await updated;
      await expect(saved).toBeVisible({ timeout: 10_000 });
    }
  });

  await test.step('the history drawer shows the diff and restores the earlier text in one click', async () => {
    await page.getByTestId('note-version-history-open').click();
    const drawer = page.getByTestId('note-version-history-drawer');
    await expect(drawer).toBeVisible();
    const items = page.getByTestId('note-version-list').getByRole('button');
    await expect(items).toHaveCount(2);
    // The newest snapshot is selected first: the text before the last edit.
    await expect(items.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('note-version-unified-view')).toContainText('- Chốt giá 10 triệu');
    await expect(page.getByTestId('note-version-unified-view')).toContainText('+ Chốt giá 12 triệu');
    await page.getByTestId('note-version-restore').click();
    await expect(drawer).toBeHidden();
    await expect(body).toHaveValue('Chốt giá 10 triệu');
  });

  await test.step('the restore is itself undoable from the history', async () => {
    await page.getByTestId('note-version-history-open').click();
    await expect(page.getByTestId('note-version-list').getByRole('button')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('note-version-history-drawer')).toBeHidden();
  });

  await test.step('save the note as a custom template, and find it in the picker', async () => {
    await page.getByTestId('note-save-as-template').click();
    const dialog = page.getByTestId('note-save-as-template-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('note-template-save-name').fill('Mẫu báo giá');
    await page.getByTestId('note-template-save-submit').click();
    await expect(dialog).toBeHidden();
    await page.getByTestId('notes-new-from-template').click();
    const picker = page.getByTestId('notes-template-picker-dialog');
    await expect(picker).toContainText('Mẫu báo giá');
  });
});
