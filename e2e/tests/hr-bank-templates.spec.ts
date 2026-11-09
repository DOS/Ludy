// SPDX-License-Identifier: AGPL-3.0-only
// The saved layouts of the banks' bulk-salary files in the HR app (#2893), end to end on the stack: an owner opens "Mẫu file lương", sees it empty, adds a template (a bank's name, a changed header, a column
// moved, the payment's content text), sees it listed with the bank's column order, renames it and deletes it after a confirmation. No AI in this screen, and the template holds no person's data.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('an owner adds, renames and deletes a bank template for the salary file', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('hr-bank-templates'));
  const slug = await createOrg(page, 'Công ty Mẫu File Lương');
  await page.goto(`/o/${slug}/hr/bank-templates`);
  await expect(page.getByRole('heading', { name: 'Mẫu file lương', exact: true })).toBeVisible();
  await expect(page.getByText('Chưa có mẫu nào')).toBeVisible();

  await test.step('a new template starts from the six columns; the owner sets a header, moves the content column up and saves', async () => {
    await page.getByTestId('hr-bank-new').click();
    const form = page.getByTestId('hr-bank-template-form');
    // Without a name the form cannot be saved.
    await expect(form.getByTestId('hr-bank-save')).toBeDisabled();
    await form.getByTestId('hr-bank-name').fill('Vietcombank');
    await form.getByLabel('Tiêu đề cột Số thứ tự').fill('So TT');
    await form.getByRole('button', { name: 'Đưa cột Nội dung chuyển khoản lên' }).click();
    await form.getByTestId('hr-bank-content').fill('Luong thang {month}');
    await form.getByTestId('hr-bank-save').click();
    await expect(page.getByTestId('hr-bank-template-form')).toBeHidden();
    const row = page.getByTestId('hr-bank-row').filter({ hasText: 'Vietcombank' });
    await expect(row).toContainText('So TT / Họ tên / Số tài khoản / Ngân hàng / Nội dung / Số tiền');
    await expect(row).toContainText('Luong thang {month}');
  });

  await test.step('a name already used in the entity is refused with a plain message', async () => {
    await page.getByTestId('hr-bank-new').click();
    const form = page.getByTestId('hr-bank-template-form');
    await form.getByTestId('hr-bank-name').fill('Vietcombank');
    await form.getByTestId('hr-bank-save').click();
    await expect(form).toContainText('đã có một mẫu với tên đó');
    await form.getByRole('button', { name: 'Hủy' }).click();
  });

  await test.step('the owner renames it and then deletes it after a confirmation', async () => {
    await page.getByTestId('hr-bank-row').filter({ hasText: 'Vietcombank' }).getByTestId('hr-bank-edit').click();
    await page.getByTestId('hr-bank-name').fill('VCB');
    await page.getByTestId('hr-bank-save').click();
    const row = page.getByTestId('hr-bank-row').filter({ hasText: 'VCB' });
    await expect(row).toBeVisible();
    await row.getByTestId('hr-bank-delete').click();
    await row.getByTestId('hr-bank-delete-confirm').click();
    await expect(page.getByTestId('hr-bank-row')).toHaveCount(0);
    await expect(page.getByText('Chưa có mẫu nào')).toBeVisible();
  });
});
