// SPDX-License-Identifier: AGPL-3.0-only
// Sales e-invoice drafts (#2500), end to end on the offline provider: an owner reads the test series -> makes a draft for a business buyer, sees the amounts the
// server computes from the lines and the checks on the fields as the form is typed -> saves it with its issues shown -> completes it, edits a line and deletes it.
// Nothing is issued: the screen says so.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

test('reads the test series, drafts a sales invoice with the amounts computed by the server and the checks on the fields, edits it and deletes it', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('einvoice'));
  await createOrg(page, 'Công ty Hóa đơn E2E');
  const nav = page.getByRole('navigation');

  await test.step('the screen starts with no series and no draft', async () => {
    await nav.getByRole('link', { name: 'Tài chính', exact: true }).click();
    await nav.getByRole('link', { name: 'Hóa đơn bán ra' }).click();
    await expect(page.getByRole('heading', { name: 'Hóa đơn bán ra' })).toBeVisible();
    await expect(page.getByTestId('invoice-no-series')).toContainText('Chưa có ký hiệu hóa đơn');
    await expect(page.getByText('Chưa có bản nháp hóa đơn nào')).toBeVisible();
  });

  await test.step('the owner reads the series from the offline provider', async () => {
    await page.getByTestId('invoice-sync').click();
    await expect(page.getByTestId('invoice-no-series')).toBeHidden();
  });

  await test.step('a new draft shows the checks on its fields and the server\'s amounts', async () => {
    await page.getByTestId('invoice-new').click();
    const form = page.getByTestId('invoice-form');
    await expect(form).toBeVisible();
    // A business buyer needs a tax code, a name and an address; a line needs a price. The checks say so before anything is saved.
    await expect(page.getByTestId('invoice-issues')).toContainText('Người mua là doanh nghiệp nên cần mã số thuế');
    await expect(page.getByTestId('invoice-save')).toBeDisabled();

    await form.getByLabel('Mã số thuế').fill('0100109107');
    await expect(page.getByTestId('invoice-issues')).toContainText('không qua được bước kiểm tra số cuối');
    await form.getByLabel('Mã số thuế').fill('0100109106');
    await form.getByLabel('Tên người mua').fill('Công ty Mua Thử E2E');
    await form.getByLabel('Địa chỉ').fill('1 Phố Thử, Hà Nội');
    await form.getByLabel('Tên hàng hóa, dịch vụ').first().fill('Dịch vụ tư vấn');
    await form.getByLabel('Số lượng').first().fill('2');
    await form.getByLabel('Đơn giá').first().fill('500000');
    // 2 x 500,000 = 1,000,000 and 10% VAT = 100,000: the totals are the server's, there is nothing to type.
    await expect(page.getByTestId('invoice-total')).toContainText(/1\.100\.000/);
    await expect(page.getByTestId('invoice-issues')).toBeHidden();
    await expect(page.getByTestId('invoice-save')).toBeEnabled();
    await expect(form.getByText('Bản nháp chưa được phát hành và chưa gửi đi đâu.')).toBeVisible();
  });

  await test.step('it saves, and appears in the list as a draft', async () => {
    await page.getByTestId('invoice-save').click();
    await expect(page.getByTestId('invoice-form')).toBeHidden();
    const row = page.getByTestId('invoice-draft');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Công ty Mua Thử E2E');
    await expect(row).toContainText(/1\.100\.000/);
    await expect(row).toContainText('Bản nháp');
  });

  await test.step('it is edited: a second line changes the total', async () => {
    await page.getByTestId('invoice-edit').click();
    const form = page.getByTestId('invoice-form');
    await expect(form.getByLabel('Tên người mua')).toHaveValue('Công ty Mua Thử E2E');
    await page.getByTestId('invoice-add-line').click();
    const lines = form.getByTestId('invoice-line');
    await expect(lines).toHaveCount(2);
    await lines.nth(1).getByLabel('Tên hàng hóa, dịch vụ').fill('Phí đi lại');
    await lines.nth(1).getByLabel('Đơn giá').fill('200000');
    await lines.nth(1).getByLabel('Thuế suất').selectOption('KCT');
    // 1,000,000 + 200,000 = 1,200,000 and VAT 100,000 only on the first line.
    await expect(page.getByTestId('invoice-total')).toContainText(/1\.300\.000/);
    await page.getByTestId('invoice-save').click();
    await expect(page.getByTestId('invoice-form')).toBeHidden();
    await expect(page.getByTestId('invoice-draft')).toContainText(/1\.300\.000/);
  });

  await test.step('it is deleted while it is a draft', async () => {
    await page.getByTestId('invoice-delete').click();
    await expect(page.getByTestId('invoice-draft')).toHaveCount(0);
    await expect(page.getByText('Chưa có bản nháp hóa đơn nào')).toBeVisible();
  });
});
