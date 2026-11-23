// SPDX-License-Identifier: AGPL-3.0-only
// My work v2 end to end (#3558): a member creates personal lists with sections, sets P1-P4 priorities and #tags,
// filters and sorts them cleanly, deletes a list returning items to Inbox, and another org member sees nothing.
import { expect, test } from '@playwright/test';
import { exec } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('a member organizes personal to-do lists, sections, priorities and #tags privately (#3558)', async ({ page, browser }) => {
  const email = newEmail('my-work-lists');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Danh sách Riêng');

  // A new org opens on the overview, which belongs to no app and shows no app menu (#3588): switch to Cộng tác first.
  await page.getByRole('navigation').getByRole('list', { name: 'Ứng dụng' }).getByRole('link', { name: 'Cộng tác', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Việc của tôi' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/my-work$`));

  await test.step('creates a personal list with color and sections', async () => {
    await page.getByTestId('new-list-button').click();
    await page.getByTestId('list-dialog-name').fill('Thuế tháng 11');
    await page.getByTestId('list-color-blue').click();
    await page.getByTestId('list-dialog-new-section').fill('Đầu tuần');
    await page.getByTestId('list-dialog-add-section').click();
    await page.getByTestId('list-dialog-new-section').fill('Cuối tuần');
    await page.getByTestId('list-dialog-add-section').click();
    await page.getByTestId('list-dialog-save').click();

    await expect(page.getByTestId('selected-list-header')).toContainText('Thuế tháng 11');
    await expect(page.getByText('Đầu tuần')).toBeVisible();
    await expect(page.getByText('Cuối tuần')).toBeVisible();
  });

  await test.step('adds to-dos in section, edits priority and #tags, then filters and sorts', async () => {
    const firstSectionAdd = page.getByRole('textbox', { name: 'Thêm việc vào mục Đầu tuần, Enter để lưu' });
    await firstSectionAdd.fill('Nộp tờ khai GTGT');
    await firstSectionAdd.press('Enter');
    await expect(page.getByTestId('todo-row').filter({ hasText: 'Nộp tờ khai GTGT' })).toBeVisible();

    await page.getByTestId('todo-title').filter({ hasText: 'Nộp tờ khai GTGT' }).click();
    await page.getByTestId('todo-editor-priority').selectOption('1');
    await page.getByTestId('todo-editor-tags').fill('thue, gap');
    await page.getByRole('button', { name: 'Lưu' }).click();

    await expect(page.getByTestId('todo-priority-badge').first()).toContainText('P1');
    await expect(page.getByTestId('todo-tag-chip').filter({ hasText: '#thue' })).toBeVisible();

    await firstSectionAdd.fill('Việc ưu tiên thấp');
    await firstSectionAdd.press('Enter');
    await expect(page.getByTestId('todo-row').filter({ hasText: 'Việc ưu tiên thấp' })).toBeVisible();

    await page.getByTestId('my-work-sort').selectOption('priority');
    await expect.poll(() => page.getByTestId('todo-title').allTextContents()).toEqual(['Nộp tờ khai GTGT', 'Việc ưu tiên thấp']);

    await page.getByTestId('tag-filter-thue').click();
    await expect(page.getByTestId('todo-row')).toHaveCount(1);
    await page.getByTestId('tag-filter-thue').click();
    await expect(page.getByTestId('todo-row')).toHaveCount(2);

    await page.reload();
    await page.getByTestId('list-nav-item').filter({ hasText: 'Thuế tháng 11' }).click();
    await expect(page.getByTestId('todo-row')).toHaveCount(2);
  });

  await test.step('deleting the list moves its to-dos safely back to Inbox', async () => {
    await page.getByTestId('edit-selected-list-button').click();
    await page.getByTestId('list-dialog-delete').click();
    await page.getByTestId('list-dialog-confirm-delete').click();

    await page.getByTestId('list-nav-inbox').click();
    await expect(page.getByTestId('todo-row').filter({ hasText: 'Nộp tờ khai GTGT' })).toBeVisible();
  });

  await test.step('another member of the org sees none of the lists, to-dos or tags', async () => {
    const otherEmail = newEmail('my-work-lists-other');
    const other = await browser.newPage({ timezoneId: 'Asia/Ho_Chi_Minh' });
    await other.goto('/');
    await signInNewUser(other, otherEmail);
    exec(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       SELECT t.org_id, u.id, 'member' FROM ludy_kernel.tenant t, ludy_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email: otherEmail },
    );
    await other.goto(`/o/${slug}/my-work`);
    await expect(other.getByTestId('list-nav-item')).toHaveCount(0);
    await expect(other.getByTestId('todo-row')).toHaveCount(0);
    await other.close();
  });
});
