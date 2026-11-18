// SPDX-License-Identifier: AGPL-3.0-only
// Notes v2 E1 (#3559) end to end: zero-setup unfiled notes, 2-level stacks and notebooks, interactive preview
// checkboxes persisted to PostgreSQL, [[Note]] autocomplete + clickable wiki-links, and RLS-safe backlinks.
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('notebooks and 2-level stacks, interactive preview checkboxes, and RLS-safe [[Note]] backlinks', async ({
  page,
  browser,
}) => {
  const ownerEmail = newEmail('notes-nb-owner');
  await page.goto('/');
  await signInNewUser(page, ownerEmail);
  const slug = await createOrg(page, 'Công ty Sổ Tay V2');
  await page.goto(`/o/${slug}/notes`);

  const rows = page.getByTestId('note-row');

  await test.step('zero-setup unfiled note works before any notebook exists', async () => {
    await expect(page.getByTestId('notebooks-sidebar')).toBeVisible();
    await page.getByRole('button', { name: 'Ghi chú mới' }).first().click();
    await expect(page.getByRole('textbox', { name: 'Tiêu đề' })).toHaveValue('Ghi chú mới');
    await page.getByRole('textbox', { name: 'Tiêu đề' }).fill('Kế hoạch quý 4');
    await page.getByRole('textbox', { name: 'Nội dung' }).fill('- [ ] Gửi báo giá đầu tuần\n- [ ] Chốt hợp đồng');
    await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible({ timeout: 10_000 });
  });

  await test.step('create a 2-level stack + shared notebook, file the note, and share it', async () => {
    await page.getByTestId('notebook-new-btn').click();
    await page.getByTestId('notebook-name-input').fill('Khách VIP');
    await page.getByTestId('notebook-stack-input').fill('Kinh doanh');
    await page.getByTestId('notebook-visibility-select').selectOption('org');
    await page.getByTestId('notebook-submit-btn').click();

    await expect(page.getByTestId('notebook-stack').filter({ hasText: 'Kinh doanh' })).toBeVisible();
    await page.getByTestId('notebook-filter-all').click();
    await rows.filter({ hasText: 'Kế hoạch quý 4' }).click();

    const picker = page.getByTestId('note-notebook-select');
    await picker.selectOption({ label: 'Kinh doanh / Khách VIP (Dùng chung)' });
    await expect(picker).not.toHaveValue('');

    await page.getByRole('button', { name: 'Chia sẻ với tổ chức' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Chia sẻ với tổ chức' }).click();
    await expect(page.getByRole('article').getByText('Dùng chung')).toBeVisible();

    await page.getByTestId('notebook-stack-filter').filter({ hasText: 'Kinh doanh' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Kế hoạch quý 4');

    await page.getByTestId('notebook-filter-unfiled').click();
    await expect(rows).toHaveCount(0);
    await page.getByTestId('notebook-filter-all').click();
    await rows.filter({ hasText: 'Kế hoạch quý 4' }).click();
  });

  await test.step('toggle an interactive checkbox in Preview mode and verify persistence across reload + DB', async () => {
    await page.getByRole('button', { name: 'Xem trước' }).click();
    const firstBox = page.getByTestId('note-task-checkbox').first();
    await expect(firstBox).not.toBeChecked();
    await firstBox.click();
    await expect(firstBox).toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await page.getByRole('button', { name: 'Xem trước' }).click();
    await expect(page.getByTestId('note-task-checkbox').first()).toBeChecked();

    const stored = sql<{ body: string }>(
      `SELECT n.body FROM crove_notes.note n
       JOIN crove_kernel.tenant t ON t.org_id = n.org_id
       WHERE t.slug = :'slug' AND n.title = 'Kế hoạch quý 4'`,
      { slug },
    );
    expect(stored).toEqual([{ body: '- [x] Gửi báo giá đầu tuần\n- [ ] Chốt hợp đồng' }]);
  });

  await test.step('link via [[ autocomplete in a private note, navigate via wiki-link, and verify RLS backlinks', async () => {
    await page.getByRole('button', { name: 'Ghi chú mới' }).first().click();
    await page.getByRole('textbox', { name: 'Tiêu đề' }).fill('Đánh giá thưởng nội bộ');
    const body = page.getByRole('textbox', { name: 'Nội dung' });
    await body.click();
    await body.pressSequentially('Đối chiếu với [[Kế hoạch');
    await expect(page.getByTestId('note-wiki-autocomplete')).toBeVisible();
    await page.getByTestId('note-wiki-option').filter({ hasText: 'Kế hoạch quý 4' }).click();
    await expect(body).toHaveValue('Đối chiếu với [[Kế hoạch quý 4]]');
    await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible({ timeout: 10_000 });

    // Click rendered wiki-link in Preview mode -> navigates to Kế hoạch quý 4 and shows private backlink to author.
    await page.getByRole('button', { name: 'Xem trước' }).click();
    await page.getByTestId('note-wiki-link').filter({ hasText: 'Kế hoạch quý 4' }).click();
    await expect(page.getByRole('textbox', { name: 'Tiêu đề' })).toHaveValue('Kế hoạch quý 4');
    await expect(page.getByTestId('note-backlinks')).toContainText('Đánh giá thưởng nội bộ');

    // Second org member opens Kế hoạch quý 4 -> sees the shared note & shared notebook, NEVER the owner's private backlink!
    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      const otherEmail = newEmail('notes-nb-member');
      await otherPage.goto('/');
      await signInNewUser(otherPage, otherEmail);
      exec(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
         SELECT t.org_id, u.id, 'member'
           FROM crove_kernel.tenant t, crove_kernel.user_account u
          WHERE t.slug = :'slug' AND u.email = :'otherEmail'`,
        { slug, otherEmail },
      );

      await otherPage.goto(`/o/${slug}/notes?list=shared`);
      await expect(otherPage.getByTestId('notebook-stack').filter({ hasText: 'Kinh doanh' })).toBeVisible();
      await otherPage.getByTestId('note-row').filter({ hasText: 'Kế hoạch quý 4' }).click();
      await expect(otherPage.getByRole('heading', { name: 'Kế hoạch quý 4' })).toBeVisible();
      await expect(otherPage.getByTestId('note-backlinks')).toBeVisible();
      await expect(otherPage.getByTestId('note-backlinks')).not.toContainText('Đánh giá thưởng nội bộ');
      await expect(otherPage.getByTestId('note-backlink-item')).toHaveCount(0);
    } finally {
      await otherContext.close();
    }
  });
});
